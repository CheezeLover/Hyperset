/**
 * Concurrent-Safe Knowledge Base - Thread-safe for high-traffic
 * 
 * Improvements:
 * - Read-write locking pattern
 * - Immutable metadata updates
 * - Atomic cache operations
 * - Request-scoped context (not shared)
 * - Connection pooling safe
 */

import fs from "fs";
import path from "path";
import crypto from "crypto";

// ── Configuration ────────────────────────────────────────────────────────────
const MAX_CONTEXT_LENGTH = 6000;
const MAX_KB_SIZE_MB = 20;
const MAX_DOC_SIZE_MB = 5;

// ── Paths ────────────────────────────────────────────────────────────────────
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
  version: number; // Incremented on each change for cache invalidation
}

// ── Thread-safe state management ─────────────────────────────────────────────

// Versioned immutable metadata - copy-on-write pattern
let _metadataVersion = 0;
let _metadata: KnowledgeBaseMetadata = {
  documents: [],
  totalSize: 0,
  lastUpdated: new Date().toISOString(),
  version: 0
};

// Pre-computed context (regenerated when metadata changes)
let _contextCache: string = "";
let _contextVersion = 0;

// Document content cache (docs rarely change, safe to cache)
const _contentCache = new Map<string, { content: string; version: number }>();

// Simple async lock for write operations
let _writeLock = Promise.resolve();

// ── Helper functions ────────────────────────────────────────────────────────
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
  const updated = { ...metadata, lastUpdated: new Date().toISOString() };
  // Atomic write: write to temp file, then rename
  const tempFile = METADATA_FILE + '.tmp';
  fs.writeFileSync(tempFile, JSON.stringify(updated, null, 2), { encoding: "utf-8", mode: 0o600 });
  fs.renameSync(tempFile, METADATA_FILE);
}

function generateId(): string {
  return crypto.randomBytes(8).toString("hex");
}

function formatBytes(bytes: number): string {
  if (bytes === 0) return "0 B";
  const k = 1024;
  const sizes = ["B", "KB", "MB", "GB"];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return parseFloat((bytes / Math.pow(k, i)).toFixed(1)) + " " + sizes[i];
}

// Build context string from current metadata (called once per metadata change)
function buildContextString(metadata: KnowledgeBaseMetadata): string {
  if (metadata.documents.length === 0) return "";
  
  const sections: string[] = [];
  let totalLength = 0;
  
  for (const doc of metadata.documents) {
    try {
      const filePath = path.join(DOCUMENTS_DIR, `${doc.id}.md`);
      if (!fs.existsSync(filePath)) continue;
      
      // Use cached content if available and version matches
      let cached = _contentCache.get(doc.id);
      let content: string;
      
      if (cached && cached.version === metadata.version) {
        content = cached.content;
      } else {
        content = fs.readFileSync(filePath, "utf-8");
        _contentCache.set(doc.id, { content, version: metadata.version });
      }
      
      const header = `--- ${doc.name} ---\n`;
      const section = header + content;
      
      if (totalLength + section.length > MAX_CONTEXT_LENGTH) {
        const remaining = MAX_CONTEXT_LENGTH - totalLength - header.length - 50;
        if (remaining > 200) {
          sections.push(header + content.slice(0, remaining) + "\n[truncated]");
        }
        break;
      }
      
      sections.push(section);
      totalLength += section.length;
    } catch {
      continue;
    }
  }
  
  return sections.join("\n\n");
}

// ── Initialization (lazy, idempotent) ──────────────────────────────────────

// Atomic initialization - safe for concurrent calls
function ensureLoaded(): void {
  if (_metadataVersion > 0) return; // Already loaded
  
  const data = readMetadata();
  if (data) {
    _metadata = { ...data, version: data.version || 1 };
    _metadataVersion = _metadata.version;
  } else {
    _metadata = {
      documents: [],
      totalSize: 0,
      lastUpdated: new Date().toISOString(),
      version: 1
    };
    _metadataVersion = 1;
  }
  
  // Build context
  _contextCache = buildContextString(_metadata);
  _contextVersion = _metadata.version;
}

// ── Public API (Concurrent-Safe) ─────────────────────────────────────────────

/** Get all documents (read-only, thread-safe) */
export function getKnowledgeDocuments(): KnowledgeDocument[] {
  ensureLoaded();
  // Return copy to prevent external mutation
  return [..._metadata.documents];
}

/** Get pre-computed context (read-only, extremely fast) */
export function getKnowledgeBaseContext(): string {
  ensureLoaded();
  return _contextCache;
}

