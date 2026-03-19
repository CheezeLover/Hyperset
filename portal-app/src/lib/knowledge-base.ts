/**
 * Knowledge Base — PostgreSQL + pgvector RAG.
 *
 * Chunks are always stored for full-text search (FTS).
 * If an OpenAI-compatible embedding API is configured, chunks are also
 * vectorised and searched via cosine similarity (pgvector HNSW).
 * When no embedding API URL is set, FTS is used automatically.
 */

import crypto from "crypto";
import { sql, ensureSchema } from "./db";

// ── Configuration ─────────────────────────────────────────────────────────────
const MAX_KB_SIZE_MB = 50;
const MAX_DOC_SIZE_MB = 10;
const CHUNK_SIZE = 1500;
const CHUNK_OVERLAP = 200;

export const DEFAULT_EMBEDDING_MODEL = "nomic-embed-text";

// ── Types ─────────────────────────────────────────────────────────────────────
export interface KnowledgeDocument {
  id: string;
  name: string;
  description: string;
  createdAt: string;
  updatedAt: string;
  size: number;
}

export interface EmbeddingConfig {
  apiKey: string;
  apiUrl: string;        // empty → skip embedding, use FTS fallback
  embeddingModel: string;
}

export interface ChunkSearchResult {
  docId: string;
  docName: string;
  chunkIndex: number;
  content: string;
  similarity: number;
}

// ── In-memory caches ──────────────────────────────────────────────────────────
let _docs: KnowledgeDocument[] | null = null;
const _contentCache = new Map<string, string>();

function formatBytes(bytes: number): string {
  if (bytes === 0) return "0 B";
  const k = 1024;
  const sizes = ["B", "KB", "MB", "GB"];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return parseFloat((bytes / Math.pow(k, i)).toFixed(1)) + " " + sizes[i];
}

function generateId(): string {
  return crypto.randomBytes(8).toString("hex");
}

interface DbDocRow {
  id: string;
  name: string;
  description: string;
  created_at: Date;
  updated_at: Date;
  size: number;
}

function rowToDoc(row: DbDocRow): KnowledgeDocument {
  return {
    id: row.id,
    name: row.name,
    description: row.description,
    createdAt: row.created_at.toISOString(),
    updatedAt: row.updated_at.toISOString(),
    size: row.size,
  };
}

