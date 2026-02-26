"use client";

import React, { useState, useEffect, useRef, useCallback } from "react";
import { AdminModal } from "./AdminModal";

interface ChatPanelProps {
  isAdmin: boolean;
  supersetIframeRef: React.RefObject<HTMLIFrameElement | null>;
  supersetUrl: string;
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

function renderMarkdown(text: string, supersetUrl: string): React.ReactNode {
  const lines = text.split("\n");
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
          background: "var(--md-surface-cont-hi)", borderRadius: 8,
          padding: "10px 12px", overflowX: "auto", fontSize: 12,
          margin: "6px 0", border: "1px solid var(--md-outline-var)",
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
        items.push(<li key={key()}>{inlineRender(lines[i].slice(2))}</li>);
        i++;
      }
      nodes.push(<ul key={key()} style={{ margin: "4px 0 4px 16px", padding: 0 }}>{items}</ul>);
      continue;
    }

    // Numbered list
    if (/^\d+\. /.test(line)) {
      const items: React.ReactNode[] = [];
      while (i < lines.length && /^\d+\. /.test(lines[i])) {
        items.push(<li key={key()}>{inlineRender(lines[i].replace(/^\d+\. /, ""))}</li>);
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
          <div key={key()} style={{ overflowX: "auto", margin: "8px 0" }}>
            <table style={{ 
              borderCollapse: "collapse", 
              width: "100%",
              fontSize: "12px",
              border: "1px solid var(--md-outline-var)"
            }}>
              <thead>
                <tr style={{ background: "var(--md-surface-cont-hi)" }}>
                  {parsedTable.headers.map((header, colIndex) => (
                    <th key={colIndex} style={{ 
                      padding: "6px 10px",
                      textAlign: parsedTable.alignments[colIndex] || "left",
                      border: "1px solid var(--md-outline-var)",
                      fontWeight: 600,
                      color: "var(--md-on-surface)"
                    }}>
                      {inlineRender(header.trim())}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {parsedTable.rows.map((row, rowIndex) => (
                  <tr key={rowIndex} style={{ 
                    background: rowIndex % 2 === 0 ? "var(--md-surface)" : "var(--md-surface-cont-hi)"
                  }}>
                    {row.map((cell, cellIndex) => (
                      <td key={cellIndex} style={{ 
                        padding: "6px 10px",
                        textAlign: parsedTable.alignments[cellIndex] || "left",
                        border: "1px solid var(--md-outline-var)",
                        color: "var(--md-on-surface)"
                      }}>
                        {inlineRender(cell.trim())}
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
          {inlineRender(hMatch[2])}
        </p>
      );
      i++;
      continue;
    }

    // Iframe embedding
    const iframeMatch = line.match(/^\[iframe\]\(([^\s]+)\)\s*(.*)$/);
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
              <div style={{ 
                fontSize: "11px", 
                color: "var(--md-on-surface)", 
                opacity: 0.7,
                marginBottom: "4px",
                fontWeight: 500 
              }}>
                {iframeTitle}
              </div>
              <div style={{ 
                border: "1px solid var(--md-outline-var)",
                borderRadius: "8px",
                overflow: "hidden",
                background: "var(--md-surface-cont)"
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
          // Show URL as link if not allowed
          nodes.push(
            <p key={key()} style={{ margin: "2px 0", lineHeight: 1.6, color: "var(--md-primary)" }}>
              🔒 <a href={iframeUrl} target="_blank" rel="noopener noreferrer" style={{ color: "var(--md-primary)" }}>
                {iframeTitle || iframeUrl}
              </a> (external content not embedded for security)
            </p>
          );
        }
      } catch {
        // Invalid URL - show as text
        nodes.push(<p key={key()} style={{ margin: "2px 0", lineHeight: 1.6 }}>{inlineRender(line)}</p>);
      }
      i++;
      continue;
    }

    // Empty line → spacing
    if (line.trim() === "") {
      nodes.push(<div key={key()} style={{ height: 6 }} />);
      i++;
      continue;
    }

    // Normal paragraph line
    nodes.push(<p key={key()} style={{ margin: "2px 0", lineHeight: 1.6 }}>{inlineRender(line)}</p>);
    i++;
  }

  return <>{nodes}</>;
}

function inlineRender(text: string): React.ReactNode {
  // Split on **bold**, *italic*, `code`
  const parts: React.ReactNode[] = [];
  let remaining = text;
  let k = 0;

  while (remaining.length > 0) {
    const boldIdx = remaining.indexOf("**");
    const italicIdx = remaining.indexOf("*");
    const codeIdx = remaining.indexOf("`");

    // Find the earliest marker
    const candidates = [
      boldIdx >= 0 ? boldIdx : Infinity,
      italicIdx >= 0 && italicIdx !== boldIdx ? italicIdx : Infinity,
      codeIdx >= 0 ? codeIdx : Infinity,
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
            background: "var(--md-surface-cont-hi)", borderRadius: 4,
            padding: "1px 5px", fontSize: "0.9em", fontFamily: "monospace",
            border: "1px solid var(--md-outline-var)",
          }}>
            {remaining.slice(1, end)}
          </code>
        );
        remaining = remaining.slice(end + 1);
        continue;
      }
    }

    // Unmatched marker — treat as literal
    parts.push(remaining[0]);
    remaining = remaining.slice(1);
  }

  return <>{parts}</>;
}

// ── Tool call step component ─────────────────────────────────────
function ToolStep({ tc }: { tc: ToolCall }) {
  const [open, setOpen] = useState(false);
  const isPending = tc.result === undefined;
  const isNav = tc.name.startsWith("navigate_superset_");

  return (
    <div style={{
      border: "1px solid var(--md-outline-var)", borderRadius: 10,
      margin: "4px 0", overflow: "hidden",
      background: "var(--md-surface)",
    }}>
      <button
        onClick={() => setOpen((o) => !o)}
        style={{
          width: "100%", display: "flex", alignItems: "center", gap: 6,
          padding: "6px 10px", background: "var(--md-primary-cont)",
          border: "none", cursor: "pointer", color: "var(--md-on-primary-cont)",
          fontSize: 12, fontWeight: 500, textAlign: "left",
        }}
      >
        <span style={{ fontSize: 9, transition: "transform 0.2s", display: "inline-block", transform: open ? "rotate(90deg)" : "none" }}>▶</span>
        {isPending ? (
          <>
            <span style={{ opacity: 0.6 }}>⋯</span>
            <span>{tc.name.replace(/_/g, " ")}</span>
          </>
        ) : isNav ? (
          <span>↗ {tc.name === "navigate_superset_dashboard" ? `Dashboard ${tc.args.dashboardId ?? ""}` : `Chart ${tc.args.chartId ?? ""}`}</span>
        ) : (
          <span>🔧 {tc.name.replace(/_/g, " ")}</span>
        )}
      </button>
      {open && (
        <pre style={{
          padding: "8px 12px", fontSize: 11, overflowX: "auto",
          whiteSpace: "pre-wrap", wordBreak: "break-all",
          color: "var(--md-on-surface)", opacity: 0.8, margin: 0,
        }}>
          {`args: ${JSON.stringify(tc.args, null, 2)}`}
          {tc.result !== undefined ? `\n\nresult: ${tc.result}` : ""}
        </pre>
      )}
    </div>
  );
}

// ── Message bubble ────────────────────────────────────────────────
function MessageBubble({ msg, supersetUrl, onSuggestionClick }: { 
  msg: Message; 
  supersetUrl: string;
  onSuggestionClick?: (suggestion: string) => void;
}) {
  const isUser = msg.role === "user";
  const isAssistant = msg.role === "assistant";
  
  return (
    <div style={{
      display: "flex",
      flexDirection: "column",
      alignItems: isUser ? "flex-end" : "flex-start",
      padding: "2px 12px",
    }}>
      {msg.toolCalls?.map((tc, i) => <ToolStep key={i} tc={tc} />)}

      {msg.content && (
        <div style={{
          maxWidth: "88%",
          padding: isUser ? "8px 12px" : "6px 0",
          borderRadius: isUser ? 14 : 0,
          background: isUser ? "var(--md-primary-cont)" : "transparent",
          color: isUser ? "var(--md-on-primary-cont)" : "var(--md-on-surface)",
          fontSize: 13,
          lineHeight: 1.55,
          wordBreak: "break-word",
        }}>
          {isUser ? msg.content : renderMarkdown(msg.content, supersetUrl)}
          {msg.streaming && (
            <span style={{
              display: "inline-block", width: 6, height: 13,
              background: "var(--md-primary)", borderRadius: 1, marginLeft: 2,
              animation: "blink 1s step-end infinite",
              verticalAlign: "text-bottom",
            }} />
          )}
        </div>
      )}
      
      {/* Follow-up suggestions for assistant messages */}
      {isAssistant && !msg.streaming && msg.followupSuggestions && msg.followupSuggestions.length > 0 && onSuggestionClick && (
        <div style={{ maxWidth: "88%", marginTop: 4 }}>
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
      marginTop: 12, 
      paddingLeft: 16,
      borderLeft: "2px solid var(--md-primary)",
    }}>
      <div style={{
        fontSize: 12, 
        color: "var(--md-primary)", 
        marginBottom: 8, 
        fontWeight: 500,
      }}>
        Follow-up questions
      </div>
      <div style={{
        display: "flex", 
        flexDirection: "column", 
        gap: 6,
      }}>
        {suggestions.map((suggestion, index) => (
          <button
            key={index}
            onClick={() => onSuggestionClick(suggestion)}
            style={{
              padding: "6px 0",
              background: "transparent",
              color: "var(--md-on-surface)", 
              border: "none",
              borderRadius: 0,
              fontSize: 13,
              cursor: "pointer",
              transition: "all 0.2s",
              textAlign: "left",
              width: "fit-content",
              maxWidth: "100%",
              display: "flex",
              alignItems: "center",
            }}
            onMouseOver={(e) => {
              e.currentTarget.style.color = "var(--md-primary)";
              e.currentTarget.style.transform = "translateX(2px)";
            }}
            onMouseOut={(e) => {
              e.currentTarget.style.color = "var(--md-on-surface)";
              e.currentTarget.style.transform = "none";
            }}
          >
            <span style={{ marginRight: 8, opacity: 0.6, color: "var(--md-primary)" }}>→</span>
            {suggestion}
          </button>
        ))}
      </div>
    </div>
  );
}

// ── Error banner ─────────────────────────────────────────────────
function ChatErrorBanner({ error, detail, isAdmin, onOpenSettings, onDismiss }: {
  error: string; detail?: string; isAdmin: boolean;
  onOpenSettings: () => void; onDismiss: () => void;
}) {
  const [copied, setCopied] = useState(false);
  const handleCopy = useCallback(() => {
    const text = [error, detail ? `Detail: ${detail}` : ""].filter(Boolean).join("\n");
    navigator.clipboard.writeText(text).then(() => { setCopied(true); setTimeout(() => setCopied(false), 1500); });
  }, [error, detail]);

  return (
    <div style={{
      margin: "8px 10px 0", padding: "10px 12px", borderRadius: 10,
      background: "rgba(211,47,47,0.10)", border: "1px solid rgba(211,47,47,0.28)",
      display: "flex", flexDirection: "column", gap: 6, fontSize: 12,
    }}>
      <div style={{ display: "flex", alignItems: "flex-start", gap: 8 }}>
        <span style={{ color: "#ef5350", fontWeight: 700, flexShrink: 0, fontSize: 14 }}>⚠</span>
        <span style={{ flex: 1, color: "var(--md-on-surface)", lineHeight: 1.5 }}>{error}</span>
        <button onClick={handleCopy} title="Copy error"
          style={{ border: "none", background: "none", cursor: "pointer", color: "var(--md-on-surface)", opacity: 0.5, fontSize: 13, flexShrink: 0, padding: "0 2px" }}>
          {copied ? "✓" : "⎘"}
        </button>
        <button onClick={onDismiss} title="Dismiss"
          style={{ border: "none", background: "none", cursor: "pointer", color: "var(--md-on-surface)", opacity: 0.4, fontSize: 15, flexShrink: 0, padding: "0 2px", lineHeight: 1 }}>
          ×
        </button>
      </div>
      {isAdmin && (
        <button onClick={onOpenSettings} style={{
          alignSelf: "flex-start", background: "none", border: "1px solid rgba(211,47,47,0.35)",
          borderRadius: 6, color: "#ef5350", fontSize: 11, padding: "3px 8px", cursor: "pointer",
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
      margin: "6px 10px 0", padding: "7px 12px", borderRadius: 8,
      background: "rgba(245,158,11,0.10)", border: "1px solid rgba(245,158,11,0.30)",
      display: "flex", alignItems: "center", gap: 8, fontSize: 11,
    }}>
      <span style={{ color: "#f59e0b", fontWeight: 700, flexShrink: 0 }}>⚡</span>
      <span style={{ flex: 1, color: "var(--md-on-surface)", opacity: 0.75, lineHeight: 1.4 }}>{message}</span>
      <button onClick={onDismiss} title="Dismiss"
        style={{ border: "none", background: "none", cursor: "pointer", color: "var(--md-on-surface)", opacity: 0.4, fontSize: 14, flexShrink: 0, padding: "0 2px", lineHeight: 1 }}>
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
  injectedMessage,
  onInjectionConsumed,
  messages,
  onMessagesChange,
}: ChatPanelProps) {
  const setMessages = onMessagesChange;
  const [input, setInput] = useState("");
  const [loading, setLoading] = useState(false);
  const [showAdminModal, setShowAdminModal] = useState(false);
  const [chatError, setChatError] = useState<{ error: string; detail?: string } | null>(null);
  const [mcpWarning, setMcpWarning] = useState<string | null>(null);
  const [hasSentMessage, setHasSentMessage] = useState(false);
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const supersetOrigin = (() => { try { return new URL(supersetUrl).origin; } catch { return "*"; } })();
  const abortControllerRef = useRef<AbortController | null>(null);

  // Probe endpoint on mount
  useEffect(() => {
    fetch("/api/chat").then(async (res) => {
      try {
        const body = await res.json();
        if (!res.ok) setChatError({ error: body.error ?? "Chat API error", detail: body.detail });
        else if (body.mcpWarning) setMcpWarning(body.mcpWarning);
      } catch { if (!res.ok) setChatError({ error: `Chat API returned HTTP ${res.status}` }); }
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
        body: JSON.stringify({ messages: history }),
        signal: abortController.signal,
      });

      if (!response.ok || !response.body) {
        const err = await response.json().catch(() => ({ error: `HTTP ${response.status}` }));
        setMessages((prev) => prev.map((m) => m.id === assistantId
          ? { ...m, content: err.error ?? "Error", streaming: false }
          : m
        ));
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
            setMessages((prev) => prev.map((m) => m.id === assistantId
              ? { ...m, content: m.content || (event.message as string), streaming: false }
              : m
            ));
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
        setMessages((prev) => prev.map((m) => m.id === assistantId
          ? { ...m, content: msg, streaming: false }
          : m
        ));
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
        setMessages((prev) => prev.map((m) => m.id === assistantId
          ? { ...m, content: err.error ?? "Error", streaming: false }
          : m
        ));
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
            setMessages((prev) => prev.map((m) => m.id === assistantId
              ? { ...m, content: m.content || (event.message as string), streaming: false }
              : m
            ));
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
        setMessages((prev) => prev.map((m) => m.id === assistantId
          ? { ...m, content: msg, streaming: false }
          : m
        ));
      }
    })
    .finally(() => {
      setLoading(false);
      abortControllerRef.current = null;
    });
  }, [messages, supersetIframeRef, supersetOrigin]);

  return (
    <div style={{ display: "flex", flexDirection: "column", height: "100%", background: "var(--md-surface-cont)" }}>
      {/* Blinking cursor CSS */}
      <style>{`@keyframes blink { 0%,100%{opacity:1} 50%{opacity:0} }`}</style>

      {/* Header */}
      <div style={{
        display: "flex", alignItems: "center", padding: "8px 12px",
        borderBottom: "1px solid var(--md-outline-var)", gap: 8, minHeight: 44, flexShrink: 0,
      }}>
        <svg viewBox="0 0 24 24" width={18} height={18} fill="var(--md-primary)">
          <path d="M20 2H4c-1.1 0-2 .9-2 2v18l4-4h14c1.1 0 2-.9 2-2V4c0-1.1-.9-2-2-2zm0 14H6l-2 2V4h16v12z" />
        </svg>
        <span style={{ fontSize: 13, fontWeight: 600, color: "var(--md-on-surface)", flex: 1 }}>Chat</span>

        {/* Clear button */}
        {messages.length > 0 && (
          <button onClick={handleClear} title="Clear conversation"
            style={{
              width: 28, height: 28, border: "none", borderRadius: "var(--radius-m)", cursor: "pointer",
              display: "flex", alignItems: "center", justifyContent: "center",
              background: "var(--md-surface-cont-hi)", color: "var(--md-on-surface)",
              opacity: 0.55, flexShrink: 0,
            }}>
            {/* Broom / clear icon */}
            <svg viewBox="0 0 24 24" width={15} height={15} fill="currentColor">
              <path d="M19 4h-3.5l-1-1h-5l-1 1H5v2h14V4zM6 19c0 1.1.9 2 2 2h8c1.1 0 2-.9 2-2V7H6v12z"/>
            </svg>
          </button>
        )}

        {/* Settings gear — admin only */}
        {isAdmin && (
          <button onClick={() => setShowAdminModal(true)} title="LLM settings"
            style={{
              width: 30, height: 30, border: "none", borderRadius: "var(--radius-m)", cursor: "pointer",
              display: "flex", alignItems: "center", justifyContent: "center",
              background: chatError ? "rgba(211,47,47,0.15)" : "var(--md-secondary-cont)",
              color: chatError ? "#ef5350" : "var(--md-on-sec-cont)",
              transition: "background 0.2s",
            }}>
            <svg viewBox="0 0 24 24" width={16} height={16} fill="currentColor">
              <path d="M19.14,12.94c0.04-0.3,0.06-0.61,0.06-0.94c0-0.32-0.02-0.64-0.07-0.94l2.03-1.58c0.18-0.14,0.23-0.41,0.12-0.61l-1.92-3.32c-0.12-0.22-0.37-0.29-0.59-0.22l-2.39,0.96c-0.5-0.38-1.03-0.7-1.62-0.94L14.4,2.81c-0.04-0.24-0.24-0.41-0.48-0.41h-3.84c-0.24,0-0.43,0.17-0.47,0.41L9.25,5.35C8.66,5.59,8.12,5.92,7.63,6.29L5.24,5.33c-0.22-0.08-0.47,0-0.59,0.22L2.74,8.87C2.62,9.08,2.66,9.34,2.86,9.48l2.03,1.58C4.84,11.36,4.8,11.69,4.8,12s0.02,0.64,0.07,0.94l-2.03,1.58c-0.18,0.14-0.23,0.41-0.12,0.61l1.92,3.32c0.12,0.22,0.37,0.29,0.59,0.22l2.39-0.96c0.5,0.38,1.03,0.7,1.62,0.94l0.36,2.54c0.05,0.24,0.24,0.41,0.48,0.41h3.84c0.24,0,0.44-0.17,0.47-0.41l0.36-2.54c0.59-0.24,1.13-0.56,1.62-0.94l2.39,0.96c0.22,0.08,0.47,0,0.59-0.22l1.92-3.32c0.12-0.22,0.07-0.47-0.12-0.61L19.14,12.94z M12,15.6c-1.98,0-3.6-1.62-3.6-3.6s1.62-3.6,3.6-3.6s3.6,1.62,3.6,3.6S13.98,15.6,12,15.6z" />
            </svg>
          </button>
        )}
      </div>

      {/* Banners */}
      {chatError && (
        <ChatErrorBanner
          error={chatError.error} detail={chatError.detail} isAdmin={isAdmin}
          onOpenSettings={() => setShowAdminModal(true)}
          onDismiss={() => setChatError(null)}
        />
      )}
      {mcpWarning && !chatError && (
        <McpWarningBanner message={mcpWarning} onDismiss={() => setMcpWarning(null)} />
      )}

      {/* Message list */}
      <div style={{ flex: 1, overflowY: "auto", padding: "12px 0" }}>
        {messages.length === 0 && (
          <div style={{
            display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center",
            height: "100%", gap: 10, opacity: 0.45, userSelect: "none",
          }}>
            <svg viewBox="0 0 24 24" width={36} height={36} fill="var(--md-primary)">
              <path d="M20 2H4c-1.1 0-2 .9-2 2v18l4-4h14c1.1 0 2-.9 2-2V4c0-1.1-.9-2-2-2zm0 14H6l-2 2V4h16v12z" />
            </svg>
            <span style={{ fontSize: 13 }}>Hello! Ask me anything about your data.</span>
          </div>
        )}
        {messages.map((msg) => (
          <MessageBubble 
            key={msg.id} 
            msg={msg} 
            supersetUrl={supersetUrl}
            onSuggestionClick={handleSuggestionClick}
          />
        ))}
        <div ref={messagesEndRef} />
      </div>

      {/* Floating Input area */}
      <div style={{
        padding: "6px 10px 10px 14px",
        display: "flex", 
        flexShrink: 0,
        background: "transparent",
        position: "relative",
      }}>
        <div style={{
          flex: 1,
          position: "relative",
          borderRadius: 24,
          background: "transparent",
          border: "1px solid var(--md-outline-var)",
          transition: "all 0.2s ease",
          ...(input.trim() ? {
            borderColor: "var(--md-primary)",
          } : hasSentMessage ? {
            borderColor: "var(--md-outline-var)",
          } : {})
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
              borderRadius: 24, 
              padding: "6px 46px 6px 14px", 
              fontSize: 14,
              background: "transparent", 
              color: "var(--md-on-surface)",
              outline: "none", 
              fontFamily: "inherit", 
              lineHeight: `${LINE_HEIGHT}px`,
              overflowY: "hidden",
              opacity: (loading || !!chatError) ? 0.6 : 1,
              transition: "height 0.1s ease",
              minHeight: 38,
              width: "100%",
              WebkitAppearance: "none",
              MozAppearance: "none",
              // Ensure no focus outline overrides our border
              outlineOffset: 0,
              WebkitTapHighlightColor: "transparent",
            }}
          />
          <div style={{
            position: "absolute",
            right: 12,
            top: "50%",
            transform: input.trim() ? "translateY(-50%) scale(1)" : "translateY(-50%) scale(0.9)",
            pointerEvents: "none",
            opacity: input.trim() ? 1 : 0.3,
            transition: "opacity 0.2s, transform 0.1s",
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
                  background: "transparent",
                  cursor: "pointer",
                  padding: "4px",
                  borderRadius: "50%",
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "center",
                  pointerEvents: "auto",
                }}
              >
                <svg viewBox="0 0 24 24" width={20} height={20} fill="#ef5350">
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
                  background: "transparent",
                  cursor: (!input.trim() || loading || !!chatError) ? "default" : "pointer",
                  padding: "4px",
                  borderRadius: "50%",
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "center",
                  pointerEvents: "auto",
                }}
              >
                <svg viewBox="0 0 24 24" width={20} height={20} fill="var(--md-primary)">
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

      <style>{`@keyframes spin { from{transform:rotate(0deg)} to{transform:rotate(360deg)} }
@keyframes blink { 0%,100%{opacity:1} 50%{opacity:0} }

/* Modern rounded scrollbar */
::-webkit-scrollbar {
  width: 8px;
  height: 8px;
}

::-webkit-scrollbar-track {
  background: transparent;
  border-radius: 10px;
}

::-webkit-scrollbar-thumb {
  background: rgba(0, 0, 0, 0.2);
  border-radius: 10px;
  border: 2px solid transparent;
  background-clip: padding-box;
}

::-webkit-scrollbar-thumb:hover {
  background: rgba(0, 0, 0, 0.3);
}

/* Firefox scrollbar */
scrollbar-width: thin;
scrollbar-color: rgba(0, 0, 0, 0.2) transparent;`}</style>
    </div>
  );
}
