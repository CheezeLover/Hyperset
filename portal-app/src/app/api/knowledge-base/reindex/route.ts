import { NextRequest, NextResponse } from "next/server";
import { getUserFromRequest } from "@/lib/auth";
import { sql, ensureSchema } from "@/lib/db";
import { indexDocument, DEFAULT_EMBEDDING_MODEL } from "@/lib/knowledge-base";
import { getAdminSettings } from "@/lib/admin-settings";

/**
 * POST /api/knowledge-base/reindex
 * Admin-only. Re-indexes documents that have no chunks (e.g. uploaded before RAG).
 * Pass ?all=true to force re-index every document regardless of chunk status.
 */
export async function POST(request: NextRequest) {
  const user = getUserFromRequest(request);
  if (!user.isAdmin) {
    return NextResponse.json({ error: "Forbidden — admin access required" }, { status: 403 });
  }

  const forceAll = new URL(request.url).searchParams.get("all") === "true";

  try {
    await ensureSchema();

    const settings = await getAdminSettings();
    // apiUrl: only fall back to embedding-specific env var, NOT to chat API URL.
    // Empty string → use local ONNX model (no key needed).
    const apiUrl  = settings?.embeddingApiUrl ?? process.env.LLM_EMBEDDING_API_URL ?? "";
    const chatApiKey = settings?.apiKey ?? process.env.LLM_API_KEY ?? "";
    const apiKey  = settings?.embeddingApiKey ?? process.env.LLM_EMBEDDING_API_KEY ?? chatApiKey;
    // Only require a key when hitting an external API; local ONNX needs none.
    if (apiUrl && !apiKey) {
      return NextResponse.json({ error: "No API key configured — cannot call embedding API" }, { status: 503 });
    }
    const embeddingModel = settings?.embeddingModel ?? process.env.LLM_EMBEDDING_MODEL ?? DEFAULT_EMBEDDING_MODEL;
    const config = { apiKey, apiUrl, embeddingModel };

    // Find documents to re-index
    const rows = forceAll
      ? await sql<{ id: string; name: string; content: string }[]>`
          SELECT id, name, content FROM hyperset_kb_documents ORDER BY created_at ASC
        `
      : await sql<{ id: string; name: string; content: string }[]>`
          SELECT d.id, d.name, d.content
          FROM hyperset_kb_documents d
          WHERE NOT EXISTS (SELECT 1 FROM hyperset_kb_chunks c WHERE c.doc_id = d.id)
          ORDER BY d.created_at ASC
        `;

    if (rows.length === 0) {
      return NextResponse.json({ ok: true, indexed: 0, message: "All documents already indexed." });
    }

    const results: Array<{ name: string; chunks: number; error?: string }> = [];

    for (const row of rows) {
      try {
        await indexDocument(row.id, row.content, row.name, config);
        const [{ count }] = await sql<{ count: number }[]>`
          SELECT COUNT(*) AS count FROM hyperset_kb_chunks WHERE doc_id = ${row.id}
        `;
        results.push({ name: row.name, chunks: Number(count) });
      } catch (e) {
        results.push({ name: row.name, chunks: 0, error: e instanceof Error ? e.message : String(e) });
      }
    }

    const failed = results.filter((r) => r.error);
    return NextResponse.json({
      ok: failed.length === 0,
      indexed: results.filter((r) => !r.error).length,
      failed: failed.length,
      results,
    });
  } catch (e) {
    console.error("[reindex] Error:", e);
    return NextResponse.json({ error: e instanceof Error ? e.message : String(e) }, { status: 500 });
  }
}