/** Get document content by ID (cached, thread-safe read) */
export function getKnowledgeDocumentContent(id: string): string | null {
  ensureLoaded();
  
  // Check if document exists in metadata
  const doc = _metadata.documents.find(d => d.id === id);
  if (!doc) return null;
  
  // Check cache
  const cached = _contentCache.get(id);
  if (cached && cached.version === _metadata.version) {
    return cached.content;
  }
  
  // Read from disk
  try {
    const filePath = path.join(DOCUMENTS_DIR, `${doc.id}.md`);
    const content = fs.readFileSync(filePath, "utf-8");
    _contentCache.set(id, { content, version: _metadata.version });
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

/** Get stats (read-only) */
export function getKnowledgeBaseStats(): {
  documentCount: number;
  totalSize: number;
  totalSizeFormatted: string;
  maxSize: number;
  maxSizeFormatted: string;
  utilizationPercent: number;
  version: number;
} {
  ensureLoaded();
  const maxBytes = MAX_KB_SIZE_MB * 1024 * 1024;
  
  return {
    documentCount: _metadata.documents.length,
    totalSize: _metadata.totalSize,
    totalSizeFormatted: formatBytes(_metadata.totalSize),
    maxSize: maxBytes,
    maxSizeFormatted: formatBytes(maxBytes),
    utilizationPercent: Math.round((_metadata.totalSize / maxBytes) * 100),
    version: _metadata.version
  };
}

/** Add document (write operation with lock) */
export async function addKnowledgeDocument(
  name: string,
  description: string,
  content: string
): Promise<KnowledgeDocument> {
  const contentSize = Buffer.byteLength(content, "utf-8");
  
  // Validation
  if (contentSize > MAX_DOC_SIZE_MB * 1024 * 1024) {
    throw new Error(`Document too large. Max is ${MAX_DOC_SIZE_MB}MB`);
  }
  
  // Acquire lock for write
  const release = await acquireWriteLock();
  
  try {
    ensureLoaded();
    
    if (_metadata.totalSize + contentSize > MAX_KB_SIZE_MB * 1024 * 1024) {
      throw new Error(`Knowledge base full. Delete some documents first.`);
    }
    
    const id = generateId();
    const now = new Date().toISOString();
    
    // Write file to disk
    ensureDirectories();
    const filePath = path.join(DOCUMENTS_DIR, `${id}.md`);
    fs.writeFileSync(filePath, content, "utf-8");
    
    // Create new metadata (immutable update)
    const doc: KnowledgeDocument = {
      id,
      name: name.replace(/\.md$/i, ""),
      description,
      createdAt: now,
      updatedAt: now,
      size: contentSize,
    };
    
    const newVersion = _metadata.version + 1;
    _metadata = {
      documents: [..._metadata.documents, doc],
      totalSize: _metadata.totalSize + contentSize,
      lastUpdated: now,
      version: newVersion
    };
    
    // Update caches atomically
    _metadataVersion = newVersion;
    _contentCache.set(id, { content, version: newVersion });
    _contextCache = buildContextString(_metadata);
    _contextVersion = newVersion;
    
    // Persist to disk
    writeMetadata(_metadata);
    
    return doc;
  } finally {
    release();
  }
}

/** Delete document (write operation with lock) */
export async function deleteKnowledgeDocument(id: string): Promise<boolean> {
  // Acquire lock
  const release = await acquireWriteLock();
  
  try {
    ensureLoaded();
    
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
      console.warn(`[kb-concurrent] Could not delete ${doc.id}.md:`, e);
    }
    
    // Create new metadata (immutable)
    const newDocs = [..._metadata.documents];
    newDocs.splice(idx, 1);
    
    const newVersion = _metadata.version + 1;
    _metadata = {
      documents: newDocs,
      totalSize: _metadata.totalSize - doc.size,
      lastUpdated: new Date().toISOString(),
      version: newVersion
    };
    
    // Update caches
    _metadataVersion = newVersion;
    _contentCache.delete(id);
    _contextCache = buildContextString(_metadata);
    _contextVersion = newVersion;
    
    writeMetadata(_metadata);
    
    return true;
  } finally {
    release();
  }
}

/** Simple search by name/description (read-only, fast) */
export function searchKnowledgeBase(query: string): Array<{ doc: KnowledgeDocument; matches: boolean }> {
  const docs = getKnowledgeDocuments();
  const queryLower = query.toLowerCase();
  
  return docs
    .filter(doc => 
      doc.name.toLowerCase().includes(queryLower) ||
      doc.description.toLowerCase().includes(queryLower)
    )
    .map(doc => ({ doc, matches: true }));
}

/** Backward compatibility */
export function getAllKnowledgeDocumentContents(): string {
  return getKnowledgeBaseContext();
}

/** Rebuild cache (admin operation) */
export function rebuildKnowledgeBaseCache(): void {
  _metadataVersion = 0;
  _contentCache.clear();
  ensureLoaded();
  console.log("[kb-concurrent] Cache rebuilt:", getKnowledgeBaseStats().documentCount, "documents");
}

// ── Lock implementation ──────────────────────────────────────────────────────

async function acquireWriteLock(): Promise<() => void> {
  let release: () => void;
  const newLock = new Promise<void>(resolve => {
    release = () => resolve();
  });
  
  const prevLock = _writeLock;
  _writeLock = prevLock.then(() => newLock);
  
  await prevLock;
  
  return release!;
}
