import type { ActionDecision } from "../types.js";
import { ChatClient, type ChatMessage } from "./chat-client.js";
import { ACTION_DECISION_SCHEMA } from "./constants.js";

// Configuration injected at build time from .env
const PERCEPTRON_API_KEY = process.env.PERCEPTRON_API_KEY;
const VISION_MODEL = process.env.VISION_MODEL;

const REASONING_API_URL = process.env.REASONING_API_URL;
const REASONING_API_KEY = process.env.REASONING_API_KEY;
const REASONING_MODEL = process.env.REASONING_MODEL;

// Initialize clients
const visionClient = new ChatClient("https://api.perceptron.inc", PERCEPTRON_API_KEY);
const reasoningClient = new ChatClient(REASONING_API_URL, REASONING_API_KEY);

// Bounding box from vision model (normalized 0-1000)
export interface BoundingBox {
  x1: number;
  y1: number;
  x2: number;
  y2: number;
  label?: string;
}

// Parse boxes from vision model response, handling collection tags
function parseBoxes(content: string): BoundingBox[] {
  const boxes: BoundingBox[] = [];

  // Match collection open/close tags and point_box tags in order
  const tokenRegex =
    /<collection\s+mention="([^"]*)"[^>]*>|<\/collection>|<point_box(?:\s+mention="([^"]*)")?>\s*\((\d+)\s*,\s*(\d+)\)\s*\((\d+)\s*,\s*(\d+)\)\s*<\/point_box>/g;

  let collectionLabel: string | undefined;
  let match;
  while ((match = tokenRegex.exec(content)) !== null) {
    if (match[0].startsWith("<collection")) {
      collectionLabel = match[1];
    } else if (match[0].startsWith("</collection")) {
      collectionLabel = undefined;
    } else {
      // point_box: use its own mention if present, otherwise the collection label
      boxes.push({
        label: match[2] || collectionLabel,
        x1: parseInt(match[3]),
        y1: parseInt(match[4]),
        x2: parseInt(match[5]),
        y2: parseInt(match[6]),
      });
    }
  }
  return boxes;
}

export interface NextActionResult {
  decision: ActionDecision;
  assistantMessage: string;
}

type VisionHint = "THINK" | "POINT" | "BOX";

function hintMessage(...hints: VisionHint[]): ChatMessage {
  return ChatClient.message(`<hint>${hints.join(" ")}</hint>`, "system");
}

export class ModelClient {
  constructor() {
    if (!PERCEPTRON_API_KEY || !REASONING_API_KEY) {
      console.warn("API keys not configured. Please set PERCEPTRON_API_KEY and REASONING_API_KEY in .env");
    }
  }

  /**
   * Find element coordinates using vision model
   */
  async findElement(
    base64Image: string,
    description: string,
    viewportWidth: number,
    viewportHeight: number,
  ): Promise<{ x: number; y: number }> {
    const response = await visionClient.chatCompletion({
      model: VISION_MODEL,
      messages: [
        hintMessage("POINT"),
        ChatClient.message([ChatClient.imagePart(base64Image), ChatClient.textPart(`Point to the ${description}`)]),
      ],
      temperature: 0,
    });

    const content = response.choices[0].message.content;
    console.log(`[Vision] Raw response: ${content}`);
    console.log(`[Vision] Viewport: ${viewportWidth}x${viewportHeight}`);

    const match = content.match(/(\d+)\s*,\s*(\d+)/);
    if (!match) {
      throw new Error(`Could not parse coordinates from vision model response: ${content}`);
    }

    const normX = parseInt(match[1]);
    const normY = parseInt(match[2]);
    const x = Math.round((normX / 1000) * viewportWidth);
    const y = Math.round((normY / 1000) * viewportHeight);
    console.log(`[Vision] Normalized: (${normX}, ${normY}) -> CSS pixels: (${x}, ${y})`);
    return { x, y };
  }

  /**
   * Analyze screenshot to identify interactive elements.
   * Streams the response and emits content + new boxes as they arrive via onStream.
   */
  async analyzeScreenshot(
    base64Image: string,
    visionFocus: string | undefined,
    onStream: (newBoxes: BoundingBox[]) => void,
  ): Promise<{ pageState: string; boxes?: BoundingBox[] }> {
    const prompt = visionFocus
      ? `Segment and label ${visionFocus}. Include buttons, links, inputs, and text. Do not segment the same element multiple times.`
      : "Segment and label page elements. Include buttons, links, inputs, and text. Do not segment the same element multiple times.";

    const options = {
      model: VISION_MODEL,
      messages: [
        hintMessage("BOX"),
        ChatClient.message([ChatClient.imagePart(base64Image), ChatClient.textPart(prompt)]),
      ],
      temperature: 0,
      frequency_penalty: 0.5,
      max_completion_tokens: 2048,
    };

    let content = "";
    const allBoxes: BoundingBox[] = [];

    await visionClient.streamChatCompletion(options, (delta) => {
      content += delta;
      const parsed = parseBoxes(content);
      const newBoxes = parsed.slice(allBoxes.length);
      allBoxes.push(...newBoxes);
      onStream(newBoxes);
    });

    console.log(`[Vision] Found ${allBoxes.length} boxes`);

    return { pageState: content, boxes: allBoxes };
  }

  /**
   * Ask a specific question about the screenshot
   */
  async askQuestion(base64Image: string, question: string): Promise<string> {
    const response = await visionClient.chatCompletion({
      model: VISION_MODEL,
      messages: [
        hintMessage("THINK"),
        ChatClient.message([
          ChatClient.imagePart(base64Image),
          ChatClient.textPart(
            `Answer this question based only on what you see in the image. Be brief (1-2 sentences).\n\nQuestion: ${question}`,
          ),
        ]),
      ],
      temperature: 0,
    });

    return response.choices[0].message.content;
  }

  /**
   * Get next action from reasoning model using multi-turn conversation
   */
  async getNextAction(messages: ChatMessage[]): Promise<NextActionResult> {
    const response = await reasoningClient.chatCompletion({
      model: REASONING_MODEL,
      messages,
      temperature: 0.1,
      response_format: ACTION_DECISION_SCHEMA,
    });

    console.log("[Reasoning] Raw response:", JSON.stringify(response).substring(0, 1000));
    const content = response.choices[0]?.message?.content;
    if (!content) {
      console.error("[Reasoning] Empty response:", JSON.stringify(response));
      throw new Error("Empty response from reasoning model");
    }
    console.log("[Reasoning] Content:", content.substring(0, 500));

    let parsed;
    try {
      parsed = JSON.parse(content);
    } catch {
      console.error("[Reasoning] Failed to parse JSON:", content);
      throw new Error(`Invalid JSON from reasoning model: ${content.substring(0, 500)}`);
    }

    const actions = parsed.actions || [parsed.action];

    return {
      decision: {
        reasoning: parsed.reasoning,
        action: actions[0],
        actions: actions,
        visionFocus: parsed.visionFocus,
        question: parsed.question,
        confidence: parsed.confidence,
      } as ActionDecision,
      assistantMessage: content,
    };
  }

  static hasApiKeys(): boolean {
    return !!(PERCEPTRON_API_KEY && REASONING_API_KEY);
  }
}
