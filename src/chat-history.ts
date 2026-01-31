/**
 * Chat history management (persists across page navigations via session storage)
 * Each tab has its own chat history, keyed by tabId.
 */

type UIChatMessage = { type: "user" | "assistant" | "action"; content: string };

const WELCOME_MESSAGE: UIChatMessage = { type: "assistant", content: "What would you like me to do?" };

function storageKey(tabId: number): string {
  return `chatHistory_${tabId}`;
}

export async function getChatHistory(tabId: number): Promise<UIChatMessage[]> {
  const key = storageKey(tabId);
  const result = await chrome.storage.session.get(key);
  return result[key]?.length ? result[key] : [WELCOME_MESSAGE];
}

export async function addToChatHistory(tabId: number, message: UIChatMessage): Promise<void> {
  const key = storageKey(tabId);
  const history = await getChatHistory(tabId);
  history.push(message);
  await chrome.storage.session.set({ [key]: history });
}

export async function clearChatHistory(tabId: number): Promise<void> {
  await chrome.storage.session.remove(storageKey(tabId));
}
