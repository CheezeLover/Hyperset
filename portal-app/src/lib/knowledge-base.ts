/**
 * Knowledge Base — PostgreSQL-backed RAG.
 *
 * Documents are chunked and stored in hyperset_kb_chunks.
 * Search uses PostgreSQL full-text search (FTS) via tsvector/tsquery.
 * pgvector extension is available for future semantic search if needed.
 */

import crypto from "crypto";
import { sql, ensureSchema } from "./db";

// ── Configuration ─────────────────────────────────────────────────────────────
const MAX_KB_SIZE_MB = 50;
const MAX_DOC_SIZE_MB = 10;
const CHUNK_SIZE = 1500;
const CHUNK_OVERLAP = 200;

// ── Types ─────────────────────────────────────────────────────────────────────
export interface KnowledgeDocument {
  id: string;
  name: string;
  description: string;
  createdAt: string;
  updatedAt: string;
  size: number;
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

// ── Index a document ──────────────────────────────────────────────────────────
export async function indexDocument(
  docId: string,
  content: string,
  docName: string,
): Promise<void> {
  await ensureSchema();
  await sql`DELETE FROM hyperset_kb_chunks WHERE doc_id = ${docId}`;

  const chunks = chunkMarkdown(content);
  if (!chunks.length) return;

  for (let i = 0; i < chunks.length; i++) {
    const id = `${docId}-${i}`;
    await sql`
      INSERT INTO hyperset_kb_chunks (id, doc_id, chunk_index, content)
      VALUES (${id}, ${docId}, ${i}, ${chunks[i]})
      ON CONFLICT (id) DO UPDATE SET content = EXCLUDED.content
    `;
  }

  console.log(`[kb] Indexed ${chunks.length} chunks for "${docName}"`);
}

// ── Full-text search ──────────────────────────────────────────────────────────
export async function semanticSearch(
  query: string,
  topK: number,
): Promise<ChunkSearchResult[]> {
  await ensureSchema();

  const rows = await sql<{ doc_id: string; doc_name: string; chunk_index: number; content: string; rank: number }[]>`
    SELECT c.doc_id, d.name AS doc_name, c.chunk_index, c.content,
           ts_rank(to_tsvector('english', c.content), plainto_tsquery('english', ${query})) AS rank
    FROM hyperset_kb_chunks c
    JOIN hyperset_kb_documents d ON d.id = c.doc_id
    WHERE to_tsvector('english', c.content) @@ plainto_tsquery('english', ${query})
    ORDER BY rank DESC
    LIMIT ${topK}
  `;

  return rows.map((r) => ({
    docId: r.doc_id,
    docName: r.doc_name,
    chunkIndex: r.chunk_index,
    content: r.content,
    similarity: r.rank,
  }));
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

export async function deleteKnowledgeDocument(id: string): Promise<boolean> {
  await ensureSchema();
  const result = await sql`DELETE FROM hyperset_kb_documents WHERE id = ${id}`;
  if (result.count === 0) return false;

  if (_docs !== null) _docs = _docs.filter((d) => d.id !== id);
  _contentCache.delete(id);

  return true;
}

export async function getKnowledgeBaseRoutingContext(): Promise<string> {
  const docs = await getKnowledgeDocuments();
  if (docs.length === 0) return "";
  return docs
    .map((doc) => `- **${doc.name}**: ${doc.description || "Company knowledge document"} (${formatBytes(doc.size)})`)
    .join("\n");
}
