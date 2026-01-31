/**
 * Tab and content script utilities
 */

async function ensureContentScript(tabId: number): Promise<void> {
  try {
    await chrome.tabs.sendMessage(tabId, { type: "PING" });
  } catch {
    await chrome.scripting.executeScript({
      target: { tabId },
      files: ["content.js"],
    });
  }
}

export async function getViewportDimensions(tabId: number): Promise<{ width: number; height: number }> {
  await ensureContentScript(tabId);
  return chrome.tabs.sendMessage(tabId, { type: "GET_VIEWPORT" });
}

export async function sendToContentScript(
  tabId: number,
  message: { type: string; [key: string]: unknown },
): Promise<void> {
  await ensureContentScript(tabId);
  await chrome.tabs.sendMessage(tabId, message);
}
