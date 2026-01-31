/**
 * Chat history management (persists across page navigations via session storage)
 */

export type UIChatMessage = { type: "user" | "assistant" | "action"; content: string };

const WELCOME_MESSAGE: UIChatMessage = { type: "assistant", content: "What would you like me to do?" };

export async function getChatHistory(): Promise<UIChatMessage[]> {
  const result = await chrome.storage.session.get("chatHistory");
  return result.chatHistory?.length ? result.chatHistory : [WELCOME_MESSAGE];
}

export async function addToChatHistory(message: UIChatMessage): Promise<void> {
  const history = await getChatHistory();
  history.push(message);
  await chrome.storage.session.set({ chatHistory: history });
}
