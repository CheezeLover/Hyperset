/**
 * Lightweight Knowledge Base - Optimized for low CPU usage
 * 
 * Key differences from production version:
 * - NO relevance scoring (saves CPU)
 * - NO auto-import scanning (manual import only)
 * - Pre-computed context string cached in memory
 * - Simple concatenation with truncation
 * - LRU cache for document contents only
 * - Lazy initialization - only loads when first accessed
 */

import fs from "fs";
import path from "path";
import crypto from "crypto";

// ── Configuration ────────────────────────────────────────────────────────────
const MAX_CONTEXT_LENGTH = 15000; // Characters to inject into prompt (increased from 6000)
const MAX_KB_SIZE_MB = 50; // Max total size (increased from 20)
const MAX_DOC_SIZE_MB = 10; // Max per document (increased from 5)

// ── Simple paths ───────────────────────────────────────────────────────────
const DATA_DIR = path.join(process.cwd(), "data");
const METADATA_FILE = path.join(DATA_DIR, "knowledge-base.json");
const DOCUMENTS_DIR = path.join(DATA_DIR, "knowledge-base");

// ── Types ───────────────────────────────────────────────────────────────────
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
  cachedContext?: string; // Pre-computed context string
}

// ── In-memory state (cleared on restart) ───────────────────────────────────
let _metadata: KnowledgeBaseMetadata | null = null;
let _contextCache: string | null = null; // Pre-built context string
const _contentCache = new Map<string, string>(); // docId -> content

// ── Simple file operations ─────────────────────────────────────────────────
function ensureDirectories(): void {
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
  if (!fs.existsSync(DOCUMENTS_DIR)) fs.mkdirSync(DOCUMENTS_DIR, { recursive: true });
}

function readMetadata(): KnowledgeBaseMetadata | null {
  try {
    const raw = fs.readFileSync(METADATA_FILE, "utf-8");
    return JSON.parse(raw) as KnowledgeBaseMetadata;
  } catch {
    return null;
  }
}

function writeMetadata(metadata: KnowledgeBaseMetadata): void {
  ensureDirectories();
  metadata.lastUpdated = new Date().toISOString();
  fs.writeFileSync(METADATA_FILE, JSON.stringify(metadata, null, 2), { encoding: "utf-8", mode: 0o600 });
}

function generateId(): string {
  return crypto.randomBytes(8).toString("hex"); // 16 chars, shorter than before
}

function formatBytes(bytes: number): string {
  if (bytes === 0) return "0 B";
  const k = 1024;
  const sizes = ["B", "KB", "MB", "GB"];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return parseFloat((bytes / Math.pow(k, i)).toFixed(1)) + " " + sizes[i];
}

// ── Pre-compute context string (CPU-intensive but done once) ────────────────
function buildContextString(docs: KnowledgeDocument[]): string {
  if (docs.length === 0) return "";
  
  const sections: string[] = [];
  let totalLength = 0;
  
  // Calculate how much space each document should get (at minimum)
  // Reserve space for all documents to be at least partially included
  const minSpacePerDoc = 500; // At least 500 chars per document
  const availableForFull = MAX_CONTEXT_LENGTH - (docs.length * minSpacePerDoc);
  const avgSpacePerDoc = Math.max(2000, Math.floor(availableForFull / docs.length));
  
  for (const doc of docs) {
    try {
      const filePath = path.join(DOCUMENTS_DIR, `${doc.id}.md`);
      if (!fs.existsSync(filePath)) continue;
      
      // Read and cache
      let content = _contentCache.get(doc.id);
      if (!content) {
        content = fs.readFileSync(filePath, "utf-8");
        _contentCache.set(doc.id, content);
      }
      
      const header = `--- ${doc.name} ---\n`;
      const sectionLength = header.length + content.length;
      
      // Calculate how much of this document we can include
      const remainingSpace = MAX_CONTEXT_LENGTH - totalLength - header.length - 100;
      
      if (sectionLength <= avgSpacePerDoc && totalLength + sectionLength <= MAX_CONTEXT_LENGTH) {
        // Full document fits
        sections.push(header + content);
        totalLength += sectionLength;
      } else if (remainingSpace > minSpacePerDoc) {
        // Include partial content
        const excerptLength = Math.min(content.length, remainingSpace - 50);
        const excerpt = content.slice(0, excerptLength);
        const isTruncated = excerptLength < content.length;
        sections.push(header + excerpt + (isTruncated ? "\n[... document continues ...]" : ""));
        totalLength += header.length + excerpt.length + (isTruncated ? 30 : 0);
      } else {
        // Minimal space - just include the header and description
        const description = doc.description || "Company knowledge document";
        sections.push(header + `[${description}]`);
        totalLength += header.length + description.length + 2;
      }
    } catch {
      // Skip files that can't be read
      continue;
    }
  }
  
  return sections.join("\n\n");
}

// ── Public API ──────────────────────────────────────────────────────────────

/** Initialize/load metadata (lazy - only runs once) */
function ensureLoaded(): void {
  if (_metadata !== null) return;
  
  const data = readMetadata();
  _metadata = data ?? {
    documents: [],
    totalSize: 0,
    lastUpdated: new Date().toISOString()
  };
  
  // Pre-compute context string
  if (_metadata.documents.length > 0) {
    _contextCache = buildContextString(_metadata.documents);
    _metadata.cachedContext = _contextCache;
  }
}

