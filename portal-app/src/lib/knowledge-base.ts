/**
 * Knowledge Base store — PostgreSQL + pgvector backed RAG.
 *
 * Documents (metadata + full text) are stored in hyperset_kb_documents.
 * Documents are chunked and embedded into hyperset_kb_chunks for semantic search.
 * The routing guide is stored as a single key in hyperset_kb_meta.
 *
 * On every add/delete, embeddings are regenerated automatically.
 * Semantic search falls back to text search if embeddings are unavailable.
 */

import crypto from "crypto";
import { sql, ensureSchema } from "./db";

// ── Configuration ─────────────────────────────────────────────────────────────
const MAX_KB_SIZE_MB = 50;
const MAX_DOC_SIZE_MB = 10;
const CHUNK_SIZE = 1500;      // target characters per chunk
const CHUNK_OVERLAP = 200;    // overlap between consecutive chunks
const EMBEDDING_BATCH_SIZE = 96; // max inputs per embeddings API call

export const DEFAULT_EMBEDDING_MODEL = "text-embedding-3-small";

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
  apiUrl: string;
  embeddingModel: string;
}

export interface ChunkSearchResult {
  docId: string;
  docName: string;
  chunkIndex: number;
  content: string;
  similarity: number;
}

// ── In-memory caches (per-instance) ─────────────────────────────────────────
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

// ── DB row type ───────────────────────────────────────────────────────────────
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

// ── RAG: Chunking ─────────────────────────────────────────────────────────────
/**
 * Split markdown content into overlapping text chunks.
 * Tries to split on headers first, then paragraphs, then raw size.
 */
