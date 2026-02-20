"use client";

import React, { useState, useEffect, useRef, useCallback } from "react";
import {
  CopilotChat,
} from "@copilotkit/react-ui";
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

function NavigationHandler({
  supersetIframeRef,
  supersetUrl,
}: {
  supersetIframeRef: React.RefObject<HTMLIFrameElement | null>;
  supersetUrl: string;
}) {
  const supersetOrigin = new URL(supersetUrl).origin;

  // Register action to navigate Superset to a dashboard
  useCopilotAction({
    name: "navigate_superset_dashboard",
    description: "Navigate the Superset panel to show a specific dashboard.",
    parameters: [
      {
        name: "dashboardId",
        type: "string",
        description: "The dashboard ID or slug to navigate to",
        required: true,
      },
    ],
    handler: async ({ dashboardId }: { dashboardId: string }) => {
      supersetIframeRef.current?.contentWindow?.postMessage(
        { type: "navigate_dashboard", dashboardId },
        supersetOrigin
      );
      return `Navigating Superset to dashboard ${dashboardId}`;
    },
    render: ({ status, result }) => (
      <div className="tool-step" style={{ display: "block" }}>
        <details>
          <summary>
            {status === "executing"
              ? "Navigating to dashboard..."
              : `Opened dashboard ${result?.split(" ").pop()}`}
          </summary>
          <pre>{result ?? "..."}</pre>
        </details>
      </div>
    ),
  });

  // Register action to navigate Superset to a chart
  useCopilotAction({
    name: "navigate_superset_chart",
    description: "Navigate the Superset panel to show a specific chart in Explore view.",
    parameters: [
      {
        name: "chartId",
        type: "string",
        description: "The chart ID to navigate to",
        required: true,
      },
    ],
    handler: async ({ chartId }: { chartId: string }) => {
      supersetIframeRef.current?.contentWindow?.postMessage(
        { type: "navigate_chart", chartId },
        supersetOrigin
      );
      return `Navigating Superset to chart ${chartId}`;
    },
    render: ({ status, result }) => (
      <div className="tool-step" style={{ display: "block" }}>
        <details>
          <summary>
            {status === "executing"
              ? "Opening chart in Explore..."
              : `Opened chart ${result?.split(" ").pop()}`}
          </summary>
          <pre>{result ?? "..."}</pre>
        </details>
      </div>
    ),
  });

  return null;
}

