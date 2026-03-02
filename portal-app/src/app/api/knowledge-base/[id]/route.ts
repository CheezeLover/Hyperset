import { NextRequest, NextResponse } from "next/server";
import { getUserFromRequest } from "@/lib/auth";
import {
  getKnowledgeDocument,
  getKnowledgeDocumentContent,
  deleteKnowledgeDocument,
} from "@/lib/knowledge-base";

// ── Rate limiters ──────────────────────────────────────────────────────────────
// Public read access: 30 req / 60 s per user
const _readRateLimitMap = new Map<string, number[]>();
const READ_RATE_LIMIT = 30;
const READ_RATE_WINDOW = 60_000;

// Delete (admin-only): 10 req / 60 s per user
const _deleteRateLimitMap = new Map<string, number[]>();
const DELETE_RATE_LIMIT = 10;
const DELETE_RATE_WINDOW = 60_000;

function checkRateLimit(
  map: Map<string, number[]>,
  limit: number,
  windowMs: number,
  key: string
): boolean {
  const now = Date.now();
  const timestamps = map.get(key) ?? [];
  const recent = timestamps.filter((t) => now - t < windowMs);
  if (recent.length >= limit) {
    map.set(key, recent);
    return false;
  }
  recent.push(now);
  map.set(key, recent);
  return true;
}

function requireAdmin(request: NextRequest) {
  const user = getUserFromRequest(request);
  if (!user.isAdmin) {
    return NextResponse.json({ error: "Forbidden — admin access required" }, { status: 403 });
  }
  return null;
}

/**
 * GET /api/knowledge-base/[id] — Get document metadata and content (public access)
 */
export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  const user = getUserFromRequest(request);
  const email = user.email ?? "anonymous";

  if (!checkRateLimit(_readRateLimitMap, READ_RATE_LIMIT, READ_RATE_WINDOW, email)) {
    return NextResponse.json({ error: "Rate limit exceeded" }, { status: 429 });
  }

  try {
    const document = getKnowledgeDocument(id);
    if (!document) {
      return NextResponse.json({ error: "Document not found" }, { status: 404 });
    }

    const content = getKnowledgeDocumentContent(id);
    if (content === null) {
      return NextResponse.json({ error: "Document content not found" }, { status: 404 });
    }

    return NextResponse.json({ document: { ...document, content } });
  } catch (error) {
    console.error(`[knowledge-base] Failed to retrieve document ${id}:`, error);
    return NextResponse.json({ error: "Failed to retrieve document" }, { status: 500 });
  }
}

/**
 * DELETE /api/knowledge-base/[id] — Delete a document (admin-only)
 */
export async function DELETE(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  const denied = requireAdmin(request);
  if (denied) return denied;

  const user = getUserFromRequest(request);
  if (!checkRateLimit(_deleteRateLimitMap, DELETE_RATE_LIMIT, DELETE_RATE_WINDOW, user.email!)) {
    return NextResponse.json({ error: "Rate limit exceeded" }, { status: 429 });
  }

  try {
    const success = deleteKnowledgeDocument(id);
    if (!success) {
      return NextResponse.json({ error: "Document not found" }, { status: 404 });
    }

    return NextResponse.json({ ok: true });
  } catch (error) {
    console.error(`[knowledge-base] Failed to delete document ${id}:`, error);
    return NextResponse.json({ error: "Failed to delete document" }, { status: 500 });
  }
}
