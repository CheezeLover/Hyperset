/**
 * Knowledge Base store — PostgreSQL backed.
 *
 * Documents (metadata + content) are stored in hyperset_kb_documents.
 * The routing guide is stored as a single key in hyperset_kb_meta.
 *
 * The pre-built context string and per-document content are cached in memory
 * per instance for fast chat reads.  Cache is rebuilt on writes.
 */

import crypto from "crypto";
import { sql, ensureSchema } from "./db";

// ── Configuration ─────────────────────────────────────────────────────────────
const MAX_CONTEXT_LENGTH = 15000;
const MAX_KB_SIZE_MB = 50;
const MAX_DOC_SIZE_MB = 10;

// ── Types ─────────────────────────────────────────────────────────────────────
export interface KnowledgeDocument {
  id: string;
  name: string;
  description: string;
  createdAt: string;
  updatedAt: string;
  size: number;
}

export interface KnowledgeBaseMetadata {
  documents: KnowledgeDocument[];
  totalSize: number;
  lastUpdated: string;
  cachedContext?: string;
  routingGuide?: string;
}

// ── In-memory caches (per-instance) ─────────────────────────────────────────
let _docs: KnowledgeDocument[] | null = null;          // document list (no content)
let _contextCache: string | null = null;               // pre-built context string
const _contentCache = new Map<string, string>();       // docId → content

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

// ── Context string builder ────────────────────────────────────────────────────
function buildContextString(
  docs: KnowledgeDocument[],
  contentMap: Map<string, string>,
): string {
  if (docs.length === 0) return "";
  const sections: string[] = [];
  let totalLength = 0;
  const minSpacePerDoc = 500;
  const availableForFull = MAX_CONTEXT_LENGTH - docs.length * minSpacePerDoc;
  const avgSpacePerDoc = Math.max(2000, Math.floor(availableForFull / docs.length));

  for (const doc of docs) {
    const content = contentMap.get(doc.id) ?? "";
    if (!content) continue;
    const header = `--- ${doc.name} ---\n`;
    const sectionLength = header.length + content.length;
    const remainingSpace = MAX_CONTEXT_LENGTH - totalLength - header.length - 100;

    if (sectionLength <= avgSpacePerDoc && totalLength + sectionLength <= MAX_CONTEXT_LENGTH) {
      sections.push(header + content);
      totalLength += sectionLength;
    } else if (remainingSpace > minSpacePerDoc) {
      const excerptLength = Math.min(content.length, remainingSpace - 50);
      const excerpt = content.slice(0, excerptLength);
      const isTruncated = excerptLength < content.length;
      sections.push(header + excerpt + (isTruncated ? "\n[... document continues ...]" : ""));
      totalLength += header.length + excerpt.length + (isTruncated ? 30 : 0);
    } else {
      const description = doc.description || "Company knowledge document";
      sections.push(header + `[${description}]`);
      totalLength += header.length + description.length + 2;
    }
  }
  return sections.join("\n\n");
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

export async function getKnowledgeBaseContext(): Promise<string> {
  if (_contextCache !== null) return _contextCache;
  await ensureSchema();
  const rows = await sql<(DbDocRow & { content: string })[]>`
    SELECT id, name, description, created_at, updated_at, size, content
    FROM hyperset_kb_documents
    ORDER BY created_at ASC
  `;
  const docs = rows.map(rowToDoc);
  const contentMap = new Map(rows.map((r) => [r.id, r.content]));
  // Populate content cache
  for (const [id, content] of contentMap) {
    _contentCache.set(id, content);
  }
  _docs = docs;
  _contextCache = buildContextString(docs, contentMap);
  return _contextCache;
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
  // Check memory cache first
  if (_docs !== null) {
    return _docs.find((d) => d.id === id) ?? null;
  }
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

  await sql`
    INSERT INTO hyperset_kb_documents (id, name, description, created_at, updated_at, size, content)
    VALUES (${id}, ${name.replace(/\.md$/i, "")}, ${description}, ${now}, ${now}, ${contentSize}, ${content})
  `;

  const doc: KnowledgeDocument = {
    id,
    name: name.replace(/\.md$/i, ""),
    description,
    createdAt: now.toISOString(),
    updatedAt: now.toISOString(),
    size: contentSize,
  };

  // Update caches
  if (_docs !== null) _docs.push(doc);
  _contentCache.set(id, content);
  _contextCache = null; // rebuild on next access

  return doc;
}

export async function deleteKnowledgeDocument(id: string): Promise<boolean> {
  await ensureSchema();
  const result = await sql`
    DELETE FROM hyperset_kb_documents WHERE id = ${id}
  `;
  if (result.count === 0) return false;

  // Invalidate caches
  if (_docs !== null) _docs = _docs.filter((d) => d.id !== id);
  _contentCache.delete(id);
  _contextCache = null;

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

  const docList = docs
    .map((doc) => `## ${doc.name}\nDescription: ${doc.description}\nSize: ${formatBytes(doc.size)}`)
    .join("\n\n");

  const routingGuide = await getKnowledgeBaseRoutingGuide();
  const routingGuideSection = routingGuide ? `\n### Routing Guide:\n${routingGuide}` : "";

  return `${docList}${routingGuideSection}`;
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