// ── Chunking ──────────────────────────────────────────────────────────────────
function chunkMarkdown(content: string): string[] {
  const chunks: string[] = [];
  const sections = content.split(/(?=^#{1,3} )/m).filter((s) => s.trim().length > 0);

  for (const section of sections) {
    if (section.trim().length < 50) continue;
    if (section.length <= CHUNK_SIZE) {
      chunks.push(section.trim());
    } else {
      const paragraphs = section.split(/\n\n+/).filter((p) => p.trim().length > 0);
      let current = "";
      for (const para of paragraphs) {
        if (current.length + para.length + 2 <= CHUNK_SIZE) {
          current = current ? current + "\n\n" + para : para;
        } else {
          if (current.trim().length >= 50) chunks.push(current.trim());
          const overlap = current.length > CHUNK_OVERLAP ? current.slice(-CHUNK_OVERLAP) : current;
          current = overlap ? overlap + "\n\n" + para : para;
        }
      }
      if (current.trim().length >= 50) chunks.push(current.trim());
    }
  }

  if (chunks.length === 0 && content.trim().length >= 50) {
    for (let i = 0; i < content.length; i += CHUNK_SIZE - CHUNK_OVERLAP) {
      const chunk = content.slice(i, i + CHUNK_SIZE).trim();
      if (chunk.length >= 50) chunks.push(chunk);
    }
  }

  return chunks;
}

// ── Embedding API ─────────────────────────────────────────────────────────────
/**
 * Call an OpenAI-compatible /embeddings endpoint.
 * Returns null when apiUrl is empty or on any error → caller uses FTS instead.
 */
async function embed(texts: string[], cfg: EmbeddingConfig): Promise<number[][] | null> {
  if (!cfg.apiUrl || !texts.length) return null;
  try {
    const res = await fetch(`${cfg.apiUrl.replace(/\/+$/, "")}/embeddings`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${cfg.apiKey}` },
      body: JSON.stringify({ model: cfg.embeddingModel, input: texts.map((t) => t.slice(0, 8000)) }),
    });
    if (!res.ok) {
      console.warn(`[kb] Embedding API ${res.status}: ${(await res.text().catch(() => "")).slice(0, 200)}`);
      return null;
    }
    const data = (await res.json()) as { data: { index: number; embedding: number[] }[] };
    return data.data.sort((a, b) => a.index - b.index).map((d) => d.embedding);
  } catch (e) {
    console.warn("[kb] Embedding error:", e);
    return null;
  }
}

// ── HNSW index management ─────────────────────────────────────────────────────
async function ensureEmbeddingDimension(dims: number): Promise<void> {
  const rows = await sql<{ value: string }[]>`
    SELECT value FROM hyperset_kb_meta WHERE key = 'embedding_dims' LIMIT 1
  `;
  const stored = rows.length > 0 ? parseInt(rows[0].value, 10) : null;

  if (stored !== null && stored !== dims) {
    console.log(`[kb] Embedding dimension changed ${stored} → ${dims}. Clearing chunks.`);
    await sql`DELETE FROM hyperset_kb_chunks`;
    await sql`DROP INDEX IF EXISTS idx_kb_chunks_embedding`;
  }

  if (stored !== dims) {
    await sql`
      INSERT INTO hyperset_kb_meta (key, value) VALUES ('embedding_dims', ${String(dims)})
      ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value
    `;
    await sql`DROP INDEX IF EXISTS idx_kb_chunks_embedding`;
    await sql`CREATE INDEX idx_kb_chunks_embedding ON hyperset_kb_chunks USING hnsw (embedding vector_cosine_ops)`;
    console.log(`[kb] HNSW index ready (dim=${dims})`);
  }
}

// ── Index a document ──────────────────────────────────────────────────────────
export async function indexDocument(
  docId: string,
  content: string,
  docName: string,
  cfg: EmbeddingConfig,
): Promise<void> {
  await ensureSchema();
  await sql`DELETE FROM hyperset_kb_chunks WHERE doc_id = ${docId}`;

  const chunks = chunkMarkdown(content);
  if (!chunks.length) return;

  const embeddings = await embed(chunks.map((c) => `${docName}\n\n${c}`), cfg);
  if (embeddings) await ensureEmbeddingDimension(embeddings[0].length);

  for (let i = 0; i < chunks.length; i++) {
    const id = `${docId}-${i}`;
    if (embeddings?.[i]) {
      const vec = `[${embeddings[i].join(",")}]`;
      await sql`
        INSERT INTO hyperset_kb_chunks (id, doc_id, chunk_index, content, embedding)
        VALUES (${id}, ${docId}, ${i}, ${chunks[i]}, ${vec}::vector)
        ON CONFLICT (id) DO UPDATE SET content = EXCLUDED.content, embedding = EXCLUDED.embedding
      `;
    } else {
      await sql`
        INSERT INTO hyperset_kb_chunks (id, doc_id, chunk_index, content)
        VALUES (${id}, ${docId}, ${i}, ${chunks[i]})
        ON CONFLICT (id) DO UPDATE SET content = EXCLUDED.content
      `;
    }
  }

  console.log(
    `[kb] Indexed ${chunks.length} chunks for "${docName}"` +
    (embeddings ? ` (${embeddings[0].length}-dim vectors)` : " (text-only — set Embedding API URL for semantic search)"),
  );
}

// ── Search ────────────────────────────────────────────────────────────────────
export async function semanticSearch(
  query: string,
  topK: number,
  cfg: EmbeddingConfig,
): Promise<ChunkSearchResult[]> {
  await ensureSchema();

  // 1. Vector search when embedding API is configured
  const qvec = await embed([query], cfg);
  if (qvec) {
    const vec = `[${qvec[0].join(",")}]`;
    const rows = await sql<{ doc_id: string; doc_name: string; chunk_index: number; content: string; similarity: number }[]>`
      SELECT c.doc_id, d.name AS doc_name, c.chunk_index, c.content,
             1 - (c.embedding <=> ${vec}::vector) AS similarity
      FROM hyperset_kb_chunks c
      JOIN hyperset_kb_documents d ON d.id = c.doc_id
      WHERE c.embedding IS NOT NULL
      ORDER BY c.embedding <=> ${vec}::vector
      LIMIT ${topK}
    `;
    if (rows.length > 0) {
      return rows.map((r) => ({ docId: r.doc_id, docName: r.doc_name, chunkIndex: r.chunk_index, content: r.content, similarity: r.similarity }));
    }
  }

  // 2. FTS fallback — always works, no embedding API needed
  const rows = await sql<{ doc_id: string; doc_name: string; chunk_index: number; content: string }[]>`
    SELECT c.doc_id, d.name AS doc_name, c.chunk_index, c.content
    FROM hyperset_kb_chunks c
    JOIN hyperset_kb_documents d ON d.id = c.doc_id
    WHERE to_tsvector('english', c.content) @@ plainto_tsquery('english', ${query})
    ORDER BY ts_rank(to_tsvector('english', c.content), plainto_tsquery('english', ${query})) DESC
    LIMIT ${topK}
  `;
  return rows.map((r) => ({ docId: r.doc_id, docName: r.doc_name, chunkIndex: r.chunk_index, content: r.content, similarity: 0.5 }));
}

// ── Document CRUD ─────────────────────────────────────────────────────────────

export async function getKnowledgeDocuments(): Promise<KnowledgeDocument[]> {
  if (_docs !== null) return _docs;
  await ensureSchema();
  const rows = await sql<DbDocRow[]>`
    SELECT id, name, description, created_at, updated_at, size
    FROM hyperset_kb_documents
    ORDER BY created_at ASC
  `;
  _docs = rows.map(rowToDoc);
  return _docs;
}

export async function getKnowledgeDocumentContent(id: string): Promise<string | null> {
  if (_contentCache.has(id)) return _contentCache.get(id)!;
  await ensureSchema();
  const rows = await sql<{ content: string }[]>`
    SELECT content FROM hyperset_kb_documents WHERE id = ${id} LIMIT 1
  `;
  if (rows.length === 0) return null;
  _contentCache.set(id, rows[0].content);
  return rows[0].content;
}

export async function getKnowledgeDocument(id: string): Promise<KnowledgeDocument | null> {
  if (_docs !== null) return _docs.find((d) => d.id === id) ?? null;
  await ensureSchema();
  const rows = await sql<DbDocRow[]>`
    SELECT id, name, description, created_at, updated_at, size
    FROM hyperset_kb_documents WHERE id = ${id} LIMIT 1
  `;
  return rows.length > 0 ? rowToDoc(rows[0]) : null;
}

export async function getKnowledgeBaseStats(): Promise<{
  documentCount: number;
  totalSize: number;
  totalSizeFormatted: string;
  maxSize: number;
  maxSizeFormatted: string;
  utilizationPercent: number;
}> {
  const docs = await getKnowledgeDocuments();
  const totalSize = docs.reduce((acc, d) => acc + d.size, 0);
  const maxBytes = MAX_KB_SIZE_MB * 1024 * 1024;
  return {
    documentCount: docs.length,
    totalSize,
    totalSizeFormatted: formatBytes(totalSize),
    maxSize: maxBytes,
    maxSizeFormatted: formatBytes(maxBytes),
    utilizationPercent: Math.round((totalSize / maxBytes) * 100),
  };
}

export async function addKnowledgeDocument(
  name: string,
  description: string,
  content: string,
): Promise<KnowledgeDocument> {
  await ensureSchema();
  const contentSize = Buffer.byteLength(content, "utf-8");

  if (contentSize > MAX_DOC_SIZE_MB * 1024 * 1024) {
    throw new Error(`Document too large. Max is ${MAX_DOC_SIZE_MB}MB`);
  }

  const stats = await getKnowledgeBaseStats();
  if (stats.totalSize + contentSize > MAX_KB_SIZE_MB * 1024 * 1024) {
    throw new Error("Knowledge base full. Delete some documents first.");
  }

  const id = generateId();
  const now = new Date();
  const cleanName = name.replace(/\.md$/i, "");

  await sql`
    INSERT INTO hyperset_kb_documents (id, name, description, created_at, updated_at, size, content)
    VALUES (${id}, ${cleanName}, ${description}, ${now}, ${now}, ${contentSize}, ${content})
  `;

  const doc: KnowledgeDocument = {
    id,
    name: cleanName,
    description,
    createdAt: now.toISOString(),
    updatedAt: now.toISOString(),
    size: contentSize,
  };

  if (_docs !== null) _docs.push(doc);
  _contentCache.set(id, content);

  return doc;
}

export async function deleteKnowledgeDocument(id: string): Promise<boolean> {
  await ensureSchema();
  const result = await sql`DELETE FROM hyperset_kb_documents WHERE id = ${id}`;
  if (result.count === 0) return false;

  if (_docs !== null) _docs = _docs.filter((d) => d.id !== id);
  _contentCache.delete(id);

  return true;
}

export async function searchKnowledgeBase(
  query: string,
): Promise<Array<{ doc: KnowledgeDocument; matches: boolean }>> {
  const docs = await getKnowledgeDocuments();
  const queryLower = query.toLowerCase();
  return docs
    .filter((doc) => doc.name.toLowerCase().includes(queryLower) || doc.description.toLowerCase().includes(queryLower))
    .map((doc) => ({ doc, matches: true }));
}

export async function getKnowledgeBaseRoutingContext(): Promise<string> {
  const docs = await getKnowledgeDocuments();
  if (docs.length === 0) return "";
  return docs
    .map((doc) => `- **${doc.name}**: ${doc.description || "Company knowledge document"} (${formatBytes(doc.size)})`)
    .join("\n");
}

