import { ModelClient } from "./api/model-client.js";
import { ChatClient, type ChatMessage } from "./api/chat-client.js";
import { REASONING_SYSTEM_PROMPT } from "./api/constants.js";
import { isInternalUrl } from "./url-utils.js";
import { ApiError } from "./api/errors.js";
import { executeAction, waitForPageReady } from "./cdp.js";
import { captureScreenshot, getViewportDimensions, sendToContentScript } from "./tab-utils.js";
import type {
  BrowserAction,
  ClickAction,
  TypeAction,
  PressAction,
  ActionHistoryEntry,
  StatusUpdate,
  ExtensionMessage,
  ScreenAnalysis,
} from "./types.js";

const MAX_ITERATIONS = 50;
const MAX_RETRIES = 3;
const ITERATION_DELAY_MS = 500;
const ACTION_DELAY_MS = 300;
const NAVIGATION_DELAY_MS = 2000;
const RETRY_DELAY_MS = 1000;

// Client is initialized with API keys from .env at build time
const client = new ModelClient();
let isRunning = false;
let currentGoal: string | null = null;
let actionHistory: ActionHistoryEntry[] = [];
let conversationMessages: ChatMessage[] = [];

// Open side panel when extension icon is clicked
chrome.action.onClicked.addListener((tab) => {
  if (tab.windowId) {
    chrome.sidePanel.open({ windowId: tab.windowId });
  }
});

function getActionDescription(action: BrowserAction): string {
  switch (action.action) {
    case "click":
      return `Click: ${(action as ClickAction).target}`;
    case "type":
      return `Type: "${(action as TypeAction).text}"`;
    case "press":
      return `Press: ${(action as PressAction).key}`;
    case "scroll":
      return `Scroll ${action.direction}`;
    case "navigate":
      return `Navigate to ${action.url}`;
    case "wait":
      return `Wait ${action.duration}ms`;
    case "done":
      return "Done";
    case "ask_user":
      return "Waiting for user";
    default:
      return action.action;
  }
}

// Broadcast status update to popup
function broadcastStatus(update: Omit<StatusUpdate, "type">): void {
  chrome.runtime
    .sendMessage({
      type: "STATUS_UPDATE",
      ...update,
    } as StatusUpdate)
    .catch((e) => {
      console.warn("[Agent] Failed to broadcast status:", e);
    });
}

