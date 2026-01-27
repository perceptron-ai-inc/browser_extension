import { useState, useEffect, useRef } from "preact/hooks";
import type { StatusUpdate } from "../types";
import { Message } from "./components/Message";
import { VisionMessage } from "./components/VisionMessage";
import { PointingMessage } from "./components/PointingMessage";
import { ActionIndicator } from "./components/ActionIndicator";
import { SendIcon, StopIcon } from "./components/Icons";

type Status = "idle" | "active" | "error";

type MessageType =
  | { type: "user"; content: string }
  | { type: "assistant"; content: string }
  | {
      type: "vision";
      screenshot: string;
      description: string;
      boxes?: StatusUpdate["boxes"];
    }
  | {
      type: "pointing";
      screenshot: string;
      target: string;
      pointX: number;
      pointY: number;
    }
  | { type: "reasoning"; content: string }
  | { type: "action"; content: string };

export function App() {
  const [messages, setMessages] = useState<MessageType[]>([
    {
      type: "assistant",
      content: "What would you like to do? I can see and interact with any page you're on.",
    },
  ]);
  const [input, setInput] = useState("");
  const [status, setStatus] = useState<Status>("idle");
  const isRunning = status === "active";
  const [indicator, setIndicator] = useState<string | null>(null);

  const messagesRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);

  // Auto-scroll to bottom when messages change or indicator appears
  useEffect(() => {
    if (messagesRef.current) {
      messagesRef.current.scrollTop = messagesRef.current.scrollHeight;
    }
  }, [messages, indicator]);

  // Focus input on mount
  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  // Listen for status updates from background
  useEffect(() => {
    const listener = (message: StatusUpdate) => {
      if (message.type !== "STATUS_UPDATE") return;

      switch (message.status) {
        case "vision":
          if (message.screenshot && message.pageDescription) {
            setIndicator(null);
            setMessages((prev) => [
              ...prev,
              {
                type: "vision",
                screenshot: message.screenshot,
                description: message.pageDescription,
                boxes: message.boxes,
              },
            ]);
          }
          break;

        case "pointing":
          if (message.screenshot && message.pointX !== undefined && message.pointY !== undefined) {
            setIndicator(null);
            setMessages((prev) => [
              ...prev,
              {
                type: "pointing",
                screenshot: message.screenshot,
                target: message.message,
                pointX: message.pointX,
                pointY: message.pointY,
              },
            ]);
          }
          break;

        case "reasoning":
          if (message.reasoning) {
            setIndicator(null);
            setMessages((prev) => [...prev, { type: "reasoning", content: message.reasoning! }]);
          } else {
            setIndicator(message.message);
          }
          break;

        case "analyzing":
          setIndicator(message.message);
          break;

        case "executing":
          setIndicator(null);
          setMessages((prev) => [
            ...prev,
            {
              type: "action",
              content: `Step ${message.iteration}: ${message.message}`,
            },
          ]);
          break;

        case "completed":
          setIndicator(null);
          setMessages((prev) => [...prev, { type: "assistant", content: `✓ ${message.message}` }]);
          resetForInput();
          break;

        case "error":
          setIndicator(null);
          setMessages((prev) => [...prev, { type: "assistant", content: message.message }]);
          setStatus("error");
          inputRef.current?.focus();
          break;

        case "stopped":
          setIndicator(null);
          setMessages((prev) => [...prev, { type: "assistant", content: message.message }]);
          resetForInput();
          break;

        case "waiting_for_user":
          setIndicator(null);
          setMessages((prev) => [...prev, { type: "assistant", content: `⏸️ ${message.message}` }]);
          resetForInput();
          break;
      }
    };

    chrome.runtime.onMessage.addListener(listener);
    return () => chrome.runtime.onMessage.removeListener(listener);
  }, []);

  const resetForInput = () => {
    setStatus("idle");
    inputRef.current?.focus();
  };

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
    if (e.key === "Enter" && !e.shiftKey && input.trim()) {
      e.preventDefault();
      sendMessage();
    }
  };

  const handleInput = (e: Event) => {
    const target = e.target as HTMLTextAreaElement;
    setInput(target.value);
    // Auto-resize
    target.style.height = "auto";
    target.style.height = target.scrollHeight + "px";
  };

  return (
    <div class="container">
      <header class="header">
        <div class="header-left">
          <div class={`status-dot ${status !== "idle" ? status : ""}`} />
          <span class="title">Browser Agent</span>
        </div>
        <span class="subtitle">Isaac + GPT-5.2</span>
      </header>

      <div class="messages" ref={messagesRef}>
        {messages.map((msg, i) => {
          switch (msg.type) {
            case "user":
              return <Message key={i} content={msg.content} type="user" />;
            case "assistant":
              return <Message key={i} content={msg.content} type="assistant" />;
            case "vision":
              return (
                <VisionMessage key={i} screenshot={msg.screenshot} description={msg.description} boxes={msg.boxes} />
              );
            case "pointing":
              return (
                <PointingMessage
                  key={i}
                  screenshot={msg.screenshot}
                  target={msg.target}
                  pointX={msg.pointX}
                  pointY={msg.pointY}
                />
              );
            case "reasoning":
              return <Message key={i} content={msg.content} type="assistant" role="reasoning" />;
            case "action":
              return <Message key={i} content={msg.content} type="assistant" role="action" />;
          }
        })}
        {indicator && <ActionIndicator text={indicator} />}
      </div>

      <div class="input-area">
        <textarea ref={inputRef} class="input" rows={1} value={input} onInput={handleInput} onKeyDown={handleKeyDown} />
        <button
          class={`send-btn ${isRunning ? "stop" : ""}`}
          disabled={!isRunning && !input.trim()}
          onClick={isRunning ? stopAutomation : sendMessage}
        >
          {isRunning ? <StopIcon /> : <SendIcon />}
        </button>
      </div>
    </div>
  );
}
