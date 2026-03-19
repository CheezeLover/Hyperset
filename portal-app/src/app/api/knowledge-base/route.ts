import { NextRequest, NextResponse } from "next/server";
import { getUserFromRequest } from "@/lib/auth";
import {
  getKnowledgeDocuments,
  addKnowledgeDocument,
  indexDocument,
} from "@/lib/knowledge-base";
import { getAdminSettings } from "@/lib/admin-settings";

// ── Rate limiters ──────────────────────────────────────────────────────────────
// Public read access: 30 req / 60 s per user
const _readRateLimitMap = new Map<string, number[]>();
const READ_RATE_LIMIT = 30;
const READ_RATE_WINDOW = 60_000;

// Upload (admin-only): 10 req / 60 s per user
const _uploadRateLimitMap = new Map<string, number[]>();
const UPLOAD_RATE_LIMIT = 10;
const UPLOAD_RATE_WINDOW = 60_000;

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
 * GET /api/knowledge-base — List all documents and routing guide (public access)
 * Returns array of KnowledgeDocument without the content, plus routing guide
 */
export async function GET(request: NextRequest) {
  const user = getUserFromRequest(request);
  const email = user.email ?? "anonymous";

  if (!checkRateLimit(_readRateLimitMap, READ_RATE_LIMIT, READ_RATE_WINDOW, email)) {
    return NextResponse.json({ error: "Rate limit exceeded" }, { status: 429 });
  }

  try {
    const documents = await getKnowledgeDocuments();
    return NextResponse.json({ documents });
  } catch (error) {
    console.error("[knowledge-base] Failed to list documents:", error);
    return NextResponse.json({ error: "Failed to retrieve documents" }, { status: 500 });
  }
}

/**
 * POST /api/knowledge-base — Upload a new document (admin-only)
 * Body: multipart/form-data with fields:
 *   - file: .md file content
 *   - description: optional description
 *   OR JSON body with:
 *   - name: string
 *   - description: string (optional)
 *   - content: string (the markdown content)
 */
export async function POST(request: NextRequest) {
  const denied = requireAdmin(request);
  if (denied) return denied;

  const user = getUserFromRequest(request);
  if (!checkRateLimit(_uploadRateLimitMap, UPLOAD_RATE_LIMIT, UPLOAD_RATE_WINDOW, user.email!)) {
    return NextResponse.json({ error: "Rate limit exceeded" }, { status: 429 });
  }

  try {
    const contentType = request.headers.get("content-type") ?? "";

    let name: string;
    let description: string;
    let content: string;

    if (contentType.includes("multipart/form-data")) {
      // Handle file upload
      const formData = await request.formData();
      const file = formData.get("file") as File | null;
      description = (formData.get("description") as string) ?? "";

      if (!file) {
        return NextResponse.json({ error: "No file provided" }, { status: 400 });
      }

      // Validate file type
      if (!file.name.toLowerCase().endsWith(".md")) {
        return NextResponse.json(
          { error: "Invalid file type — only .md files are allowed" },
          { status: 400 }
        );
      }

      // Validate file size (10MB limit)
      const MAX_SIZE = 10 * 1024 * 1024;
      if (file.size > MAX_SIZE) {
        return NextResponse.json(
          { error: "File too large — maximum size is 10MB" },
          { status: 400 }
        );
      }

      name = file.name.replace(/\.md$/i, "");
      content = await file.text();
    } else {
      // Handle JSON body upload
      const body = await request.json();

      if (!body.name || typeof body.name !== "string") {
        return NextResponse.json({ error: "Name is required" }, { status: 400 });
      }

      if (!body.content || typeof body.content !== "string") {
        return NextResponse.json({ error: "Content is required" }, { status: 400 });
      }

      // Validate content size (10MB limit)
      const MAX_SIZE = 10 * 1024 * 1024;
      if (Buffer.byteLength(body.content, "utf-8") > MAX_SIZE) {
        return NextResponse.json(
          { error: "Content too large — maximum size is 10MB" },
          { status: 400 }
        );
      }

      name = body.name.replace(/\.md$/i, "");
      description = body.description ?? "";
      content = body.content;
    }

    // Validate content is not empty
    if (!content.trim()) {
      return NextResponse.json({ error: "Document content cannot be empty" }, { status: 400 });
    }

    // Add the document
    const doc = await addKnowledgeDocument(name, description, content);

    // Trigger FTS indexing — non-blocking so the response is returned immediately.
    void (async () => {
      try {
        const s = await getAdminSettings();
        await indexDocument(doc.id, content, doc.name, {
          chunkSize: s?.kbChunkSize,
          chunkOverlap: s?.kbChunkOverlap,
        });
      } catch (e) {
        console.error("[kb] Background indexing failed for", doc.id, ":", e);
      }
    })();

    return NextResponse.json({ document: doc }, { status: 201 });
  } catch (error) {
    console.error("[knowledge-base] Failed to upload document:", error);
    return NextResponse.json({ error: "Failed to upload document" }, { status: 500 });
  }
}

