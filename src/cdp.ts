/**
 * Chrome DevTools Protocol (CDP) utilities for browser automation
 */

import type { BrowserAction } from "./types.js";

// Track attached debugger sessions
const attachedTabs = new Set<number>();

// Clean up debugger on tab close
chrome.tabs.onRemoved.addListener((tabId) => {
  attachedTabs.delete(tabId);
});

async function ensureDebugger(tabId: number): Promise<void> {
  if (!attachedTabs.has(tabId)) {
    try {
      await chrome.debugger.attach({ tabId }, "1.3");
      attachedTabs.add(tabId);
    } catch {
      throw new Error("Cannot interact with this page. Please navigate to a website first.");
    }
  }
}

export async function click(tabId: number, x: number, y: number): Promise<void> {
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

export async function type(tabId: number, text: string): Promise<void> {
  await ensureDebugger(tabId);

  for (const char of text) {
    await chrome.debugger.sendCommand({ tabId }, "Input.dispatchKeyEvent", {
      type: "char",
      text: char,
    });
    // 50ms delay between keystrokes
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}

const KEY_DEFINITIONS: Record<string, { keyCode: number; code: string; text?: string }> = {
  Enter: { keyCode: 13, code: "Enter", text: "\r" },
  Escape: { keyCode: 27, code: "Escape" },
  ArrowUp: { keyCode: 38, code: "ArrowUp" },
  ArrowDown: { keyCode: 40, code: "ArrowDown" },
};

export async function press(tabId: number, key: string): Promise<void> {
  await ensureDebugger(tabId);

  const keyDef = KEY_DEFINITIONS[key];
  if (!keyDef) {
    throw new Error(`Unsupported key: ${key}`);
  }

  await chrome.debugger.sendCommand({ tabId }, "Input.dispatchKeyEvent", {
    type: "keyDown",
    key,
    code: keyDef.code,
    windowsVirtualKeyCode: keyDef.keyCode,
    nativeVirtualKeyCode: keyDef.keyCode,
    text: keyDef.text,
  });

  await chrome.debugger.sendCommand({ tabId }, "Input.dispatchKeyEvent", {
    type: "keyUp",
    key,
    code: keyDef.code,
    windowsVirtualKeyCode: keyDef.keyCode,
    nativeVirtualKeyCode: keyDef.keyCode,
  });
}

export async function scroll(tabId: number, direction: string): Promise<void> {
  await ensureDebugger(tabId);

  const delta = 500;
  let deltaX = 0;
  let deltaY = 0;

  switch (direction) {
    case "up":
      deltaY = -delta;
      break;
    case "down":
      deltaY = delta;
      break;
    case "left":
      deltaX = -delta;
      break;
    case "right":
      deltaX = delta;
      break;
  }

  // x, y are arbitrary - position doesn't matter for document-level scrolling
  await chrome.debugger.sendCommand({ tabId }, "Input.dispatchMouseEvent", {
    type: "mouseWheel",
    x: 400,
    y: 300,
    deltaX,
    deltaY,
  });
}

export async function waitForPageReady(tabId: number, timeout = 5000): Promise<void> {
  try {
    await ensureDebugger(tabId);
  } catch (e) {
    console.warn("[CDP] Failed to attach debugger for page ready check:", e);
    return;
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
    } catch (e) {
      console.warn("[CDP] Error checking page ready state:", e);
      return;
    }

    await new Promise((resolve) => setTimeout(resolve, 100));
  }
}

export async function captureScreenshot(tabId: number): Promise<string> {
  // Hide overlay before capturing
  await chrome.tabs.sendMessage(tabId, { type: "HIDE_OVERLAY" }).catch((e) => {
    console.warn("[Screenshot] Failed to hide overlay:", e);
  });

  // Small delay to ensure overlay is hidden
  await new Promise((resolve) => setTimeout(resolve, 50));

  await ensureDebugger(tabId);

  const result = (await chrome.debugger.sendCommand({ tabId }, "Page.captureScreenshot", {
    format: "jpeg",
    quality: 85,
  })) as { data: string };

  // Show overlay again
  await chrome.tabs.sendMessage(tabId, { type: "SHOW_OVERLAY" }).catch((e) => {
    console.warn("[Screenshot] Failed to show overlay:", e);
  });

  return result.data;
}

export async function executeAction(tabId: number, action: BrowserAction): Promise<void> {
  switch (action.action) {
    case "click":
      if (action.x !== undefined && action.y !== undefined) {
        await click(tabId, action.x, action.y);
      }
      break;
    case "type":
      await type(tabId, action.text);
      break;
    case "press":
      await press(tabId, action.key);
      break;
    case "scroll":
      await scroll(tabId, action.direction);
      break;
    case "wait":
      await new Promise((resolve) => setTimeout(resolve, action.duration));
      break;
  }
}
