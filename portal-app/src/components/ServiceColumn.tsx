"use client";

import React from "react";

interface Page {
  name: string;
}

interface ServiceColumnProps {
  openPanelKeys: Set<string>;
  pages: Page[];
  pagesUrl: string;
  onToggleChat: () => void;
  onTogglePage: (name: string) => void;
}

function pageIcon(name: string) {
  const letter = name.charAt(0).toUpperCase();
  return (
    <svg viewBox="0 0 24 24" width={20} height={20}>
      <rect x="3" y="3" width="18" height="18" rx="4" fill="currentColor" opacity={0.15} />
      <text
        x="12"
        y="16.5"
        textAnchor="middle"
        fontSize="11"
        fontFamily="system-ui,sans-serif"
        fontWeight="600"
        fill="currentColor"
        opacity={0.9}
      >
        {letter}
      </text>
    </svg>
  );
}

function ServiceBtn({
  active,
  tooltip,
  onClick,
  colorScheme,
  children,
}: {
  active: boolean;
  tooltip: string;
  onClick: () => void;
  colorScheme: "primary" | "secondary";
  children: React.ReactNode;
}) {
  const [hovered, setHovered] = React.useState(false);

  const isPrimary = colorScheme === "primary";
  const bgColor = active
    ? isPrimary
      ? "var(--md-primary-cont)"
      : "var(--md-secondary-cont)"
    : hovered
    ? isPrimary
      ? "var(--md-primary-cont)"
      : "var(--md-secondary-cont)"
    : "transparent";
  const iconColor = isPrimary
    ? "var(--md-on-primary-cont)"
    : "var(--md-on-sec-cont)";
  const indicatorColor = isPrimary
    ? "var(--md-primary)"
    : "var(--md-secondary)";

  return (
    <div style={{ position: "relative" }}>
      <button
        onClick={onClick}
        onMouseEnter={() => setHovered(true)}
        onMouseLeave={() => setHovered(false)}
        title={tooltip}
        style={{
          width: 40,
          height: 40,
          border: "none",
          borderRadius: "var(--radius-m)",
          cursor: "pointer",
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          background: bgColor,
          color: iconColor,
          opacity: active || hovered ? 1 : 0.6,
          position: "relative",
          transition: "background 0.2s, opacity 0.2s",
          boxShadow: active
            ? "0 1px 4px rgba(0,0,0,.1), 0 2px 8px rgba(0,0,0,.06)"
            : "none",
        }}
      >
        {/* Active indicator bar */}
        {active && (
          <span
            style={{
              position: "absolute",
              left: 0,
              top: 8,
              bottom: 8,
              width: 3,
              borderRadius: "0 2px 2px 0",
              background: indicatorColor,
            }}
          />
        )}
        {children}
      </button>
      {/* Tooltip */}
      {hovered && (
        <div
          style={{
            position: "absolute",
            right: "calc(100% + 8px)",
            top: "50%",
            transform: "translateY(-50%)",
            background: "var(--md-surface-cont-hi)",
            color: "var(--md-on-surface)",
            padding: "4px 10px",
            borderRadius: 6,
            fontSize: 12,
            whiteSpace: "nowrap",
            pointerEvents: "none",
            boxShadow: "0 2px 8px rgba(0,0,0,.12)",
            zIndex: 999,
          }}
        >
          {tooltip}
        </div>
      )}
    </div>
  );
}

export function ServiceColumn({
  openPanelKeys,
  pages,
  pagesUrl: _pagesUrl,
  onToggleChat,
  onTogglePage,
}: ServiceColumnProps) {
  return (
    <div
      style={{
        display: "flex",
        flexDirection: "column",
        alignItems: "center",
        justifyContent: "flex-start",
        padding: "8px 0",
        gap: 4,
        width: 48,
        minWidth: 48,
        flexShrink: 0,
        background: "var(--md-surface)",
        zIndex: 20,
        order: 99,
      }}
    >
      {/* Chat button */}
      <ServiceBtn
        active={openPanelKeys.has("chat")}
        tooltip="Chat"
        onClick={onToggleChat}
        colorScheme="primary"
      >
        <svg viewBox="0 0 24 24" width={20} height={20} fill="currentColor">
          <path d="M20 2H4c-1.1 0-2 .9-2 2v18l4-4h14c1.1 0 2-.9 2-2V4c0-1.1-.9-2-2-2zm0 14H6l-2 2V4h16v12z" />
        </svg>
      </ServiceBtn>

      {/* Separator before pages */}
      {pages.length > 0 && (
        <div
          style={{
            width: 24,
            height: 1,
            background: "var(--md-outline-var)",
            margin: "4px 0",
          }}
        />
      )}

      {/* Dynamic page buttons */}
      {pages.map((page) => (
        <ServiceBtn
          key={page.name}
          active={openPanelKeys.has(`page:${page.name}`)}
          tooltip={page.name.charAt(0).toUpperCase() + page.name.slice(1)}
          onClick={() => onTogglePage(page.name)}
          colorScheme="secondary"
        >
          {pageIcon(page.name)}
        </ServiceBtn>
      ))}
    </div>
  );
}
