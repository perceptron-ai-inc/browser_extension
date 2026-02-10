/**
 * Tool execution handler for reasoning model tool calls
 */

import { ModelClient, type BoundingBox } from "./api/model-client.js";
import type { ToolName } from "./api/tools.js";
import { isInternalUrl } from "./url-utils.js";
import { executeAction, waitForPageReady, captureScreenshot, getAccessibilityTree } from "./cdp.js";
import { getViewportDimensions, sendToContentScript } from "./tab-utils.js";

const NAVIGATION_DELAY_MS = 2000;

export interface ToolState {
  currentScreenshot: string | null;
  viewport: { width: number; height: number } | null;
  lastAnalysis: string | null;
  lastFoundElement: string | null;
}

export interface ToolStatus {
  status:
    | "analyzing"
    | "reasoning"
    | "executing"
    | "completed"
    | "error"
    | "stopped"
    | "waiting_for_user"
    | "vision"
    | "pointing";
  message: string;
  screenshot?: string;
  pageDescription?: string;
  boxes?: BoundingBox[];
  pointX?: number;
  pointY?: number;
}

type StatusCallback = (status: ToolStatus) => void;

export async function executeToolCall(
  tabId: number,
  client: ModelClient,
  toolName: ToolName,
  args: Record<string, unknown>,
  toolState: ToolState,
  onStatus: StatusCallback,
): Promise<string> {
  switch (toolName) {
    case "capture_screenshot": {
      onStatus({ status: "analyzing", message: "Capturing screenshot..." });

      const tab = await chrome.tabs.get(tabId);
      if (isInternalUrl(tab.url!)) {
        return "Cannot capture screenshot on this page. Use execute_action with navigate to go to a website first.";
      }

      try {
        await waitForPageReady(tabId);
      } catch (e) {
        console.warn("[ToolExecutor] waitForPageReady failed:", e);
      }

      try {
        toolState.currentScreenshot = await captureScreenshot(tabId);
        toolState.viewport = await getViewportDimensions(tabId);
        return `Screenshot captured. Viewport: ${toolState.viewport.width}x${toolState.viewport.height}`;
      } catch (e) {
        return `Failed to capture screenshot: ${e instanceof Error ? e.message : "Unknown error"}`;
      }
    }

    case "analyze_page": {
      if (!toolState.currentScreenshot) {
        return "Error: No screenshot available. Call capture_screenshot first.";
      }

      const prompt = args.prompt as string;
      onStatus({ status: "analyzing", message: prompt });

      // Clear existing boxes
      await sendToContentScript(tabId, { type: "CLEAR_BOXES" }).catch(() => {});

      try {
        const allBoxes: BoundingBox[] = [];
        const { pageState, boxes } = await client.analyzeScreenshot(toolState.currentScreenshot, prompt, (newBoxes) => {
          allBoxes.push(...newBoxes);
          if (newBoxes.length > 0) {
            sendToContentScript(tabId, { type: "ADD_BOXES", boxes: newBoxes }).catch(() => {});
          }
        });

        toolState.lastAnalysis = pageState;

        onStatus({
          status: "vision",
          message: "Page analyzed",
          screenshot: toolState.currentScreenshot,
          pageDescription: pageState,
          boxes,
        });

        return pageState;
      } catch (e) {
        return `Failed to analyze page: ${e instanceof Error ? e.message : "Unknown error"}`;
      }
    }

    case "get_a11y_tree": {
      onStatus({ status: "analyzing", message: "Getting accessibility tree..." });

      const tab = await chrome.tabs.get(tabId);
      if (isInternalUrl(tab.url!)) {
        return "Cannot get accessibility tree on this page. Use execute_action with navigate to go to a website first.";
      }

      try {
        const tree = await getAccessibilityTree(tabId);
        return tree;
      } catch (e) {
        return `Failed to get accessibility tree: ${e instanceof Error ? e.message : "Unknown error"}`;
      }
    }

    case "find_element": {
      if (!toolState.currentScreenshot || !toolState.viewport) {
        return "Error: No screenshot available. Call capture_screenshot first.";
      }

      const query = args.query as string;
      onStatus({ status: "analyzing", message: `Finding: ${query}` });

      try {
        const coords = await client.findElement(
          toolState.currentScreenshot,
          query,
          toolState.viewport.width,
          toolState.viewport.height,
        );

        onStatus({
          status: "pointing",
          message: query,
          screenshot: toolState.currentScreenshot,
          pointX: (coords.x / toolState.viewport.width) * 100,
          pointY: (coords.y / toolState.viewport.height) * 100,
        });

        // Store for use in subsequent click
        toolState.lastFoundElement = query;

        return `Element found at coordinates: x=${coords.x}, y=${coords.y}`;
      } catch (e) {
        return `Failed to find element: ${e instanceof Error ? e.message : "Unknown error"}`;
      }
    }

    case "execute_action": {
      const action = args.action as string;

      // Clear boxes before executing
      await sendToContentScript(tabId, { type: "CLEAR_BOXES" }).catch(() => {});

      switch (action) {
        case "click": {
          const x = args.x as number | undefined;
          const y = args.y as number | undefined;
          if (x === undefined || y === undefined) {
            return "Error: click requires x and y coordinates. Use find_element first to get coordinates.";
          }

          const clickTarget = toolState.lastFoundElement || `(${x}, ${y})`;

          onStatus({ status: "executing", message: `Clicking on ${clickTarget}` });
          sendToContentScript(tabId, { type: "FLASH_CLICK", x, y }).catch(() => {});

          try {
            await executeAction(tabId, { action: "click", x, y });
            // Invalidate screenshot and element after click (page may have changed)
            toolState.currentScreenshot = null;
            toolState.viewport = null;
            toolState.lastFoundElement = null;
            return `Clicked on ${clickTarget}`;
          } catch (e) {
            return `Failed to click: ${e instanceof Error ? e.message : "Unknown error"}`;
          }
        }

        case "type": {
          const text = args.text as string | undefined;
          if (!text) {
            return "Error: type requires text parameter";
          }

          onStatus({ status: "executing", message: `Typing: "${text}"` });

          try {
            await executeAction(tabId, { action: "type", text });
            return `Typed: "${text}"`;
          } catch (e) {
            return `Failed to type: ${e instanceof Error ? e.message : "Unknown error"}`;
          }
        }

        case "press": {
          const key = args.key as string | undefined;
          if (!key) {
            return "Error: press requires key parameter (Enter, Escape, ArrowDown, ArrowUp)";
          }

          onStatus({ status: "executing", message: `Pressing: ${key}` });

          try {
            await executeAction(tabId, { action: "press", key });
            // Invalidate screenshot after Enter (may submit form)
            if (key === "Enter") {
              toolState.currentScreenshot = null;
              toolState.viewport = null;
            }
            return `Pressed: ${key}`;
          } catch (e) {
            return `Failed to press key: ${e instanceof Error ? e.message : "Unknown error"}`;
          }
        }

        case "scroll": {
          const direction = args.direction as string | undefined;
          if (!direction) {
            return "Error: scroll requires direction parameter (up, down, left, right)";
          }

          onStatus({ status: "executing", message: `Scrolling ${direction}` });

          try {
            await executeAction(tabId, {
              action: "scroll",
              direction: direction as "up" | "down" | "left" | "right",
            });
            // Invalidate screenshot after scroll
            toolState.currentScreenshot = null;
            toolState.viewport = null;
            return `Scrolled ${direction}`;
          } catch (e) {
            return `Failed to scroll: ${e instanceof Error ? e.message : "Unknown error"}`;
          }
        }

        case "wait": {
          const duration = (args.duration as number) || 1000;
          onStatus({ status: "executing", message: `Waiting ${duration}ms` });
          await new Promise((resolve) => setTimeout(resolve, duration));
          return `Waited ${duration}ms`;
        }

        case "navigate": {
          const url = args.url as string | undefined;
          if (!url) {
            return "Error: navigate requires url parameter";
          }

          if (url.startsWith("javascript:") || url.startsWith("data:")) {
            return "Error: Cannot navigate to unsafe URL";
          }

          onStatus({ status: "executing", message: `Navigating to ${url}` });

          try {
            await chrome.tabs.update(tabId, { url });
            await new Promise((resolve) => setTimeout(resolve, NAVIGATION_DELAY_MS));
            // Invalidate screenshot after navigation
            toolState.currentScreenshot = null;
            toolState.viewport = null;
            toolState.lastAnalysis = null;
            return `Navigated to ${url}`;
          } catch (e) {
            return `Failed to navigate: ${e instanceof Error ? e.message : "Unknown error"}`;
          }
        }

        default:
          return `Error: Unknown action "${action}". Valid actions: click, type, press, scroll, wait, navigate`;
      }
    }

    case "ask_user":
      // Handled in main loop - just return confirmation
      return "Waiting for user response...";

    case "complete":
      // Handled in main loop - just return confirmation
      return "Task marked as complete.";

    default:
      return `Error: Unknown tool "${toolName}"`;
  }
}
