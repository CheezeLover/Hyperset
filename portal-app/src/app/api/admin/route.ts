import { NextRequest, NextResponse } from "next/server";
import { getUserFromRequest } from "@/lib/auth";
import OpenAI from "openai";
import {
  getAdminSettings,
  setAdminSettings,
  clearAdminSettings,
} from "@/lib/admin-settings";
import { DEFAULT_SYSTEM_PROMPT } from "@/lib/default-system-prompt";

import { checkRateLimit } from "@/lib/rate-limit";

// ── Rate limiters ──────────────────────────────────────────────────────────────
// General admin endpoint limit: 20 req / 60 s per user (config reads/saves).
const ADMIN_RATE_LIMIT   = 20;
const ADMIN_RATE_WINDOW  = 60_000;

// Stricter limit for PATCH (makes a live outbound LLM call): 5 req / 60 s.
const PATCH_RATE_LIMIT   = 5;
const PATCH_RATE_WINDOW  = 60_000;

function requireAdmin(request: NextRequest) {
  const user = getUserFromRequest(request);
  if (!user.isAdmin) return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  return null;
}

/**
 * Validate an API URL before making outbound requests.
 * Blocks non-HTTPS, loopback, private, and link-local addresses
 * to prevent SSRF attacks via the API validation endpoint.
 */
function validateApiUrl(url: string): string | null {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return "apiUrl must be a valid URL";
  }
  if (parsed.protocol !== "https:") {
    return "apiUrl must use https://";
  }
  const host = parsed.hostname;

  // ── IPv4 loopback and unspecified ────────────────────────────────────────────
  if (host === "localhost" || host === "127.0.0.1" || host === "0.0.0.0") {
    return "apiUrl must not point to a loopback address";
  }

  // ── IPv4 private / link-local / CGNAT ranges ─────────────────────────────────
  const ipv4 = host.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (ipv4) {
    const [a, b] = [Number(ipv4[1]), Number(ipv4[2])];
    if (
      a === 10 ||                           // 10.0.0.0/8      RFC-1918
      (a === 172 && b >= 16 && b <= 31) ||  // 172.16.0.0/12   RFC-1918
      (a === 192 && b === 168) ||           // 192.168.0.0/16  RFC-1918
      (a === 169 && b === 254) ||           // 169.254.0.0/16  link-local
      (a === 100 && b >= 64 && b <= 127)    // 100.64.0.0/10   CGNAT (RFC-6598)
    ) {
      return "apiUrl must not point to a private, link-local, or CGNAT address";
    }
  }

  // ── IPv6 loopback, mapped, and private ranges ────────────────────────────────
  // Node's URL parser strips brackets: "https://[::1]/" → hostname "::1"
  const h6 = host.toLowerCase();

  // :: — unspecified address (analogous to 0.0.0.0 in IPv4)
  if (h6 === "::" || h6 === "0:0:0:0:0:0:0:0") {
    return "apiUrl must not point to an unspecified IPv6 address";
  }
  // ::1 / 0:0:0:0:0:0:0:1 — loopback
  if (h6 === "::1" || h6 === "0:0:0:0:0:0:0:1") {
    return "apiUrl must not point to an IPv6 loopback address";
  }
  // ::ffff:0:0/96 — IPv4-mapped (covers ::ffff:127.0.0.1, ::ffff:10.x.x.x …)
  if (h6.startsWith("::ffff:")) {
    return "apiUrl must not use an IPv4-mapped IPv6 address";
  }
  // 64:ff9b::/96 and 64:ff9b:1::/48 — NAT64 well-known prefixes (RFC 6052, RFC 8215).
  // These translate an IPv6 address to IPv4, so 64:ff9b::10.0.0.1 reaches 10.0.0.1.
  if (h6.startsWith("64:ff9b:")) {
    return "apiUrl must not use a NAT64 address";
  }
  // 2002::/16 — 6to4 (RFC 3056). Embeds an IPv4 address in bits 16-47.
  // e.g. 2002:7f00:0001:: encodes 127.0.0.1; 2002:0a00:: encodes 10.0.0.0
  if (h6.startsWith("2002:")) {
    return "apiUrl must not use a 6to4 address";
  }
  // fe80::/10 — IPv6 link-local
  if (/^fe[89ab]/.test(h6)) {
    return "apiUrl must not point to an IPv6 link-local address";
  }
  // fc00::/7 — Unique Local Addresses (fc00:: and fd00::, analogous to RFC-1918)
  if (/^f[cd]/.test(h6)) {
    return "apiUrl must not point to a private IPv6 (ULA) address";
  }

  return null;
}

