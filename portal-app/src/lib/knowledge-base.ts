/**
 * Production-ready knowledge base with RAG-style retrieval and smart caching.
 * 
 * Improvements over basic version:
 * - Document chunking for large files
 * - Simple keyword-based relevance scoring
 * - In-memory LRU cache for document contents
 * - Size limits and warnings
 * - On-demand loading instead of dumping everything into the prompt
 */

import fs from "fs";
import path from "path";
import crypto from "crypto";

// ── Configuration ────────────────────────────────────────────────────────────
const MAX_KB_SIZE_MB = 50; // Maximum total knowledge base size in MB
const MAX_DOC_SIZE_MB = 10; // Maximum single document size in MB
const CHUNK_SIZE = 4000; // Characters per chunk for large documents
const CHUNK_OVERLAP = 500; // Overlap between chunks to maintain context
const CONTENT_CACHE_SIZE = 100; // Max documents to keep in memory cache
const MAX_CONTEXT_LENGTH = 8000; // Maximum characters to inject into prompt

// ── AES-256-GCM encryption for metadata at rest ─────────────────────────────
const _encKey = (() => {
  const secret = process.env.SESSION_SECRET ?? "";
  return crypto.createHash("sha256").update(secret).digest();
})();

function encryptString(plaintext: string): string {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", _encKey, iv);
  const encrypted = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  const authTag = cipher.getAuthTag();
  return [iv.toString("base64"), authTag.toString("base64"), encrypted.toString("base64")].join(":");
}

function decryptString(ciphertext: string): string {
  const parts = ciphertext.split(":");
  if (parts.length !== 3) throw new Error("Invalid ciphertext format");
  const [ivB64, tagB64, encB64] = parts;
  const iv = Buffer.from(ivB64, "base64");
  const authTag = Buffer.from(tagB64, "base64");
  const encrypted = Buffer.from(encB64, "base64");
  const decipher = crypto.createDecipheriv("aes-256-gcm", _encKey, iv);
  decipher.setAuthTag(authTag);
  return decipher.update(encrypted).toString("utf8") + decipher.final("utf8");
}

// ── Paths ──────────────────────────────────────────────────────────────────
const DATA_DIR = process.env.KNOWLEDGE_BASE_PATH
  ? path.dirname(process.env.KNOWLEDGE_BASE_PATH)
  : path.join(process.cwd(), "data");

const METADATA_FILE = process.env.KNOWLEDGE_BASE_PATH
  ?? path.join(DATA_DIR, "knowledge-base.json");

const DOCUMENTS_DIR = path.join(DATA_DIR, "knowledge-base");

// ── Types ───────────────────────────────────────────────────────────────────
export interface KnowledgeDocument {
  id: string;
  name: string;
  description: string;
  createdAt: string;
  updatedAt: string;
  size: number;
  chunks?: number; // Number of chunks if document was split
}

export interface KnowledgeBaseMetadata {
  documents: KnowledgeDocument[];
  totalSize: number;
  lastUpdated: string;
}

export interface DocumentChunk {
  id: string;
  docId: string;
  docName: string;
  content: string;
  index: number;
  totalChunks: number;
}

// ── Simple LRU Cache for document contents ─────────────────────────────────
class LRUCache<K, V> {
  private cache = new Map<K, V>();
  private maxSize: number;

  constructor(maxSize: number) {
    this.maxSize = maxSize;
  }

  get(key: K): V | undefined {
    const value = this.cache.get(key);
    if (value !== undefined) {
      // Move to end (most recently used)
      this.cache.delete(key);
      this.cache.set(key, value);
    }
    return value;
  }

  set(key: K, value: V): void {
    if (this.cache.has(key)) {
      this.cache.delete(key);
    } else if (this.cache.size >= this.maxSize) {
      // Remove least recently used (first item)
      const firstKey = this.cache.keys().next().value;
      if (firstKey !== undefined) {
        this.cache.delete(firstKey);
      }
    }
    this.cache.set(key, value);
  }

  clear(): void {
    this.cache.clear();
  }

