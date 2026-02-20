"use client";

import React, { useState, useEffect, useRef, useCallback } from "react";
import { useCopilotChat, useCopilotAction } from "@copilotkit/react-core";
import { TextMessage, MessageRole } from "@copilotkit/runtime-client-gql";
import type { Message } from "@copilotkit/runtime-client-gql";
import { AdminModal } from "./AdminModal";

interface ChatPanelProps {
  isAdmin: boolean;
  supersetIframeRef: React.RefObject<HTMLIFrameElement | null>;
  supersetUrl: string;
  injectedMessage: string | null;
  onInjectionConsumed: () => void;
}

// ── Navigation action handler (must be inside CopilotKit context) ──
function NavigationHandler({
  supersetIframeRef,
  supersetUrl,
}: {
  supersetIframeRef: React.RefObject<HTMLIFrameElement | null>;
  supersetUrl: string;
}) {
  const supersetOrigin = new URL(supersetUrl).origin;

  useCopilotAction({
    name: "navigate_superset_dashboard",
    description: "Navigate the Superset panel to show a specific dashboard.",
    parameters: [
      { name: "dashboardId", type: "string", description: "The dashboard ID or slug", required: true },
    ],
    handler: async ({ dashboardId }: { dashboardId: string }) => {
      supersetIframeRef.current?.contentWindow?.postMessage(
        { type: "navigate_dashboard", dashboardId },
        supersetOrigin
      );
      return `Navigated to dashboard ${dashboardId}`;
    },
  });

  useCopilotAction({
    name: "navigate_superset_chart",
    description: "Navigate the Superset panel to show a specific chart in Explore view.",
    parameters: [
      { name: "chartId", type: "string", description: "The chart ID to navigate to", required: true },
    ],
    handler: async ({ chartId }: { chartId: string }) => {
      supersetIframeRef.current?.contentWindow?.postMessage(
        { type: "navigate_chart", chartId },
        supersetOrigin
      );
      return `Opened chart ${chartId} in Explore`;
    },
  });

  return null;
}

// ── Render a single chat message ───────────────────────────────────
function ChatMessage({ message }: { message: Message }) {
  const isUser = message.role === "user";
  const isAssistant = message.role === "assistant";

  const text =
    typeof message.content === "string"
      ? message.content
      : Array.isArray(message.content)
      ? (message.content as Array<{ type: string; text?: string }>)
          .filter((c) => c.type === "text")
          .map((c) => c.text ?? "")
          .join("")
      : "";

  if (!text && !isAssistant) return null;

  return (
    <div
      style={{
        display: "flex",
        justifyContent: isUser ? "flex-end" : "flex-start",
        padding: "2px 12px",
      }}
    >
      <div
        style={{
          maxWidth: "88%",
          padding: isUser ? "8px 12px" : "8px 0",
          borderRadius: isUser ? "16px 16px 4px 16px" : 0,
          background: isUser ? "var(--md-primary)" : "transparent",
          color: isUser ? "#fff" : "var(--md-on-surface)",
          fontSize: 13.5,
          lineHeight: 1.55,
          whiteSpace: "pre-wrap",
          wordBreak: "break-word",
        }}
      >
        {text || <span style={{ opacity: 0.4, fontStyle: "italic" }}>…</span>}
      </div>
    </div>
  );
}

