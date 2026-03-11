"use client";

import React, { useState, useRef, useCallback, useEffect } from "react";
import { SupersetPanel } from "./SupersetPanel";
import { ChatPanel, type Message } from "./ChatPanel";
import { ServiceColumn } from "./ServiceColumn";

interface Page {
  name: string;
  icon?: string;
  iconColor?: string;
}

interface HypersetLayoutProps {
  supersetUrl: string;
  pagesUrl: string;
  isAdmin: boolean;
  userId: string;
  userRoles: string[];
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
  userRoles,
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
  // Prevent resetting opened-page tracking on unrelated re-renders.
  const seededOpenedPageUrlRef = useRef<string | null>(null);
  // Chat message history — lifted here so it survives panel collapse/expand
  const [chatMessages, setChatMessages] = useState<Message[]>([]);
  const [isPortraitMode, setIsPortraitMode] = useState(false);
  const isPortraitModeRef = useRef(false);

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

  const isPortrait = () =>
    typeof window !== "undefined" && window.innerWidth < window.innerHeight;

  // ── Dynamic pages discovery ──────────────────────────────────
  const loadPages = useCallback(async () => {
    try {
      const res = await fetch(`${pagesUrl}/__pages__`, {
        credentials: "include",
      });
      if (!res.ok) return;
      const data = await res.json() as { pages: { name: string; has_backend: boolean }[] };
      
      const pageMetaRes = await fetch("/api/admin/pages", { credentials: "include" });
      const pageMeta = pageMetaRes.ok 
        ? (await pageMetaRes.json() as { pages: { name: string; active: boolean; allowedGroups: string[]; icon?: string; iconColor?: string }[] }).pages 
        : [];
      const metaMap = new Map(pageMeta.map((p) => [p.name, p]));
      
      const filteredPages: Page[] = (data.pages as { name: string; has_backend: boolean }[])
        .filter((p) => {
          const meta = metaMap.get(p.name);
          if (!meta) return true;
          if (!meta.active) return false;
          if (meta.allowedGroups.length === 0) return true;
          return meta.allowedGroups.some((g) => userRoles.includes(g));
        })
        .map((p) => {
          const meta = metaMap.get(p.name);
          return { 
            name: p.name, 
            icon: meta?.icon, 
            iconColor: meta?.iconColor 
          };
        });
      
      setPages((prev) => {
        const existingNames = new Set(prev.map((p) => p.name));
        const newPages = filteredPages.filter((p) => !existingNames.has(p.name));
        return newPages.length > 0 ? [...prev, ...newPages] : prev;
      });
    } catch {
      // Pages service unavailable — not a fatal error
    }
  }, [pagesUrl, userRoles]);

  useEffect(() => {
    loadPages();
    const id = setInterval(loadPages, 10_000);
    return () => clearInterval(id);
  }, [loadPages]);

  useEffect(() => {
    const updateOrientation = () => {
      const portrait = window.innerWidth < window.innerHeight;
      setIsPortraitMode(portrait);
      isPortraitModeRef.current = portrait;
    };
    updateOrientation();
    window.addEventListener("resize", updateOrientation);
    return () => window.removeEventListener("resize", updateOrientation);
  }, []);

  // ── Superset bridge: receive messages ────────────────────────
  useEffect(() => {
    const trustedOrigin = (() => {
      try {
        return new URL(supersetUrl).origin;
      } catch {
        return "";
      }
    })();

    const reportOpenedPage = (url: string, reason?: string) => {
      void fetch("/api/superset-opened-page", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ url, reason }),
      }).catch(() => {
        // Best-effort telemetry only.
      });
    };

    const requestOpenedPage = () => {
      supersetIframeRef.current?.contentWindow?.postMessage(
        { type: "get_location" },
        "*",
      );
      supersetIframeRef.current?.contentWindow?.postMessage(
        { type: "ping" },
        "*",
      );
    };

    // Seed only once per configured Superset URL.
    if (seededOpenedPageUrlRef.current !== supersetUrl) {
      reportOpenedPage(supersetUrl, "seed");
      seededOpenedPageUrlRef.current = supersetUrl;
    }
    // Ask bridge for the current live location.
    requestOpenedPage();
    const pollId = window.setInterval(requestOpenedPage, 5000);

    const handler = (event: MessageEvent) => {
      // Temporarily removing origin check for debugging
      
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
      } else if (msg?.type === "superset_location" && typeof msg.url === "string") {
        reportOpenedPage(msg.url, typeof msg.reason === "string" ? msg.reason : "superset_location");
      } else if (msg?.type === "ready") {
        reportOpenedPage(supersetUrl, "debug_received_ready");
        requestOpenedPage();
      } else if (msg?.type === "pong") {
        reportOpenedPage(supersetUrl, "debug_received_pong");
      }
    };
    window.addEventListener("message", handler);
    return () => {
      window.clearInterval(pollId);
      window.removeEventListener("message", handler);
    };
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
      const pos = isPortraitModeRef.current ? clientY - rect.top : clientX - rect.left;
      const size = isPortraitModeRef.current ? rect.height : rect.width;
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
      document.body.style.cursor = isPortraitModeRef.current ? "row-resize" : "col-resize";
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
      const pos = isPortraitModeRef.current ? e.clientY - rect.top : e.clientX - rect.left;
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
    <div
        id="hyperset-container"
        style={{
          display: "flex",
          width: "100%",
          height: "100%",
          flexDirection: isPortraitMode ? "column" : "row",
          background: "var(--md-surface)",
        }}
      >
        {/* Main Superset panel */}
        <div
          style={{
            flex: mainFlex,
            minWidth: isPortraitMode ? "100%" : 50,
            minHeight: isPortraitMode ? 50 : "100%",
            width: isPortraitMode ? "100%" : undefined,
            height: isPortraitMode ? "100%" : "100%",
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
              isPortrait={isPortraitMode}
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
                minWidth: isPortraitMode ? "100%" : 50,
                minHeight: isPortraitMode ? 50 : "100%",
                width: isPortraitMode ? "100%" : undefined,
                height: isPortraitMode ? "100%" : "100%",
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
                  messages={chatMessages}
                  onMessagesChange={setChatMessages}
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
          isPortraitMode={isPortraitMode}
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
          onDisconnect={() => {
            // Redirect to our logout API endpoint
            window.location.href = "/api/auth/logout";
          }}
        />
      </div>
  );
}

// ── Resizer handle ─────────────────────────────────────────────
function Resizer({
  isPortrait,
  colorClass,
  onMouseDown,
  onTouchStart,
}: {
  isPortrait: boolean;
  colorClass: "primary" | "secondary";
  onMouseDown: React.MouseEventHandler;
  onTouchStart: React.TouchEventHandler;
}) {
  const [hovered, setHovered] = useState(false);
  const backgroundColor = hovered 
    ? "var(--md-primary)" 
    : "var(--md-outline-var)";

  return (
    <div
      onMouseDown={onMouseDown}
      onTouchStart={onTouchStart}
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
      style={{
        width: isPortrait ? "100%" : 3,
        height: isPortrait ? 3 : "100%",
        background: backgroundColor,
        cursor: isPortrait ? "row-resize" : "col-resize",
        flexShrink: 0,
        zIndex: 10,
        transition: "background 0.2s",
      }}
    />
  );
}