  size(): number {
    return this.cache.size;
  }
}

// Content cache: document ID -> content
const _contentCache = new LRUCache<string, string>(CONTENT_CACHE_SIZE);

// ── In-memory cache for metadata ────────────────────────────────────────────
let _metadataCache: KnowledgeBaseMetadata | null | undefined = undefined;

// ── File operations ─────────────────────────────────────────────────────────
function ensureDirectories(): void {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.mkdirSync(DOCUMENTS_DIR, { recursive: true });
}

function readMetadataFromDisk(): KnowledgeBaseMetadata | null {
  try {
    const raw = fs.readFileSync(METADATA_FILE, "utf-8");
    const decrypted = decryptString(raw);
    return JSON.parse(decrypted) as KnowledgeBaseMetadata;
  } catch {
    return null;
  }
}

function writeMetadataToDisk(metadata: KnowledgeBaseMetadata): void {
  try {
    ensureDirectories();
    metadata.lastUpdated = new Date().toISOString();
    const encrypted = encryptString(JSON.stringify(metadata, null, 2));
    fs.writeFileSync(METADATA_FILE, encrypted, { encoding: "utf-8", mode: 0o600 });
    fs.chmodSync(METADATA_FILE, 0o600);
  } catch (e) {
    console.warn("[knowledge-base] Could not persist metadata to disk:", e);
  }
}

function generateId(): string {
  return crypto.randomBytes(16).toString("hex");
}

function formatBytes(bytes: number): string {
  if (bytes === 0) return "0 B";
  const k = 1024;
  const sizes = ["B", "KB", "MB", "GB"];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return parseFloat((bytes / Math.pow(k, i)).toFixed(1)) + " " + sizes[i];
}

// ── Document chunking for large files ───────────────────────────────────────
function chunkDocument(content: string, chunkSize: number = CHUNK_SIZE, overlap: number = CHUNK_OVERLAP): string[] {
  const chunks: string[] = [];
  let start = 0;

  while (start < content.length) {
    let end = start + chunkSize;
    
    // Try to end at a paragraph boundary
    if (end < content.length) {
      const nextNewline = content.indexOf('\n\n', end - overlap);
      if (nextNewline !== -1 && nextNewline < end + overlap) {
        end = nextNewline + 2;
      } else {
        // Try to end at a sentence boundary
        const nextPeriod = content.indexOf('. ', end - overlap);
        if (nextPeriod !== -1 && nextPeriod < end + overlap) {
          end = nextPeriod + 2;
        }
      }
    } else {
      end = content.length;
    }

    chunks.push(content.slice(start, end).trim());
    start = end - overlap;
    
    if (start >= content.length) break;
  }

  return chunks;
}

