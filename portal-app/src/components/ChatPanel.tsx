"use client";

import React, { useState, useEffect, useRef, useCallback } from "react";
import { AdminModal } from "./AdminModal";

interface ChatPanelProps {
  isAdmin: boolean;
  supersetIframeRef: React.RefObject<HTMLIFrameElement | null>;
  supersetUrl: string;
  /** Current Superset URL tracked in the browser; sent with each chat request. */
  currentSupersetUrl?: string;
  injectedMessage: string | null;
  onInjectionConsumed: () => void;
  /** Lifted state — persists across panel collapse/expand */
  messages: Message[];
  onMessagesChange: (updater: (prev: Message[]) => Message[]) => void;
}

// ── Message types ────────────────────────────────────────────────
type Role = "user" | "assistant" | "tool";

interface ChatEvent {
  type: "delta" | "tool_call" | "tool_result" | "done" | "error" | "followup_suggestions";
  content?: string;
  name?: string;
  args?: Record<string, unknown>;
  result?: string;
  message?: string;
  suggestions?: unknown; // Will be validated as string[]
}

export interface ToolCall {
  name: string;
  args: Record<string, unknown>;
  result?: string;
}

export interface Message {
  id: string;
  role: Role;
  content: string;
  toolCalls?: ToolCall[];
  /** Follow-up suggestions for assistant messages */
  followupSuggestions?: string[];
  /** true while assistant is still streaming */
  streaming?: boolean;
}

// ── AI chart embed component ─────────────────────────────────────
// Renders an embedded Superset chart with a "Temporary / Keep permanently"
// toggle badge.  State is managed per-instance so toggling one chart doesn't
// affect others.
function AiChartEmbed({
  chartId,
  iframeUrl,
  iframeTitle,
  supersetUrl,
  onSupersetLinkClick,
}: {
  chartId: number;
  iframeUrl: string;
  iframeTitle: string;
  supersetUrl: string;
  onSupersetLinkClick?: (url: string) => void;
}) {
  const [status, setStatus] = useState<"temporary" | "saving" | "permanent">("temporary");

  const handlePromote = async () => {
    setStatus("saving");
    try {
      const res = await fetch("/api/chart-promote", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ chartId }),
      });
      setStatus(res.ok ? "permanent" : "temporary");
    } catch {
      setStatus("temporary");
    }
  };

  // Security: reuse the same trusted-domain logic as the regular [iframe] renderer
  const thirdPartyDomains = ["youtube.com", "youtu.be", "vimeo.com"];
  const supersetHostname = (() => { try { return new URL(supersetUrl).hostname; } catch { return ""; } })();
  const hypersetDomain = getHypersetDomain(supersetUrl);
  let trusted = false;
  try {
    const u = new URL(iframeUrl);
    const isThirdParty = thirdPartyDomains.some(d => u.hostname === d || u.hostname.endsWith("." + d));
    const isInternal =
      (supersetHostname !== "" && (u.hostname === supersetHostname || u.hostname.endsWith("." + supersetHostname))) ||
      (hypersetDomain  !== "" && (u.hostname === hypersetDomain  || u.hostname.endsWith("." + hypersetDomain)));
    const protocolOk = isInternal
      ? (u.protocol === "https:" || u.protocol === "http:")
      : u.protocol === "https:";
    trusted = (isThirdParty || isInternal) && protocolOk;
  } catch { /* invalid URL */ }

  if (!trusted) {
    return (
      <a href={iframeUrl} target="_blank" rel="noopener noreferrer"
        style={{ fontSize: 12, color: "var(--md-primary)", display: "block", margin: "4px 0" }}>
        {iframeTitle || iframeUrl}
      </a>
    );
  }

  return (
    <div style={{ margin: "12px 0" }}>
      {/* Clickable title */}
      <button
        onClick={() => onSupersetLinkClick?.(iframeUrl)}
        title="Open in Superset"
        style={{
          display: "inline-flex", alignItems: "center", gap: 4,
          background: "none", border: "none", padding: 0, marginBottom: 4,
          cursor: onSupersetLinkClick ? "pointer" : "default",
          fontSize: 11, fontWeight: 500, color: "var(--md-primary)", opacity: 0.85,
        }}
        onMouseOver={e => { e.currentTarget.style.opacity = "1"; e.currentTarget.style.textDecoration = "underline"; }}
        onMouseOut={e => { e.currentTarget.style.opacity = "0.85"; e.currentTarget.style.textDecoration = "none"; }}
      >
        {iframeTitle}
        <svg viewBox="0 0 16 16" width={10} height={10} fill="currentColor" style={{ opacity: 0.7, flexShrink: 0 }}>
          <path d="M2 2h5v1.5H3.5v9h9V11H14v4H2V2zm7 0h5v5h-1.5V4.56L7.28 9.78 6.22 8.72 11.44 3.5H9V2z"/>
        </svg>
      </button>

      {/* iframe */}
      <div style={{       border: "1px solid var(--md-outline-var)", borderRadius: "12px",
      overflow: "hidden", background: "var(--md-surface-cont)",
      boxShadow: "0 2px 8px rgba(0,0,0,0.06), 0 1px 3px rgba(0,0,0,0.04)",
    }}>
        <iframe
          src={iframeUrl}
          title={iframeTitle}
          style={{ width: "100%", height: "300px", border: "none", display: "block" }}
          sandbox="allow-scripts allow-same-origin allow-popups allow-forms"
          allowFullScreen
        />
      </div>

      {/* AI provenance badge + keep-permanently button — below the graph */}
      <div style={{ display: "flex", alignItems: "center", gap: 8, marginTop: 5 }}>
        {status === "permanent" ? (
          <span style={{
            fontSize: 11, fontWeight: 600, color: "#4caf50",
            display: "inline-flex", alignItems: "center", gap: 3,
          }}>
            <svg viewBox="0 0 16 16" width={11} height={11} fill="currentColor"><path d="M13.78 4.22a.75.75 0 0 1 0 1.06l-7.25 7.25a.75.75 0 0 1-1.06 0L2.22 9.28a.75.75 0 1 1 1.06-1.06L6 10.94l6.72-6.72a.75.75 0 0 1 1.06 0Z"/></svg>
            Saved permanently
          </span>
        ) : (
          <>
            <span style={{
              fontSize: 11, fontWeight: 600, color: "#ff9800",
              display: "inline-flex", alignItems: "center", gap: 3,
            }}>
              <svg viewBox="0 0 16 16" width={11} height={11} fill="currentColor"><path d="M8 1a7 7 0 1 1 0 14A7 7 0 0 1 8 1Zm0 1.5a5.5 5.5 0 1 0 0 11 5.5 5.5 0 0 0 0-11ZM8 4a.75.75 0 0 1 .75.75v3.5a.75.75 0 0 1-1.5 0v-3.5A.75.75 0 0 1 8 4Zm0 8a1 1 0 1 1 0-2 1 1 0 0 1 0 2Z"/></svg>
              Temporary
            </span>
            <button
              onClick={handlePromote}
              disabled={status === "saving"}
              title="Keep this chart permanently — it won't be auto-deleted"
              style={{
                fontSize: 11, padding: "2px 9px", borderRadius: 6,
                background: "var(--md-primary-cont)", border: "none",
                color: "var(--md-on-primary-cont)",
                cursor: status === "saving" ? "default" : "pointer",
                opacity: status === "saving" ? 0.55 : 1,
                transition: "opacity 0.15s",
              }}
            >
              {status === "saving" ? "Saving…" : "Keep permanently"}
            </button>
          </>
        )}
      </div>
    </div>
  );
}

// ── Table parsing helper ──────────────────────────────────────────
interface ParsedTable {
  headers: string[];
  alignments: ("left" | "right" | "center")[];
  rows: string[][];
}

function parseMarkdownTable(lines: string[]): ParsedTable | null {
  if (lines.length < 2) return null;

  // Parse header row
  const headerLine = lines[0].trim();
  if (!headerLine.startsWith("|") || !headerLine.endsWith("|")) return null;

  const headerCells = headerLine
    .split("|")
    .slice(1, -1) // Remove empty first/last from |header1|header2|
    .map(cell => cell.trim());

  if (headerCells.length === 0) return null;

  // Parse alignment row (second line)
  const alignLine = lines[1].trim();
  const alignments: ("left" | "right" | "center")[] = [];

  if (alignLine.startsWith("|") && alignLine.endsWith("|")) {
    const alignParts = alignLine.split("|").slice(1, -1);
    for (const part of alignParts) {
      const trimmed = part.trim();
      if (trimmed.startsWith(":") && trimmed.endsWith(":")) {
        alignments.push("center");
      } else if (trimmed.startsWith(":")) {
        alignments.push("left");
      } else if (trimmed.endsWith(":")) {
        alignments.push("right");
      } else {
        alignments.push("left"); // default
      }
    }
  }

  // If no alignment row or it doesn't match, default to left alignment
  if (alignments.length !== headerCells.length) {
    alignments.length = 0; // clear and rebuild with defaults
    for (let i = 0; i < headerCells.length; i++) {
      alignments.push("left");
    }
  }

  // Parse data rows (skip header and alignment lines)
  const rows: string[][] = [];
  for (let i = 2; i < lines.length; i++) {
    const rowLine = lines[i].trim();
    
    // Be more lenient - allow rows that contain | even if they don't start/end with |
    if (!rowLine.includes("|")) continue;

    // Clean up the line by ensuring it starts and ends with |
    let cleanLine = rowLine;
    if (!cleanLine.startsWith("|")) cleanLine = "|" + cleanLine;
    if (!cleanLine.endsWith("|")) cleanLine = cleanLine + "|";

    const rowCells = cleanLine
      .split("|")
      .slice(1, -1)
      .map(cell => cell.trim());

    if (rowCells.length === headerCells.length) {
      rows.push(rowCells);
    }
  }

  return {
    headers: headerCells,
    alignments,
    rows
  };
}

