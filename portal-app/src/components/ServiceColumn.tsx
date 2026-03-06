"use client";

import React from "react";

interface Page {
  name: string;
}

interface ServiceColumnProps {
  openPanelKeys: Set<string>;
  pages: Page[];
  pagesUrl: string;
  isAdmin: boolean;
  onToggleChat: () => void;
  onTogglePage: (name: string) => void;
  onShowSettings?: () => void;
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
      ? "var(--md-primary-cont)"
      : "var(--md-secondary-cont)"
    : hovered
    ? isPrimary
      ? "var(--md-primary-cont)"
      : "var(--md-secondary-cont)"
    : "transparent";
  const iconColor = active || hovered
    ? isPrimary
      ? "var(--md-on-primary-cont)"  // Dark text on orange background when selected
      : "var(--md-on-sec-cont)"
    : isPrimary
      ? "var(--md-icon-primary)"  // Orange icon on transparent background
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
  openPanelKeys,
  pages,
  pagesUrl: _pagesUrl,
  isAdmin,
  onToggleChat,
  onTogglePage,
  onShowSettings,
  onDisconnect,
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

      {/* Spacer to push buttons to bottom */}
      <div style={{ flex: 1 }} />

      {/* Settings button — admin only */}
      {isAdmin && onShowSettings && (
        <ServiceBtn
          active={false}
          tooltip="LLM settings"
          onClick={onShowSettings}
          colorScheme="secondary"
        >
          <svg viewBox="0 0 24 24" width={20} height={20} fill="currentColor">
            <path d="M19.14,12.94c0.04-0.3,0.06-0.61,0.06-0.94c0-0.32-0.02-0.64-0.07-0.94l2.03-1.58c0.18-0.14,0.23-0.41,0.12-0.61l-1.92-3.32c-0.12-0.22-0.37-0.29-0.59-0.22l-2.39,0.96c-0.5-0.38-1.03-0.7-1.62-0.94L14.4,2.81c-0.04-0.24-0.24-0.41-0.48-0.41h-3.84c-0.24,0-0.43,0.17-0.47,0.41L9.25,5.35C8.66,5.59,8.12,5.92,7.63,6.29L5.24,5.33c-0.22-0.08-0.47,0-0.59,0.22L2.74,8.87C2.62,9.08,2.66,9.34,2.86,9.48l2.03,1.58C4.84,11.36,4.8,11.69,4.8,12s0.02,0.64,0.07,0.94l-2.03,1.58c-0.18,0.14-0.23,0.41-0.12,0.61l1.92,3.32c0.12,0.22,0.37,0.29,0.59,0.22l2.39-0.96c0.5,0.38,1.03,0.7,1.62,0.94l0.36,2.54c0.05,0.24,0.24,0.41,0.48,0.41h3.84c0.24,0,0.44-0.17,0.47-0.41l0.36-2.54c0.59-0.24,1.13-0.56,1.62-0.94l2.39,0.96c0.22,0.08,0.47,0,0.59-0.22l1.92-3.32c0.12-0.22,0.07-0.47-0.12-0.61L19.14,12.94z M12,15.6c-1.98,0-3.6-1.62-3.6-3.6s1.62-3.6,3.6-3.6s3.6,1.62,3.6,3.6S13.98,15.6,12,15.6z" />
          </svg>
        </ServiceBtn>
      )}

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
