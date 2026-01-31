import { useState, useEffect, useRef } from "preact/hooks";
import type { StatusUpdate } from "../types";

type Status = "idle" | "active" | "error";

type MessageType =
  | { type: "user"; content: string }
  | { type: "assistant"; content: string }
  | { type: "action"; content: string };

interface ChatOverlayProps {
  defaultOpen?: boolean;
}

// Full Perceptron logo with icon and text
const PerceptronLogo = () => <img class="agent-logo" src={chrome.runtime.getURL("icons/logo.svg")} alt="Perceptron" />;

export function ChatOverlay({ defaultOpen = false }: ChatOverlayProps) {
  const [isOpen, setIsOpen] = useState(defaultOpen);
  const [messages, setMessages] = useState<MessageType[]>([]);
  const [input, setInput] = useState("");
  const [status, setStatus] = useState<Status>("idle");
  const [indicator, setIndicator] = useState<string | null>(null);
  const isRunning = status === "active";

  const messagesRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);

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
    if (e.key === "Enter" && input.trim()) {
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

  return (
    <div class="agent-sidebar">
      <div class="agent-sidebar-header">
        <span class="agent-sidebar-title">
          <PerceptronLogo />
        </span>
        <button class="agent-sidebar-close" onClick={() => setIsOpen(false)}>
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
        <input
          ref={inputRef}
          type="text"
          placeholder={isRunning ? "Running..." : "What should I do?"}
          value={input}
          disabled={isRunning}
          onInput={(e) => setInput((e.target as HTMLInputElement).value)}
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