// ── Auto-import function ──────────────────────────────────────────────────
function autoImportOrphanedFiles(metadata: KnowledgeBaseMetadata): KnowledgeBaseMetadata {
  try {
    ensureDirectories();
    const files = fs.readdirSync(DOCUMENTS_DIR);
    const registeredNames = new Set(metadata.documents.map(d => `${d.id}.md`));
    
    for (const file of files) {
      if (!file.toLowerCase().endsWith('.md')) continue;
      if (registeredNames.has(file)) continue;
      
      const baseName = file.replace(/\.md$/i, '');
      const isRegisteredByName = metadata.documents.some(d => 
        d.name.toLowerCase() === baseName.toLowerCase()
      );
      if (isRegisteredByName) continue;
      
      try {
        const filePath = path.join(DOCUMENTS_DIR, file);
        const stats = fs.statSync(filePath);
        
        if (!stats.isFile()) continue;
        
        // Check size limits
        if (stats.size > MAX_DOC_SIZE_MB * 1024 * 1024) {
          console.warn(`[knowledge-base] Skipping ${file}: exceeds ${MAX_DOC_SIZE_MB}MB limit`);
          continue;
        }
        
        // Check total KB size
        if (metadata.totalSize + stats.size > MAX_KB_SIZE_MB * 1024 * 1024) {
          console.warn(`[knowledge-base] Cannot import ${file}: would exceed ${MAX_KB_SIZE_MB}MB total limit`);
          continue;
        }
        
        const content = fs.readFileSync(filePath, "utf-8");
        const id = generateId();
        const now = new Date().toISOString();
        
        // Rename file to use ID
        const newFilePath = path.join(DOCUMENTS_DIR, `${id}.md`);
        fs.renameSync(filePath, newFilePath);
        
        // Check if document needs chunking
        const needsChunking = content.length > CHUNK_SIZE;
        const chunks = needsChunking ? chunkDocument(content) : [content];
        
        // For chunked documents, save chunks as separate files
        if (needsChunking && chunks.length > 1) {
          for (let i = 0; i < chunks.length; i++) {
            const chunkPath = path.join(DOCUMENTS_DIR, `${id}_chunk_${i}.md`);
            fs.writeFileSync(chunkPath, chunks[i], "utf-8");
          }
        }
        
        const doc: KnowledgeDocument = {
          id,
          name: baseName,
          description: "Auto-imported from filesystem",
          createdAt: now,
          updatedAt: now,
          size: stats.size,
          chunks: chunks.length > 1 ? chunks.length : undefined,
        };
        
        metadata.documents.push(doc);
        metadata.totalSize += stats.size;
        
        // Add to cache
        _contentCache.set(id, content);
        
        console.log(`[knowledge-base] Auto-imported: ${file} -> ${id}.md (${formatBytes(stats.size)})${chunks.length > 1 ? ` [${chunks.length} chunks]` : ''}`);
      } catch (e) {
        console.warn(`[knowledge-base] Failed to auto-import ${file}:`, e);
      }
    }
    
    if (metadata.documents.length > registeredNames.size) {
      writeMetadataToDisk(metadata);
    }
    
    return metadata;
  } catch (e) {
    console.warn("[knowledge-base] Error scanning for orphaned files:", e);
    return metadata;
  }
}

// ── Relevance scoring ──────────────────────────────────────────────────────
function calculateRelevance(query: string, content: string): number {
  const queryTerms = query.toLowerCase().split(/\s+/).filter(t => t.length > 2);
  const contentLower = content.toLowerCase();
  
  let score = 0;
  for (const term of queryTerms) {
    // Count occurrences
    const regex = new RegExp(term, 'g');
    const matches = contentLower.match(regex);
    if (matches) {
      score += matches.length;
    }
    
    // Bonus for exact phrase match
    if (contentLower.includes(term)) {
      score += 5;
    }
    
    // Bonus for heading match (markdown headers)
    if (contentLower.includes(`# ${term}`) || 
        contentLower.includes(`## ${term}`) ||
        contentLower.includes(`### ${term}`)) {
      score += 20;
    }
  }
  
  return score;
}

// ── Public API ──────────────────────────────────────────────────────────────

/** Get knowledge base metadata with auto-import */
export function getKnowledgeBaseMetadata(): KnowledgeBaseMetadata {
  if (_metadataCache === undefined) {
    const data = readMetadataFromDisk();
    const metadata = data ?? { documents: [], totalSize: 0, lastUpdated: new Date().toISOString() };
    _metadataCache = autoImportOrphanedFiles(metadata);
  }
  return _metadataCache;
}

/** Get all documents from the knowledge base */
export function getKnowledgeDocuments(): KnowledgeDocument[] {
  return getKnowledgeBaseMetadata().documents;
}

/** Get a single document by ID */
export function getKnowledgeDocument(id: string): KnowledgeDocument | null {
  const docs = getKnowledgeDocuments();
  return docs.find((d) => d.id === id) ?? null;
}

