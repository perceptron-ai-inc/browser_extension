import { ModelClient } from "./api/model-client.js";
import { ChatClient, type ChatMessage } from "./api/chat-client.js";
import { REASONING_SYSTEM_PROMPT } from "./api/constants.js";
import { isInternalUrl } from "./url-utils.js";
import { ApiError } from "./api/errors.js";
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

// Capture screenshot of current tab
async function captureScreenshot(): Promise<string> {
  const dataUrl = await chrome.tabs.captureVisibleTab({
    format: "jpeg",
    quality: 85,
  });
  return dataUrl.replace(/^data:image\/jpeg;base64,/, "");
}

// Ensure content script is injected
async function ensureContentScript(tabId: number): Promise<void> {
  try {
    await chrome.tabs.sendMessage(tabId, { type: "PING" });
  } catch {
    // Content script not loaded, inject it
    await chrome.scripting.executeScript({
      target: { tabId },
      files: ["content.js"],
    });
  }
}

async function getViewportDimensions(tabId: number): Promise<{ width: number; height: number }> {
  await ensureContentScript(tabId);
  return chrome.tabs.sendMessage(tabId, { type: "GET_VIEWPORT" });
}

// Debugger management
const attachedTabs = new Set<number>();

async function ensureDebugger(tabId: number): Promise<void> {
  if (!attachedTabs.has(tabId)) {
    try {
      await chrome.debugger.attach({ tabId }, "1.3");
      attachedTabs.add(tabId);
    } catch {
      // Can't attach to chrome:// or other restricted pages
      throw new Error("Cannot interact with this page. Please navigate to a website first.");
    }
  }
}

// Click using CDP - matches Playwright's page.mouse.click()
async function cdpClick(tabId: number, x: number, y: number): Promise<void> {
  await ensureDebugger(tabId);

  await chrome.debugger.sendCommand({ tabId }, "Input.dispatchMouseEvent", {
    type: "mousePressed",
    x,
    y,
    button: "left",
    clickCount: 1,
  });

  await chrome.debugger.sendCommand({ tabId }, "Input.dispatchMouseEvent", {
    type: "mouseReleased",
    x,
    y,
    button: "left",
    clickCount: 1,
  });
}