/** GET /api/admin — return current effective LLM settings */
export async function GET(request: NextRequest) {
  const denied = requireAdmin(request);
  if (denied) return denied;

  const { email } = getUserFromRequest(request);
  if (!await checkRateLimit("admin", ADMIN_RATE_LIMIT, ADMIN_RATE_WINDOW, email)) {
    return NextResponse.json({ error: "Rate limit exceeded" }, { status: 429 });
  }

  console.log("[admin/api] Loading admin settings...");
  const s = await getAdminSettings();
  console.log("[admin/api] Got settings from DB:", s ? "settings found" : "no settings");
  const effectiveSystemPrompt = s?.systemPrompt ?? process.env.LLM_SYSTEM_PROMPT ?? DEFAULT_SYSTEM_PROMPT;

  const response = {
    apiUrl:              s?.apiUrl              ?? process.env.LLM_API_URL       ?? "",
    apiKey:              s?.apiKey              ? "***" : "",
    model:               s?.model               ?? process.env.LLM_MODEL        ?? "gpt-4o",
    systemPrompt:        s?.systemPrompt        ?? process.env.LLM_SYSTEM_PROMPT ?? "",
    modelParams:         s?.modelParams         ?? "",
    effectiveSystemPrompt,
    maxTurns:            s?.maxTurns            ?? Number(process.env.LLM_MAX_TURNS             ?? 40),
    maxToolResultChars:  s?.maxToolResultChars  ?? Number(process.env.LLM_MAX_TOOL_RESULT_CHARS ?? 3000),
    maxHistoryMessages:  s?.maxHistoryMessages  ?? Number(process.env.LLM_MAX_HISTORY_MESSAGES  ?? 20),
    cleanupDelayMinutes: s?.cleanupDelayMinutes ?? Number(process.env.HYPERSET_CLEANUP_DELAY_MINUTES ?? 120),
    kbTopK:              s?.kbTopK              ?? 6,
    kbChunkSize:         s?.kbChunkSize         ?? 1500,
    kbChunkOverlap:      s?.kbChunkOverlap      ?? 200,
    isCustom: !!(s?.apiUrl || s?.apiKey || s?.model || s?.systemPrompt || s?.modelParams),
  };
  console.log("[admin/api] Returning response with isCustom:", response.isCustom);
  return NextResponse.json(response);
}

