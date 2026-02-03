import { ModelClient } from "./api/model-client.js";
import { ChatClient, type ChatMessage } from "./api/chat-client.js";
import { REASONING_SYSTEM_PROMPT } from "./api/constants.js";
import { AUTOMATION_TOOLS, type ToolName } from "./api/tools.js";
import { ApiError } from "./api/errors.js";
import { getChatHistory, addToChatHistory, clearChatHistory } from "./chat-history.js";
import { executeToolCall, type ToolState } from "./tool-executor.js";
import type { ActionHistoryEntry, StatusUpdate, ExtensionMessage } from "./types.js";

const MAX_ITERATIONS = 100;
const MAX_RETRIES = 3;
const ITERATION_DELAY_MS = 500;
const RETRY_DELAY_MS = 1000;

// Client is initialized with API keys from .env at build time
const client = new ModelClient();

// Per-tab automation state (keyed by origin tab)
interface TabState {
  isRunning: boolean;
  goal: string | null;
  actionHistory: ActionHistoryEntry[];
  conversationMessages: ChatMessage[];
  originTabId: number | null; // For chat history
  tabId: number; // Current tab (changes if site opens popup)
}

const tabStates = new Map<number, TabState>();

function getTabState(tabId: number): TabState {
  if (!tabStates.has(tabId)) {
    tabStates.set(tabId, {
      isRunning: false,
      goal: null,
      actionHistory: [],
      conversationMessages: [],
      originTabId: null, // Set when opened by another tab
      tabId: tabId,
    });
  }
  return tabStates.get(tabId)!;
}

// Switch automation to new tab when site opens a popup
chrome.tabs.onCreated.addListener((tab) => {
  if (!tab.openerTabId || !tab.id) return;

  const state = tabStates.get(tab.openerTabId);
  if (state?.isRunning) {
    console.log(`[Agent] Switching to new tab ${tab.id}`);
    state.originTabId = tab.openerTabId;
    state.tabId = tab.id;
    tabStates.delete(tab.openerTabId);
    tabStates.set(tab.id, state);
  }
});

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

// Broadcast status update to content script overlay
function broadcastStatus(state: TabState, update: Omit<StatusUpdate, "type">): void {
  const message = {
    type: "STATUS_UPDATE",
    ...update,
  } as StatusUpdate;

  const type = CHAT_HISTORY_MAP[update.status];
  if (type && update.message) {
    addToChatHistory(state.originTabId ?? state.tabId, { type, content: update.message });
  }

  chrome.tabs.sendMessage(state.tabId, message).catch((e) => {
    console.warn("[Agent] Failed to send status to content script:", e);
  });
}

// Main automation loop with tool-based orchestration
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

  // Initialize conversation with system prompt and goal
  const messages: ChatMessage[] = [
    ChatClient.message(REASONING_SYSTEM_PROMPT, "system"),
    ChatClient.message(`Goal: ${goal}`, "user"),
  ];

  // Tool execution state (screenshot caching)
  const toolState: ToolState = {
    currentScreenshot: null,
    viewport: null,
    lastAnalysis: null,
    lastFoundElement: null,
  };

  let iteration = 0;
  let retryCount = 0;

  while (state.isRunning && iteration < MAX_ITERATIONS) {
    iteration++;
    console.log(`[Agent] Starting iteration ${iteration}`);

    try {
      // Add current URL context (state.tabId may have changed if site opened popup)
      const tab = await chrome.tabs.get(state.tabId);
      const urlMessage = ChatClient.message(`Current URL: ${tab.url}`, "user");

      broadcastStatus(state, {
        status: "reasoning",
        iteration,
        message: "Deciding next action...",
      });

      // Call reasoning model with tools
      const response = await client.chatWithTools([...messages, urlMessage], AUTOMATION_TOOLS);

      const assistantMessage = response.choices[0].message;
      messages.push(urlMessage);
      messages.push(assistantMessage as ChatMessage);

      console.log("[Agent] Response:", {
        hasContent: !!assistantMessage.content,
        toolCalls: assistantMessage.tool_calls?.length || 0,
        finishReason: response.choices[0].finish_reason,
      });

      // Check if model wants to use tools
      if (!assistantMessage.tool_calls || assistantMessage.tool_calls.length === 0) {
        // Model responded with text only - might be done or need clarification
        if (assistantMessage.content) {
          broadcastStatus(state, {
            status: "completed",
            iteration,
            message: assistantMessage.content,
          });
        }
        break;
      }

      // Process each tool call
      for (const toolCall of assistantMessage.tool_calls) {
        if (!state.isRunning) break;

        const { name, arguments: argsJson } = toolCall.function;
        const args = JSON.parse(argsJson);

        console.log(`[Agent] Tool call: ${name}`, args);

        let result: string;

        try {
          result = await executeToolCall(state.tabId, client, name as ToolName, args, toolState, (status) => {
            broadcastStatus(state, { ...status, iteration });
          });
        } catch (error) {
          result = `Error: ${error instanceof Error ? error.message : "Unknown error"}`;
        }

        console.log(`[Agent] Tool result: ${result.substring(0, 200)}`);

        // Add tool result to conversation
        messages.push({
          role: "tool",
          tool_call_id: toolCall.id,
          content: result,
        });

        // Check for terminal states
        if (name === "complete") {
          broadcastStatus(state, {
            status: "completed",
            iteration,
            message: args.result as string,
          });
          state.isRunning = false;
          break;
        }

        if (name === "ask_user") {
          broadcastStatus(state, {
            status: "waiting_for_user",
            iteration,
            message: args.prompt as string,
          });
          state.isRunning = false;
          break;
        }

        // Track action history for non-vision tools
        if (name === "execute_action") {
          state.actionHistory.push({
            action: { action: args.action as string, ...args },
            timestamp: Date.now(),
            success: !result.startsWith("Error"),
          });
        }
      }

      retryCount = 0;
      await new Promise((resolve) => setTimeout(resolve, ITERATION_DELAY_MS));
    } catch (error) {
      retryCount++;
      const errorMessage = error instanceof Error ? error.message : "Unknown error";
      const isRetriable = error instanceof ApiError && error.isRetriable;

      if (!isRetriable || retryCount >= MAX_RETRIES) {
        broadcastStatus(state, {
          status: "error",
          iteration,
          message: errorMessage,
        });
        break;
      }

      console.warn(`[Agent] Retrying (${retryCount}/${MAX_RETRIES}): ${errorMessage}`);
      await new Promise((resolve) => setTimeout(resolve, RETRY_DELAY_MS));
    }
  }

  if (iteration >= MAX_ITERATIONS) {
    broadcastStatus(state, {
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
        broadcastStatus(state, {
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
