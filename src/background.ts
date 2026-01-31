import { ModelClient } from "./api/model-client.js";
import { ChatClient, type ChatMessage } from "./api/chat-client.js";
import { REASONING_SYSTEM_PROMPT } from "./api/constants.js";
import { isInternalUrl } from "./url-utils.js";
import { ApiError } from "./api/errors.js";
import { executeAction, waitForPageReady, captureScreenshot } from "./cdp.js";
import { getViewportDimensions, sendToContentScript } from "./tab-utils.js";
import { getChatHistory, addToChatHistory, clearChatHistory } from "./chat-history.js";
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

// Per-tab automation state
interface TabState {
  isRunning: boolean;
  goal: string | null;
  actionHistory: ActionHistoryEntry[];
  conversationMessages: ChatMessage[];
}

const tabStates = new Map<number, TabState>();

function getTabState(tabId: number): TabState {
  if (!tabStates.has(tabId)) {
    tabStates.set(tabId, {
      isRunning: false,
      goal: null,
      actionHistory: [],
      conversationMessages: [],
    });
  }
  return tabStates.get(tabId)!;
}

// Clean up when tab is closed
chrome.tabs.onRemoved.addListener((tabId) => {
  tabStates.delete(tabId);
  clearChatHistory(tabId);
});

const CHAT_HISTORY_MAP: Record<string, "action" | "assistant"> = {
  executing: "action",
  completed: "assistant",
  error: "assistant",
  stopped: "assistant",
  waiting_for_user: "assistant",
};

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

// Broadcast status update to content script overlay
function broadcastStatus(tabId: number, update: Omit<StatusUpdate, "type">): void {
  const message = {
    type: "STATUS_UPDATE",
    ...update,
  } as StatusUpdate;

  // Add to chat history based on status
  const type = CHAT_HISTORY_MAP[update.status];
  if (type && update.message) {
    addToChatHistory(tabId, { type, content: update.message });
  }

  // Send to content script in the tab
  chrome.tabs.sendMessage(tabId, message).catch((e) => {
    console.warn("[Agent] Failed to send status to content script:", e);
  });
}

// Main automation loop
async function runAutomation(tabId: number, goal: string): Promise<void> {
  if (!ModelClient.hasApiKeys()) {
    throw new Error(
      "API keys not configured. Please set PERCEPTRON_API_KEY and REASONING_API_KEY in .env and rebuild.",
    );
  }

  const state = getTabState(tabId);
  state.isRunning = true;
  state.goal = goal;
  state.actionHistory = [];
  state.conversationMessages = [
    ChatClient.message(REASONING_SYSTEM_PROMPT, "system"),
    ChatClient.message(`Goal: ${goal}`, "system"),
  ];

  let iteration = 0;
  let retryCount = 0;
  let pendingQuestion: string | undefined;
  let pendingVisionFocus: string | undefined;
  let visionAnswer: string | undefined;

  while (state.isRunning && iteration < MAX_ITERATIONS) {
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
          screenshot = await captureScreenshot(tabId);
        } catch (e) {
          console.log("[Agent] Screenshot capture failed:", e);
        }
      } else {
        console.log("[Agent] Skipping screenshot for internal URL:", currentUrl);
      }

      // Step 1b: Analyze with vision model (only if we have a screenshot)
      if (screenshot) {
        broadcastStatus(tabId, {
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

          broadcastStatus(tabId, {
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
        broadcastStatus(tabId, {
          status: "reasoning",
          iteration,
          message: "No page loaded - determining where to navigate...",
        });

        screenAnalysis.pageState = `Cannot capture page (${currentUrl}). Navigate to a regular website to continue.`;
      }

      // Step 2: Get next action from reasoning model
      broadcastStatus(tabId, {
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
        conversationTurns: Math.floor(state.conversationMessages.length / 2),
      });

      const { decision, assistantMessage } = await client.getNextAction([
        ...state.conversationMessages,
        ...newMessages,
      ]);
      state.conversationMessages.push(...newMessages, ChatClient.message(assistantMessage, "assistant"));
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
        if (!state.isRunning) break;

        const action = actions[i];
        let actionToExecute: BrowserAction = action;

        switch (action.action) {
          case "done":
            broadcastStatus(tabId, {
              status: "completed",
              iteration,
              message: (action as { result: string }).result,
              reasoning: decision.reasoning,
            });
            state.isRunning = false;
            break actionLoop;

          case "ask_user":
            broadcastStatus(tabId, {
              status: "waiting_for_user",
              iteration,
              message: action.prompt,
            });
            state.isRunning = false;
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

            broadcastStatus(tabId, {
              status: "analyzing",
              iteration,
              message: `Finding element: ${clickAction.target}`,
            });

            const coords = await client.findElement(screenshot, clickAction.target, viewport.width, viewport.height);
            console.log(`[Agent] Click coords: (${coords.x}, ${coords.y})`);

            broadcastStatus(tabId, {
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

        broadcastStatus(tabId, {
          status: "executing",
          iteration,
          message: getActionDescription(action),
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

        state.actionHistory.push({
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
        broadcastStatus(tabId, {
          status: "error",
          iteration,
          message: errorMessage,
        });
        break;
      }

      console.warn(`[Agent] Retrying (${retryCount}/${MAX_RETRIES}): ${errorMessage}`);

      if (state.actionHistory.length > 0) {
        state.actionHistory[state.actionHistory.length - 1].success = false;
      }

      await new Promise((resolve) => setTimeout(resolve, RETRY_DELAY_MS));
    }
  }

  if (iteration >= MAX_ITERATIONS) {
    broadcastStatus(tabId, {
      status: "stopped",
      iteration,
      message:
        "This is taking longer than expected. Let me know if you'd like me to keep going or try a different approach.",
    });
  }

  state.isRunning = false;
  state.goal = null;
}

// Message handler
chrome.runtime.onMessage.addListener((message: ExtensionMessage, sender, sendResponse) => {
  const tabId = sender.tab?.id;

  switch (message.type) {
    case "RUN":
      if (!tabId) {
        sendResponse({ success: false, error: "No tab ID found" });
        return true;
      }
      addToChatHistory(tabId, { type: "user", content: message.goal });
      runAutomation(tabId, message.goal)
        .then(() => sendResponse({ success: true }))
        .catch((error) => {
          const msg = error instanceof Error ? error.message : "Unknown error";
          sendResponse({ success: false, error: msg });
        });
      return true;

    case "STOP":
      if (tabId) {
        const state = getTabState(tabId);
        state.isRunning = false;
        broadcastStatus(tabId, {
          status: "stopped",
          iteration: state.actionHistory.length,
          message: "Stopped by user",
        });
      }
      sendResponse({ success: true });
      break;

    case "GET_STATUS":
      if (tabId) {
        const state = getTabState(tabId);
        sendResponse({
          isRunning: state.isRunning,
          currentGoal: state.goal,
          actionCount: state.actionHistory.length,
        });
      } else {
        sendResponse({ isRunning: false, currentGoal: null, actionCount: 0 });
      }
      break;

    case "GET_CHAT_HISTORY":
      if (tabId) {
        const state = getTabState(tabId);
        getChatHistory(tabId).then((chatHistory) => {
          sendResponse({ chatHistory, isRunning: state.isRunning, currentGoal: state.goal });
        });
      } else {
        sendResponse({ chatHistory: [], isRunning: false, currentGoal: null });
      }
      return true; // async response

    case "CHECK_API_KEY":
      sendResponse({ hasKey: ModelClient.hasApiKeys() });
      return true;
  }

  return false;
});
