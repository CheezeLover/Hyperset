"use client";

import React from "react";

interface Page {
  name: string;
}

interface ServiceColumnProps {
  isPortraitMode: boolean;
  openPanelKeys: Set<string>;
  pages: Page[];
  pagesUrl: string;
  onToggleChat: () => void;
  onTogglePage: (name: string) => void;
  onDisconnect?: () => void;
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
      ? "var(--md-primary)"
      : "var(--md-secondary-cont)"
    : hovered
    ? isPrimary
      ? "var(--md-primary-cont)"
      : "var(--md-secondary-cont)"
    : "transparent";
  const iconColor = active && isPrimary
    ? "#ffffff"
    : isPrimary
    ? "var(--md-primary)"
    : "var(--md-on-sec-cont)";

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
          opacity: 1, // Always show at full opacity
          position: "relative",
          transition: "background 0.2s",
          // Never show shadow
          boxShadow: "none",
        }}
      >
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
  isPortraitMode,
  openPanelKeys,
  pages,
  pagesUrl: _pagesUrl,
  onToggleChat,
  onTogglePage,
  onDisconnect,
}: ServiceColumnProps) {
  return (
    <div
      style={{
        display: "flex",
        flexDirection: isPortraitMode ? "row" : "column",
        alignItems: "center",
        justifyContent: isPortraitMode ? "space-between" : "flex-start",
        padding: isPortraitMode ? "0 16px" : "8px 0",
        gap: isPortraitMode ? 8 : 4,
        width: isPortraitMode ? "100%" : 48,
        minWidth: isPortraitMode ? "100%" : 48,
        height: isPortraitMode ? 48 : "100%",
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

      {/* Spacer to push disconnect button to bottom (only in column mode) */}
      {!isPortraitMode && <div style={{ flex: 1 }} />}

      {/* Disconnect button at bottom */}
      {onDisconnect && (
        <ServiceBtn
          active={false}
          tooltip="Disconnect"
          onClick={onDisconnect}
          colorScheme="secondary"
        >
          <svg viewBox="0 0 24 24" width={20} height={20} fill="currentColor">
            <path d="M17 7l-1.41 1.41L18.17 11H8v2h10.17l-2.58 2.58L17 17l5-5zM4 5h8V3H4c-1.1 0-2 .9-2 2v14c0 1.1.9 2 2 2h8v-2H4V5z"/>
          </svg>
        </ServiceBtn>
      )}
    </div>
  );
}
