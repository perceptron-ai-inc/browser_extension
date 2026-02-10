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

async function click(tabId: number, x: number, y: number): Promise<void> {
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

async function type(tabId: number, text: string): Promise<void> {
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
  Backspace: { keyCode: 8, code: "Backspace" },
  ArrowUp: { keyCode: 38, code: "ArrowUp" },
  ArrowDown: { keyCode: 40, code: "ArrowDown" },
};

async function press(tabId: number, key: string): Promise<void> {
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

async function scroll(tabId: number, direction: string): Promise<void> {
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
  return withHiddenOverlay(tabId, async () => {
    await ensureDebugger(tabId);

    const { data } = (await chrome.debugger.sendCommand({ tabId }, "Page.captureScreenshot", {
      format: "jpeg",
      quality: 85,
    })) as { data: string };

    return data;
  });
}

async function hideOverlay(tabId: number): Promise<void> {
  await chrome.tabs.sendMessage(tabId, { type: "HIDE_OVERLAY" }).catch(() => {});
  await new Promise((resolve) => setTimeout(resolve, 50));
}

async function showOverlay(tabId: number): Promise<void> {
  await chrome.tabs.sendMessage(tabId, { type: "SHOW_OVERLAY" }).catch(() => {});
}

async function withHiddenOverlay<T>(tabId: number, fn: () => Promise<T>): Promise<T> {
  await hideOverlay(tabId);
  try {
    return await fn();
  } finally {
    await showOverlay(tabId);
  }
}

interface AXNode {
  nodeId: string;
  ignored?: boolean;
  role?: { value: string };
  name?: { value: string };
  properties?: Array<{ name: string; value: { value: unknown } }>;
  childIds?: string[];
}

const SKIP_ROLES = new Set(["none", "generic", "InlineTextBox"]);

function formatA11yTree(nodes: AXNode[]): string {
  const nodeMap = new Map(nodes.map((n) => [n.nodeId, n]));
  const lines: string[] = [];
  const visited = new Set<string>();

  function getProp(node: AXNode, name: string): unknown {
    return node.properties?.find((p) => p.name === name)?.value.value;
  }

  function isHidden(node: AXNode): boolean {
    return !!(node.ignored || getProp(node, "hidden") || getProp(node, "hiddenRoot"));
  }

  function walk(nodeId: string, depth: number): void {
    if (visited.has(nodeId)) return;
    visited.add(nodeId);

    const node = nodeMap.get(nodeId);
    if (!node || isHidden(node)) return;

    const role = node.role?.value || "unknown";
    const children = node.childIds || [];

    if (SKIP_ROLES.has(role)) {
      children.forEach((id) => walk(id, depth));
      return;
    }

    const props = [
      getProp(node, "focused") && "focused",
      getProp(node, "disabled") && "disabled",
      getProp(node, "checked") !== undefined && (getProp(node, "checked") ? "checked" : "unchecked"),
      getProp(node, "expanded") !== undefined && (getProp(node, "expanded") ? "expanded" : "collapsed"),
      getProp(node, "selected") && "selected",
    ].filter(Boolean);

    const name = node.name?.value ? ` "${node.name.value}"` : "";
    const propsStr = props.length ? ` (${props.join(", ")})` : "";
    lines.push(`${"  ".repeat(depth)}${role}${name}${propsStr}`);

    children.forEach((id) => walk(id, depth + 1));
  }

  const root = nodes.find((n) => !nodes.some((o) => o.childIds?.includes(n.nodeId)));
  if (root) walk(root.nodeId, 0);

  return lines.join("\n");
}

export async function getAccessibilityTree(tabId: number): Promise<string> {
  await ensureDebugger(tabId);
  await chrome.debugger.sendCommand({ tabId }, "Accessibility.enable");
  const { nodes } = (await chrome.debugger.sendCommand({ tabId }, "Accessibility.getFullAXTree")) as {
    nodes: AXNode[];
  };
  return formatA11yTree(nodes);
}

export async function executeAction(tabId: number, action: BrowserAction): Promise<void> {
  switch (action.action) {
    case "click":
      if (action.x !== undefined && action.y !== undefined) {
        await withHiddenOverlay(tabId, () => click(tabId, action.x!, action.y!));
      }
      break;
    case "type":
      await withHiddenOverlay(tabId, () => type(tabId, action.text));
      break;
    case "press":
      await withHiddenOverlay(tabId, () => press(tabId, action.key));
      break;
    case "scroll":
      await withHiddenOverlay(tabId, () => scroll(tabId, action.direction));
      break;
  }
}