// ── Main chat panel ────────────────────────────────────────────────
export function ChatPanel({
  isAdmin,
  supersetIframeRef,
  supersetUrl,
  injectedMessage,
  onInjectionConsumed,
}: ChatPanelProps) {
  const [showAdminModal, setShowAdminModal] = useState(false);
  const [input, setInput] = useState("");
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);

  const { visibleMessages, appendMessage, isLoading } = useCopilotChat();

  // Auto-scroll to bottom when new messages arrive
  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [visibleMessages, isLoading]);

  // Inject message from Superset "inspect_chart"
  useEffect(() => {
    if (!injectedMessage) return;
    setInput(injectedMessage);
    inputRef.current?.focus();
    onInjectionConsumed();
  }, [injectedMessage, onInjectionConsumed]);

  const handleSend = useCallback(async () => {
    const text = input.trim();
    if (!text || isLoading) return;
    setInput("");
    await appendMessage(
      new TextMessage({ role: MessageRole.User, content: text })
    );
  }, [input, isLoading, appendMessage]);

  const handleKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      handleSend();
    }
  };

  // Auto-resize textarea
  const handleInput = (e: React.ChangeEvent<HTMLTextAreaElement>) => {
    setInput(e.target.value);
    const el = e.target;
    el.style.height = "auto";
    el.style.height = Math.min(el.scrollHeight, 120) + "px";
  };

  const isEmpty = visibleMessages.length === 0;

  return (
    <div className="hs-chat-panel">
      <NavigationHandler supersetIframeRef={supersetIframeRef} supersetUrl={supersetUrl} />

      {/* ── Header ── */}
      <div className="hs-chat-header">
        <svg viewBox="0 0 24 24" width={15} height={15} fill="var(--md-primary)" style={{ flexShrink: 0 }}>
          <path d="M20 2H4c-1.1 0-2 .9-2 2v18l4-4h14c1.1 0 2-.9 2-2V4c0-1.1-.9-2-2-2z" />
        </svg>
        <span className="hs-chat-header-title">Chat</span>
        <span className="hs-chat-header-spacer" />
        {isAdmin && (
          <button
            className="hs-chat-icon-btn"
            onClick={() => setShowAdminModal(true)}
            title="LLM settings"
            aria-label="LLM settings"
          >
            <svg viewBox="0 0 24 24" width={14} height={14} fill="currentColor">
              <path d="M19.14,12.94c0.04-0.3,0.06-0.61,0.06-0.94c0-0.32-0.02-0.64-0.07-0.94l2.03-1.58c0.18-0.14,0.23-0.41,0.12-0.61l-1.92-3.32c-0.12-0.22-0.37-0.29-0.59-0.22l-2.39,0.96c-0.5-0.38-1.03-0.7-1.62-0.94L14.4,2.81c-0.04-0.24-0.24-0.41-0.48-0.41h-3.84c-0.24,0-0.43,0.17-0.47,0.41L9.25,5.35C8.66,5.59,8.12,5.92,7.63,6.29L5.24,5.33c-0.22-0.08-0.47,0-0.59,0.22L2.74,8.87C2.62,9.08,2.66,9.34,2.86,9.48l2.03,1.58C4.84,11.36,4.8,11.69,4.8,12s0.02,0.64,0.07,0.94l-2.03,1.58c-0.18,0.14-0.23,0.41-0.12,0.61l1.92,3.32c0.12,0.22,0.37,0.29,0.59,0.22l2.39-0.96c0.5,0.38,1.03,0.7,1.62,0.94l0.36,2.54c0.05,0.24,0.24,0.41,0.48,0.41h3.84c0.24,0,0.44-0.17,0.47-0.41l0.36-2.54c0.59-0.24,1.13-0.56,1.62-0.94l2.39,0.96c0.22,0.08,0.47,0,0.59-0.22l1.92-3.32c0.12-0.22,0.07-0.47-0.12-0.61L19.14,12.94z M12,15.6c-1.98,0-3.6-1.62-3.6-3.6s1.62-3.6,3.6-3.6s3.6,1.62,3.6,3.6S13.98,15.6,12,15.6z" />
            </svg>
          </button>
        )}
      </div>

      {/* ── Messages ── */}
      <div className="hs-chat-messages">
        {isEmpty && (
          <div className="hs-chat-empty">
            <div className="hs-chat-empty-icon">
              <svg viewBox="0 0 24 24" width={28} height={28} fill="var(--md-primary)">
                <path d="M20 2H4c-1.1 0-2 .9-2 2v18l4-4h14c1.1 0 2-.9 2-2V4c0-1.1-.9-2-2-2z" />
              </svg>
            </div>
            <p className="hs-chat-empty-title">Hyperset Assistant</p>
            <p className="hs-chat-empty-sub">Ask anything about your data, dashboards, or charts.</p>
          </div>
        )}
        {visibleMessages.map((msg, i) => (
          <ChatMessage key={i} message={msg} />
        ))}
        {isLoading && (
          <div style={{ padding: "4px 12px" }}>
            <div className="hs-chat-typing">
              <span /><span /><span />
            </div>
          </div>
        )}
        <div ref={messagesEndRef} />
      </div>

      {/* ── Input bar ── */}
      <div className="hs-chat-input-bar">
        <textarea
          ref={inputRef}
          className="hs-chat-textarea"
          value={input}
          onChange={handleInput}
          onKeyDown={handleKeyDown}
          placeholder="Message…"
          rows={1}
          disabled={isLoading}
        />
        <button
          className="hs-chat-send-btn"
          onClick={handleSend}
          disabled={!input.trim() || isLoading}
          aria-label="Send"
        >
          <svg viewBox="0 0 24 24" width={16} height={16} fill="currentColor">
            <path d="M2.01 21L23 12 2.01 3 2 10l15 2-15 2z" />
          </svg>
        </button>
      </div>

      {showAdminModal && <AdminModal onClose={() => setShowAdminModal(false)} />}
    </div>
  );
}