/** Get document content by ID (with caching) */
export function getKnowledgeDocumentContent(id: string): string | null {
  // Check cache first
  const cached = _contentCache.get(id);
  if (cached) {
    return cached;
  }
  
  const doc = getKnowledgeDocument(id);
  if (!doc) return null;

  const filePath = path.join(DOCUMENTS_DIR, `${doc.id}.md`);
  try {
    const content = fs.readFileSync(filePath, "utf-8");
    
    // If document has chunks, load and combine them
    if (doc.chunks && doc.chunks > 1) {
      let fullContent = content;
      for (let i = 1; i < doc.chunks; i++) {
        const chunkPath = path.join(DOCUMENTS_DIR, `${doc.id}_chunk_${i}.md`);
        if (fs.existsSync(chunkPath)) {
          fullContent += '\n\n' + fs.readFileSync(chunkPath, "utf-8");
        }
      }
      _contentCache.set(id, fullContent);
      return fullContent;
    }
    
    _contentCache.set(id, content);
    return content;
  } catch {
    return null;
  }
}

/** Get relevant content based on query (RAG-style retrieval) */
export function getRelevantKnowledgeContent(query: string, maxChars: number = MAX_CONTEXT_LENGTH): string {
  const docs = getKnowledgeDocuments();
  if (docs.length === 0) return "";

  // Score all documents
  const scoredDocs = docs.map(doc => {
    const content = getKnowledgeDocumentContent(doc.id);
    if (!content) return { doc, content: "", score: 0 };
    const score = calculateRelevance(query, content);
    return { doc, content, score };
  }).filter(item => item.score > 0);

  // Sort by relevance
  scoredDocs.sort((a, b) => b.score - a.score);

  // Build context up to maxChars
  const contents: string[] = [];
  let totalLength = 0;

  for (const { doc, content } of scoredDocs) {
    const header = `--- ${doc.name} ---\n`;
    const section = header + content;
    
    if (totalLength + section.length > maxChars) {
      // Add a truncated note
      const remaining = maxChars - totalLength - header.length - 100;
      if (remaining > 200) {
        contents.push(header + content.slice(0, remaining) + "\n... [truncated]");
      }
      break;
    }
    
    contents.push(section);
    totalLength += section.length;
  }

  return contents.join("\n\n");
}

/** Get all document contents concatenated (original behavior for backwards compatibility) */
export function getAllKnowledgeDocumentContents(): string {
  const docs = getKnowledgeDocuments();
  if (docs.length === 0) return "";

  const contents: string[] = [];
  let totalLength = 0;

  for (const doc of docs) {
    const content = getKnowledgeDocumentContent(doc.id);
    if (content) {
      const section = `--- Document: ${doc.name} ---\n${content}`;
      
      // Respect max context length
      if (totalLength + section.length > MAX_CONTEXT_LENGTH) {
        const remaining = MAX_CONTEXT_LENGTH - totalLength - 100;
        if (remaining > 200) {
          contents.push(`--- Document: ${doc.name} ---\n${content.slice(0, remaining)}\n... [truncated due to length]`);
        }
        break;
      }
      
      contents.push(section);
      totalLength += section.length;
    }
  }

  return contents.join("\n\n");
}

/** Add a new document to the knowledge base */
export function addKnowledgeDocument(
  name: string,
  description: string,
  content: string
): KnowledgeDocument {
  ensureDirectories();

  const contentSize = Buffer.byteLength(content, "utf-8");
  
  // Check size limits
  if (contentSize > MAX_DOC_SIZE_MB * 1024 * 1024) {
    throw new Error(`Document too large. Maximum size is ${MAX_DOC_SIZE_MB}MB`);
  }

  const metadata = getKnowledgeBaseMetadata();
  if (metadata.totalSize + contentSize > MAX_KB_SIZE_MB * 1024 * 1024) {
    throw new Error(`Knowledge base full. Maximum total size is ${MAX_KB_SIZE_MB}MB. Please delete some documents first.`);
  }

  const id = generateId();
  const now = new Date().toISOString();
  
  // Check if chunking needed
  const needsChunking = content.length > CHUNK_SIZE;
  const chunks = needsChunking ? chunkDocument(content) : [content];

  // Write the main document file
  const filePath = path.join(DOCUMENTS_DIR, `${id}.md`);
  fs.writeFileSync(filePath, chunks[0], "utf-8");

  // Write additional chunks if needed
  if (needsChunking && chunks.length > 1) {
    for (let i = 1; i < chunks.length; i++) {
      const chunkPath = path.join(DOCUMENTS_DIR, `${id}_chunk_${i}.md`);
      fs.writeFileSync(chunkPath, chunks[i], "utf-8");
    }
  }

  // Create metadata entry
  const doc: KnowledgeDocument = {
    id,
    name: name.replace(/\.md$/i, ""),
    description,
    createdAt: now,
    updatedAt: now,
    size: contentSize,
    chunks: chunks.length > 1 ? chunks.length : undefined,
  };

  // Update metadata
  metadata.documents.push(doc);
  metadata.totalSize += contentSize;
  writeMetadataToDisk(metadata);

  // Update cache
  _metadataCache = metadata;
  _contentCache.set(id, content);

  return doc;
}

