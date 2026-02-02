export interface ClickAction {
  action: "click";
  x?: number;
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

export interface NavigateAction {
  action: "navigate";
  url: string;
}

export type BrowserAction = ClickAction | TypeAction | PressAction | ScrollAction | WaitAction | NavigateAction;

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
