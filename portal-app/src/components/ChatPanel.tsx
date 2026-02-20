"use client";

import React, { useState, useEffect, useRef, useCallback } from "react";
import { CopilotChat } from "@copilotkit/react-ui";
import { useCopilotAction } from "@copilotkit/react-core";
import type { SupersetToPortal } from "@/lib/superset-bridge";
import { AdminModal } from "./AdminModal";

interface ChatPanelProps {
  isAdmin: boolean;
  supersetIframeRef: React.RefObject<HTMLIFrameElement | null>;
  supersetUrl: string;
  injectedMessage: string | null;
  onInjectionConsumed: () => void;
}

// ── Navigation actions (must live inside CopilotKit context) ────
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
      { name: "dashboardId", type: "string", description: "The dashboard ID or slug to navigate to", required: true },
    ],
    handler: async ({ dashboardId }: { dashboardId: string }) => {
      supersetIframeRef.current?.contentWindow?.postMessage(
        { type: "navigate_dashboard", dashboardId }, supersetOrigin
      );
      return `Navigated to dashboard ${dashboardId}`;
    },
    render: ({ status, result }) => (
      <div className="tool-step" style={{ display: "block" }}>
        <details>
          <summary>{status === "executing" ? "Navigating to dashboard…" : `Opened dashboard ${result?.split(" ").pop()}`}</summary>
          <pre>{result ?? "…"}</pre>
        </details>
      </div>
    ),
  });

  useCopilotAction({
    name: "navigate_superset_chart",
    description: "Navigate the Superset panel to show a specific chart in Explore view.",
    parameters: [
      { name: "chartId", type: "string", description: "The chart ID to navigate to", required: true },
    ],
    handler: async ({ chartId }: { chartId: string }) => {
      supersetIframeRef.current?.contentWindow?.postMessage(
        { type: "navigate_chart", chartId }, supersetOrigin
      );
      return `Opened chart ${chartId} in Explore`;
    },
    render: ({ status, result }) => (
      <div className="tool-step" style={{ display: "block" }}>
        <details>
          <summary>{status === "executing" ? "Opening chart in Explore…" : `Opened chart ${result?.split(" ").pop()}`}</summary>
          <pre>{result ?? "…"}</pre>
        </details>
      </div>
    ),
  });

  return null;
}

// ── Error banner with copy button ───────────────────────────────
function ChatErrorBanner({
  error,
  detail,
  isAdmin,
  onOpenSettings,
  onDismiss,
}: {
  error: string;
  detail?: string;
  isAdmin: boolean;
  onOpenSettings: () => void;
  onDismiss: () => void;
}) {
  const [copied, setCopied] = useState(false);

  const handleCopy = useCallback(() => {
    const text = [error, detail ? `Detail: ${detail}` : ""].filter(Boolean).join("\n");
    navigator.clipboard.writeText(text).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    });
  }, [error, detail]);

  return (
    <div
      style={{
        margin: "8px 10px 0",
        padding: "10px 12px",
        borderRadius: 10,
        background: "rgba(211,47,47,0.10)",
        border: "1px solid rgba(211,47,47,0.28)",
        display: "flex",
        flexDirection: "column",
        gap: 6,
        fontSize: 12,
      }}
    >
      <div style={{ display: "flex", alignItems: "flex-start", gap: 8 }}>
        <span style={{ color: "#ef5350", fontWeight: 700, flexShrink: 0, fontSize: 14 }}>⚠</span>
        <span style={{ flex: 1, color: "var(--md-on-surface)", lineHeight: 1.5 }}>{error}</span>
        <button
          onClick={handleCopy}
          title="Copy error"
          style={{ border: "none", background: "none", cursor: "pointer", color: "var(--md-on-surface)", opacity: 0.5, fontSize: 13, flexShrink: 0, padding: "0 2px" }}
        >
          {copied ? "✓" : "⎘"}
        </button>
        <button
          onClick={onDismiss}
          title="Dismiss"
          style={{ border: "none", background: "none", cursor: "pointer", color: "var(--md-on-surface)", opacity: 0.4, fontSize: 15, flexShrink: 0, padding: "0 2px", lineHeight: 1 }}
        >
          ×
        </button>
      </div>
      {isAdmin && (
        <button
          onClick={onOpenSettings}
          style={{
            alignSelf: "flex-start",
            background: "none",
            border: "1px solid rgba(211,47,47,0.35)",
            borderRadius: 6,
            color: "#ef5350",
            fontSize: 11,
            padding: "3px 8px",
            cursor: "pointer",
          }}
        >
          Open LLM Settings
        </button>
      )}
    </div>
  );
}