/** Delete a document from the knowledge base */
export function deleteKnowledgeDocument(id: string): boolean {
  const metadata = getKnowledgeBaseMetadata();
  
  const docIndex = metadata.documents.findIndex((d) => d.id === id);
  if (docIndex === -1) return false;

  const doc = metadata.documents[docIndex];

  // Delete the main file
  const filePath = path.join(DOCUMENTS_DIR, `${doc.id}.md`);
  try {
    fs.unlinkSync(filePath);
  } catch (e) {
    console.warn(`[knowledge-base] Could not delete file ${filePath}:`, e);
  }

  // Delete chunk files if any
  if (doc.chunks && doc.chunks > 1) {
    for (let i = 1; i < doc.chunks; i++) {
      const chunkPath = path.join(DOCUMENTS_DIR, `${doc.id}_chunk_${i}.md`);
      try {
        fs.unlinkSync(chunkPath);
      } catch (e) {
        // Chunk might not exist
      }
    }
  }

  // Update metadata
  metadata.totalSize -= doc.size;
  metadata.documents.splice(docIndex, 1);
  writeMetadataToDisk(metadata);

  // Update caches
  _metadataCache = metadata;
  _contentCache.set(id, null as any); // Mark as deleted

  return true;
}

/** Get knowledge base statistics */
export function getKnowledgeBaseStats(): {
  documentCount: number;
  totalSize: number;
  totalSizeFormatted: string;
  cacheSize: number;
  maxSize: number;
  maxSizeFormatted: string;
  utilizationPercent: number;
} {
  const metadata = getKnowledgeBaseMetadata();
  const maxBytes = MAX_KB_SIZE_MB * 1024 * 1024;
  
  return {
    documentCount: metadata.documents.length,
    totalSize: metadata.totalSize,
    totalSizeFormatted: formatBytes(metadata.totalSize),
    cacheSize: _contentCache.size(),
    maxSize: maxBytes,
    maxSizeFormatted: formatBytes(maxBytes),
    utilizationPercent: Math.round((metadata.totalSize / maxBytes) * 100),
  };
}

/** Search documents by keyword */
export function searchKnowledgeBase(query: string): Array<{ doc: KnowledgeDocument; relevance: number; excerpt: string }> {
  const docs = getKnowledgeDocuments();
  const results: Array<{ doc: KnowledgeDocument; relevance: number; excerpt: string }> = [];

  const queryLower = query.toLowerCase();

  for (const doc of docs) {
    const content = getKnowledgeDocumentContent(doc.id);
    if (!content) continue;

    const relevance = calculateRelevance(query, content);
    if (relevance > 0) {
      // Extract excerpt around first match
      const contentLower = content.toLowerCase();
      const matchIndex = contentLower.indexOf(queryLower);
      let excerpt = "";
      
      if (matchIndex !== -1) {
        const start = Math.max(0, matchIndex - 100);
        const end = Math.min(content.length, matchIndex + 200);
        excerpt = content.slice(start, end);
        if (start > 0) excerpt = "..." + excerpt;
        if (end < content.length) excerpt = excerpt + "...";
      } else {
        excerpt = content.slice(0, 300) + "...";
      }

      results.push({ doc, relevance, excerpt });
    }
  }

  results.sort((a, b) => b.relevance - a.relevance);
  return results;
}
