/**
 * Tool definitions for OpenAI function calling API
 */

export const AUTOMATION_TOOLS = [
  {
    type: "function" as const,
    function: {
      name: "capture_screenshot",
      description:
        "Capture the current browser viewport as an image. Use this before any vision tools (analyze_page, find_element, ask_vision).",
      parameters: {
        type: "object",
        properties: {},
        required: [],
        additionalProperties: false,
      },
    },
  },
  {
    type: "function" as const,
    function: {
      name: "analyze_page",
      description:
        "Analyze the current screenshot using the vision model. Returns a description based on your prompt. Requires capture_screenshot first.",
      parameters: {
        type: "object",
        properties: {
          prompt: {
            type: "string",
            description:
              "Instructions for the vision model (e.g., 'List all buttons and links on the page', 'Describe the login form', 'What products are shown?')",
          },
        },
        required: ["prompt"],
        additionalProperties: false,
      },
    },
  },
  {
    type: "function" as const,
    function: {
      name: "find_element",
      description:
        "Find the exact x,y coordinates of a specific element. Use this before clicking to get precise coordinates. Requires capture_screenshot first.",
      parameters: {
        type: "object",
        properties: {
          target: {
            type: "string",
            description:
              "Description of the element to find (e.g., 'the blue Submit button', 'search input field', 'first search result link')",
          },
        },
        required: ["target"],
        additionalProperties: false,
      },
    },
  },
  {
    type: "function" as const,
    function: {
      name: "ask_vision",
      description:
        "Ask a question about what's visible in the current screenshot. Use to verify actions or gather information. Requires capture_screenshot first.",
      parameters: {
        type: "object",
        properties: {
          question: {
            type: "string",
            description:
              "The question to answer (e.g., 'What text is in the search box?', 'Is the login form visible?', 'What error message is shown?')",
          },
        },
        required: ["question"],
        additionalProperties: false,
      },
    },
  },
  {
    type: "function" as const,
    function: {
      name: "execute_action",
      description: "Execute a browser action.",
      parameters: {
        type: "object",
        properties: {
          action: {
            type: "string",
            enum: ["click", "type", "press", "scroll", "wait", "navigate"],
            description: "The action to perform",
          },
          x: {
            type: "number",
            description: "X coordinate for click (required for click)",
          },
          y: {
            type: "number",
            description: "Y coordinate for click (required for click)",
          },
          text: {
            type: "string",
            description: "Text to type (required for type)",
          },
          key: {
            type: "string",
            enum: ["Enter", "Escape", "ArrowDown", "ArrowUp"],
            description: "Key to press (required for press)",
          },
          direction: {
            type: "string",
            enum: ["up", "down", "left", "right"],
            description: "Scroll direction (required for scroll)",
          },
          duration: {
            type: "number",
            description: "Wait duration in milliseconds (required for wait)",
          },
          url: {
            type: "string",
            description: "URL to navigate to (required for navigate)",
          },
        },
        required: ["action"],
        additionalProperties: false,
      },
    },
  },
  {
    type: "function" as const,
    function: {
      name: "ask_user",
      description:
        "Pause automation ONLY when user must provide private info (passwords, 2FA codes) or solve captchas. Do NOT use for clarification or confirmation - figure it out yourself.",
      parameters: {
        type: "object",
        properties: {
          prompt: {
            type: "string",
            description:
              "What the user needs to provide (e.g., 'Please enter your password', 'Please solve the captcha')",
          },
        },
        required: ["prompt"],
        additionalProperties: false,
      },
    },
  },
  {
    type: "function" as const,
    function: {
      name: "complete",
      description: "Mark the task as complete. Use when the goal has been achieved.",
      parameters: {
        type: "object",
        properties: {
          result: {
            type: "string",
            description: "Summary of what was accomplished",
          },
        },
        required: ["result"],
        additionalProperties: false,
      },
    },
  },
];

export type ToolName =
  | "capture_screenshot"
  | "analyze_page"
  | "find_element"
  | "ask_vision"
  | "execute_action"
  | "ask_user"
  | "complete";