/** POST /api/admin — save LLM settings (admin-only, applies to ALL users) */
export async function POST(request: NextRequest) {
  console.log("[admin/api] POST handler called - starting save...");
  const denied = requireAdmin(request);
  if (denied) {
    console.log("[admin/api] Access denied - not an admin");
    return denied;
  }

  const { email } = getUserFromRequest(request);
  console.log("[admin/api] User:", email);
  if (!await checkRateLimit("admin", ADMIN_RATE_LIMIT, ADMIN_RATE_WINDOW, email)) {
    return NextResponse.json({ error: "Rate limit exceeded" }, { status: 429 });
  }

  const body = await request.json();
  console.log("[admin/api] Request body keys:", Object.keys(body));
  const prev = await getAdminSettings() ?? {};

  const clamp = (v: unknown, min: number, max: number, fallback: number): number => {
    const n = Number(v);
    if (!isFinite(n)) return fallback;
    return Math.max(min, Math.min(max, Math.round(n)));
  };

  // Clamp cleanupDelayMinutes to [1, 10080] (1 min to 1 week)
  const clampMinutes = (v: unknown, fallback: number): number => {
    const n = Number(v);
    if (!isFinite(n)) return fallback;
    return Math.max(1, Math.min(10080, Math.round(n)));
  };

  console.log("[admin/api] Calling setAdminSettings...");
  try {
    await setAdminSettings({
      apiUrl:             body.apiUrl             !== undefined ? body.apiUrl             : prev.apiUrl,
      apiKey:             body.apiKey && body.apiKey !== "***" ? body.apiKey              : prev.apiKey,
      model:              body.model              !== undefined ? body.model              : prev.model,
      systemPrompt:       body.systemPrompt       !== undefined ? body.systemPrompt       : prev.systemPrompt,
      modelParams:        body.modelParams        !== undefined ? body.modelParams        : prev.modelParams,
      maxTurns:           body.maxTurns           !== undefined ? clamp(body.maxTurns,          1, 200,   40) : prev.maxTurns,
      maxToolResultChars: body.maxToolResultChars !== undefined ? clamp(body.maxToolResultChars, 500, 50000, 3000) : prev.maxToolResultChars,
      maxHistoryMessages: body.maxHistoryMessages !== undefined ? clamp(body.maxHistoryMessages, 4, 200,   20) : prev.maxHistoryMessages,
      cleanupDelayMinutes: body.cleanupDelayMinutes !== undefined ? clampMinutes(body.cleanupDelayMinutes, 120) : prev.cleanupDelayMinutes,
      kbTopK:              body.kbTopK             !== undefined ? clamp(body.kbTopK,        1, 20,   6)    : prev.kbTopK,
      kbChunkSize:         body.kbChunkSize        !== undefined ? clamp(body.kbChunkSize,   200, 8000, 1500) : prev.kbChunkSize,
      kbChunkOverlap:      body.kbChunkOverlap     !== undefined ? clamp(body.kbChunkOverlap, 0, 1000, 200)  : prev.kbChunkOverlap,
    });
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error("[admin/api] Failed to save settings:", msg);
    return NextResponse.json({ error: msg }, { status: 500 });
  }
  console.log("[admin/api] Save completed successfully");

  return NextResponse.json({ ok: true });
}

/** DELETE /api/admin — reset runtime overrides back to env defaults */
export async function DELETE(request: NextRequest) {
  const denied = requireAdmin(request);
  if (denied) return denied;

  const { email } = getUserFromRequest(request);
  if (!await checkRateLimit("admin", ADMIN_RATE_LIMIT, ADMIN_RATE_WINDOW, email)) {
    return NextResponse.json({ error: "Rate limit exceeded" }, { status: 429 });
  }

  await clearAdminSettings();
  return NextResponse.json({ ok: true });
}

/** PATCH /api/admin — validate an API config by making a minimal call */
export async function PATCH(request: NextRequest) {
  const denied = requireAdmin(request);
  if (denied) return denied;

  const { email } = getUserFromRequest(request);
  if (!await checkRateLimit("admin-patch", PATCH_RATE_LIMIT, PATCH_RATE_WINDOW, email)) {
    return NextResponse.json({ error: "Rate limit exceeded. Please wait before validating again." }, { status: 429 });
  }

  const body = await request.json() as { apiUrl: string; apiKey: string; model: string };

  if (!body.apiUrl || !body.apiKey || !body.model) {
    return NextResponse.json({ ok: false, error: "apiUrl, apiKey and model are required" }, { status: 400 });
  }

  const urlError = validateApiUrl(body.apiUrl);
  if (urlError) {
    return NextResponse.json({ ok: false, error: urlError }, { status: 400 });
  }

  try {
    const openai = new OpenAI({ apiKey: body.apiKey, baseURL: body.apiUrl });
    const res = await openai.chat.completions.create({
      model: body.model,
      messages: [{ role: "user", content: "hi" }],
      max_tokens: 1,
    });
    const replied = !!res.choices?.[0]?.message;
    return NextResponse.json({ ok: replied, model: res.model });
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    const status = (err as { status?: number }).status;
    return NextResponse.json(
      { ok: false, error: msg, status },
      { status: 200 } // always 200 so the client gets the body
    );
  }
}