// ── MCP warning banner (non-blocking, amber) ────────────────────
function McpWarningBanner({ message, onDismiss }: { message: string; onDismiss: () => void }) {
  return (
    <div style={{
      margin: "6px 10px 0",
      padding: "7px 12px",
      borderRadius: 8,
      background: "rgba(245,158,11,0.10)",
      border: "1px solid rgba(245,158,11,0.30)",
      display: "flex",
      alignItems: "center",
      gap: 8,
      fontSize: 11,
    }}>
      <span style={{ color: "#f59e0b", fontWeight: 700, flexShrink: 0 }}>⚡</span>
      <span style={{ flex: 1, color: "var(--md-on-surface)", opacity: 0.75, lineHeight: 1.4 }}>{message}</span>
      <button
        onClick={onDismiss}
        title="Dismiss"
        style={{ border: "none", background: "none", cursor: "pointer", color: "var(--md-on-surface)", opacity: 0.4, fontSize: 14, flexShrink: 0, padding: "0 2px", lineHeight: 1 }}
      >×</button>
    </div>
  );
}

// ── Main panel ──────────────────────────────────────────────────
export function ChatPanel({
  isAdmin,
  supersetIframeRef,
  supersetUrl,
  injectedMessage,
  onInjectionConsumed,
}: ChatPanelProps) {
  const [showAdminModal, setShowAdminModal] = useState(false);
  const [chatError, setChatError] = useState<{ error: string; detail?: string } | null>(null);
  const [mcpWarning, setMcpWarning] = useState<string | null>(null);
  const chatRef = useRef<HTMLDivElement>(null);

  // Probe the chat endpoint on mount to surface config errors and MCP status
  useEffect(() => {
    fetch("/api/chat")
      .then(async (res) => {
        try {
          const body = await res.json();
          if (!res.ok) {
            setChatError({ error: body.error ?? "Chat API error", detail: body.detail });
          } else if (body.mcpWarning) {
            setMcpWarning(body.mcpWarning);
          }
        } catch {
          if (!res.ok) setChatError({ error: `Chat API returned HTTP ${res.status}` });
        }
      })
      .catch(() => {
        // Network error — widget will show its own state
      });
  }, []);

  // Inject message from Superset bridge into CopilotKit textarea
  useEffect(() => {
    if (!injectedMessage) return;
    const textarea = chatRef.current?.querySelector(
      "textarea, input[type='text']"
    ) as HTMLTextAreaElement | null;
    if (textarea) {
      const setter = Object.getOwnPropertyDescriptor(
        window.HTMLTextAreaElement.prototype, "value"
      )?.set;
      if (setter) {
        setter.call(textarea, injectedMessage);
        textarea.dispatchEvent(new Event("input", { bubbles: true }));
        textarea.focus();
      }
    }
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
    <div style={{ display: "flex", flexDirection: "column", height: "100%", background: "var(--md-surface-cont)" }}>

      {/* Header */}
      <div style={{
        display: "flex", alignItems: "center", padding: "8px 12px",
        borderBottom: "1px solid var(--md-outline-var)", gap: 8, minHeight: 44, flexShrink: 0,
      }}>
        <svg viewBox="0 0 24 24" width={18} height={18} fill="var(--md-primary)">
          <path d="M20 2H4c-1.1 0-2 .9-2 2v18l4-4h14c1.1 0 2-.9 2-2V4c0-1.1-.9-2-2-2zm0 14H6l-2 2V4h16v12z" />
        </svg>
        <span style={{ fontSize: 13, fontWeight: 600, color: "var(--md-on-surface)", flex: 1 }}>Chat</span>

        {isAdmin && (
          <button
            className="hs-chat-icon-btn"
            onClick={() => setShowAdminModal(true)}
            title="LLM settings"
            style={{
              width: 30, height: 30, border: "none",
              borderRadius: "var(--radius-m)", cursor: "pointer",
              display: "flex", alignItems: "center", justifyContent: "center",
              background: chatError ? "rgba(211,47,47,0.15)" : "var(--md-secondary-cont)",
              color: chatError ? "#ef5350" : "var(--md-on-sec-cont)",
              transition: "background 0.2s",
            }}
          >
            <svg viewBox="0 0 24 24" width={16} height={16} fill="currentColor">
              <path d="M19.14,12.94c0.04-0.3,0.06-0.61,0.06-0.94c0-0.32-0.02-0.64-0.07-0.94l2.03-1.58c0.18-0.14,0.23-0.41,0.12-0.61l-1.92-3.32c-0.12-0.22-0.37-0.29-0.59-0.22l-2.39,0.96c-0.5-0.38-1.03-0.7-1.62-0.94L14.4,2.81c-0.04-0.24-0.24-0.41-0.48-0.41h-3.84c-0.24,0-0.43,0.17-0.47,0.41L9.25,5.35C8.66,5.59,8.12,5.92,7.63,6.29L5.24,5.33c-0.22-0.08-0.47,0-0.59,0.22L2.74,8.87C2.62,9.08,2.66,9.34,2.86,9.48l2.03,1.58C4.84,11.36,4.8,11.69,4.8,12s0.02,0.64,0.07,0.94l-2.03,1.58c-0.18,0.14-0.23,0.41-0.12,0.61l1.92,3.32c0.12,0.22,0.37,0.29,0.59,0.22l2.39-0.96c0.5,0.38,1.03,0.7,1.62,0.94l0.36,2.54c0.05,0.24,0.24,0.41,0.48,0.41h3.84c0.24,0,0.44-0.17,0.47-0.41l0.36-2.54c0.59-0.24,1.13-0.56,1.62-0.94l2.39,0.96c0.22,0.08,0.47,0,0.59-0.22l1.92-3.32c0.12-0.22,0.07-0.47-0.12-0.61L19.14,12.94z M12,15.6c-1.98,0-3.6-1.62-3.6-3.6s1.62-3.6,3.6-3.6s3.6,1.62,3.6,3.6S13.98,15.6,12,15.6z" />
            </svg>
          </button>
        )}
      </div>

      {/* Error banner (shown when /api/chat probe fails — blocks chat) */}
      {chatError && (
        <ChatErrorBanner
          error={chatError.error}
          detail={chatError.detail}
          isAdmin={isAdmin}
          onOpenSettings={() => setShowAdminModal(true)}
          onDismiss={() => setChatError(null)}
        />
      )}

      {/* MCP warning banner (non-blocking — chat still works without MCP) */}
      {mcpWarning && !chatError && (
        <McpWarningBanner message={mcpWarning} onDismiss={() => setMcpWarning(null)} />
      )}

      {/* CopilotKit chat widget */}
      <div ref={chatRef} style={{ flex: 1, overflow: "hidden", position: "relative" }}>
        <NavigationHandler supersetIframeRef={supersetIframeRef} supersetUrl={supersetUrl} />
        <CopilotChat
          className="copilotKitChat"
          instructions={`You are Hyperset, an intelligent assistant for Apache Superset analytics.
${mcpWarning
  ? "The Superset MCP data tools are currently unavailable. You can still have a conversation and answer general questions, but you cannot query data, list dashboards, or run SQL right now."
  : "You have access to the full Superset MCP API (dashboards, charts, SQL execution, datasets, databases). When users ask to navigate to a dashboard or chart, use navigate_superset_dashboard or navigate_superset_chart. Always present SQL query results clearly with key insights. When creating charts or dashboards, confirm what was created and offer to open it."}
When users ask to navigate to a dashboard or chart, use navigate_superset_dashboard or navigate_superset_chart.`}
          labels={{
            title: "Hyperset Assistant",
            initial: "Hello! I can help you explore your data, run queries, create dashboards and charts. What would you like to do?",
          }}
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

      {showAdminModal && (
        <AdminModal onClose={() => { setShowAdminModal(false); setChatError(null); }} />
      )}
    </div>
  );
}