// Main automation loop
async function runAutomation(tabId: number, goal: string): Promise<void> {
  if (!ModelClient.hasApiKeys()) {
    throw new Error(
      "API keys not configured. Please set PERCEPTRON_API_KEY and REASONING_API_KEY in .env and rebuild.",
    );
  }

  isRunning = true;
  currentGoal = goal;
  actionHistory = [];
  conversationMessages = [
    ChatClient.message(REASONING_SYSTEM_PROMPT, "system"),
    ChatClient.message(`Goal: ${goal}`, "system"),
  ];

  let iteration = 0;
  let retryCount = 0;
  let pendingQuestion: string | undefined;
  let pendingVisionFocus: string | undefined;
  let visionAnswer: string | undefined;

  while (isRunning && iteration < MAX_ITERATIONS) {
    iteration++;
    console.log(`[Agent] Starting iteration ${iteration}`);

    try {
      // Step 1: Try to capture and analyze screenshot
      let screenshot: string | null = null;

      // Get current tab URL
      const tab = await chrome.tabs.get(tabId);
      const currentUrl = tab.url!;
      const screenAnalysis: ScreenAnalysis = { url: currentUrl };

      // Only capture and analyze screenshots on real pages
      if (!isInternalUrl(currentUrl)) {
        try {
          await waitForPageReady(tabId);
        } catch (e) {
          console.warn("[Agent] waitForPageReady failed:", e);
        }

        try {
          screenshot = await captureScreenshot();
        } catch (e) {
          console.log("[Agent] Screenshot capture failed:", e);
        }
      } else {
        console.log("[Agent] Skipping screenshot for internal URL:", currentUrl);
      }

      // Step 1b: Analyze with vision model (only if we have a screenshot)
      if (screenshot) {
        broadcastStatus({
          status: "analyzing",
          iteration,
          message: "Analyzing current page...",
        });

        // Clear existing boxes before streaming new ones
        await sendToContentScript(tabId, { type: "CLEAR_BOXES" }).catch((e) => {
          console.warn("[Agent] Failed to clear boxes:", e);
        });

        // Run question answering and screenshot analysis in parallel
        const questionPromise = pendingQuestion
          ? client.askQuestion(screenshot, pendingQuestion).catch((error) => {
              console.warn("[Agent] Question answering failed:", error);
              return undefined;
            })
          : Promise.resolve(undefined);

        const analysisPromise = client
          .analyzeScreenshot(screenshot, pendingVisionFocus, (newBoxes) => {
            // Draw new boxes on the live page as they stream in
            if (newBoxes.length > 0) {
              sendToContentScript(tabId, { type: "ADD_BOXES", boxes: newBoxes }).catch((e) => {
                console.warn("[Agent] Failed to add boxes:", e);
              });
            }
          })
          .catch((apiError) => {
            console.warn("[Agent] Vision API failed:", apiError);
            return null;
          });

        const [questionResult, analysisResult] = await Promise.all([questionPromise, analysisPromise]);

        visionAnswer = questionResult;
        if (visionAnswer) {
          console.log(`[Agent] Vision answer: ${visionAnswer}`);
        }
        pendingQuestion = undefined;

        if (analysisResult) {
          screenAnalysis.pageState = analysisResult.pageState;
          pendingVisionFocus = undefined;

          broadcastStatus({
            status: "vision",
            iteration,
            message: "Page analyzed",
            screenshot,
            pageDescription: analysisResult.pageState,
            boxes: analysisResult.boxes,
          });
        }
      } else {
        // No screenshot - blank page or restricted URL
        broadcastStatus({
          status: "reasoning",
          iteration,
          message: "No page loaded - determining where to navigate...",
        });

        screenAnalysis.pageState = `Cannot capture page (${currentUrl}). Navigate to a regular website to continue.`;
      }

      // Step 2: Get next action from reasoning model
      broadcastStatus({
        status: "analyzing",
        iteration,
        message: `Determining next action...`,
      });

      // Build messages for this turn (goal is only in the first message)
      const newMessages: ChatMessage[] = [];
      newMessages.push(ChatClient.message(`Current URL: ${screenAnalysis.url}`, "user"));
      if (screenAnalysis.pageState) {
        newMessages.push(ChatClient.message(`Current page:\n${screenAnalysis.pageState}`, "user"));
      }
      if (visionAnswer) {
        newMessages.push(ChatClient.message(`Answer to your previous question:\n${visionAnswer}`, "user"));
      }

      console.log("[Agent] Sending to reasoning model:", {
        url: screenAnalysis.url,
        pageState: screenAnalysis.pageState?.substring(0, 200),
        conversationTurns: Math.floor(conversationMessages.length / 2),
      });

      const { decision, assistantMessage } = await client.getNextAction([...conversationMessages, ...newMessages]);
      conversationMessages.push(...newMessages, ChatClient.message(assistantMessage, "assistant"));
      visionAnswer = undefined; // Clear after use

      // Save question and vision focus hint for next iteration
      pendingQuestion = decision.question || undefined;
      pendingVisionFocus = decision.visionFocus;

      // Get all actions (1-3) from decision
      const actions = decision.actions || [decision.action];

      // Step 3: Execute all actions in sequence
      // Only get viewport if we have a screenshot (not on chrome:// pages)
      let viewport: { width: number; height: number } | null = null;
      if (screenshot) {
        try {
          viewport = await getViewportDimensions(tabId);
        } catch (e) {
          console.warn("[Agent] Failed to get viewport:", e);
        }
      }

      // Clear boxes before executing actions
      await sendToContentScript(tabId, { type: "CLEAR_BOXES" }).catch((e) => {
        console.warn("[Agent] Failed to clear boxes:", e);
      });

      actionLoop: for (let i = 0; i < actions.length; i++) {
        if (!isRunning) break;

        const action = actions[i];
        let actionToExecute: BrowserAction = action;

        switch (action.action) {
          case "done":
            broadcastStatus({
              status: "completed",
              iteration,
              message: (action as { result: string }).result,
              reasoning: decision.reasoning,
            });
            isRunning = false;
            break actionLoop;

          case "ask_user":
            broadcastStatus({
              status: "waiting_for_user",
              iteration,
              message: action.prompt,
            });
            isRunning = false;
            break actionLoop;

          case "click": {
            const clickAction = action as ClickAction;
            if (!clickAction.target) {
              throw new Error("Click action missing target");
            }

            if (!screenshot || !viewport) {
              throw new Error(
                `Cannot click: screenshot=${!!screenshot}, viewport=${!!viewport}. Navigate to a website first.`,
              );
            }

            broadcastStatus({
              status: "analyzing",
              iteration,
              message: `Finding element: ${clickAction.target}`,
            });

            const coords = await client.findElement(screenshot, clickAction.target, viewport.width, viewport.height);
            console.log(`[Agent] Click coords: (${coords.x}, ${coords.y})`);

            broadcastStatus({
              status: "pointing",
              iteration,
              message: clickAction.target,
              screenshot,
              pointX: (coords.x / viewport.width) * 100,
              pointY: (coords.y / viewport.height) * 100,
            });

            actionToExecute = { ...clickAction, x: coords.x, y: coords.y };

            sendToContentScript(tabId, { type: "FLASH_CLICK", x: coords.x, y: coords.y }).catch((e) => {
              console.warn("[Agent] Failed to flash click:", e);
            });
            break;
          }
        }

        broadcastStatus({
          status: "executing",
          iteration,
          message: `Executing: ${getActionDescription(action)}`,
          action: actionToExecute,
          reasoning: i === 0 ? decision.reasoning : undefined,
          confidence: decision.confidence,
        });

        if (actionToExecute.action === "navigate") {
          const url = actionToExecute.url;
          // Block dangerous URLs
          if (url.startsWith("javascript:") || url.startsWith("data:")) {
            console.log("[Agent] Blocked navigation to unsafe URL:", url);
          } else {
            await chrome.tabs.update(tabId, { url });
            await new Promise((resolve) => setTimeout(resolve, NAVIGATION_DELAY_MS));
          }
        } else {
          await executeAction(tabId, actionToExecute);
        }

        actionHistory.push({
          action,
          reasoning: decision.reasoning,
          timestamp: Date.now(),
          success: true,
        });

        // Brief pause between actions in sequence
        if (i < actions.length - 1) {
          await new Promise((resolve) => setTimeout(resolve, ACTION_DELAY_MS));
        }
      }

      // Pause before next iteration (screenshot + analysis)
      retryCount = 0;
      await new Promise((resolve) => setTimeout(resolve, ITERATION_DELAY_MS));
    } catch (error) {
      retryCount++;
      const errorMessage = error instanceof Error ? error.message : "Unknown error";
      const isRetriable = error instanceof ApiError && error.isRetriable;

      if (!isRetriable || retryCount >= MAX_RETRIES) {
        broadcastStatus({
          status: "error",
          iteration,
          message: errorMessage,
        });
        break;
      }

      console.warn(`[Agent] Retrying (${retryCount}/${MAX_RETRIES}): ${errorMessage}`);

      if (actionHistory.length > 0) {
        actionHistory[actionHistory.length - 1].success = false;
      }

      await new Promise((resolve) => setTimeout(resolve, RETRY_DELAY_MS));
    }
  }

  if (iteration >= MAX_ITERATIONS) {
    broadcastStatus({
      status: "stopped",
      iteration,
      message:
        "This is taking longer than expected. Let me know if you'd like me to keep going or try a different approach.",
    });
  }

  isRunning = false;
  currentGoal = null;
}

// Message handler
chrome.runtime.onMessage.addListener((message: ExtensionMessage, _sender, sendResponse) => {
  switch (message.type) {
    case "RUN":
      chrome.tabs.query({ active: true, currentWindow: true }, async (tabs) => {
        const tab = tabs[0];
        if (tab?.id) {
          try {
            await runAutomation(tab.id, message.goal);
            sendResponse({ success: true });
          } catch (error) {
            const msg = error instanceof Error ? error.message : "Unknown error";
            sendResponse({ success: false, error: msg });
          }
        } else {
          sendResponse({ success: false, error: "No active tab found" });
        }
      });
      return true;

    case "STOP":
      isRunning = false;
      broadcastStatus({
        status: "stopped",
        iteration: actionHistory.length,
        message: "Stopped by user",
      });
      sendResponse({ success: true });
      break;

    case "GET_STATUS":
      sendResponse({
        isRunning,
        currentGoal,
        actionCount: actionHistory.length,
      });
      break;

    case "CHECK_API_KEY":
      sendResponse({ hasKey: ModelClient.hasApiKeys() });
      return true;
  }

  return false;
});
