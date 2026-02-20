"use client";

import React, { useState, useRef, useCallback, useEffect } from "react";
import { CopilotKit } from "@copilotkit/react-core";
import { SupersetPanel } from "./SupersetPanel";
import { ChatPanel } from "./ChatPanel";
import { ServiceColumn } from "./ServiceColumn";

interface Page {
  name: string;
}

interface HypersetLayoutProps {
  supersetUrl: string;
  pagesUrl: string;
  isAdmin: boolean;
  userId: string;
}

interface PanelState {
  key: string;
  flex: number;
  url: string;
  title: string;
  resizerColor: "primary" | "secondary";
}

const MIN_FLEX = 5;
const DEFAULT_CHAT_FLEX = 30;
const DEFAULT_PAGE_FLEX = 30;

export function HypersetLayout({
  supersetUrl,
  pagesUrl,
  isAdmin,
  userId,
}: HypersetLayoutProps) {
  const [mainFlex, setMainFlex] = useState(100);
  const [panels, setPanels] = useState<PanelState[]>([]);
  const [pages, setPages] = useState<Page[]>([]);
  // Map key → last used flex (persists across open/close)
  const lastFlex = useRef<Record<string, number>>({});
  // Chat input to pre-fill when Superset sends "inspect_chart" message
  const [chatInjection, setChatInjection] = useState<string | null>(null);
  // Ref to Superset iframe for postMessage
  const supersetIframeRef = useRef<HTMLIFrameElement>(null);

  // Drag state
  const dragging = useRef<{
    key: string;
    startPos: number;
    startMainFlex: number;
    startPanelFlex: number;
    containerSize: number;
    totalFlex: number;
  } | null>(null);

  const isMobile = () =>
    typeof window !== "undefined" && window.innerWidth <= 768;

  // ── Dynamic pages discovery ──────────────────────────────────
  const loadPages = useCallback(async () => {
    try {
      const res = await fetch(`${pagesUrl}/__pages__`, {
        credentials: "include",
      });
      if (!res.ok) return;
      const data = await res.json();
      setPages((prev) => {
        const existingNames = new Set(prev.map((p) => p.name));
        const newPages: Page[] = (data.pages as Page[]).filter(
          (p) => !existingNames.has(p.name)
        );
        return newPages.length > 0 ? [...prev, ...newPages] : prev;
      });
    } catch {
      // Pages service unavailable — not a fatal error
    }
  }, [pagesUrl]);

  useEffect(() => {
    loadPages();
    const id = setInterval(loadPages, 10_000);
    return () => clearInterval(id);
  }, [loadPages]);

  // ── Superset bridge: receive messages ────────────────────────
  useEffect(() => {
    const handler = (event: MessageEvent) => {
      if (event.origin !== new URL(supersetUrl).origin) return;
      const msg = event.data;
      if (msg?.type === "inspect_chart") {
        const context = [
          `Chart: ${msg.chartTitle}`,
          msg.datasource ? `Datasource: ${msg.datasource}` : "",
          msg.query ? `SQL: ${msg.query}` : "",
        ]
          .filter(Boolean)
          .join("\n");
        setChatInjection(context);
        // Auto-open chat panel if not open
        setPanels((prev) => {
          if (prev.some((p) => p.key === "chat")) return prev;
          const flex =
            lastFlex.current["chat"] ?? DEFAULT_CHAT_FLEX;
          const actualFlex = Math.min(flex, mainFlex - MIN_FLEX);
          if (actualFlex <= 0) return prev;
          setMainFlex((mf) => mf - actualFlex);
          return [
            ...prev,
            {
              key: "chat",
              flex: actualFlex,
              url: "",
              title: "Chat",
              resizerColor: "primary",
            },
          ];
        });
      }
    };
    window.addEventListener("message", handler);
    return () => window.removeEventListener("message", handler);
  }, [supersetUrl, mainFlex]);

  // ── Toggle a side panel ──────────────────────────────────────
  const togglePanel = useCallback(
    (key: string, url: string, title: string, resizerColor: "primary" | "secondary") => {
      setPanels((prev) => {
        const idx = prev.findIndex((p) => p.key === key);
        if (idx !== -1) {
          // Collapse
          const removed = prev[idx];
          lastFlex.current[key] = removed.flex;
          setMainFlex((mf) => mf + removed.flex);
          return prev.filter((_, i) => i !== idx);
        } else {
          // Expand
          const flex = lastFlex.current[key] ?? (key === "chat" ? DEFAULT_CHAT_FLEX : DEFAULT_PAGE_FLEX);
          setMainFlex((mf) => {
            const actual = Math.min(flex, mf - MIN_FLEX);
            if (actual <= 0) return mf;
            const panel: PanelState = { key, flex: actual, url, title, resizerColor };
            setPanels((p2) => [...p2, panel]);
            return mf - actual;
          });
          return prev; // Will be updated by the inner setPanels
        }
      });
    },
    []
  );

  // Simpler toggle that avoids setState-in-setState anti-pattern
  const handleTogglePanel = useCallback(
    (key: string, url: string, title: string, resizerColor: "primary" | "secondary") => {
      setPanels((prev) => {
        const idx = prev.findIndex((p) => p.key === key);
        if (idx !== -1) {
          const removed = prev[idx];
          lastFlex.current[key] = removed.flex;
          setMainFlex((mf) => mf + removed.flex);
          return prev.filter((_, i) => i !== idx);
        } else {
          const flex = lastFlex.current[key] ?? (key === "chat" ? DEFAULT_CHAT_FLEX : DEFAULT_PAGE_FLEX);
          const actualFlex = Math.min(flex, mainFlex - MIN_FLEX);
          if (actualFlex <= 0) return prev;
          setMainFlex((mf) => mf - actualFlex);
          return [
            ...prev,
            { key, flex: actualFlex, url, title, resizerColor },
          ];
        }
      });
    },
    [mainFlex]
  );

  // ── Drag resize ───────────────────────────────────────────────
  const startResize = useCallback(
    (key: string, clientX: number, clientY: number) => {
      const container = document.getElementById("hyperset-container");
      if (!container) return;
      const rect = container.getBoundingClientRect();
      const pos = isMobile() ? clientY - rect.top : clientX - rect.left;
      const size = isMobile() ? rect.height : rect.width;
      const panel = panels.find((p) => p.key === key);
      if (!panel) return;
      dragging.current = {
        key,
        startPos: pos,
        startMainFlex: mainFlex,
        startPanelFlex: panel.flex,
        containerSize: size,
        totalFlex: mainFlex + panel.flex,
      };
      // Disable iframe pointer events during drag
      document.querySelectorAll("iframe").forEach((f) => {
        (f as HTMLIFrameElement).style.pointerEvents = "none";
      });
      document.body.style.cursor = isMobile() ? "row-resize" : "col-resize";
      document.body.style.userSelect = "none";
    },
    [mainFlex, panels]
  );

  useEffect(() => {
    const handleMouseMove = (e: MouseEvent) => {
      if (!dragging.current) return;
      e.preventDefault();
      const container = document.getElementById("hyperset-container");
      if (!container) return;
      const rect = container.getBoundingClientRect();
      const pos = isMobile() ? e.clientY - rect.top : e.clientX - rect.left;
      const d = dragging.current;
      const delta = pos - d.startPos;
      const flexPerPx = d.totalFlex / d.containerSize;
      const deltaFlex = delta * flexPerPx;
      const newMain = Math.max(
        MIN_FLEX,
        Math.min(d.totalFlex - MIN_FLEX, d.startMainFlex + deltaFlex)
      );
      const newPanel = d.totalFlex - newMain;
      setMainFlex(newMain);
      setPanels((prev) =>
        prev.map((p) =>
          p.key === d.key ? { ...p, flex: newPanel } : p
        )
      );
    };

    const handleMouseUp = () => {
      if (!dragging.current) return;
      if (dragging.current) {
        // Persist last flex
        const d = dragging.current;
        setPanels((prev) => {
          const p = prev.find((x) => x.key === d.key);
          if (p) lastFlex.current[d.key] = p.flex;
          return prev;
        });
      }
      dragging.current = null;
      document.querySelectorAll("iframe").forEach((f) => {
        (f as HTMLIFrameElement).style.pointerEvents = "";
      });
      document.body.style.cursor = "";
      document.body.style.userSelect = "";
    };

    document.addEventListener("mousemove", handleMouseMove);
    document.addEventListener("mouseup", handleMouseUp);
    document.addEventListener("touchmove", (e) => {
      if (dragging.current) {
        e.preventDefault();
        handleMouseMove(e.touches[0] as unknown as MouseEvent);
      }
    }, { passive: false });
    document.addEventListener("touchend", handleMouseUp);
    document.addEventListener("touchcancel", handleMouseUp);

    return () => {
      document.removeEventListener("mousemove", handleMouseMove);
      document.removeEventListener("mouseup", handleMouseUp);
    };
  }, []);

  const openPanelKeys = new Set(panels.map((p) => p.key));

  return (
    <CopilotKit runtimeUrl="/api/chat">
      <div
        id="hyperset-container"
        style={{
          display: "flex",
          width: "100%",
          height: "100%",
          flexDirection: "row",
          background: "var(--md-surface)",
        }}
      >
        {/* Main Superset panel */}
        <div
          style={{
            flex: mainFlex,
            minWidth: 50,
            height: "100%",
            overflow: "hidden",
            background: "var(--md-surface-cont)",
          }}
        >
          <SupersetPanel
            src={supersetUrl}
            iframeRef={supersetIframeRef}
          />
        </div>

        {/* Side panels + resizers */}
        {panels.map((panel) => (
          <React.Fragment key={panel.key}>
            {/* Resizer */}
            <Resizer
              colorClass={panel.resizerColor}
              onMouseDown={(e) => startResize(panel.key, e.clientX, e.clientY)}
              onTouchStart={(e) =>
                startResize(
                  panel.key,
                  e.touches[0].clientX,
                  e.touches[0].clientY
                )
              }
            />
            {/* Panel */}
            <div
              style={{
                flex: panel.flex,
                minWidth: 50,
                height: "100%",
                overflow: "hidden",
                background: "var(--md-surface-cont)",
                display: "flex",
                flexDirection: "column",
              }}
            >
              {panel.key === "chat" ? (
                <ChatPanel
                  isAdmin={isAdmin}
                  supersetIframeRef={supersetIframeRef}
                  supersetUrl={supersetUrl}
                  injectedMessage={chatInjection}
                  onInjectionConsumed={() => setChatInjection(null)}
                />
              ) : (
                <iframe
                  src={panel.url}
                  title={panel.title}
                  style={{
                    flex: 1,
                    border: "none",
                    width: "100%",
                    height: "100%",
                  }}
                />
              )}
            </div>
          </React.Fragment>
        ))}

        {/* Service column (icon strip) */}
        <ServiceColumn
          openPanelKeys={openPanelKeys}
          pages={pages}
          pagesUrl={pagesUrl}
          onToggleChat={() =>
            handleTogglePanel("chat", "", "Chat", "primary")
          }
          onTogglePage={(name) =>
            handleTogglePanel(
              `page:${name}`,
              `${pagesUrl}/${name}`,
              name.charAt(0).toUpperCase() + name.slice(1),
              "secondary"
            )
          }
        />
      </div>
    </CopilotKit>
  );
}

