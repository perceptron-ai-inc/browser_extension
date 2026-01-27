/**
 * Generic chat completions client for OpenAI-compatible APIs
 */

import { ApiError } from "./errors.js";

export interface ChatMessage {
  role: "system" | "user" | "assistant";
  content: string | ChatContentPart[];
}

export interface ChatContentPart {
  type: "text" | "image_url";
  text?: string;
  image_url?: { url: string };
}

export interface ChatCompletionOptions {
  model: string;
  messages: ChatMessage[];
  temperature?: number;
  max_completion_tokens?: number;
  frequency_penalty?: number;
  response_format?: object;
  stream?: boolean;
}

export interface ChatCompletionResponse {
  choices: Array<{
    message: {
      content: string;
    };
  }>;
}

export class ChatClient {
  private baseUrl: string;
  private apiKey: string;

  constructor(baseUrl: string, apiKey: string) {
    this.baseUrl = baseUrl;
    this.apiKey = apiKey;
  }

  private async post(options: ChatCompletionOptions): Promise<Response> {
    const headers: Record<string, string> = {
      "Content-Type": "application/json",
      Authorization: `Bearer ${this.apiKey}`,
    };
    if (options.stream) {
      headers["Accept"] = "text/event-stream";
    }

    const response = await fetch(`${this.baseUrl}/v1/chat/completions`, {
      method: "POST",
      headers,
      body: JSON.stringify(options),
    });

    if (!response.ok) {
      const errorBody = await response.json().catch((e) => {
        console.warn("[ChatClient] Failed to parse error response:", e);
        return {};
      });
      throw new ApiError(errorBody.error?.message, response.status);
    }

    return response;
  }

  async chatCompletion(options: ChatCompletionOptions): Promise<ChatCompletionResponse> {
    const response = await this.post(options);
    return response.json();
  }

  /**
   * Streaming chat completion that calls onContent with accumulated text as chunks arrive
   */
  async streamChatCompletion(options: ChatCompletionOptions, onDelta: (delta: string) => void): Promise<void> {
    const response = await this.post({ ...options, stream: true });

    const reader = response.body!.getReader();
    const decoder = new TextDecoder();
    let buffer = "";

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      // Append decoded bytes to buffer (may contain partial line from previous read)
      buffer += decoder.decode(value, { stream: true });
      // Split on newlines — all elements are complete lines except the last
      const lines = buffer.split("\n");
      // Last element is either empty or an incomplete line — save it for the next read
      buffer = lines.pop() || "";

      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed.startsWith("data: ")) {
          // Empty lines are normal SSE separators — only warn on non-empty unexpected lines
          if (trimmed) console.warn("[ChatClient] Unexpected SSE line:", trimmed);
          continue;
        }
        const data = trimmed.slice(6);
        if (data === "[DONE]") continue;

        try {
          const parsed = JSON.parse(data);
          const delta = parsed.choices?.[0]?.delta?.content;
          if (delta) {
            onDelta(delta);
          }
        } catch (e) {
          console.warn("[ChatClient] Failed to parse SSE chunk:", data, e);
        }
      }
    }
  }

  /**
   * Helper to create a message (text or multimodal)
   */
  static message(content: string | ChatContentPart[], role: "system" | "user" | "assistant" = "user"): ChatMessage {
    return { role, content };
  }

  /**
   * Helper to create a text content part
   */
  static textPart(text: string): ChatContentPart {
    return { type: "text", text };
  }

  /**
   * Helper to create an image content part from base64
   */
  static imagePart(base64: string, mimeType: string = "image/jpeg"): ChatContentPart {
    return {
      type: "image_url",
      image_url: { url: `data:${mimeType};base64,${base64}` },
    };
  }
}
