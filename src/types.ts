// Screen analysis result from vision model
export interface ScreenAnalysis {
  pageState?: string;
  url: string;
}

export interface ClickAction {
  action: "click";
  target: string; // Description of element to click (vision model will find coordinates)
  x?: number; // Resolved coordinates (filled in after vision model lookup)
  y?: number;
}

export interface TypeAction {
  action: "type";
  text: string;
}

export interface ScrollAction {
  action: "scroll";
  direction: "up" | "down" | "left" | "right";
}

export interface PressAction {
  action: "press";
  key: string;
}

export interface WaitAction {
  action: "wait";
  duration: number;
}

export interface AskUserAction {
  action: "ask_user";
  prompt: string;
}

export interface NavigateAction {
  action: "navigate";
  url: string;
}

export interface DoneAction {
  action: "done";
  result: string;
}

export type BrowserAction =
  | ClickAction
  | TypeAction
  | PressAction
  | ScrollAction
  | WaitAction
  | AskUserAction
  | NavigateAction
  | DoneAction;

// Decision from reasoning model
export interface ActionDecision {
  reasoning: string;
  action: BrowserAction; // First action (for compatibility)
  actions?: BrowserAction[]; // All actions (1-3)
  visionFocus?: string; // Tell vision model what to describe/focus on
  question?: string; // Question to verify action result or goal completion
  confidence: number;
}

// Action history entry
export interface ActionHistoryEntry {
  action: BrowserAction;
  reasoning: string;
  timestamp: number;
  success?: boolean;
}

// Status update message
export interface StatusUpdate {
  type: "STATUS_UPDATE";
  status:
    | "analyzing"
    | "reasoning"
    | "executing"
    | "completed"
    | "error"
    | "stopped"
    | "waiting_for_user"
    | "vision"
    | "pointing";
  iteration: number;
  message: string;
  action?: BrowserAction;
  reasoning?: string;
  confidence?: number;
  screenshot?: string;
  pageDescription?: string;
  pointX?: number;
  pointY?: number;
  boxes?: Array<{
    x1: number;
    y1: number;
    x2: number;
    y2: number;
    label?: string;
  }>;
}

// Messages between components
export type ExtensionMessage =
  | { type: "RUN"; goal: string }
  | { type: "STOP" }
  | { type: "GET_STATUS" }
  | { type: "CHECK_API_KEY" }
  | StatusUpdate;