// ── Resizer handle ─────────────────────────────────────────────
function Resizer({
  colorClass,
  onMouseDown,
  onTouchStart,
}: {
  colorClass: "primary" | "secondary";
  onMouseDown: React.MouseEventHandler;
  onTouchStart: React.TouchEventHandler;
}) {
  const [hovered, setHovered] = useState(false);
  const color =
    colorClass === "primary"
      ? "var(--md-primary)"
      : "var(--md-secondary)";
  const mutedColor =
    colorClass === "primary"
      ? "var(--md-primary-muted)"
      : "var(--md-secondary-muted)";

  return (
    <div
      onMouseDown={onMouseDown}
      onTouchStart={onTouchStart}
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
      style={{
        width: 12,
        background: "transparent",
        cursor: "col-resize",
        flexShrink: 0,
        position: "relative",
        zIndex: 10,
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
      }}
    >
      <div
        style={{
          position: "absolute",
          top: "50%",
          left: "50%",
          transform: "translate(-50%, -50%)",
          width: hovered ? 4 : 3,
          height: hovered ? 56 : 32,
          borderRadius: 2,
          background: hovered ? mutedColor : "var(--md-outline-var)",
          opacity: hovered ? 1 : 0.5,
          transition: "all 0.2s",
          pointerEvents: "none",
        }}
      />
    </div>
  );
}
