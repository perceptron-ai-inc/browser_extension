import { useState, useEffect, useRef, useCallback } from "preact/hooks";
import type { StatusUpdate } from "../types";

type Status = "idle" | "active" | "error";

type MessageType =
  | { type: "user"; content: string }
  | { type: "assistant"; content: string }
  | { type: "action"; content: string };

interface ChatOverlayProps {
  defaultOpen?: boolean;
  draggable?: boolean;
}

const PerceptronLogo = () => <img class="agent-logo" src={chrome.runtime.getURL("icons/logo.svg")} alt="Perceptron" />;

export function ChatOverlay({ defaultOpen = false, draggable = true }: ChatOverlayProps) {
  const [isOpen, setIsOpen] = useState(defaultOpen);
  const [messages, setMessages] = useState<MessageType[]>([]);
  const [input, setInput] = useState("");
  const [status, setStatus] = useState<Status>("idle");
  const [indicator, setIndicator] = useState<string | null>(null);
  const [position, setPosition] = useState<{ x: number; y: number } | null>(null);
  const [isDragging, setIsDragging] = useState(false);
  const dragOffset = useRef({ x: 0, y: 0 });
  const sidebarRef = useRef<HTMLDivElement>(null);
  const isRunning = status === "active";

  const messagesRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);

  // Clamp position to viewport
  const clampPosition = useCallback((x: number, y: number) => {
    const rect = sidebarRef.current?.getBoundingClientRect();
    if (!rect) return { x, y };
    return {
      x: Math.max(0, Math.min(window.innerWidth - rect.width, x)),
      y: Math.max(0, Math.min(window.innerHeight - rect.height, y)),
    };
  }, []);

  // Load position from storage on mount (only when draggable)
  useEffect(() => {
    if (!draggable) return;
    chrome.storage.session.get("panelPosition").then((result) => {
      if (result.panelPosition) {
        setPosition(clampPosition(result.panelPosition.x, result.panelPosition.y));
      }
    });
  }, [draggable, clampPosition]);

  // Keep position in bounds on window resize
  useEffect(() => {
    if (!draggable || !position) return;
    const handleResize = () => {
      setPosition((pos) => (pos ? clampPosition(pos.x, pos.y) : null));
    };
    window.addEventListener("resize", handleResize);
    return () => window.removeEventListener("resize", handleResize);
  }, [draggable, position, clampPosition]);

  // Save position to storage when it changes (after drag ends)
  useEffect(() => {
    if (!draggable || !position || isDragging) return;
    chrome.storage.session.set({ panelPosition: position });
  }, [position, isDragging, draggable]);

  // Drag handlers
  const handleMouseDown = useCallback(
    (e: MouseEvent) => {
      const rect = sidebarRef.current?.getBoundingClientRect();
      if (!rect) return;
      setIsDragging(true);
      dragOffset.current = {
        x: e.clientX - rect.left,
        y: e.clientY - rect.top,
      };
      // Set position from current CSS position on first drag
      if (!position) {
        setPosition({ x: rect.left, y: rect.top });
      }
      e.preventDefault();
    },
    [position],
  );

  useEffect(() => {
    if (!isDragging) return;

    const handleMouseMove = (e: MouseEvent) => {
      setPosition(clampPosition(e.clientX - dragOffset.current.x, e.clientY - dragOffset.current.y));
    };

    const handleMouseUp = () => {
      setIsDragging(false);
    };

    window.addEventListener("mousemove", handleMouseMove);
    window.addEventListener("mouseup", handleMouseUp);
    return () => {
      window.removeEventListener("mousemove", handleMouseMove);
      window.removeEventListener("mouseup", handleMouseUp);
    };
  }, [isDragging, clampPosition]);

  // Load chat history on mount
  useEffect(() => {
    chrome.runtime.sendMessage({ type: "GET_CHAT_HISTORY" }, (response) => {
      if (response?.chatHistory) {
        setMessages(response.chatHistory);
        if (response.isRunning) {
          setIsOpen(true);
          setStatus("active");
        }
      }
    });
  }, []);

  // Auto-scroll to bottom
  useEffect(() => {
    if (messagesRef.current) {
      messagesRef.current.scrollTop = messagesRef.current.scrollHeight;
    }
  }, [messages, indicator]);

  // Focus input when opened
  useEffect(() => {
    if (isOpen) {
      inputRef.current?.focus();
    }
  }, [isOpen]);

  // Listen for status updates from background
  useEffect(() => {
    const listener = (message: StatusUpdate) => {
      if (message.type !== "STATUS_UPDATE") return;

      // Auto-open when automation starts
      if (status !== "active" && message.status === "analyzing") {
        setIsOpen(true);
        setStatus("active");
      }

      switch (message.status) {
        case "analyzing":
          setIndicator(message.message);
          break;

        case "executing":
          setIndicator(null);
          setMessages((prev) => [...prev, { type: "action", content: message.message }]);
          break;

        case "completed":
          setIndicator(null);
          setMessages((prev) => [...prev, { type: "assistant", content: `✓ ${message.message}` }]);
          setStatus("idle");
          break;

        case "error":
          setIndicator(null);
          setMessages((prev) => [...prev, { type: "assistant", content: message.message }]);
          setStatus("error");
          break;

        case "stopped":
          setIndicator(null);
          setMessages((prev) => [...prev, { type: "assistant", content: message.message }]);
          setStatus("idle");
          break;

        case "waiting_for_user":
          setIndicator(null);
          setMessages((prev) => [...prev, { type: "assistant", content: message.message }]);
          setStatus("idle");
          break;
      }
    };

    chrome.runtime.onMessage.addListener(listener);
    return () => chrome.runtime.onMessage.removeListener(listener);
  }, [status]);

  const sendMessage = () => {
    const text = input.trim();
    if (!text || isRunning) return;

    setMessages((prev) => [...prev, { type: "user", content: text }]);
    setInput("");
    setStatus("active");

    chrome.runtime.sendMessage({ type: "RUN", goal: text });
  };

  const stopAutomation = () => {
    chrome.runtime.sendMessage({ type: "STOP" });
  };

  const handleKeyDown = (e: KeyboardEvent) => {
    // Enter sends message, Shift+Enter adds newline
    if (e.key === "Enter" && !e.shiftKey && input.trim()) {
      e.preventDefault();
      sendMessage();
    }
  };

  if (!isOpen) {
    return (
      <button class="agent-sidebar-tab" onClick={() => setIsOpen(true)}>
        <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
          <path d="M15 18l-6-6 6-6" />
        </svg>
        {isRunning && <span class="agent-sidebar-tab-indicator" />}
      </button>
    );
  }

  const positionStyle = position
    ? { left: `${position.x}px`, top: `${position.y}px`, right: "auto", bottom: "auto" }
    : undefined;

  return (
    <div ref={sidebarRef} class="agent-sidebar" style={positionStyle}>
      <div
        class={`agent-sidebar-header ${draggable ? "agent-sidebar-header-draggable" : ""}`}
        onMouseDown={draggable ? handleMouseDown : undefined}
      >
        <span class="agent-sidebar-title">
          <PerceptronLogo />
        </span>
        <button class="agent-sidebar-close" onClick={() => setIsOpen(false)} onMouseDown={(e) => e.stopPropagation()}>
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
            <path d="M9 18l6-6-6-6" />
          </svg>
        </button>
      </div>

      <div class="agent-sidebar-messages" ref={messagesRef}>
        {messages.map((msg, i) => (
          <div key={i} class={`agent-message agent-message-${msg.type}`}>
            {msg.content}
          </div>
        ))}
        {indicator && <div class="agent-indicator">{indicator}</div>}
      </div>

      <div class="agent-sidebar-input">
        <textarea
          ref={inputRef}
          placeholder={isRunning ? "Running..." : "What should I do?"}
          value={input}
          disabled={isRunning}
          onInput={(e) => setInput((e.target as HTMLTextAreaElement).value)}
          onKeyDown={handleKeyDown}
        />
        <button onClick={isRunning ? stopAutomation : sendMessage} disabled={!isRunning && !input.trim()}>
          {isRunning ? (
            <svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor">
              <rect x="4" y="4" width="16" height="16" rx="2" />
            </svg>
          ) : (
            <svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor">
              <path d="M5 3l14 9-14 9V3z" />
            </svg>
          )}
        </button>
      </div>
    </div>
  );
}