// Type using CDP - matches Playwright's page.keyboard.type() with 50ms delay
async function cdpType(tabId: number, text: string): Promise<void> {
  await ensureDebugger(tabId);

  for (const char of text) {
    await chrome.debugger.sendCommand({ tabId }, "Input.dispatchKeyEvent", {
      type: "char",
      text: char,
    });
    // 50ms delay between keystrokes like desktop_use
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}

// Key definitions matching Playwright's usKeyboardLayout
const KEY_DEFINITIONS: Record<string, { keyCode: number; code: string; text?: string }> = {
  Enter: { keyCode: 13, code: "Enter", text: "\r" },
  Tab: { keyCode: 9, code: "Tab" },
  Escape: { keyCode: 27, code: "Escape" },
  Backspace: { keyCode: 8, code: "Backspace" },
  Delete: { keyCode: 46, code: "Delete" },
  ArrowUp: { keyCode: 38, code: "ArrowUp" },
  ArrowDown: { keyCode: 40, code: "ArrowDown" },
  ArrowLeft: { keyCode: 37, code: "ArrowLeft" },
  ArrowRight: { keyCode: 39, code: "ArrowRight" },
  Home: { keyCode: 36, code: "Home" },
  End: { keyCode: 35, code: "End" },
  PageUp: { keyCode: 33, code: "PageUp" },
  PageDown: { keyCode: 34, code: "PageDown" },
  Space: { keyCode: 32, code: "Space", text: " " },
  Control: { keyCode: 17, code: "ControlLeft" },
  Shift: { keyCode: 16, code: "ShiftLeft" },
  Alt: { keyCode: 18, code: "AltLeft" },
  Meta: { keyCode: 91, code: "MetaLeft" },
};

// Modifier key to bit flag mapping
const MODIFIER_FLAGS: Record<string, number> = {
  Alt: 1,
  Control: 2,
  Meta: 4,
  Shift: 8,
};

// Press a key or key combination - matches Playwright's page.keyboard.press()
async function cdpPress(tabId: number, key: string): Promise<void> {
  await ensureDebugger(tabId);

  // Handle ControlOrMeta - resolve to Meta on Mac, Control elsewhere
  const isMac = navigator.platform?.toLowerCase().includes("mac");
  const resolvedKey = key.replace(/ControlOrMeta/g, isMac ? "Meta" : "Control");

  // Handle key combinations like "Control+a"
  const parts = resolvedKey.split("+");
  const modifiers = parts.slice(0, -1);
  const mainKey = parts[parts.length - 1];

  // Calculate modifier flags
  let modifierFlags = 0;
  for (const mod of modifiers) {
    modifierFlags |= MODIFIER_FLAGS[mod] || 0;
  }

  // Get key definition
  const keyDef = KEY_DEFINITIONS[mainKey] || {
    keyCode: mainKey.toUpperCase().charCodeAt(0),
    code: `Key${mainKey.toUpperCase()}`,
    text: mainKey.length === 1 ? mainKey : undefined,
  };

  // Press modifiers down
  for (const mod of modifiers) {
    const modDef = KEY_DEFINITIONS[mod];
    if (modDef) {
      await chrome.debugger.sendCommand({ tabId }, "Input.dispatchKeyEvent", {
        type: "keyDown",
        key: mod,
        code: modDef.code,
        windowsVirtualKeyCode: modDef.keyCode,
        nativeVirtualKeyCode: modDef.keyCode,
        modifiers: modifierFlags,
      });
    }
  }

  // Press the main key
  await chrome.debugger.sendCommand({ tabId }, "Input.dispatchKeyEvent", {
    type: "keyDown",
    key: mainKey,
    code: keyDef.code,
    windowsVirtualKeyCode: keyDef.keyCode,
    nativeVirtualKeyCode: keyDef.keyCode,
    text: keyDef.text,
    modifiers: modifierFlags,
  });

  await chrome.debugger.sendCommand({ tabId }, "Input.dispatchKeyEvent", {
    type: "keyUp",
    key: mainKey,
    code: keyDef.code,
    windowsVirtualKeyCode: keyDef.keyCode,
    nativeVirtualKeyCode: keyDef.keyCode,
    modifiers: modifierFlags,
  });

  // Release modifiers in reverse order
  for (let i = modifiers.length - 1; i >= 0; i--) {
    const mod = modifiers[i];
    const modDef = KEY_DEFINITIONS[mod];
    if (modDef) {
      modifierFlags &= ~(MODIFIER_FLAGS[mod] || 0);
      await chrome.debugger.sendCommand({ tabId }, "Input.dispatchKeyEvent", {
        type: "keyUp",
        key: mod,
        code: modDef.code,
        windowsVirtualKeyCode: modDef.keyCode,
        nativeVirtualKeyCode: modDef.keyCode,
        modifiers: modifierFlags,
      });
    }
  }
}

// Scroll using CDP - matches Playwright's page.mouse.wheel()
// Uses delta of 500 like desktop_use
async function cdpScroll(tabId: number, direction: string): Promise<void> {
  await ensureDebugger(tabId);

  const delta = 500; // Same as desktop_use
  const deltaX = direction === "left" ? -delta : direction === "right" ? delta : 0;
  const deltaY = direction === "up" ? -delta : direction === "down" ? delta : 0;

  await chrome.debugger.sendCommand({ tabId }, "Input.dispatchMouseEvent", {
    type: "mouseWheel",
    x: 400,
    y: 300,
    deltaX,
    deltaY,
  });
}

// Clean up debugger on tab close
chrome.tabs.onRemoved.addListener((tabId) => {
  attachedTabs.delete(tabId);
});

// Wait for page to be ready (document.readyState === 'complete')
async function waitForPageReady(tabId: number, timeout = 5000): Promise<void> {
  try {
    await ensureDebugger(tabId);
  } catch {
    return; // Can't attach debugger, skip waiting
  }

  const startTime = Date.now();

  while (Date.now() - startTime < timeout) {
    try {
      const result = (await chrome.debugger.sendCommand({ tabId }, "Runtime.evaluate", {
        expression: "document.readyState",
      })) as { result: { value: string } };

      if (result?.result?.value === "complete") {
        await new Promise((resolve) => setTimeout(resolve, 200));
        return;
      }
    } catch {
      return; // Debugger error, stop waiting
    }

    await new Promise((resolve) => setTimeout(resolve, 100));
  }
}

// Execute action via CDP
async function executeAction(tabId: number, action: BrowserAction): Promise<void> {
  switch (action.action) {
    case "click":
      if (action.x !== undefined && action.y !== undefined) {
        await cdpClick(tabId, action.x, action.y);
      }
      break;
    case "type":
      await cdpType(tabId, action.text);
      break;
    case "press":
      await cdpPress(tabId, action.key);
      break;
    case "scroll":
      await cdpScroll(tabId, action.direction);
      break;
    case "wait":
      await new Promise((resolve) => setTimeout(resolve, action.duration));
      break;
  }
}

// Broadcast status update to popup
function broadcastStatus(update: Omit<StatusUpdate, "type">): void {
  chrome.runtime
    .sendMessage({
      type: "STATUS_UPDATE",
      ...update,
    } as StatusUpdate)
    .catch(() => {
      // Popup might be closed, ignore error
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

  const maxIterations = 50;
  const maxRetries = 3;
  let iteration = 0;
  let retryCount = 0;
  let pendingQuestion: string | undefined;
  let pendingVisionFocus: string | undefined;
  let visionAnswer: string | undefined;

  while (isRunning && iteration < maxIterations) {
    iteration++;
    console.log(`[Agent] Starting iteration ${iteration}`);

    try {
      // Step 1: Try to capture and analyze screenshot
      let screenshot: string | null = null;
      let screenAnalysis: ScreenAnalysis;

      // Get current tab URL
      const tab = await chrome.tabs.get(tabId);
      const currentUrl = tab.url || "";

      // Only capture and analyze screenshots on real pages
      if (!isInternalUrl(currentUrl)) {
        try {
          await waitForPageReady(tabId);
        } catch {
          // Ignore errors
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
        // First, answer any pending question from the reasoning model
        if (pendingQuestion) {
          broadcastStatus({
            status: "analyzing",
            iteration,
            message: `Answering: ${pendingQuestion}`,
          });

          try {
            visionAnswer = await client.askQuestion(screenshot, pendingQuestion);
            console.log(`[Agent] Vision answer: ${visionAnswer}`);
          } catch (error) {
            console.log("[Agent] Question answering failed:", error);
          }
          pendingQuestion = undefined;
        }

        broadcastStatus({
          status: "analyzing",
          iteration,
          message: "Analyzing current page...",
        });

        try {
          // Clear existing boxes before streaming new ones
          try {
            await ensureContentScript(tabId);
            await chrome.tabs.sendMessage(tabId, { type: "CLEAR_BOXES" });
          } catch {
            // Content script might not be loaded
          }

          const result = await client.analyzeScreenshot(screenshot, pendingVisionFocus, (newBoxes) => {
            // Draw new boxes on the live page as they stream in
            if (newBoxes.length > 0) {
              chrome.tabs.sendMessage(tabId, { type: "ADD_BOXES", boxes: newBoxes }).catch(() => {});
            }
          });

          screenAnalysis = {
            pageState: result.pageState,
            url: currentUrl,
          };

          pendingVisionFocus = undefined;

          broadcastStatus({
            status: "vision",
            iteration,
            message: "Page analyzed",
            screenshot,
            pageDescription: `URL: ${currentUrl}\n\n${result.pageState}`,
            boxes: result.boxes,
          });
        } catch (apiError) {
          // Vision API failed but we still have the screenshot
          console.log("[Agent] Vision API failed:", apiError);
          screenAnalysis = {
            pageState: `Page at ${currentUrl}. Vision analysis failed - proceeding with screenshot only.`,
            url: currentUrl,
          };
        }
      } else {
        // No screenshot - blank page or restricted URL
        broadcastStatus({
          status: "reasoning",
          iteration,
          message: "No page loaded - determining where to navigate...",
        });

        screenAnalysis = {
          pageState: currentUrl
            ? `Cannot capture page (${currentUrl}). Navigate to a regular website to continue.`
            : "Blank page or new tab. Navigate to a website first.",
          url: currentUrl,
        };
      }

      // Step 2: Get next action from reasoning model
      broadcastStatus({
        status: "analyzing",
        iteration,
        message: `Determining next action...`,
      });

      // Build messages for this turn (goal is only in the first message)
      const newMessages: ChatMessage[] = [];
      if (screenAnalysis.url) {
        newMessages.push(ChatClient.message(`Current URL: ${screenAnalysis.url}`, "user"));
      }
      newMessages.push(ChatClient.message(`Current page:\n${screenAnalysis.pageState}`, "user"));
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

      // Check if first action is done
      if (actions[0].action === "done") {
        broadcastStatus({
          status: "completed",
          iteration,
          message: (actions[0] as { result: string }).result,
          reasoning: decision.reasoning,
        });
        break;
      }

      // Step 3: Execute all actions in sequence
      // Only get viewport if we have a screenshot (not on chrome:// pages)
      let viewport: { width: number; height: number } | null = null;
      if (screenshot) {
        try {
          viewport = await getViewportDimensions(tabId);
        } catch {
          // Can't get viewport (restricted page), proceed without it
        }
      }

      // Clear boxes before executing actions
      try {
        await chrome.tabs.sendMessage(tabId, { type: "CLEAR_BOXES" });
      } catch {
        // Content script might not be loaded
      }

      for (let i = 0; i < actions.length; i++) {
        if (!isRunning) break;

        const action = actions[i];
        let actionToExecute = action;
        let actionDesc = action.action;

        // Handle done action mid-sequence
        if (action.action === "done") {
          broadcastStatus({
            status: "completed",
            iteration,
            message: (action as { result: string }).result,
            reasoning: decision.reasoning,
          });
          isRunning = false;
          break;
        }

        if (action.action === "click") {
          const clickAction = action as ClickAction;
          if (!clickAction.target) {
            throw new Error("Click action missing target");
          }
          actionDesc = `Click: ${clickAction.target}`;

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

          // Flash the click target on the page
          chrome.tabs.sendMessage(tabId, { type: "FLASH_CLICK", x: coords.x, y: coords.y }).catch(() => {});
        } else if (action.action === "type") {
          const typeAction = action as TypeAction;
          actionDesc = `Type: "${typeAction.text}"`;
        } else if (action.action === "press") {
          const pressAction = action as PressAction;
          actionDesc = `Press: ${pressAction.key}`;
        } else if (action.action === "scroll") {
          actionDesc = `Scroll ${action.direction}`;
        } else if (action.action === "navigate") {
          actionDesc = `Navigate to ${action.url}`;
        } else if (action.action === "ask_user") {
          // Pause and ask the user
          broadcastStatus({
            status: "waiting_for_user",
            iteration,
            message: action.prompt,
          });
          // Stop the loop - user will resume or provide input
          isRunning = false;
          break;
        }

        broadcastStatus({
          status: "executing",
          iteration,
          message: `Executing: ${actionDesc}`,
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
            await new Promise((resolve) => setTimeout(resolve, 2000));
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
          await new Promise((resolve) => setTimeout(resolve, 300));
        }
      }

      // Pause before next iteration (screenshot + analysis)
      retryCount = 0;
      await new Promise((resolve) => setTimeout(resolve, 500));
    } catch (error) {
      retryCount++;
      const errorMessage = error instanceof Error ? error.message : "Unknown error";
      const isRetriable = error instanceof ApiError && error.isRetriable;

      if (!isRetriable || retryCount >= maxRetries) {
        broadcastStatus({
          status: "error",
          iteration,
          message: errorMessage,
        });
        break;
      }

      console.warn(`[Agent] Retrying (${retryCount}/${maxRetries}): ${errorMessage}`);

      if (actionHistory.length > 0) {
        actionHistory[actionHistory.length - 1].success = false;
      }

      await new Promise((resolve) => setTimeout(resolve, 1000));
    }
  }

  if (iteration >= maxIterations) {
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
