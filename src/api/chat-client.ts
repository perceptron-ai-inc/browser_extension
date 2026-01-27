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

  async chatCompletion(options: ChatCompletionOptions): Promise<ChatCompletionResponse> {
    const response = await fetch(`${this.baseUrl}/chat/completions`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${this.apiKey}`,
      },
      body: JSON.stringify(options),
    });

    if (!response.ok) {
      const body = await response.json().catch((e) => {
        console.warn("[ChatClient] Failed to parse error response:", e);
        return {};
      });
      throw new ApiError(body.error?.message, response.status);
    }

    return response.json();
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