// ── Markdown-lite renderer ────────────────────────────────────────
// Handles bold, italic, inline code, code blocks, bullet lists, numbered lists,
// line breaks, tables, and iframe embeds. No external deps.
// Iframe syntax: [iframe](https://url.com) Title
// Any subdomain of HYPERSET_DOMAIN is automatically whitelisted for iframes.
// HYPERSET_DOMAIN is derived from the configured supersetUrl (e.g.
// "https://superset.acme.internal" → base domain "acme.internal").
function getHypersetDomain(supersetUrl: string): string {
  try {
    const hostname = new URL(supersetUrl).hostname;
    const dotIdx = hostname.indexOf(".");
    return dotIdx !== -1 ? hostname.slice(dotIdx + 1) : hostname;
  } catch {
    return "";
  }
}

function renderMarkdown(
  text: string,
  supersetUrl: string,
  onSupersetLinkClick?: (url: string) => void,
): React.ReactNode {
  // Build a domain-check helper (same logic as the iframe whitelist) and a
  // bound inlineRender so every call site automatically gets the callbacks.
  const supersetHostname = (() => { try { return new URL(supersetUrl).hostname; } catch { return ""; } })();
  const hypersetDomain   = getHypersetDomain(supersetUrl);
  const isSupersetUrl    = (url: string): boolean => {
    try {
      const { hostname } = new URL(url);
      return (
        (supersetHostname !== "" && (hostname === supersetHostname || hostname.endsWith("." + supersetHostname))) ||
        (hypersetDomain   !== "" && (hostname === hypersetDomain   || hostname.endsWith("." + hypersetDomain)))
      );
    } catch { return false; }
  };
  // Convenience wrapper — keeps all call sites below identical in shape
  const ir = (t: string) => inlineRender(t, onSupersetLinkClick, isSupersetUrl);

  // Pre-process: normalise [iframe] tokens so the block-level renderer always
  // sees them on their own bare line.
  //
  // Step 1 — strip triple-backtick code fences that wrap [iframe] lines.
  // Step 2 — if [iframe] appears inline after other text on the same line
  //          (e.g. "Here is your chart: [iframe](url) Title"), split it out
  //          onto its own line so the block regex can match it.
  // Step 3 — remove any leading whitespace from lines that start with [iframe]
  //          so the anchored regex always fires.
  const processedText = text
    // Step 1: strip code fences wrapping [iframe] or [iframe-ai:N] lines
    .replace(
      /```[^\n]*\n((?:\[iframe(?:-ai:\d+)?\][^\n]*\n?)+)```/g,
      (_: string, iframeLines: string) => iframeLines.trimEnd(),
    )
    // Step 2: split [iframe*] tokens that appear inline after other text
    .replace(
      /([^\n])(\[iframe(?:-ai:\d+)?\]\([^\s)]+\)[^\n]*)/g,
      (_: string, before: string, iframePart: string) => `${before}\n${iframePart}`,
    )
    // Step 3: strip leading whitespace so the anchored block regex always fires
    .replace(/^[ \t]+(\[iframe(?:-ai:\d+)?\])/gm, "$1");

  const lines = processedText.split("\n");
  const nodes: React.ReactNode[] = [];
  let i = 0;
  let keyCounter = 0;
  const key = () => keyCounter++;

  while (i < lines.length) {
    const line = lines[i];

    // Code block
    if (line.startsWith("```")) {
      const lang = line.slice(3).trim();
      const codeLines: string[] = [];
      i++;
      while (i < lines.length && !lines[i].startsWith("```")) {
        codeLines.push(lines[i]);
        i++;
      }
      i++; // consume closing ```
      nodes.push(
        <pre key={key()} style={{
          background: "var(--md-surface-cont-hi)",
          borderRadius: "10px",
          padding: "12px 14px",
          overflowX: "auto",
          fontSize: 12,
          margin: "8px 0",
          border: "1px solid var(--md-outline-var)",
          boxShadow: "inset 0 1px 2px rgba(0,0,0,0.03)",
        }}>
          <code data-lang={lang}>{codeLines.join("\n")}</code>
        </pre>
      );
      continue;
    }

    // Bullet list item
    if (/^[\-\*] /.test(line)) {
      const items: React.ReactNode[] = [];
      while (i < lines.length && /^[\-\*] /.test(lines[i])) {
        items.push(<li key={key()}>{ir(lines[i].slice(2))}</li>);
        i++;
      }
      nodes.push(<ul key={key()} style={{ margin: "4px 0 4px 16px", padding: 0 }}>{items}</ul>);
      continue;
    }

    // Numbered list
    if (/^\d+\. /.test(line)) {
      const items: React.ReactNode[] = [];
      while (i < lines.length && /^\d+\. /.test(lines[i])) {
        items.push(<li key={key()}>{ir(lines[i].replace(/^\d+\. /, ""))}</li>);
        i++;
      }
      nodes.push(<ol key={key()} style={{ margin: "4px 0 4px 16px", padding: 0 }}>{items}</ol>);
      continue;
    }

    // Table
    if (line.includes("|") && !line.startsWith("    ") && !line.startsWith("\t")) {
      // Parse table - collect all consecutive lines that look like table rows
      const tableLines: string[] = [line];
      i++;
      while (i < lines.length) {
        const nextLine = lines[i];
        if (nextLine.includes("|") && !nextLine.startsWith("    ") && !nextLine.startsWith("\t")) {
          tableLines.push(nextLine);
          i++;
        } else {
          break;
        }
      }

      // Parse table structure
      const parsedTable = parseMarkdownTable(tableLines);
      if (parsedTable) {
        nodes.push(
          <div key={key()} style={{ overflowX: "auto", margin: "12px 0", borderRadius: "10px", border: "1px solid var(--md-outline-var)" }}>
            <table style={{ 
              borderCollapse: "collapse", 
              width: "100%",
              fontSize: "13px",
              background: "var(--md-surface-cont)",
            }}>
              <thead>
                <tr style={{ background: "var(--md-surface-cont-hi)" }}>
                  {parsedTable.headers.map((header, colIndex) => (
                    <th key={colIndex} style={{ 
                      padding: "8px 12px",
                      textAlign: parsedTable.alignments[colIndex] || "left",
                      border: "1px solid var(--md-outline-var)",
                      borderTop: "none",
                      fontWeight: 600,
                      color: "var(--md-on-surface)",
                      fontSize: "12px",
                    }}>
                      {ir(header.trim())}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {parsedTable.rows.map((row, rowIndex) => (
                  <tr key={rowIndex} style={{ 
                    background: rowIndex % 2 === 0 ? "var(--md-surface-cont)" : "var(--md-surface-cont-hi)",
                    transition: "background 0.15s ease",
                  }}>
                    {row.map((cell, cellIndex) => (
                      <td key={cellIndex} style={{ 
                        padding: "8px 12px",
                        textAlign: parsedTable.alignments[cellIndex] || "left",
                        border: "1px solid var(--md-outline-var)",
                        borderBottom: rowIndex === parsedTable.rows.length - 1 ? "none" : "1px solid var(--md-outline-var)",
                        color: "var(--md-on-surface)",
                        fontSize: "13px",
                      }}>
                        {ir(cell.trim())}
                      </td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        );
        continue;
      }
    }

    // Heading
    const hMatch = line.match(/^(#{1,3}) (.*)/);
    if (hMatch) {
      const level = hMatch[1].length;
      const sizes = ["1.1em", "1.05em", "1em"];
      nodes.push(
        <p key={key()} style={{ fontWeight: 700, fontSize: sizes[level - 1] ?? "1em", margin: "8px 0 4px" }}>
          {ir(hMatch[2])}
        </p>
      );
      i++;
      continue;
    }

    // Horizontal rule (--- or ***)
    if (/^[-*]{3,}\s*$/.test(line)) {
      nodes.push(<hr key={key()} style={{ 
        border: "none", 
        borderTop: "1px solid var(--md-outline-var)", 
        margin: "12px 0",
        opacity: 0.8,
      }} />);
      i++;
      continue;
    }

    // <details> / collapsible methodology block
    // Handles both:
    //   <details><summary>Title</summary>   (summary on same line as opening tag)
    //   <details>\n<summary>Title</summary>  (summary on next line)
    if (line.trim().startsWith("<details")) {
      let summaryText = "";
      const bodyLines: string[] = [];

      // Summary may be on the same line: <details><summary>Title</summary>
      const inlineSummaryMatch = line.match(/<summary>(.*?)<\/summary>/);
      if (inlineSummaryMatch) {
        summaryText = inlineSummaryMatch[1];
        i++;
      } else {
        // Move to next line to find <summary>
        i++;
        while (i < lines.length) {
          const summaryMatch = lines[i].match(/<summary>(.*?)<\/summary>/);
          if (summaryMatch) {
            summaryText = summaryMatch[1];
            i++;
            break;
          }
          i++;
        }
      }

      // Collect body lines until </details>
      while (i < lines.length && lines[i].trim() !== "</details>") {
        bodyLines.push(lines[i]);
        i++;
      }
      i++; // consume </details>

      nodes.push(
        <details key={key()} style={{
          margin: "12px 0", borderRadius: "12px",
          border: "1px solid var(--md-outline-var)",
          background: "var(--md-surface-cont)",
          overflow: "hidden",
          boxShadow: "0 1px 3px rgba(0,0,0,0.04)",
        }}>
          <summary style={{
            cursor: "pointer", fontWeight: 500,
            padding: "10px 14px", userSelect: "none",
            listStyle: "none", display: "flex", alignItems: "center", gap: 8,
            fontSize: "13px",
            transition: "background 0.15s ease",
          }} onMouseOver={e => e.currentTarget.style.background = "var(--md-surface-cont-hi)"} onMouseOut={e => e.currentTarget.style.background = "transparent"}>
            {summaryText || "Details"}
          </summary>
          <div style={{ padding: "0 14px 12px", borderTop: "1px solid var(--md-outline-var)" }}>
            {renderMarkdown(bodyLines.join("\n"), supersetUrl, onSupersetLinkClick)}
          </div>
        </details>
      );
      continue;
    }

    // AI chart embed — [iframe-ai:CHART_ID](url) Title
    // Renders an iframe with a "Temporary / Keep permanently" toggle badge.
    const iframeAiMatch = line.match(/^\[iframe-ai:(\d+)\]\s*\(([^\s)]+)\)\s*(.*)$/);
    if (iframeAiMatch) {
      const chartId    = parseInt(iframeAiMatch[1], 10);
      const iframeUrl  = iframeAiMatch[2];
      const iframeTitle = iframeAiMatch[3].trim() || "Embedded Content";
      nodes.push(
        <AiChartEmbed
          key={`ai-chart-${chartId}`}
          chartId={chartId}
          iframeUrl={iframeUrl}
          iframeTitle={iframeTitle}
          supersetUrl={supersetUrl}
          onSupersetLinkClick={onSupersetLinkClick}
        />
      );
      i++;
      continue;
    }

    // Iframe embedding — allow optional space between ] and ( to handle LLM formatting variations
    const iframeMatch = line.match(/^\[iframe\]\s*\(([^\s)]+)\)\s*(.*)$/);
    if (iframeMatch) {
      const iframeUrl = iframeMatch[1];
      const iframeTitle = iframeMatch[2].trim() || "Embedded Content";
      
      // Security: Only allow URLs from trusted domains.
      // Third-party embeds are whitelisted by name; Hyperset-internal URLs are
      // whitelisted dynamically via two complementary checks — no hardcoded hostnames:
      //   1. Exact match / subdomain of the configured supersetUrl hostname itself
      //      (e.g. superset.acme.internal and *.superset.acme.internal)
      //   2. Exact match / subdomain of the HYPERSET_DOMAIN base domain derived
      //      from supersetUrl (e.g. acme.internal and *.acme.internal)
      // Either check passing is sufficient.  HTTP is accepted for internal domains
      // because local deployments often skip TLS; HTTPS is still required for
      // third-party embeds.
      const thirdPartyDomains = ["youtube.com", "youtu.be", "vimeo.com"];
      const supersetHostname = (() => { try { return new URL(supersetUrl).hostname; } catch { return ""; } })();
      const hypersetDomain = getHypersetDomain(supersetUrl);

      try {
        const url = new URL(iframeUrl);
        const isThirdParty = thirdPartyDomains.some(d =>
          url.hostname === d || url.hostname.endsWith("." + d)
        );
        const isHypersetSubdomain =
          // Check 1: exact supersetUrl host or any of its subdomains
          (supersetHostname !== "" && (
            url.hostname === supersetHostname ||
            url.hostname.endsWith("." + supersetHostname)
          )) ||
          // Check 2: base HYPERSET_DOMAIN or any subdomain of it
          (hypersetDomain !== "" && (
            url.hostname === hypersetDomain ||
            url.hostname.endsWith("." + hypersetDomain)
          ));
        const isAllowed = isThirdParty || isHypersetSubdomain;
        // Require HTTPS for third-party; allow HTTP/HTTPS for internal domains
        const protocolOk = isHypersetSubdomain
          ? (url.protocol === "https:" || url.protocol === "http:")
          : url.protocol === "https:";

        if (isAllowed && protocolOk) {
          nodes.push(
            <div key={key()} style={{ margin: "12px 0" }}>
              {/* Clickable title — opens the chart/dashboard in the Superset panel */}
              <button
                onClick={() => onSupersetLinkClick?.(iframeUrl)}
                title="Open in Superset"
                style={{
                  display: "inline-flex", alignItems: "center", gap: 4,
                  background: "none", border: "none", padding: 0, marginBottom: 4,
                  cursor: onSupersetLinkClick ? "pointer" : "default",
                  fontSize: 11, fontWeight: 500,
                  color: "var(--md-primary)", opacity: 0.85,
                  textDecoration: "none",
                }}
                onMouseOver={e => { e.currentTarget.style.opacity = "1"; e.currentTarget.style.textDecoration = "underline"; }}
                onMouseOut={e => { e.currentTarget.style.opacity = "0.85"; e.currentTarget.style.textDecoration = "none"; }}
              >
                {iframeTitle}
                {/* "open in panel" icon */}
                <svg viewBox="0 0 16 16" width={10} height={10} fill="currentColor" style={{ opacity: 0.7, flexShrink: 0 }}>
                  <path d="M2 2h5v1.5H3.5v9h9V11H14v4H2V2zm7 0h5v5h-1.5V4.56L7.28 9.78 6.22 8.72 11.44 3.5H9V2z"/>
                </svg>
              </button>
              <div style={{
                border: "1px solid var(--md-outline-var)",
                borderRadius: "12px",
                overflow: "hidden",
                background: "var(--md-surface-cont)",
                boxShadow: "0 2px 8px rgba(0,0,0,0.06), 0 1px 3px rgba(0,0,0,0.04)",
              }}>
                <iframe
                  src={iframeUrl}
                  title={iframeTitle}
                  style={{
                    width: "100%",
                    height: "300px",
                    border: "none",
                    display: "block"
                  }}
                  sandbox="allow-scripts allow-same-origin allow-popups allow-forms"
                  allowFullScreen
                />
              </div>
            </div>
          );
        } else {
          // Domain check failed — render as a plain clickable link rather than
          // silently dropping so the user always sees something and can debug
          // any config mismatch between SUPERSET_PUBLIC_URL and the portal URL.
          nodes.push(
            <a key={key()} href={iframeUrl} target="_blank" rel="noopener noreferrer"
              style={{ fontSize: 12, color: "var(--md-primary)", display: "block", margin: "4px 0" }}>
              {iframeTitle || iframeUrl}
            </a>
          );
        }
      } catch {
        // Invalid URL — silently drop rather than leaking raw iframe syntax into the chat.
      }
      i++;
      continue;
    }

    // Empty line → spacing
    if (line.trim() === "") {
      nodes.push(<div key={key()} style={{ height: 8 }} />);
      i++;
      continue;
    }

    // Normal paragraph line
    nodes.push(<p key={key()} style={{ margin: "4px 0", lineHeight: 1.65, fontSize: 14 }}>{ir(line)}</p>);
    i++;
  }

  return <>{nodes}</>;
}

function inlineRender(
  text: string,
  onSupersetLink?: (url: string) => void,
  isSupersetUrlFn?: (url: string) => boolean,
): React.ReactNode {
  // Handles **bold**, *italic*, `code`, and [text](url) links.
  // [text](url) links pointing to the Superset domain open in the Superset
  // iframe panel instead of a new browser tab.
  const parts: React.ReactNode[] = [];
  let remaining = text;
  let k = 0;

  while (remaining.length > 0) {
    const boldIdx  = remaining.indexOf("**");
    const italicIdx = remaining.indexOf("*");
    const codeIdx  = remaining.indexOf("`");
    const linkIdx  = remaining.indexOf("[");

    // Find the earliest marker
    const candidates = [
      boldIdx  >= 0                              ? boldIdx  : Infinity,
      italicIdx >= 0 && italicIdx !== boldIdx    ? italicIdx : Infinity,
      codeIdx  >= 0                              ? codeIdx  : Infinity,
      linkIdx  >= 0                              ? linkIdx  : Infinity,
    ];
    const minIdx = Math.min(...candidates);

    if (minIdx === Infinity) {
      parts.push(remaining);
      break;
    }

    // Text before the marker
    if (minIdx > 0) {
      parts.push(remaining.slice(0, minIdx));
      remaining = remaining.slice(minIdx);
      continue;
    }

    // Bold
    if (remaining.startsWith("**")) {
      const end = remaining.indexOf("**", 2);
      if (end !== -1) {
        parts.push(<strong key={k++}>{remaining.slice(2, end)}</strong>);
        remaining = remaining.slice(end + 2);
        continue;
      }
    }

    // Italic (but not bold)
    if (remaining.startsWith("*") && !remaining.startsWith("**")) {
      const end = remaining.indexOf("*", 1);
      if (end !== -1) {
        parts.push(<em key={k++}>{remaining.slice(1, end)}</em>);
        remaining = remaining.slice(end + 1);
        continue;
      }
    }

    // Inline code
    if (remaining.startsWith("`")) {
      const end = remaining.indexOf("`", 1);
      if (end !== -1) {
        parts.push(
          <code key={k++} style={{
            background: "var(--md-surface-cont-hi)",
            borderRadius: "6px",
            padding: "2px 6px",
            fontSize: "0.92em",
            fontFamily: "ui-monospace, SFMono-Regular, monospace",
            border: "1px solid var(--md-outline-var)",
            boxShadow: "inset 0 1px 2px rgba(0,0,0,0.03)",
          }}>
            {remaining.slice(1, end)}
          </code>
        );
        remaining = remaining.slice(end + 1);
        continue;
      }
    }

    // Link [text](url)
    if (remaining.startsWith("[")) {
      const linkMatch = remaining.match(/^\[([^\]]*)\]\(([^)\s]+)\)/);
      if (linkMatch) {
        const linkText = linkMatch[1];
        const linkUrl  = linkMatch[2];
        const isSuperset = isSupersetUrlFn?.(linkUrl) ?? false;
        const isIframeLink = linkText.toLowerCase() === "iframe" || linkText.toLowerCase().startsWith("iframe-");

        if (isIframeLink && isSuperset) {
          // Convert [iframe](url) to embedded iframe
          const iframeTitle = linkText.replace(/^iframe(-ai:\d+)?/i, "").trim() || "Chart";
          parts.push(
            <div key={k++} style={{ margin: "12px 0" }}>
              <div style={{
                border: "1px solid var(--md-outline-var)",
                borderRadius: "12px",
                overflow: "hidden",
                background: "var(--md-surface-cont)",
                boxShadow: "0 2px 8px rgba(0,0,0,0.06), 0 1px 3px rgba(0,0,0,0.04)",
              }}>
                <iframe
                  src={linkUrl}
                  title={iframeTitle}
                  style={{
                    width: "100%",
                    height: "300px",
                    border: "none",
                    display: "block"
                  }}
                  sandbox="allow-scripts allow-same-origin allow-popups allow-forms"
                  allowFullScreen
                />
              </div>
            </div>
          );
        } else if (isSuperset && onSupersetLink) {
          // Open in the Superset iframe panel instead of a new tab
          parts.push(
            <button
              key={k++}
              onClick={() => onSupersetLink(linkUrl)}
              title="Open in Superset panel"
              style={{
                background: "none", border: "none",
                color: "var(--md-primary)", cursor: "pointer",
                padding: 0, textDecoration: "underline",
                fontFamily: "inherit", fontSize: "inherit",
                display: "inline", verticalAlign: "baseline",
              }}
            >
              {linkText}
              <svg viewBox="0 0 16 16" width={10} height={10}
                fill="currentColor" style={{ marginLeft: 3, verticalAlign: "middle", opacity: 0.7 }}>
                <path d="M2 2h5v1.5H3.5v9h9V11H14v4H2V2zm7 0h5v5h-1.5V4.56L7.28 9.78 6.22 8.72 11.44 3.5H9V2z"/>
              </svg>
            </button>
          );
        } else {
          parts.push(
            <a
              key={k++}
              href={linkUrl}
              target="_blank"
              rel="noopener noreferrer"
              style={{ color: "var(--md-primary)" }}
            >
              {linkText}
            </a>
          );
        }
        remaining = remaining.slice(linkMatch[0].length);
        continue;
      }
    }

    // Unmatched marker — treat as literal
    parts.push(remaining[0]);
    remaining = remaining.slice(1);
  }

  return <>{parts}</>;
}

// ── Tool call step component (used inside ToolCallsZone) ────────
function ToolStep({ tc }: { tc: ToolCall }) {
  const [open, setOpen] = useState(false);
  const isPending = tc.result === undefined;
  const isNav = tc.name.startsWith("navigate_superset_");

  return (
    <div style={{
      border: "1px solid var(--md-outline-var)",
      borderRadius: "10px",
      overflow: "hidden",
      background: "var(--md-surface-cont)",
      boxShadow: "0 1px 2px rgba(0,0,0,0.04)",
      transition: "box-shadow 0.2s ease, transform 0.15s ease",
    }} onMouseOver={e => e.currentTarget.style.boxShadow = "0 2px 4px rgba(0,0,0,0.06)"} onMouseOut={e => e.currentTarget.style.boxShadow = "0 1px 2px rgba(0,0,0,0.04)"}>
      <button
        onClick={() => setOpen((o) => !o)}
        style={{
          width: "100%",
          display: "flex",
          alignItems: "center",
          gap: 8,
          padding: "8px 12px",
          background: "transparent",
          border: "none",
          cursor: "pointer",
          color: "var(--md-on-surface)",
          fontSize: 12,
          fontWeight: 500,
          textAlign: "left",
          opacity: 0.9,
          transition: "opacity 0.15s ease",
        }}
        onMouseOver={e => e.currentTarget.style.opacity = "1"}
        onMouseOut={e => e.currentTarget.style.opacity = "0.9"}
      >
        {isPending ? (
          <>
            <span style={{
              width: 10, height: 10,
              border: "2px solid currentColor",
              borderTopColor: "transparent",
              borderRadius: "50%",
              display: "inline-block",
              animation: "spin 0.8s linear infinite",
              flexShrink: 0,
            }} />
            <span style={{ opacity: 0.75 }}>{tc.name.replace(/_/g, " ")}</span>
          </>
        ) : isNav ? (
          <span>↗ {tc.name === "navigate_superset_dashboard" ? `Dashboard ${tc.args.dashboardId ?? ""}` : `Chart ${tc.args.chartId ?? ""}`}</span>
        ) : (
          <span>✓ {tc.name.replace(/_/g, " ")}</span>
        )}
        <span style={{ fontSize: 11, opacity: 0.5, marginLeft: "auto", flexShrink: 0, transition: "transform 0.2s" }}>{open ? "▴" : "▾"}</span>
      </button>
      {open && (
        <pre style={{
          padding: "10px 14px",
          fontSize: 11,
          overflowX: "auto",
          whiteSpace: "pre-wrap",
          wordBreak: "break-all",
          color: "var(--md-on-surface)",
          opacity: 0.8,
          margin: 0,
          borderTop: "1px solid var(--md-outline-var)",
          background: "var(--md-surface-cont-hi)",
          fontFamily: "ui-monospace, SFMono-Regular, monospace",
        }}>
          {`args: ${JSON.stringify(tc.args, null, 2)}`}
          {tc.result !== undefined ? `\n\nresult: ${tc.result}` : ""}
        </pre>
      )}
    </div>
  );
}

// ── Tool calls zone (single collapsible that groups all tool calls) ──
function ToolCallsZone({ toolCalls, streaming }: { toolCalls: ToolCall[]; streaming?: boolean }) {
  const [open, setOpen] = useState(false);
  if (!toolCalls || toolCalls.length === 0) return null;

  const pendingCount = toolCalls.filter(tc => tc.result === undefined).length;
  const isDone = pendingCount === 0 && !streaming;
  const label = !isDone
    ? `${toolCalls.length} tool${toolCalls.length !== 1 ? "s" : ""} running…`
    : `${toolCalls.length} tool${toolCalls.length !== 1 ? "s" : ""} used`;

  return (
    <div style={{
      maxWidth: "88%",
      borderRadius: "12px",
      marginBottom: "8px",
      overflow: "hidden",
      boxShadow: "0 2px 8px rgba(0,0,0,0.06)",
      border: "1px solid var(--md-primary-cont)",
    }}>
      <button
        onClick={() => setOpen(o => !o)}
        style={{
          width: "100%",
          display: "flex",
          alignItems: "center",
          gap: 8,
          padding: "10px 14px",
          background: "var(--md-primary-cont)",
          border: "none",
          cursor: "pointer",
          color: "var(--md-on-primary-cont)",
          fontSize: 13,
          fontWeight: 500,
          textAlign: "left",
          transition: "opacity 0.15s ease",
        }}
        onMouseOver={e => e.currentTarget.style.opacity = "0.95"}
        onMouseOut={e => e.currentTarget.style.opacity = "1"}
      >
        <svg viewBox="0 0 24 24" width={14} height={14} fill="currentColor"
          style={{ flexShrink: 0, opacity: 0.9 }}>
          <path d="M22.7 19l-9.1-9.1c.9-2.3.4-5-1.5-6.9-2-2-5-2.4-7.4-1.3L9 6 6 9 1.6 4.7C.4 7.1.9 10.1 2.9 12.1c1.9 1.9 4.6 2.4 6.9 1.5l9.1 9.1c.4.4 1 .4 1.4 0l2.3-2.3c.5-.4.5-1.1.1-1.4z"/>
        </svg>
        <span style={{ flex: 1 }}>{label}</span>
        {!isDone && (
          <span style={{
            width: 12, height: 12,
            border: "2px solid var(--md-on-primary-cont)",
            borderTopColor: "transparent",
            borderRadius: "50%",
            display: "inline-block",
            animation: "spin 0.8s linear infinite",
            opacity: 0.75,
            flexShrink: 0,
          }} />
        )}
        <span style={{ fontSize: 12, opacity: 0.6, marginLeft: 4, flexShrink: 0, transition: "transform 0.2s ease" }}>{open ? "▴" : "▾"}</span>
      </button>

      {open && (
        <div style={{
          padding: "10px",
          background: "var(--md-surface)",
          display: "flex",
          flexDirection: "column",
          gap: 6,
        }}>
          {toolCalls.map((tc, i) => <ToolStep key={i} tc={tc} />)}
        </div>
      )}
    </div>
  );
}

// ── Message bubble ────────────────────────────────────────────────
function MessageBubble({ msg, supersetUrl, onSuggestionClick, onSupersetLinkClick }: {
  msg: Message;
  supersetUrl: string;
  onSuggestionClick?: (suggestion: string) => void;
  onSupersetLinkClick?: (url: string) => void;
}) {
  const isUser = msg.role === "user";
  const isAssistant = msg.role === "assistant";
  
  return (
    <div style={{
      display: "flex",
      flexDirection: "column",
      alignItems: isUser ? "flex-end" : "flex-start",
      padding: "4px 16px",
      animation: "fadeInUp 0.3s ease-out",
    }}>
      {msg.toolCalls && msg.toolCalls.length > 0 && (
        <ToolCallsZone toolCalls={msg.toolCalls} streaming={msg.streaming} />
      )}

      {msg.content && (
        <div style={{
          maxWidth: "88%",
          padding: isUser ? "10px 16px" : "8px 0",
          borderRadius: isUser ? "18px" : 0,
          background: isUser ? "var(--md-primary-cont)" : "transparent",
          color: isUser ? "var(--md-on-primary-cont)" : "var(--md-on-surface)",
          fontSize: 14,
          lineHeight: 1.6,
          wordBreak: "break-word",
          boxShadow: isUser ? "0 1px 3px rgba(0,0,0,0.08), 0 1px 2px rgba(0,0,0,0.04)" : "none",
          transition: "transform 0.2s ease, box-shadow 0.2s ease",
        }}>
          {isUser ? msg.content : renderMarkdown(msg.content, supersetUrl, onSupersetLinkClick)}
          {msg.streaming && (
            <span style={{
              display: "inline-block",
              width: 7,
              height: 16,
              background: "var(--md-primary)",
              borderRadius: "2px",
              marginLeft: 3,
              animation: "blink 1s step-end infinite",
              verticalAlign: "text-bottom",
            }} />
          )}
        </div>
      )}
      
      {isAssistant && !msg.streaming && msg.followupSuggestions && msg.followupSuggestions.length > 0 && onSuggestionClick && (
        <div style={{ maxWidth: "88%", marginTop: "6px" }}>
          <FollowupSuggestions 
            suggestions={msg.followupSuggestions} 
            onSuggestionClick={onSuggestionClick}
          />
        </div>
      )}
    </div>
  );
}

// ── Follow-up suggestions component ────────────────────────────────
function FollowupSuggestions({ suggestions, onSuggestionClick }: {
  suggestions: string[];
  onSuggestionClick: (suggestion: string) => void;
}) {
  return (
    <div style={{
      marginTop: 16, 
      paddingLeft: 16,
      borderLeft: "3px solid var(--md-primary)",
    }}>
      <div style={{
        fontSize: 12, 
        color: "var(--md-primary)", 
        marginBottom: 10, 
        fontWeight: 600,
        letterSpacing: "0.3px",
      }}>
        Follow-up questions
      </div>
      <div style={{
        display: "flex", 
        flexDirection: "column", 
        gap: 4,
      }}>
        {suggestions.map((suggestion, index) => (
          <button
            key={index}
            onClick={() => onSuggestionClick(suggestion)}
            style={{
              padding: "8px 12px",
              background: "transparent",
              color: "var(--md-on-surface)", 
              border: "none",
              borderRadius: "8px",
              fontSize: 14,
              cursor: "pointer",
              transition: "all 0.2s ease-out",
              textAlign: "left",
              width: "fit-content",
              maxWidth: "100%",
              display: "flex",
              alignItems: "center",
              gap: 8,
            }}
            onMouseOver={(e) => {
              e.currentTarget.style.color = "var(--md-primary)";
              e.currentTarget.style.background = "var(--md-surface-cont)";
              e.currentTarget.style.transform = "translateX(4px)";
            }}
            onMouseOut={(e) => {
              e.currentTarget.style.color = "var(--md-on-surface)";
              e.currentTarget.style.background = "transparent";
              e.currentTarget.style.transform = "none";
            }}
          >
            <span style={{ opacity: 0.5, color: "var(--md-primary)", fontSize: 14 }}>→</span>
            {suggestion}
          </button>
        ))}
      </div>
    </div>
  );
}

// ── Error types ─────────────────────────────────────────────────────
interface ErrorLog {
  source: "api" | "network" | "llm" | "internal" | "stream";
  message: string;
  timestamp: string;
  details?: string;
}

interface ChatErrorState {
  error: string;
  detail?: string;
  logs: ErrorLog[];
}

// ── Error banner ─────────────────────────────────────────────────
function ChatErrorBanner({ error, detail, logs, isAdmin, onOpenSettings, onDismiss }: {
  error: string; detail?: string; logs: ErrorLog[]; isAdmin: boolean;
  onOpenSettings: () => void; onDismiss: () => void;
}) {
  const [copied, setCopied] = useState(false);
  const [expanded, setExpanded] = useState(false);

  const handleCopy = useCallback(() => {
    const allLogs = [
      `Error: ${error}`,
      detail ? `Detail: ${detail}` : "",
      logs.length > 0 ? "\n--- Debug Logs ---\n" + logs.map(log => 
        `[${log.timestamp}] [${log.source.toUpperCase()}] ${log.message}${log.details ? `\n  Details: ${log.details}` : ""}`
      ).join("\n") : ""
    ].filter(Boolean).join("\n");
    
    navigator.clipboard.writeText(allLogs).then(() => { setCopied(true); setTimeout(() => setCopied(false), 1500); });
  }, [error, detail, logs]);

  const hasLogs = logs.length > 0;

  return (
    <div style={{
      margin: "12px 16px 0",
      padding: "12px 16px",
      borderRadius: "12px",
      background: "rgba(211,47,47,0.08)",
      border: "1px solid rgba(211,47,47,0.25)",
      display: "flex",
      flexDirection: "column",
      gap: 8,
      fontSize: 13,
      backdropFilter: "blur(8px)",
    }}>
      <div style={{ display: "flex", alignItems: "flex-start", gap: 10 }}>
        <span style={{ color: "#ef5350", fontWeight: 700, flexShrink: 0, fontSize: 16 }}>⚠</span>
        <span style={{ flex: 1, color: "var(--md-on-surface)", lineHeight: 1.5 }}>{error}</span>
        <button onClick={handleCopy} title="Copy error"
          style={{ 
            border: "none", 
            background: "none", 
            cursor: "pointer", 
            color: "var(--md-on-surface)", 
            opacity: 0.5, 
            fontSize: 14, 
            flexShrink: 0, 
            padding: "2px 6px",
            borderRadius: "6px",
            transition: "opacity 0.15s, background 0.15s",
          }}
          onMouseOver={e => { e.currentTarget.style.opacity = "0.8"; e.currentTarget.style.background = "var(--md-surface-cont-hi)"; }}
          onMouseOut={e => { e.currentTarget.style.opacity = "0.5"; e.currentTarget.style.background = "transparent"; }}>
          {copied ? "✓" : "⎘"}
        </button>
        <button onClick={onDismiss} title="Dismiss"
          style={{ 
            border: "none", 
            background: "none", 
            cursor: "pointer", 
            color: "var(--md-on-surface)", 
            opacity: 0.4, 
            fontSize: 18, 
            flexShrink: 0, 
            padding: "2px 6px",
            lineHeight: 1,
            borderRadius: "6px",
            transition: "opacity 0.15s, background 0.15s",
          }}
          onMouseOver={e => { e.currentTarget.style.opacity = "0.8"; e.currentTarget.style.background = "var(--md-surface-cont-hi)"; }}
          onMouseOut={e => { e.currentTarget.style.opacity = "0.4"; e.currentTarget.style.background = "transparent"; }}>
          ×
        </button>
      </div>
      {hasLogs && (
        <div style={{ marginTop: 4 }}>
          <button 
            onClick={() => setExpanded(!expanded)}
            style={{
              background: "none",
              border: "none",
              color: "var(--md-on-surface)",
              opacity: 0.6,
              fontSize: 11,
              cursor: "pointer",
              padding: "4px 0",
              display: "flex",
              alignItems: "center",
              gap: 4,
            }}
          >
            <span style={{ transform: expanded ? "rotate(90deg)" : "rotate(0deg)", transition: "transform 0.2s" }}>▶</span>
            {expanded ? "Hide" : "Show"} debug logs ({logs.length})
          </button>
          {expanded && (
            <div style={{
              marginTop: 8,
              padding: "8px 10px",
              background: "rgba(0,0,0,0.15)",
              borderRadius: "8px",
              fontSize: 11,
              fontFamily: "monospace",
              maxHeight: "200px",
              overflow: "auto",
              whiteSpace: "pre-wrap",
              wordBreak: "break-word",
            }}>
              {logs.map((log, i) => (
                <div key={i} style={{ marginBottom: 6, opacity: 0.85 }}>
                  <span style={{ color: "#ffa726", opacity: 0.7 }}>[{log.timestamp}]</span>{" "}
                  <span style={{ color: log.source === "llm" ? "#ef5350" : log.source === "api" ? "#42a5f5" : "#bdbdbd" }}>[{log.source.toUpperCase()}]</span>{" "}
                  {log.message}
                  {log.details && <div style={{ marginLeft: 12, opacity: 0.7, fontSize: 10 }}>{log.details}</div>}
                </div>
              ))}
            </div>
          )}
        </div>
      )}
      {isAdmin && (
        <button onClick={onOpenSettings} style={{
          alignSelf: "flex-start",
          background: "transparent",
          border: "1px solid rgba(211,47,47,0.35)",
          borderRadius: "8px",
          color: "#ef5350",
          fontSize: 12,
          padding: "6px 12px",
          cursor: "pointer",
          fontWeight: 500,
          transition: "all 0.2s ease",
        }}>
          Open LLM Settings
        </button>
      )}
    </div>
  );
}

// ── MCP warning banner ────────────────────────────────────────────
function McpWarningBanner({ message, onDismiss }: { message: string; onDismiss: () => void }) {
  return (
    <div style={{
      margin: "10px 16px 0",
      padding: "10px 14px",
      borderRadius: "10px",
      background: "rgba(245,158,11,0.08)",
      border: "1px solid rgba(245,158,11,0.25)",
      display: "flex",
      alignItems: "center",
      gap: 10,
      fontSize: 12,
      backdropFilter: "blur(8px)",
    }}>
      <span style={{ color: "#f59e0b", fontWeight: 700, flexShrink: 0, fontSize: 14 }}>⚡</span>
      <span style={{ flex: 1, color: "var(--md-on-surface)", opacity: 0.85, lineHeight: 1.4 }}>{message}</span>
      <button onClick={onDismiss} title="Dismiss"
        style={{ 
          border: "none", 
          background: "none", 
          cursor: "pointer", 
          color: "var(--md-on-surface)", 
          opacity: 0.4, 
          fontSize: 16, 
          flexShrink: 0, 
          padding: "2px 6px",
          lineHeight: 1,
          borderRadius: "6px",
          transition: "opacity 0.15s, background 0.15s",
        }}
        onMouseOver={e => { e.currentTarget.style.opacity = "0.8"; e.currentTarget.style.background = "var(--md-surface-cont-hi)"; }}
        onMouseOut={e => { e.currentTarget.style.opacity = "0.4"; e.currentTarget.style.background = "transparent"; }}>
        ×
      </button>
    </div>
  );
}



// ── Main panel ───────────────────────────────────────────────────
export function ChatPanel({
  isAdmin,
  supersetIframeRef,
  supersetUrl,
  currentSupersetUrl,
  injectedMessage,
  onInjectionConsumed,
  messages,
  onMessagesChange,
}: ChatPanelProps) {
  const setMessages = onMessagesChange;
  const [input, setInput] = useState("");
  const [loading, setLoading] = useState(false);
  const [showAdminModal, setShowAdminModal] = useState(false);
  const [chatError, setChatError] = useState<ChatErrorState | null>(null);
  const [mcpWarning, setMcpWarning] = useState<string | null>(null);
  const [hasSentMessage, setHasSentMessage] = useState(false);
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const supersetOrigin = (() => { try { return new URL(supersetUrl).origin; } catch { return "*"; } })();
  const abortControllerRef = useRef<AbortController | null>(null);

  // Probe endpoint on mount
  useEffect(() => {
    const timestamp = new Date().toISOString();
    fetch("/api/chat").then(async (res) => {
      try {
        const body = await res.json();
        if (!res.ok) setChatError({ 
          error: body.error ?? "Chat API error", 
          detail: body.detail,
          logs: [{ source: "api", message: body.error ?? "Chat API error", timestamp, details: body.detail }]
        });
        else if (body.mcpWarning) setMcpWarning(body.mcpWarning);
      } catch { if (!res.ok) setChatError({ 
        error: `Chat API returned HTTP ${res.status}`,
        logs: [{ source: "network", message: `HTTP ${res.status}`, timestamp, details: "Failed to parse response" }]
      }); }
    }).catch(() => {});
  }, []);

  // Inject message from Superset bridge
  useEffect(() => {
    if (!injectedMessage) return;
    setInput(injectedMessage);
    textareaRef.current?.focus();
    onInjectionConsumed();
  }, [injectedMessage, onInjectionConsumed]);

  // Auto-scroll
  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages]);

  // Auto-resize textarea up to 5 lines (~120px), no scrollbar inside
  const LINE_HEIGHT = 24; // px — matches lineHeight 1.5 * fontSize 16
  const MAX_LINES = 5;
  const MAX_TEXTAREA_H = LINE_HEIGHT * MAX_LINES; // 120px

  const handleInputChange = (e: React.ChangeEvent<HTMLTextAreaElement>) => {
    setInput(e.target.value);
    // Reset to auto so scrollHeight reflects content, then clamp to 5 lines
    e.target.style.height = "auto";
    const newH = Math.min(e.target.scrollHeight, MAX_TEXTAREA_H);
    e.target.style.height = newH + "px";
    // Only show scrollbar once capped; hide below cap for clean look
    e.target.style.overflowY = e.target.scrollHeight > MAX_TEXTAREA_H ? "auto" : "hidden";
  };

  const sendMessage = useCallback(async () => {
    const text = input.trim();
    if (!text || loading) return;
    setInput("");
    if (textareaRef.current) { textareaRef.current.style.height = "auto"; }

    const userMsg: Message = { id: Date.now().toString(), role: "user", content: text };
    setMessages((prev) => [...prev, userMsg]);
    setLoading(true);
    setHasSentMessage(true);

    // Create a new abort controller for this request
    const abortController = new AbortController();
    abortControllerRef.current = abortController;

    // Build messages array for the API (only role+content for history)
    const history = [...messages, userMsg].map((m) => ({
      role: m.role === "tool" ? "user" : m.role, // collapse tool messages
      content: m.content,
    }));

    const assistantId = (Date.now() + 1).toString();
    setMessages((prev) => [...prev, { id: assistantId, role: "assistant", content: "", streaming: true, toolCalls: [] }]);

    try {
      const response = await fetch("/api/chat", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ messages: history, currentSupersetUrl }),
        signal: abortController.signal,
      });

      if (!response.ok || !response.body) {
        const err = await response.json().catch(() => ({ error: `HTTP ${response.status}` }));
        const timestamp = new Date().toISOString();
        setMessages((prev) => prev.map((m) => m.id === assistantId
          ? { ...m, content: err.error ?? "Error", streaming: false }
          : m
        ));
        setChatError({
          error: err.error ?? "Error",
          detail: err.detail,
          logs: [{ source: "api", message: err.error ?? "Error", timestamp, details: err.detail ?? `HTTP ${response.status}` }]
        });
        return;
      }

      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";
      let currentToolCallIndex: number | null = null;

      while (true) {
        // Check if the request was aborted
        if (abortController.signal.aborted) {
          setMessages((prev) => prev.map((m) => m.id === assistantId
            ? { ...m, content: m.content + "\n\n[Response interrupted]", streaming: false }
            : m
          ));
          break;
        }

        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });

        const lines = buffer.split("\n");
        buffer = lines.pop() ?? "";

        for (const line of lines) {
          if (!line.trim()) continue;
          let event: ChatEvent;
          try { event = JSON.parse(line); } catch { continue; }

          if (event.type === "delta") {
            setMessages((prev) => prev.map((m) => m.id === assistantId
              ? { ...m, content: m.content + (event.content as string) }
              : m
            ));
          } else if (event.type === "tool_call") {
            currentToolCallIndex = Date.now(); // unique per call
            const tc: ToolCall = { name: event.name as string, args: event.args as Record<string, unknown> };
            // Send navigation postMessage to Superset immediately
            if (event.name === "navigate_superset_dashboard") {
              supersetIframeRef.current?.contentWindow?.postMessage(
                { type: "navigate_dashboard", dashboardId: (event.args as Record<string, unknown>).dashboardId },
                supersetOrigin
              );
            } else if (event.name === "navigate_superset_chart") {
              supersetIframeRef.current?.contentWindow?.postMessage(
                { type: "navigate_chart", chartId: (event.args as Record<string, unknown>).chartId },
                supersetOrigin
              );
            }
            setMessages((prev) => prev.map((m) => m.id === assistantId
              ? { ...m, toolCalls: [...(m.toolCalls ?? []), tc] }
              : m
            ));
          } else if (event.type === "tool_result") {
            setMessages((prev) => prev.map((m) => {
              if (m.id !== assistantId) return m;
              const calls = [...(m.toolCalls ?? [])];
              // Update the last matching tool call with its result
              for (let i = calls.length - 1; i >= 0; i--) {
                if (calls[i].name === event.name && calls[i].result === undefined) {
                  calls[i] = { ...calls[i], result: event.result as string };
                  break;
                }
              }
              return { ...m, toolCalls: calls };
            }));
            void currentToolCallIndex; // suppress unused warning
            
            // Refresh Superset iframe after dashboard operations to ensure charts load properly
            const dashboardTools = ["superset_dashboard_create", "superset_dashboard_add_charts", "superset_dashboard_update"];
            if (dashboardTools.includes(event.name as string)) {
              // Small delay to allow the backend to fully process the changes
              setTimeout(() => {
                if (supersetIframeRef.current) {
                  const currentSrc = supersetIframeRef.current.src;
                  try {
                    const url = new URL(currentSrc);
                    // Add cache-busting timestamp to force reload
                    url.searchParams.set("_refresh", Date.now().toString());
                    supersetIframeRef.current.src = url.toString();
                  } catch {
                    // Fallback: append timestamp to the raw URL
                    const separator = currentSrc.includes("?") ? "&" : "?";
                    supersetIframeRef.current.src = `${currentSrc}${separator}_refresh=${Date.now()}`;
                  }
                }
              }, 500);
            }
          } else if (event.type === "done") {
            setMessages((prev) => prev.map((m) => m.id === assistantId
              ? { ...m, streaming: false }
              : m
            ));
          } else if (event.type === "followup_suggestions") {
            // Validate that suggestions is a string array
            const suggestions = Array.isArray(event.suggestions)
              ? event.suggestions.filter((s): s is string => typeof s === "string")
              : [];
            setMessages((prev) => prev.map((m) => m.id === assistantId
              ? { ...m, followupSuggestions: suggestions }
              : m
            ));
          } else if (event.type === "error") {
            const timestamp = new Date().toISOString();
            setMessages((prev) => prev.map((m) => m.id === assistantId
              ? { ...m, content: m.content || (event.message as string), streaming: false }
              : m
            ));
            setChatError({
              error: "Stream error",
              logs: [{ source: "stream", message: event.message as string, timestamp }]
            });
          }
        }
      }
    } catch (err) {
      if (err instanceof Error && err.name === "AbortError") {
        // Request was aborted by user
        setMessages((prev) => prev.map((m) => m.id === assistantId
          ? { ...m, content: m.content + "\n\n[Response interrupted]", streaming: false }
          : m
        ));
      } else {
        const msg = err instanceof Error ? err.message : "Network error";
        const timestamp = new Date().toISOString();
        setMessages((prev) => prev.map((m) => m.id === assistantId
          ? { ...m, content: msg, streaming: false }
          : m
        ));
        setChatError({
          error: "Network error",
          logs: [{ source: "network", message: msg, timestamp }]
        });
      }
    } finally {
      setLoading(false);
      abortControllerRef.current = null;
    }
  }, [input, loading, messages, supersetIframeRef, supersetOrigin]);

  const handleKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      sendMessage();
    }
  };

  const handleClear = () => setMessages(() => []);

  // Navigate the Superset iframe to a URL when the user clicks a Superset link.
  // Strip standalone/embedded-mode params so the main panel shows the full
  // Superset UI even if the URL originally came from an embed tool.
  const handleSupersetLinkClick = useCallback((url: string) => {
    if (!supersetIframeRef.current) return;
    try {
      const u = new URL(url);
      u.searchParams.delete("standalone");          // superset embedded mode
      u.searchParams.delete("native_filters_key");  // may carry stale filter state
      supersetIframeRef.current.src = u.toString();
    } catch {
      supersetIframeRef.current.src = url;
    }
  }, [supersetIframeRef]);
  
  const handleStopGenerating = () => {
    if (abortControllerRef.current) {
      abortControllerRef.current.abort();
      abortControllerRef.current = null;
    }
  };
  
  const handleSuggestionClick = useCallback((suggestion: string) => {
    // Send the suggestion immediately without validation
    const userMsg: Message = { 
      id: Date.now().toString(), 
      role: "user", 
      content: suggestion 
    };
    setMessages((prev) => [...prev, userMsg]);
    
    // Build messages array for the API
    const history = [...messages, userMsg].map((m) => ({
      role: m.role === "tool" ? "user" : m.role,
      content: m.content,
    }));

    const assistantId = (Date.now() + 1).toString();
    setMessages((prev) => [...prev, { 
      id: assistantId, 
      role: "assistant", 
      content: "", 
      streaming: true, 
      toolCalls: [] 
    }]);
    setLoading(true);
    setHasSentMessage(true);

    // Create a new abort controller for this request
    const abortController = new AbortController();
    abortControllerRef.current = abortController;

    // Call the API directly
    fetch("/api/chat", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ messages: history }),
      signal: abortController.signal,
    })
    .then(async (response) => {
      if (!response.ok || !response.body) {
        const err = await response.json().catch(() => ({ error: `HTTP ${response.status}` }));
        const timestamp = new Date().toISOString();
        setMessages((prev) => prev.map((m) => m.id === assistantId
          ? { ...m, content: err.error ?? "Error", streaming: false }
          : m
        ));
        setChatError({
          error: err.error ?? "Error",
          detail: err.detail,
          logs: [{ source: "api", message: err.error ?? "Error", timestamp, details: err.detail ?? `HTTP ${response.status}` }]
        });
        return;
      }

      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";
      let currentToolCallIndex: number | null = null;

      while (true) {
        // Check if the request was aborted
        if (abortController.signal.aborted) {
          setMessages((prev) => prev.map((m) => m.id === assistantId
            ? { ...m, content: m.content + "\n\n[Response interrupted]", streaming: false }
            : m
          ));
          break;
        }

        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });

        const lines = buffer.split("\n");
        buffer = lines.pop() ?? "";

        for (const line of lines) {
          if (!line.trim()) continue;
          let event: ChatEvent;
          try { event = JSON.parse(line); } catch { continue; }

          if (event.type === "delta") {
            setMessages((prev) => prev.map((m) => m.id === assistantId
              ? { ...m, content: m.content + (event.content as string) }
              : m
            ));
          } else if (event.type === "tool_call") {
            currentToolCallIndex = Date.now();
            const tc: ToolCall = { name: event.name as string, args: event.args as Record<string, unknown> };
            if (event.name === "navigate_superset_dashboard") {
              supersetIframeRef.current?.contentWindow?.postMessage(
                { type: "navigate_dashboard", dashboardId: (event.args as Record<string, unknown>).dashboardId },
                supersetOrigin
              );
            } else if (event.name === "navigate_superset_chart") {
              supersetIframeRef.current?.contentWindow?.postMessage(
                { type: "navigate_chart", chartId: (event.args as Record<string, unknown>).chartId },
                supersetOrigin
              );
            }
            setMessages((prev) => prev.map((m) => m.id === assistantId
              ? { ...m, toolCalls: [...(m.toolCalls ?? []), tc] }
              : m
            ));
          } else if (event.type === "tool_result") {
            setMessages((prev) => prev.map((m) => {
              if (m.id !== assistantId) return m;
              const calls = [...(m.toolCalls ?? [])];
              for (let i = calls.length - 1; i >= 0; i--) {
                if (calls[i].name === event.name && calls[i].result === undefined) {
                  calls[i] = { ...calls[i], result: event.result as string };
                  break;
                }
              }
              return { ...m, toolCalls: calls };
            }));
          } else if (event.type === "followup_suggestions") {
            const suggestions = Array.isArray(event.suggestions)
              ? event.suggestions.filter((s): s is string => typeof s === "string")
              : [];
            setMessages((prev) => prev.map((m) => m.id === assistantId
              ? { ...m, followupSuggestions: suggestions }
              : m
            ));
          } else if (event.type === "done") {
            setMessages((prev) => prev.map((m) => m.id === assistantId
              ? { ...m, streaming: false }
              : m
            ));
          } else if (event.type === "error") {
            const timestamp = new Date().toISOString();
            setMessages((prev) => prev.map((m) => m.id === assistantId
              ? { ...m, content: m.content || (event.message as string), streaming: false }
              : m
            ));
            setChatError({
              error: "Stream error",
              logs: [{ source: "stream", message: event.message as string, timestamp }]
            });
          }
        }
      }
    })
    .catch((err) => {
      if (err instanceof Error && err.name === "AbortError") {
        // Request was aborted by user
        setMessages((prev) => prev.map((m) => m.id === assistantId
          ? { ...m, content: m.content + "\n\n[Response interrupted]", streaming: false }
          : m
        ));
      } else {
        const msg = err instanceof Error ? err.message : "Network error";
        const timestamp = new Date().toISOString();
        setMessages((prev) => prev.map((m) => m.id === assistantId
          ? { ...m, content: msg, streaming: false }
          : m
        ));
        setChatError({
          error: "Network error",
          logs: [{ source: "network", message: msg, timestamp }]
        });
      }
    })
    .finally(() => {
      setLoading(false);
      abortControllerRef.current = null;
    });
  }, [messages, supersetIframeRef, supersetOrigin]);

  return (
    <div style={{ 
      display: "flex", 
      flexDirection: "column", 
      height: "100%", 
      minHeight: 0,
      background: "var(--md-surface-cont)",
      fontFamily: "system-ui, -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif",
    }}>
      {/* Animations CSS */}
      <style>{`
        @keyframes blink { 0%,100%{opacity:1} 50%{opacity:0} }
        @keyframes spin { from{transform:rotate(0deg)} to{transform:rotate(360deg)} }
        @keyframes fadeInUp {
          from {
            opacity: 0;
            transform: translateY(8px);
          }
          to {
            opacity: 1;
            transform: translateY(0);
          }
        }
        
        /* Hide scrollbar in chat messages area — keep clean look */
        .chat-messages::-webkit-scrollbar { display: none; }
        .chat-messages { scrollbar-width: none; -ms-overflow-style: none; }
      `}</style>

      {/* Header */}
      <div style={{
        display: "flex",
        alignItems: "center",
        padding: "12px 16px",
        gap: 10,
        minHeight: 52,
        flexShrink: 0,
        background: "var(--md-surface-cont)",
      }}>
        <svg viewBox="0 0 24 24" width={20} height={20} fill="var(--md-primary)">
          <path d="M20 2H4c-1.1 0-2 .9-2 2v18l4-4h14c1.1 0 2-.9 2-2V4c0-1.1-.9-2-2-2zm0 14H6l-2 2V4h16v12z" />
        </svg>
        <span style={{ fontSize: 15, fontWeight: 600, color: "var(--md-on-surface)", flex: 1 }}>Chat</span>

        {/* Clear button */}
        {messages.length > 0 && (
          <button onClick={handleClear} title="Clear conversation"
            style={{
              width: 32, height: 32,
              border: "none",
              borderRadius: "10px",
              cursor: "pointer",
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              background: "var(--md-surface-cont-hi)",
              color: "var(--md-on-surface)",
              opacity: 0.65,
              flexShrink: 0,
              transition: "all 0.2s ease",
            }}
            onMouseOver={e => { e.currentTarget.style.opacity = "1"; e.currentTarget.style.background = "var(--md-surface)"; e.currentTarget.style.transform = "scale(1.05)"; }}
            onMouseOut={e => { e.currentTarget.style.opacity = "0.65"; e.currentTarget.style.background = "var(--md-surface-cont-hi)"; e.currentTarget.style.transform = "none"; }}>
            <svg viewBox="0 0 24 24" width={16} height={16} fill="currentColor">
              <path d="M19 4h-3.5l-1-1h-5l-1 1H5v2h14V4zM6 19c0 1.1.9 2 2 2h8c1.1 0 2-.9 2-2V7H6v12z"/>
            </svg>
          </button>
        )}

        {/* Settings gear — admin only */}
        {isAdmin && (
          <button onClick={() => setShowAdminModal(true)} title="LLM settings"
            style={{
              width: 32, height: 32,
              border: "none",
              borderRadius: "10px",
              cursor: "pointer",
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              background: chatError ? "rgba(211,47,47,0.15)" : "var(--md-surface-cont-hi)",
              color: chatError ? "#ef5350" : "var(--md-on-surface)",
              opacity: chatError ? 0.9 : 0.65,
              flexShrink: 0,
              transition: "all 0.2s ease",
            }}
            onMouseOver={e => { e.currentTarget.style.opacity = "1"; e.currentTarget.style.background = chatError ? "rgba(211,47,47,0.2)" : "var(--md-surface)"; e.currentTarget.style.transform = "scale(1.05)"; }}
            onMouseOut={e => { e.currentTarget.style.opacity = chatError ? "0.9" : "0.65"; e.currentTarget.style.background = chatError ? "rgba(211,47,47,0.15)" : "var(--md-surface-cont-hi)"; e.currentTarget.style.transform = "none"; }}>
            <svg viewBox="0 0 24 24" width={17} height={17} fill="currentColor">
              <path d="M19.14,12.94c0.04-0.3,0.06-0.61,0.06-0.94c0-0.32-0.02-0.64-0.07-0.94l2.03-1.58c0.18-0.14,0.23-0.41,0.12-0.61l-1.92-3.32c-0.12-0.22-0.37-0.29-0.59-0.22l-2.39,0.96c-0.5-0.38-1.03-0.7-1.62-0.94L14.4,2.81c-0.04-0.24-0.24-0.41-0.48-0.41h-3.84c-0.24,0-0.43,0.17-0.47,0.41L9.25,5.35C8.66,5.59,8.12,5.92,7.63,6.29L5.24,5.33c-0.22-0.08-0.47,0-0.59,0.22L2.74,8.87C2.62,9.08,2.66,9.34,2.86,9.48l2.03,1.58C4.84,11.36,4.8,11.69,4.8,12s0.02,0.64,0.07,0.94l-2.03,1.58c-0.18,0.14-0.23,0.41-0.12,0.61l1.92,3.32c0.12,0.22,0.37,0.29,0.59,0.22l2.39-0.96c0.5,0.38,1.03,0.7,1.62,0.94l0.36,2.54c0.05,0.24,0.24,0.41,0.48,0.41h3.84c0.24,0,0.44-0.17,0.47-0.41l0.36-2.54c0.59-0.24,1.13-0.56,1.62-0.94l2.39,0.96c0.22,0.08,0.47,0,0.59-0.22l1.92-3.32c0.12-0.22,0.07-0.47-0.12-0.61L19.14,12.94z M12,15.6c-1.98,0-3.6-1.62-3.6-3.6s1.62-3.6,3.6-3.6s3.6,1.62,3.6,3.6S13.98,15.6,12,15.6z" />
            </svg>
          </button>
        )}
      </div>

      {/* Banners */}
      {chatError && (
        <ChatErrorBanner
          error={chatError.error} detail={chatError.detail} logs={chatError.logs} isAdmin={isAdmin}
          onOpenSettings={() => setShowAdminModal(true)}
          onDismiss={() => setChatError(null)}
        />
      )}
      {mcpWarning && !chatError && (
        <McpWarningBanner message={mcpWarning} onDismiss={() => setMcpWarning(null)} />
      )}

      {/* Message list */}
      <div style={{ flex: 1, minHeight: 0, position: "relative" }}>
        {/* Top gradient */}
        <div style={{
          position: "absolute",
          top: 0,
          left: 0,
          right: 0,
          height: 24,
          background: "linear-gradient(to bottom, var(--md-surface-cont), transparent)",
          zIndex: 1,
          pointerEvents: "none",
        }} />
        {/* Bottom gradient */}
        <div style={{
          position: "absolute",
          bottom: 0,
          left: 0,
          right: 0,
          height: 24,
          background: "linear-gradient(to top, var(--md-surface-cont), transparent)",
          zIndex: 1,
          pointerEvents: "none",
        }} />
        <div 
          className="chat-messages" 
          style={{
            height: "100%",
            overflowY: messages.length === 0 ? "hidden" : "auto",
            padding: "16px 0"
        }}>
        {messages.length === 0 && (
          <div style={{
            display: "flex",
            flexDirection: "column",
            alignItems: "center",
            justifyContent: "center",
            minHeight: "100%",
            gap: 16,
            userSelect: "none",
            animation: "fadeInUp 0.5s ease-out",
          }}>
            <div style={{
              width: 64,
              height: 64,
              borderRadius: "50%",
              background: "var(--md-primary-cont)",
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              boxShadow: "0 2px 8px rgba(0,0,0,0.08)",
            }}>
              <svg viewBox="0 0 24 24" width={32} height={32} fill="var(--md-primary)">
                <path d="M20 2H4c-1.1 0-2 .9-2 2v18l4-4h14c1.1 0 2-.9 2-2V4c0-1.1-.9-2-2-2zm0 14H6l-2 2V4h16v12z" />
              </svg>
            </div>
            <span style={{ fontSize: 15, fontWeight: 500 }}>Hello! Ask me anything about your data.</span>
          </div>
        )}
        {messages.map((msg) => (
          <MessageBubble
            key={msg.id}
            msg={msg}
            supersetUrl={supersetUrl}
            onSuggestionClick={handleSuggestionClick}
            onSupersetLinkClick={handleSupersetLinkClick}
          />
        ))}
        {messages.length >= 20 && (
          <div style={{
            margin: "8px 16px",
            padding: "8px 12px",
            borderRadius: 10,
            background: "var(--md-surface-cont-hi)",
            border: "1px solid var(--md-outline-var)",
            fontSize: 12,
            color: "var(--md-on-surface-var)",
            textAlign: "center",
            lineHeight: 1.5,
          }}>
            This conversation is getting long and may slow down responses.{" "}
            <button
              onClick={handleClear}
              style={{
                background: "none",
                border: "none",
                padding: 0,
                cursor: "pointer",
                color: "var(--md-primary)",
                fontSize: 12,
                fontWeight: 600,
                textDecoration: "underline",
                fontFamily: "inherit",
              }}
            >
              Reset conversation
            </button>
          </div>
        )}
        <div ref={messagesEndRef} style={{ height: 8 }} />
      </div>
      </div>

      {/* Floating Input area */}
      <div style={{
        padding: "8px 16px 16px",
        display: "flex", 
        flexShrink: 0,
        background: "transparent",
        position: "relative",
      }}>
        <div style={{
          flex: 1,
          position: "relative",
          borderRadius: "26px",
          background: "var(--md-surface-cont-hi)",
          border: `2px solid ${input.trim() ? "var(--md-primary)" : hasSentMessage ? "var(--md-outline)" : "var(--md-outline-var)"}`,
          transition: "all 0.2s ease-out",
          boxShadow: input.trim() 
            ? "0 4px 12px rgba(255, 107, 53, 0.15), 0 2px 4px rgba(0,0,0,0.06)"
            : "0 2px 8px rgba(0,0,0,0.04), 0 1px 2px rgba(0,0,0,0.02)",
        }}>
          <textarea
            ref={textareaRef}
            value={input}
            onChange={handleInputChange}
            onKeyDown={handleKeyDown}
            placeholder="Ask about your data…"
            rows={1}
            disabled={loading || !!chatError}
            className="chat-input"
            style={{
              flex: 1, resize: "none", 
              border: "none",
              borderRadius: "26px", 
              padding: "10px 52px 10px 18px", 
              fontSize: 15,
              background: "transparent", 
              color: "var(--md-on-surface)",
              outline: "none", 
              fontFamily: "inherit", 
              lineHeight: `${LINE_HEIGHT}px`,
              overflowY: "hidden",
              opacity: (loading || !!chatError) ? 0.6 : 1,
              transition: "height 0.15s ease",
              minHeight: 42,
              width: "100%",
              WebkitAppearance: "none",
              MozAppearance: "none",
              outlineOffset: 0,
              WebkitTapHighlightColor: "transparent",
            }}
          />
          <div style={{
            position: "absolute",
            right: 12,
            top: "50%",
            transform: input.trim() || loading ? "translateY(-50%) scale(1)" : "translateY(-50%) scale(0.85)",
            pointerEvents: "none",
            opacity: input.trim() || loading ? 1 : 0.4,
            transition: "all 0.2s ease-out",
          }}>
            {loading ? (
              <button
                onClick={(e) => {
                  e.stopPropagation();
                  handleStopGenerating();
                }}
                title="Stop generating"
                style={{
                  border: "none",
                  background: "rgba(239, 83, 80, 0.12)",
                  cursor: "pointer",
                  padding: "6px",
                  borderRadius: "50%",
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "center",
                  pointerEvents: "auto",
                  transition: "all 0.2s ease",
                }}
                onMouseOver={e => { e.currentTarget.style.background = "rgba(239, 83, 80, 0.2)"; e.currentTarget.style.transform = "scale(1.1)"; }}
                onMouseOut={e => { e.currentTarget.style.background = "rgba(239, 83, 80, 0.12)"; e.currentTarget.style.transform = "none"; }}>
                <svg viewBox="0 0 24 24" width={22} height={22} fill="#ef5350">
                  <path d="M18 18H6V6h12v12z"/>
                </svg>
              </button>
            ) : (
              <button
                onClick={(e) => {
                  e.stopPropagation();
                  if (input.trim() && !loading && !chatError) sendMessage();
                }}
                disabled={!input.trim() || loading || !!chatError}
                title="Send"
                style={{
                  border: "none",
                  background: input.trim() ? "var(--md-primary)" : "transparent",
                  cursor: (!input.trim() || loading || !!chatError) ? "default" : "pointer",
                  padding: "6px",
                  borderRadius: "50%",
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "center",
                  pointerEvents: "auto",
                  transition: "all 0.2s ease",
                }}
                onMouseOver={e => { if (input.trim()) { e.currentTarget.style.filter = "brightness(1.1)"; e.currentTarget.style.transform = "scale(1.1)"; } }}
                onMouseOut={e => { e.currentTarget.style.filter = "none"; e.currentTarget.style.transform = "none"; }}>
                <svg viewBox="0 0 24 24" width={22} height={22} fill={input.trim() ? "#FFFFFF" : "var(--md-primary)"} style={{ transition: "fill 0.2s ease" }}>
                  <path d="M2.01 21L23 12 2.01 3 2 10l15 2-15 2z" transform="rotate(-45 12 12)" />
                </svg>
              </button>
            )}
          </div>
        </div>
      </div>

      {/* Admin modal */}
      {showAdminModal && (
        <AdminModal onClose={() => { setShowAdminModal(false); setChatError(null); }} />
      )}
    </div>
  );
}
