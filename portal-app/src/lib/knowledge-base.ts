/**
 * Server-side knowledge base store for company-specific documents.
 *
 * Documents are stored as .md files on disk with metadata tracked in a JSON file.
 * The metadata file is encrypted with AES-256-GCM (using the same key derivation as admin-settings).
 *
 * Storage structure:
 *   - Metadata: data/knowledge-base.json (encrypted)
 *   - Documents: data/knowledge-base/*.md (plain text .md files)
 */

import fs from "fs";
import path from "path";
import crypto from "crypto";

// ── AES-256-GCM encryption for metadata at rest ────────────────────────────────
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

// ── Paths ────────────────────────────────────────────────────────────────────
const DATA_DIR = process.env.KNOWLEDGE_BASE_PATH
  ? path.dirname(process.env.KNOWLEDGE_BASE_PATH)
  : path.join(process.cwd(), "data");

const METADATA_FILE = process.env.KNOWLEDGE_BASE_PATH
  ?? path.join(DATA_DIR, "knowledge-base.json");

const DOCUMENTS_DIR = path.join(DATA_DIR, "knowledge-base");

// ── Types ────────────────────────────────────────────────────────────────────
export interface KnowledgeDocument {
  id: string;
  name: string;           // Original filename (without .md extension)
  description: string;  // Optional description of the document
  createdAt: string;     // ISO timestamp
  updatedAt: string;     // ISO timestamp
  size: number;         // File size in bytes
}

export interface KnowledgeBaseMetadata {
  documents: KnowledgeDocument[];
}

// ── In-memory cache ───────────────────────────────────────────────────────────
let _cache: KnowledgeBaseMetadata | null | undefined = undefined;

// ── File operations ──────────────────────────────────────────────────────────
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
    // File doesn't exist or decryption failed — return null
    return null;
  }
}

function writeMetadataToDisk(metadata: KnowledgeBaseMetadata): void {
  try {
    ensureDirectories();
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

// ── Public API ────────────────────────────────────────────────────────────────

/** Get all documents from the knowledge base */
export function getKnowledgeDocuments(): KnowledgeDocument[] {
  if (_cache === undefined) {
    const data = readMetadataFromDisk();
    _cache = data ?? { documents: [] };
  }
  return _cache.documents;
}

/** Get a single document by ID */
export function getKnowledgeDocument(id: string): KnowledgeDocument | null {
  const docs = getKnowledgeDocuments();
  return docs.find((d) => d.id === id) ?? null;
}

/** Get document content by ID */
export function getKnowledgeDocumentContent(id: string): string | null {
  const doc = getKnowledgeDocument(id);
  if (!doc) return null;

  const filePath = path.join(DOCUMENTS_DIR, `${doc.id}.md`);
  try {
    return fs.readFileSync(filePath, "utf-8");
  } catch {
    return null;
  }
}

/** Add a new document to the knowledge base */
export function addKnowledgeDocument(
  name: string,
  description: string,
  content: string
): KnowledgeDocument {
  ensureDirectories();

  const id = generateId();
  const now = new Date().toISOString();
  const filePath = path.join(DOCUMENTS_DIR, `${id}.md`);

  // Write the document content
  fs.writeFileSync(filePath, content, "utf-8");

  // Create metadata entry
  const doc: KnowledgeDocument = {
    id,
    name: name.replace(/\.md$/i, ""), // Remove .md extension if present
    description,
    createdAt: now,
    updatedAt: now,
    size: Buffer.byteLength(content, "utf-8"),
  };

  // Update metadata
  const metadata = readMetadataFromDisk() ?? { documents: [] };
  metadata.documents.push(doc);
  writeMetadataToDisk(metadata);

  // Update cache
  _cache = metadata;

  return doc;
}

/** Delete a document from the knowledge base */
export function deleteKnowledgeDocument(id: string): boolean {
  const metadata = readMetadataFromDisk();
  if (!metadata) return false;

  const docIndex = metadata.documents.findIndex((d) => d.id === id);
  if (docIndex === -1) return false;

  const doc = metadata.documents[docIndex];

  // Delete the file
  const filePath = path.join(DOCUMENTS_DIR, `${doc.id}.md`);
  try {
    fs.unlinkSync(filePath);
  } catch (e) {
    console.warn(`[knowledge-base] Could not delete file ${filePath}:`, e);
  }

  // Update metadata
  metadata.documents.splice(docIndex, 1);
  writeMetadataToDisk(metadata);

  // Update cache
  _cache = metadata;

  return true;
}

/** Get all document contents concatenated (for LLM context injection) */
export function getAllKnowledgeDocumentContents(): string {
  const docs = getKnowledgeDocuments();
  if (docs.length === 0) return "";

  const contents: string[] = [];
  for (const doc of docs) {
    const content = getKnowledgeDocumentContent(doc.id);
    if (content) {
      contents.push(`--- Document: ${doc.name} ---\n${content}`);
    }
  }

  return contents.join("\n\n");
}
