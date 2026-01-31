/**
 * Tab and content script utilities
 */

export async function captureScreenshot(tabId: number): Promise<string> {
  // Hide overlay before capturing
  await chrome.tabs.sendMessage(tabId, { type: "HIDE_OVERLAY" }).catch((e) => {
    console.warn("[Screenshot] Failed to hide overlay:", e);
  });

  // Small delay to ensure overlay is hidden
  await new Promise((resolve) => setTimeout(resolve, 50));

  const dataUrl = await chrome.tabs.captureVisibleTab({
    format: "jpeg",
    quality: 85,
  });

  // Show overlay again
  await chrome.tabs.sendMessage(tabId, { type: "SHOW_OVERLAY" }).catch((e) => {
    console.warn("[Screenshot] Failed to show overlay:", e);
  });

  return dataUrl.replace(/^data:image\/jpeg;base64,/, "");
}

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