/** Get all documents (lightweight - no scanning) */
export function getKnowledgeDocuments(): KnowledgeDocument[] {
  ensureLoaded();
  return _metadata?.documents ?? [];
}

/** Get pre-computed context for LLM (FAST - just returns cached string) */
export function getKnowledgeBaseContext(): string {
  ensureLoaded();
  return _contextCache ?? "";
}

/** Get document content by ID (cached) */
export function getKnowledgeDocumentContent(id: string): string | null {
  // Check memory cache first
  let content = _contentCache.get(id);
  if (content) return content;
  
  // Check if document exists
  const docs = getKnowledgeDocuments();
  const doc = docs.find(d => d.id === id);
  if (!doc) return null;
  
  // Read and cache
  try {
    const filePath = path.join(DOCUMENTS_DIR, `${doc.id}.md`);
    content = fs.readFileSync(filePath, "utf-8");
    _contentCache.set(id, content);
    return content;
  } catch {
    return null;
  }
}

/** Get single document metadata */
export function getKnowledgeDocument(id: string): KnowledgeDocument | null {
  const docs = getKnowledgeDocuments();
  return docs.find(d => d.id === id) ?? null;
}

/** Simple stats (no scanning) */
export function getKnowledgeBaseStats(): {
  documentCount: number;
  totalSize: number;
  totalSizeFormatted: string;
  maxSize: number;
  maxSizeFormatted: string;
  utilizationPercent: number;
} {
  ensureLoaded();
  const maxBytes = MAX_KB_SIZE_MB * 1024 * 1024;
  const totalSize = _metadata?.totalSize ?? 0;
  
  return {
    documentCount: _metadata?.documents.length ?? 0,
    totalSize,
    totalSizeFormatted: formatBytes(totalSize),
    maxSize: maxBytes,
    maxSizeFormatted: formatBytes(maxBytes),
    utilizationPercent: Math.round((totalSize / maxBytes) * 100),
  };
}

/** Add document (rebuilds cache) */
export function addKnowledgeDocument(
  name: string,
  description: string,
  content: string
): KnowledgeDocument {
  ensureLoaded();
  
  const contentSize = Buffer.byteLength(content, "utf-8");
  
  // Simple validation
  if (contentSize > MAX_DOC_SIZE_MB * 1024 * 1024) {
    throw new Error(`Document too large. Max is ${MAX_DOC_SIZE_MB}MB`);
  }
  
  const currentSize = _metadata?.totalSize ?? 0;
  if (currentSize + contentSize > MAX_KB_SIZE_MB * 1024 * 1024) {
    throw new Error(`Knowledge base full. Delete some documents first.`);
  }
  
  const id = generateId();
  const now = new Date().toISOString();
  
  // Write file
  ensureDirectories();
  const filePath = path.join(DOCUMENTS_DIR, `${id}.md`);
  fs.writeFileSync(filePath, content, "utf-8");
  
  // Update metadata
  const doc: KnowledgeDocument = {
    id,
    name: name.replace(/\.md$/i, ""),
    description,
    createdAt: now,
    updatedAt: now,
    size: contentSize,
  };
  
  if (!_metadata) {
    _metadata = { documents: [], totalSize: 0, lastUpdated: now };
  }
  
  _metadata.documents.push(doc);
  _metadata.totalSize += contentSize;
  
  // Cache content
  _contentCache.set(id, content);
  
  // Rebuild context string
  _contextCache = buildContextString(_metadata.documents);
  _metadata.cachedContext = _contextCache;
  
  // Persist
  writeMetadata(_metadata);
  
  return doc;
}

/** Delete document (rebuilds cache) */
export function deleteKnowledgeDocument(id: string): boolean {
  ensureLoaded();
  if (!_metadata) return false;
  
  const idx = _metadata.documents.findIndex(d => d.id === id);
  if (idx === -1) return false;
  
  const doc = _metadata.documents[idx];
  
  // Delete file
  try {
    const filePath = path.join(DOCUMENTS_DIR, `${doc.id}.md`);
    if (fs.existsSync(filePath)) {
      fs.unlinkSync(filePath);
    }
  } catch (e) {
    console.warn(`[kb] Could not delete ${doc.id}.md:`, e);
  }
  
  // Update metadata
  _metadata.totalSize -= doc.size;
  _metadata.documents.splice(idx, 1);
  _contentCache.delete(id);
  
  // Rebuild context
  _contextCache = buildContextString(_metadata.documents);
  _metadata.cachedContext = _contextCache;
  
  writeMetadata(_metadata);
  
  return true;
}

/** Simple search (returns doc names only, no content scanning) */
export function searchKnowledgeBase(query: string): Array<{ doc: KnowledgeDocument; matches: boolean }> {
  const docs = getKnowledgeDocuments();
  const queryLower = query.toLowerCase();
  
  // Simple name/description matching only (no content scanning = fast)
  return docs
    .filter(doc => 
      doc.name.toLowerCase().includes(queryLower) ||
      doc.description.toLowerCase().includes(queryLower)
    )
    .map(doc => ({ doc, matches: true }));
}

/** Backward compatibility - returns full context */
export function getAllKnowledgeDocumentContents(): string {
  return getKnowledgeBaseContext();
}

/** Rebuild cache (call if files modified externally) */
export function rebuildKnowledgeBaseCache(): void {
  _metadata = null;
  _contextCache = null;
  _contentCache.clear();
  ensureLoaded();
  console.log("[kb] Cache rebuilt:", getKnowledgeBaseStats().documentCount, "documents");
}