export function ChatPanel({
  isAdmin,
  supersetIframeRef,
  supersetUrl,
  injectedMessage,
  onInjectionConsumed,
}: ChatPanelProps) {
  const [showAdminModal, setShowAdminModal] = useState(false);
  const chatRef = useRef<HTMLDivElement>(null);

  // Inject message into chat input when Superset sends "inspect_chart"
  useEffect(() => {
    if (!injectedMessage) return;
    // Find CopilotKit textarea and set its value
    const textarea = chatRef.current?.querySelector(
      "textarea, input[type='text']"
    ) as HTMLTextAreaElement | null;
    if (textarea) {
      const nativeInputValueSetter = Object.getOwnPropertyDescriptor(
        window.HTMLTextAreaElement.prototype,
        "value"
      )?.set;
      if (nativeInputValueSetter) {
        nativeInputValueSetter.call(textarea, injectedMessage);
        textarea.dispatchEvent(new Event("input", { bubbles: true }));
        textarea.focus();
      }
    }
    onInjectionConsumed();
  }, [injectedMessage, onInjectionConsumed]);

  return (
    <div
      style={{
        display: "flex",
        flexDirection: "column",
        height: "100%",
        background: "var(--md-surface-cont)",
      }}
    >
      {/* Panel header */}
      <div
        style={{
          display: "flex",
          alignItems: "center",
          padding: "8px 12px",
          borderBottom: "1px solid var(--md-outline-var)",
          gap: 8,
          minHeight: 44,
          flexShrink: 0,
        }}
      >
        <svg
          viewBox="0 0 24 24"
          width={18}
          height={18}
          fill="var(--md-primary)"
        >
          <path d="M20 2H4c-1.1 0-2 .9-2 2v18l4-4h14c1.1 0 2-.9 2-2V4c0-1.1-.9-2-2-2zm0 14H6l-2 2V4h16v12z" />
        </svg>
        <span
          style={{
            fontSize: 13,
            fontWeight: 600,
            color: "var(--md-on-surface)",
            flex: 1,
          }}
        >
          Chat
        </span>

        {/* Admin settings button — only visible to admins */}
        {isAdmin && (
          <button
            onClick={() => setShowAdminModal(true)}
            title="Admin LLM settings"
            style={{
              width: 30,
              height: 30,
              border: "none",
              borderRadius: "var(--radius-m)",
              cursor: "pointer",
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              background: "var(--md-secondary-cont)",
              color: "var(--md-on-sec-cont)",
              transition: "background 0.2s",
            }}
          >
            <svg viewBox="0 0 24 24" width={16} height={16} fill="currentColor">
              <path d="M19.14,12.94c0.04-0.3,0.06-0.61,0.06-0.94c0-0.32-0.02-0.64-0.07-0.94l2.03-1.58c0.18-0.14,0.23-0.41,0.12-0.61 l-1.92-3.32c-0.12-0.22-0.37-0.29-0.59-0.22l-2.39,0.96c-0.5-0.38-1.03-0.7-1.62-0.94L14.4,2.81c-0.04-0.24-0.24-0.41-0.48-0.41 h-3.84c-0.24,0-0.43,0.17-0.47,0.41L9.25,5.35C8.66,5.59,8.12,5.92,7.63,6.29L5.24,5.33c-0.22-0.08-0.47,0-0.59,0.22L2.74,8.87 C2.62,9.08,2.66,9.34,2.86,9.48l2.03,1.58C4.84,11.36,4.8,11.69,4.8,12s0.02,0.64,0.07,0.94l-2.03,1.58 c-0.18,0.14-0.23,0.41-0.12,0.61l1.92,3.32c0.12,0.22,0.37,0.29,0.59,0.22l2.39-0.96c0.5,0.38,1.03,0.7,1.62,0.94l0.36,2.54 c0.05,0.24,0.24,0.41,0.48,0.41h3.84c0.24,0,0.44-0.17,0.47-0.41l0.36-2.54c0.59-0.24,1.13-0.56,1.62-0.94l2.39,0.96 c0.22,0.08,0.47,0,0.59-0.22l1.92-3.32c0.12-0.22,0.07-0.47-0.12-0.61L19.14,12.94z M12,15.6c-1.98,0-3.6-1.62-3.6-3.6 s1.62-3.6,3.6-3.6s3.6,1.62,3.6,3.6S13.98,15.6,12,15.6z" />
            </svg>
          </button>
        )}
      </div>

      {/* CopilotKit chat — fills remaining height */}
      <div ref={chatRef} style={{ flex: 1, overflow: "hidden", position: "relative" }}>
        <NavigationHandler
          supersetIframeRef={supersetIframeRef}
          supersetUrl={supersetUrl}
        />
        <CopilotChat
          className="copilotKitChat"
          instructions={`You are Hyperset, an intelligent assistant for Apache Superset analytics.
You have access to the full Superset MCP API (dashboards, charts, SQL execution, datasets, databases).
When users ask to navigate to a dashboard or chart, use navigate_superset_dashboard or navigate_superset_chart.
Always present SQL query results clearly with key insights.
When creating charts or dashboards, confirm what was created and offer to open it.`}
          labels={{
            title: "Hyperset Assistant",
            initial: "Hello! I can help you explore your data, run queries, create dashboards and charts. What would you like to do?",
          }}
        />
      </div>

      {/* Admin modal */}
      {showAdminModal && (
        <AdminModal onClose={() => setShowAdminModal(false)} />
      )}
    </div>
  );
}
