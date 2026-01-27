import type { ScreenAnalysis, ActionDecision, ActionHistoryEntry } from "../types.js";
import { ChatClient } from "./chat-client.js";

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

// Parse boxes from vision model response
function parseBoxes(content: string): BoundingBox[] {
  const boxes: BoundingBox[] = [];
  const boxRegex =
    /<point_box(?:\s+mention="([^"]*)")?>\s*\((\d+)\s*,\s*(\d+)\)\s*\((\d+)\s*,\s*(\d+)\)\s*<\/point_box>/g;

  let match;
  while ((match = boxRegex.exec(content)) !== null) {
    boxes.push({
      label: match[1],
      x1: parseInt(match[2]),
      y1: parseInt(match[3]),
      x2: parseInt(match[4]),
      y2: parseInt(match[5]),
    });
  }
  return boxes;
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
        ChatClient.message("<hint>POINT</hint>", "system"),
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
   * Analyze screenshot to identify interactive elements
   */
  async analyzeScreenshot(
    base64Image: string,
    visionFocus?: string,
  ): Promise<{ pageState: string; boxes?: BoundingBox[] }> {
    const prompt = visionFocus
      ? `This is a browser page. Segment elements, focused on: ${visionFocus}`
      : "This is a browser page. Segment elements.";

    const response = await visionClient.chatCompletion({
      model: VISION_MODEL,
      messages: [
        ChatClient.message("<hint>BOX</hint>", "system"),
        ChatClient.message([ChatClient.imagePart(base64Image), ChatClient.textPart(prompt)]),
      ],
      temperature: 0,
      max_completion_tokens: 2048,
      frequency_penalty: 0.6,
    });

    const content = response.choices[0].message.content;
    const boxes = parseBoxes(content);
    console.log(`[Vision] Found ${boxes.length} boxes`);

    return { pageState: content, boxes };
  }

  /**
   * Ask a specific question about the screenshot
   */
  async askQuestion(base64Image: string, question: string): Promise<string> {
    const response = await visionClient.chatCompletion({
      model: VISION_MODEL,
      messages: [
        ChatClient.message([
          ChatClient.imagePart(base64Image),
          ChatClient.textPart(
            `Answer this question based only on what you see in the image. Be brief (1-2 sentences).\n\nQuestion: ${question}`,
          ),
        ]),
      ],
      temperature: 0,
      max_completion_tokens: 256,
    });

    return response.choices[0].message.content;
  }

  /**
   * Get next action from reasoning model
   */
  async getNextAction(
    screenAnalysis: ScreenAnalysis,
    userGoal: string,
    actionHistory: ActionHistoryEntry[] = [],
    visionAnswer?: string,
  ): Promise<ActionDecision> {
    const systemPrompt = `You are a browser automation planner. Based on the page description from a vision model, decide the next action(s) to take.

Available actions:
- navigate: Navigate to a URL. Avoid paths or query parameters when possible - interact with the site through clicks and typing instead.
- click: Click on an element. Use the EXACT text labels from the page description. Include context to disambiguate if there are multiple similar elements (e.g., "Add to Cart button next to the Nike Air Max", "first search result", "Sign In link in the top navigation").
- type: Type text into the currently focused input. Specify the text.
- press: Press a key or key combination. Keys: Enter, Tab, Escape, Backspace, Delete, ArrowDown, ArrowUp, ArrowLeft, ArrowRight, Home, End, PageUp, PageDown. For shortcuts use ControlOrMeta (e.g., "ControlOrMeta+a" for select all, "ControlOrMeta+c" for copy).
- scroll: Scroll the page. Specify direction (up/down/left/right).
- wait: Wait for page to load. Specify duration in milliseconds.
- ask_user: Hand off to the user for input they must provide (e.g., login credentials, captcha, 2FA code, confirming something you cannot verify).
- done: Task is complete or cannot continue. Specify result summary.

Rules:
1. If the URL starts with "chrome://" or is blank/unknown, you MUST use navigate to go to a real website first - you cannot click or type on these pages
2. Check if the current URL matches the goal. If on a completely unrelated site, use navigate to go to the right website
3. You can chain multiple actions if they logically flow together (e.g., click input + type text, or click search + wait)
4. Avoid chaining actions when you need to see the result first (e.g., don't chain click search + click result)
5. If you need to visit a website, use navigate with the appropriate URL
6. Be specific when describing elements to click - use the exact label/text from the page description
7. If what you're looking for is not visible on screen, scroll to find it
8. If you've scrolled 2-3 times without finding it, try a different approach (search, navigation, or ask_user)
9. Prefer keyboard shortcuts over clicking when possible (e.g., Enter to submit forms, Tab to move between fields, Escape to close modals)
10. Use ask_user for things you cannot do or verify: login credentials, captchas, 2FA, confirming video playback, etc.
11. Say "done" ONLY when the original goal is achieved

Return JSON with:
{
  "reasoning": "Brief explanation of why these actions",
  "actions": [{action object}, ...],
  "visionFocus": "Brief hint for vision model - a few words only (e.g., 'search area', 'login form', 'product listings')",
  "question": "Brief question to verify result (e.g., 'Is the video playing?', 'Did results load?')",
  "confidence": 0.0-1.0
}`;

    const historyText =
      actionHistory.length > 0
        ? actionHistory
            .slice(-10)
            .map((h) => `- ${h.action.action}: ${JSON.stringify(h.action)}`)
            .join("\n")
        : "None";

    let userMessage = `Goal: ${userGoal}

History:
${historyText}

Current URL: ${screenAnalysis.url || "unknown"}

Current page:
${screenAnalysis.pageState}`;

    if (visionAnswer) {
      userMessage += `\n\nAnswer to your previous question:\n${visionAnswer}`;
    }

    const response = await reasoningClient.chatCompletion({
      model: REASONING_MODEL,
      messages: [ChatClient.message(systemPrompt, "system"), ChatClient.message(userMessage, "user")],
      temperature: 0.1,
      response_format: {
        type: "json_schema",
        json_schema: {
          name: "action_decision",
          strict: true,
          schema: {
            type: "object",
            properties: {
              reasoning: { type: "string" },
              actions: {
                type: "array",
                items: {
                  type: "object",
                  properties: {
                    action: {
                      type: "string",
                      enum: ["click", "type", "press", "scroll", "wait", "ask_user", "navigate", "done"],
                    },
                    target: { type: ["string", "null"] },
                    text: { type: ["string", "null"] },
                    key: { type: ["string", "null"] },
                    prompt: { type: ["string", "null"] },
                    direction: {
                      type: ["string", "null"],
                      enum: ["up", "down", "left", "right", null],
                    },
                    duration: { type: ["number", "null"] },
                    url: { type: ["string", "null"] },
                    result: { type: ["string", "null"] },
                  },
                  required: ["action", "target", "text", "key", "prompt", "direction", "duration", "url", "result"],
                  additionalProperties: false,
                },
              },
              visionFocus: { type: ["string", "null"] },
              question: { type: ["string", "null"] },
              confidence: { type: "number" },
            },
            required: ["reasoning", "actions", "visionFocus", "question", "confidence"],
            additionalProperties: false,
          },
        },
      },
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
      reasoning: parsed.reasoning,
      action: actions[0],
      actions: actions,
      visionFocus: parsed.visionFocus,
      question: parsed.question,
      confidence: parsed.confidence,
    } as ActionDecision;
  }

  static hasApiKeys(): boolean {
    return !!(PERCEPTRON_API_KEY && REASONING_API_KEY);
  }
}