function chunkMarkdown(content: string): string[] {
  const chunks: string[] = [];

  // Split on markdown headers (h1–h3) to preserve section boundaries
  const sections = content.split(/(?=^#{1,3} )/m).filter((s) => s.trim().length > 0);

  for (const section of sections) {
    if (section.trim().length < 50) continue;

    if (section.length <= CHUNK_SIZE) {
      chunks.push(section.trim());
    } else {
      // Large section: split by double newlines (paragraphs)
      const paragraphs = section.split(/\n\n+/).filter((p) => p.trim().length > 0);
      let current = "";

      for (const para of paragraphs) {
        if (current.length + para.length + 2 <= CHUNK_SIZE) {
          current = current ? current + "\n\n" + para : para;
        } else {
          if (current.trim().length >= 50) chunks.push(current.trim());
          // Carry a short overlap from the end of the previous chunk
          const overlap = current.length > CHUNK_OVERLAP ? current.slice(-CHUNK_OVERLAP) : current;
          current = overlap ? overlap + "\n\n" + para : para;
        }
      }
      if (current.trim().length >= 50) chunks.push(current.trim());
    }
  }

  // Fallback: raw character splitting (no headers/paragraphs found)
  if (chunks.length === 0 && content.trim().length >= 50) {
    for (let i = 0; i < content.length; i += CHUNK_SIZE - CHUNK_OVERLAP) {
      const chunk = content.slice(i, i + CHUNK_SIZE).trim();
      if (chunk.length >= 50) chunks.push(chunk);
    }
  }

  return chunks;
}

// ── RAG: Batch Embedding API ──────────────────────────────────────────────────
async function generateEmbeddings(
  texts: string[],
  config: EmbeddingConfig,
): Promise<number[][]> {
  const baseUrl = config.apiUrl.replace(/\/+$/, "");
  const response = await fetch(`${baseUrl}/embeddings`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${config.apiKey}`,
    },
    body: JSON.stringify({
      model: config.embeddingModel,
      input: texts.map((t) => t.slice(0, 8000)),
    }),
  });

  if (!response.ok) {
    const errText = await response.text().catch(() => "");
    throw new Error(`Embedding API error ${response.status}: ${errText.slice(0, 200)}`);
  }

  const data = (await response.json()) as {
    data: Array<{ index: number; embedding: number[] }>;
  };
  // Sort by index to guarantee correct order
  return data.data.sort((a, b) => a.index - b.index).map((d) => d.embedding);
}

// ── RAG: Index a document ─────────────────────────────────────────────────────
/**
 * Chunk the document, batch-embed all chunks, and store them in hyperset_kb_chunks.
 * Re-indexes from scratch on each call (idempotent).
 */
export async function indexDocument(
  docId: string,
  content: string,
  docName: string,
  config: EmbeddingConfig,
): Promise<void> {
  await ensureSchema();

  // Remove stale chunks first
  await sql`DELETE FROM hyperset_kb_chunks WHERE doc_id = ${docId}`;

  const chunks = chunkMarkdown(content);
  if (chunks.length === 0) return;

  // Prefix each chunk with the document name for better contextual embedding
  const textsToEmbed = chunks.map((c) => `${docName}\n\n${c}`);

  // Batch-embed to minimise API round-trips
  const allEmbeddings: number[][] = [];
  for (let i = 0; i < textsToEmbed.length; i += EMBEDDING_BATCH_SIZE) {
    const batch = textsToEmbed.slice(i, i + EMBEDDING_BATCH_SIZE);
    const embeddings = await generateEmbeddings(batch, config);
    allEmbeddings.push(...embeddings);
  }

  // Insert all chunks
  for (let i = 0; i < chunks.length; i++) {
    const chunkId = `${docId}-${i}`;
    const embLiteral = `[${allEmbeddings[i].join(",")}]`;
    await sql`
      INSERT INTO hyperset_kb_chunks (id, doc_id, chunk_index, content, embedding)
      VALUES (${chunkId}, ${docId}, ${i}, ${chunks[i]}, ${embLiteral}::vector)
      ON CONFLICT (id) DO UPDATE
        SET content = EXCLUDED.content, embedding = EXCLUDED.embedding
    `;
  }

  console.log(`[kb] Indexed ${chunks.length} chunks for "${docName}" (${docId})`);
}

// ── RAG: Semantic search ──────────────────────────────────────────────────────
/**
 * Embed the query and return the top-K most similar chunks across all documents.
 */
export async function semanticSearch(
  query: string,
  topK: number,
  config: EmbeddingConfig,
): Promise<ChunkSearchResult[]> {
  await ensureSchema();

  const [queryEmbedding] = await generateEmbeddings([query], config);
  const embLiteral = `[${queryEmbedding.join(",")}]`;

  const rows = await sql<
    {
      doc_id: string;
      doc_name: string;
      chunk_index: number;
      content: string;
      similarity: number;
    }[]
  >`
    SELECT
      c.doc_id,
      d.name AS doc_name,
      c.chunk_index,
      c.content,
      1 - (c.embedding <=> ${embLiteral}::vector) AS similarity
    FROM hyperset_kb_chunks c
    JOIN hyperset_kb_documents d ON d.id = c.doc_id
    WHERE c.embedding IS NOT NULL
    ORDER BY c.embedding <=> ${embLiteral}::vector
    LIMIT ${topK}
  `;

  return rows.map((r) => ({
    docId: r.doc_id,
    docName: r.doc_name,
    chunkIndex: r.chunk_index,
    content: r.content,
    similarity: r.similarity,
  }));
}

// ── Public API ────────────────────────────────────────────────────────────────

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

  // Update caches
  if (_docs !== null) _docs.push(doc);
  _contentCache.set(id, content);

  return doc;
}

export async function deleteKnowledgeDocument(id: string): Promise<boolean> {
  await ensureSchema();
  // ON DELETE CASCADE on hyperset_kb_chunks.doc_id removes chunks automatically
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
    .filter(
      (doc) =>
        doc.name.toLowerCase().includes(queryLower) ||
        doc.description.toLowerCase().includes(queryLower),
    )
    .map((doc) => ({ doc, matches: true }));
}

export async function getKnowledgeBaseRoutingGuide(): Promise<string> {
  await ensureSchema();
  const rows = await sql<{ value: string }[]>`
    SELECT value FROM hyperset_kb_meta WHERE key = 'routing_guide' LIMIT 1
  `;
  return rows.length > 0 ? rows[0].value : "";
}

export async function getKnowledgeBaseRoutingContext(): Promise<string> {
  const docs = await getKnowledgeDocuments();
  if (docs.length === 0) return "";

  return docs
    .map((doc) => `- **${doc.name}**: ${doc.description || "Company knowledge document"} (${formatBytes(doc.size)})`)
    .join("\n");
}

export async function setKnowledgeBaseRoutingGuide(guide: string): Promise<void> {
  await ensureSchema();
  await sql`
    INSERT INTO hyperset_kb_meta (key, value)
    VALUES ('routing_guide', ${guide})
    ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value
  `;
  console.log("[kb] Routing guide updated:", guide.length, "characters");
}
