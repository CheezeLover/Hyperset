"use client";

import React, { useState, useEffect, useCallback } from "react";

const spinKeyframes = `
  @keyframes spin { from { transform: rotate(0deg); } to { transform: rotate(360deg); } }
`;

interface AdminModalProps {
  onClose: () => void;
}

interface LlmSettings {
  apiUrl: string;
  apiKey: string;
  model: string;
  systemPrompt: string;
  modelParams: string;
  isCustom: boolean;
  maxTurns: number;
  maxToolResultChars: number;
  maxHistoryMessages: number;
  cleanupDelayMinutes: number;
}

interface AdminSettingsResponse extends LlmSettings {
  effectiveSystemPrompt?: string;
}

interface KnowledgeDocument {
  id: string;
  name: string;
  description: string;
  createdAt: string;
  updatedAt: string;
  size: number;
}

interface TestResult {
  ok: boolean;
  error?: string;
  model?: string;
}

interface PageInfo {
  name: string;
  hasBackend: boolean;
  active: boolean;
  allowedGroups: string[];
  icon?: string;
  iconColor?: string;
}

type Tab = "llm" | "knowledge" | "additional";

function formatBytes(bytes: number): string {
  if (bytes === 0) return "0 B";
  const k = 1024;
  const sizes = ["B", "KB", "MB", "GB"];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return parseFloat((bytes / Math.pow(k, i)).toFixed(1)) + " " + sizes[i];
}

function formatDate(isoString: string): string {
  const date = new Date(isoString);
  return date.toLocaleDateString() + " " + date.toLocaleTimeString();
}

function TestResultBanner({ result }: { result: TestResult }) {
  const [copied, setCopied] = useState(false);
  const handleCopy = () => {
    const text = result.error ?? (result.model ? `OK — model: ${result.model}` : "OK");
    navigator.clipboard.writeText(text).then(() => { setCopied(true); setTimeout(() => setCopied(false), 1500); });
  };

  return (
    <div style={{
      display: "flex", alignItems: "flex-start", gap: 8, padding: "8px 10px", borderRadius: 8,
      background: result.ok ? "rgba(76,175,80,0.12)" : "rgba(211,47,47,0.12)",
      border: `1px solid ${result.ok ? "rgba(76,175,80,0.3)" : "rgba(211,47,47,0.3)"}`,
      fontSize: 12,
    }}>
      <span style={{ color: result.ok ? "#4caf50" : "#ef5350", fontWeight: 700, flexShrink: 0 }}>
        {result.ok ? "✓" : "✗"}
      </span>
      <span style={{ flex: 1, wordBreak: "break-word", color: "var(--md-on-surface)", opacity: 0.85 }}>
        {result.ok ? `Connected — model: ${result.model ?? "ok"}` : result.error ?? "Unknown error"}
      </span>
      <button onClick={handleCopy} title="Copy to clipboard"
        style={{ border: "none", background: "none", cursor: "pointer", padding: "0 2px",
          color: "var(--md-on-surface)", opacity: 0.5, flexShrink: 0, fontSize: 13 }}>
        {copied ? "✓" : "⎘"}
      </button>
    </div>
  );
}

// ── Knowledge Base Tab Component ───────────────────────────────────────────
function KnowledgeBaseTab() {
  const [documents, setDocuments] = useState<KnowledgeDocument[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [uploading, setUploading] = useState(false);
  const [deletingId, setDeletingId] = useState<string | null>(null);
  const [selectedFiles, setSelectedFiles] = useState<File[]>([]);
  const [description, setDescription] = useState("");
  const [textContent, setTextContent] = useState("");
  const [textName, setTextName] = useState("");
  const [uploadMode, setUploadMode] = useState<"file" | "text">("file");
  const [routingGuide, setRoutingGuide] = useState("");
  const [routingGuideSaving, setRoutingGuideSaving] = useState(false);
  const [routingGuideSaved, setRoutingGuideSaved] = useState(false);

  const loadDocuments = useCallback(async () => {
    try {
      const res = await fetch("/api/knowledge-base");
      if (!res.ok) throw new Error("Failed to load documents");
      const data = await res.json();
      setDocuments(data.documents || []);
      setRoutingGuide(data.routingGuide || "");
      setError("");
    } catch (e) {
      setError("Failed to load documents");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    loadDocuments();
  }, [loadDocuments]);

  const handleFileUpload = async () => {
    if (selectedFiles.length === 0) return;

    setUploading(true);
    setError("");

    try {
      for (const file of selectedFiles) {
        const formData = new FormData();
        formData.append("file", file);
        formData.append("description", description);

        const res = await fetch("/api/knowledge-base", {
          method: "POST",
          body: formData,
        });

        if (!res.ok) {
          const data = await res.json();
          throw new Error(data.error || `Upload failed for ${file.name}`);
        }
      }

      setSelectedFiles([]);
      setDescription("");
      await loadDocuments();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Upload failed");
    } finally {
      setUploading(false);
    }
  };

  const handleTextUpload = async () => {
    if (!textName.trim() || !textContent.trim()) return;

    setUploading(true);
    setError("");

    try {
      const res = await fetch("/api/knowledge-base", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: textName,
          description,
          content: textContent,
        }),
      });

      if (!res.ok) {
        const data = await res.json();
        throw new Error(data.error || "Upload failed");
      }

      setTextName("");
      setTextContent("");
      setDescription("");
      await loadDocuments();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Upload failed");
    } finally {
      setUploading(false);
    }
  };

  const handleDelete = async (id: string) => {
    if (!confirm("Are you sure you want to delete this document?")) return;

    setDeletingId(id);
    setError("");

    try {
      const res = await fetch(`/api/knowledge-base/${id}`, { method: "DELETE" });
      if (!res.ok) throw new Error("Delete failed");
      await loadDocuments();
    } catch (e) {
      setError("Failed to delete document");
    } finally {
      setDeletingId(null);
    }
  };

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 20 }}>
      {/* Upload Section */}
      <section style={{
        background: "var(--md-surface)", borderRadius: 16, padding: 20,
        border: "1px solid var(--md-outline-var)",
      }}>
        <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 16 }}>
          <div style={{ width: 8, height: 8, borderRadius: "50%", background: "var(--md-primary)" }} />
          <h3 style={{ fontSize: 14, fontWeight: 600, color: "var(--md-on-surface)", margin: 0 }}>Upload Document</h3>
        </div>

        <div style={{ display: "flex", gap: 6, marginBottom: 16 }}>
          <button
            onClick={() => setUploadMode("file")}
            style={{
              flex: 1, padding: "10px 16px", borderRadius: 10, fontSize: 12, fontWeight: 600,
              cursor: "pointer", border: "none", transition: "all 0.2s ease",
              background: uploadMode === "file" ? "var(--md-primary)" : "var(--md-surface-cont)",
              color: uploadMode === "file" ? "white" : "var(--md-on-surface)",
              opacity: uploadMode === "file" ? 1 : 0.6,
            }}
          >
            📄 File Upload
          </button>
          <button
            onClick={() => setUploadMode("text")}
            style={{
              flex: 1, padding: "10px 16px", borderRadius: 10, fontSize: 12, fontWeight: 600,
              cursor: "pointer", border: "none", transition: "all 0.2s ease",
              background: uploadMode === "text" ? "var(--md-primary)" : "var(--md-surface-cont)",
              color: uploadMode === "text" ? "white" : "var(--md-on-surface)",
              opacity: uploadMode === "text" ? 1 : 0.6,
            }}
          >
            ✏️ Text Input
          </button>
        </div>

        {uploadMode === "file" ? (
          <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
            <label style={{ display: "flex", flexDirection: "column", gap: 6 }}>
              <span style={labelStyle}>Select .md files (multiple allowed)</span>
              <input
                type="file"
                accept=".md"
                multiple
                onChange={(e) => setSelectedFiles(Array.from(e.target.files || []))}
                style={{ ...inputStyle, padding: "8px 10px" }}
                disabled={uploading}
              />
            </label>
            {selectedFiles.length > 0 && (
              <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
                {selectedFiles.map((file, idx) => (
                  <p key={idx} style={{ fontSize: 12, opacity: 0.7, margin: 0, display: "flex", alignItems: "center", gap: 8 }}>
                    <span style={{ color: "var(--md-primary)" }}>📄</span>
                    {file.name} ({formatBytes(file.size)})
                    <button
                      onClick={() => setSelectedFiles(selectedFiles.filter((_, i) => i !== idx))}
                      style={{ border: "none", background: "none", cursor: "pointer", color: "var(--md-on-surface)", opacity: 0.5, padding: "0 4px" }}
                    >
                      ×
                    </button>
                  </p>
                ))}
              </div>
            )}
            <label style={{ display: "flex", flexDirection: "column", gap: 6 }}>
              <span style={labelStyle}>Description (optional, applied to all files)</span>
              <input
                type="text"
                value={description}
                onChange={(e) => setDescription(e.target.value)}
                placeholder="Brief description of these documents..."
                style={inputStyle}
                disabled={uploading}
              />
            </label>
            <button
              onClick={handleFileUpload}
              disabled={selectedFiles.length === 0 || uploading}
              style={{ ...primaryBtnStyle, alignSelf: "flex-start", opacity: (selectedFiles.length === 0 || uploading) ? 0.5 : 1 }}
            >
              {uploading ? "Uploading..." : `Upload ${selectedFiles.length > 0 ? `${selectedFiles.length} ` : ""}Document${selectedFiles.length !== 1 ? "s" : ""}`}
            </button>
          </div>
        ) : (
          <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
            <label style={{ display: "flex", flexDirection: "column", gap: 6 }}>
              <span style={labelStyle}>Document Name</span>
              <input
                type="text"
                value={textName}
                onChange={(e) => setTextName(e.target.value)}
                placeholder="e.g., Company Procedures"
                style={inputStyle}
                disabled={uploading}
              />
            </label>
            <label style={{ display: "flex", flexDirection: "column", gap: 6 }}>
              <span style={labelStyle}>Description (optional)</span>
              <input
                type="text"
                value={description}
                onChange={(e) => setDescription(e.target.value)}
                placeholder="Brief description of this document..."
                style={inputStyle}
                disabled={uploading}
              />
            </label>
            <label style={{ display: "flex", flexDirection: "column", gap: 6 }}>
              <span style={labelStyle}>Content (Markdown)</span>
              <textarea
                value={textContent}
                onChange={(e) => setTextContent(e.target.value)}
                placeholder="Enter markdown content here..."
                rows={6}
                style={{ ...inputStyle, resize: "vertical", fontFamily: "monospace", fontSize: 12, lineHeight: 1.5 }}
                disabled={uploading}
              />
            </label>
            <button
              onClick={handleTextUpload}
              disabled={!textName.trim() || !textContent.trim() || uploading}
              style={{ ...primaryBtnStyle, alignSelf: "flex-start", opacity: (!textName.trim() || !textContent.trim() || uploading) ? 0.5 : 1 }}
            >
              {uploading ? "Uploading..." : "Upload Document"}
            </button>
          </div>
        )}
      </section>

      {/* Documents List */}
      <section style={{
        background: "var(--md-surface)", borderRadius: 16, padding: 20,
        border: "1px solid var(--md-outline-var)",
      }}>
        <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 16 }}>
          <div style={{ width: 8, height: 8, borderRadius: "50%", background: "#4caf50" }} />
          <h3 style={{ fontSize: 14, fontWeight: 600, color: "var(--md-on-surface)", margin: 0 }}>Knowledge Base Documents ({documents.length})</h3>
        </div>

        {loading ? (
          <p style={{ opacity: 0.6, fontSize: 13 }}>Loading documents...</p>
        ) : documents.length === 0 ? (
          <p style={{ opacity: 0.6, fontSize: 13, fontStyle: "italic" }}>
            No documents in knowledge base. Upload .md files to enrich LLM responses with company-specific information.
          </p>
        ) : (
          <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
            {documents.map((doc) => (
              <div
                key={doc.id}
                style={{
                  display: "flex",
                  alignItems: "flex-start",
                  gap: 12,
                  padding: 14,
                  background: "var(--md-surface-cont)",
                  borderRadius: 12,
                  border: "1px solid var(--md-outline-var)",
                }}
              >
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 4 }}>
                    <span style={{ fontWeight: 600, fontSize: 13, color: "var(--md-on-surface)" }}>
                      {doc.name}
                    </span>
                    <span style={{ fontSize: 10, opacity: 0.5, background: "var(--md-surface-cont-hi)", padding: "2px 6px", borderRadius: 4 }}>
                      {formatBytes(doc.size)}
                    </span>
                  </div>
                  {doc.description && (
                    <p style={{ fontSize: 11, opacity: 0.7, margin: "0 0 4px", lineHeight: 1.4 }}>
                      {doc.description}
                    </p>
                  )}
                  <p style={{ fontSize: 11, opacity: 0.5, margin: 0 }}>
                    Created: {formatDate(doc.createdAt)}
                  </p>
                </div>
                <button
                  onClick={() => handleDelete(doc.id)}
                  disabled={deletingId === doc.id}
                  style={{
                    ...dangerBtnStyle,
                    opacity: deletingId === doc.id ? 0.5 : 1,
                    flexShrink: 0,
                  }}
                  title="Delete document"
                >
                  {deletingId === doc.id ? "..." : "🗑️ Delete"}
                </button>
              </div>
            ))}
          </div>
        )}
      </section>

      {/* Routing Guide Editor */}
      <section style={{
        background: "var(--md-surface)", borderRadius: 16, padding: 20,
        border: "1px solid var(--md-outline-var)",
      }}>
        <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 16 }}>
          <div style={{ width: 8, height: 8, borderRadius: "50%", background: "#9c27b0" }} />
          <h3 style={{ fontSize: 14, fontWeight: 600, color: "var(--md-on-surface)", margin: 0 }}>Routing Guide</h3>
          <span style={{ fontSize: 11, opacity: 0.5, marginLeft: "auto" }}>
            {routingGuide.length} chars
          </span>
        </div>
        <p style={{ fontSize: 12, opacity: 0.6, margin: "0 0 12px", lineHeight: 1.5 }}>
          Explain to the AI which document to use for different topics. Be specific about routing decisions.
        </p>
        <textarea
          value={routingGuide}
          onChange={(e) => setRoutingGuide(e.target.value)}
          placeholder={`Example routing guide:

- For financial metrics and KPIs → Use "airline-metrics.md"
- For safety procedures and regulations → Use "regulatory-compliance.md"  
- For company procedures and operations → Use "company-overview.md"
- For terminology and definitions → Use "airline-terminology.md"

When user asks about "revenue", "costs", "profits" → Check airline-metrics.md first
When user asks about "delays", "on-time performance" → Check company-overview.md first
When user mentions abbreviations like "OTP", "RASM", "CASM" → Check airline-terminology.md`}
          rows={10}
          style={{ ...inputStyle, resize: "vertical", fontFamily: "monospace", fontSize: 12, lineHeight: 1.5, marginBottom: 12 }}
        />
        <button
          onClick={async () => {
            setRoutingGuideSaving(true);
            setError("");
            try {
              const res = await fetch("/api/knowledge-base", {
                method: "PUT",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ routingGuide }),
              });
              if (!res.ok) throw new Error("Failed to save routing guide");
              setRoutingGuideSaved(true);
              setTimeout(() => setRoutingGuideSaved(false), 2000);
            } catch (e) {
              setError("Failed to save routing guide");
            } finally {
              setRoutingGuideSaving(false);
            }
          }}
          disabled={routingGuideSaving}
          style={{ 
            ...primaryBtnStyle, alignSelf: "flex-start", 
            padding: "12px 24px",
            boxShadow: routingGuideSaved ? "none" : "0 4px 12px rgba(211, 84, 0, 0.3)",
            ...(routingGuideSaved ? { background: "#4caf50", boxShadow: "0 4px 12px rgba(76, 175, 80, 0.3)" } : {}),
          }}
        >
          {routingGuideSaved ? "✓ Saved" : routingGuideSaving ? "Saving..." : "Save Routing Guide"}
        </button>
      </section>

      {error && (
        <div style={{ padding: "12px 16px", borderRadius: 12, background: "rgba(211,47,47,0.1)", border: "1px solid rgba(211,47,47,0.25)" }}>
          <span style={{ color: "#ef5350", fontSize: 13 }}>{error}</span>
        </div>
      )}
    </div>
  );
}

// ── Pages Tab Component ───────────────────────────────────────────────────────
function PagesTab() {
  const [pages, setPages] = useState<PageInfo[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [uploading, setUploading] = useState(false);
  const [showUpload, setShowUpload] = useState(false);
  const [newPageName, setNewPageName] = useState("");
  const [htmlFile, setHtmlFile] = useState<File | null>(null);
  const [backendFile, setBackendFile] = useState<File | null>(null);
  const [editingPage, setEditingPage] = useState<string | null>(null);
  const [editGroups, setEditGroups] = useState("");
  const [deletingPage, setDeletingPage] = useState<string | null>(null);
  const [showTemplates, setShowTemplates] = useState(false);
  const [editModalPage, setEditModalPage] = useState<PageInfo | null>(null);
  const [editHtmlFile, setEditHtmlFile] = useState<File | null>(null);
  const [editBackendFile, setEditBackendFile] = useState<File | null>(null);
  const [removeBackend, setRemoveBackend] = useState(false);
  const [editIcon, setEditIcon] = useState("");
  const [editIconColor, setEditIconColor] = useState("");
  const [updatingPage, setUpdatingPage] = useState(false);

  const loadPages = useCallback(async () => {
    try {
      const res = await fetch("/api/admin/pages");
      const data = await res.json() as { pages: PageInfo[] };
      setPages(data.pages);
    } catch {
      setError("Failed to load pages");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    loadPages();
  }, [loadPages]);

  const handleUpload = async () => {
    if (!newPageName.trim() || !htmlFile) {
      setError("Page name and HTML file are required");
      return;
    }
    setUploading(true);
    setError("");
    try {
      const formData = new FormData();
      formData.append("name", newPageName.trim());
      formData.append("html", htmlFile);
      if (backendFile) formData.append("backend", backendFile);
      
      const res = await fetch("/api/admin/pages", {
        method: "POST",
        body: formData,
      });
      if (!res.ok) {
        const data = await res.json() as { error?: string };
        throw new Error(data.error ?? "Upload failed");
      }
      setShowUpload(false);
      setNewPageName("");
      setHtmlFile(null);
      setBackendFile(null);
      loadPages();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Upload failed");
    } finally {
      setUploading(false);
    }
  };

  const handleToggleActive = async (name: string, active: boolean) => {
    try {
      await fetch("/api/admin/pages", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name, active }),
      });
      setPages((prev) => prev.map((p) => p.name === name ? { ...p, active } : p));
    } catch {
      setError("Failed to update page");
    }
  };

  const handleSaveGroups = async (name: string) => {
    const groups = editGroups.split(",").map((g) => g.trim()).filter(Boolean);
    try {
      await fetch("/api/admin/pages", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name, allowedGroups: groups }),
      });
      setPages((prev) => prev.map((p) => p.name === name ? { ...p, allowedGroups: groups } : p));
      setEditingPage(null);
    } catch {
      setError("Failed to update groups");
    }
  };

  const handleDelete = async (name: string) => {
    try {
      await fetch("/api/admin/pages", {
        method: "DELETE",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name }),
      });
      setPages((prev) => prev.filter((p) => p.name !== name));
      setDeletingPage(null);
    } catch {
      setError("Failed to delete page");
    }
  };

  const openEditModal = (page: PageInfo) => {
    setEditModalPage(page);
    setEditIcon(page.icon || "");
    setEditIconColor(page.iconColor || "");
    setEditHtmlFile(null);
    setEditBackendFile(null);
    setRemoveBackend(false);
  };

  const handleUpdateFiles = async () => {
    if (!editModalPage) return;
    setUpdatingPage(true);
    try {
      const formData = new FormData();
      formData.append("name", editModalPage.name);
      if (editHtmlFile) formData.append("html", editHtmlFile);
      if (editBackendFile) formData.append("backend", editBackendFile);
      if (removeBackend) formData.append("removeBackend", "true");
      
      const res = await fetch("/api/admin/pages", {
        method: "PUT",
        body: formData,
      });
      if (!res.ok) {
        const data = await res.json() as { error?: string };
        throw new Error(data.error ?? "Update failed");
      }
      
      const icon = editIcon.trim() || undefined;
      const iconColor = editIconColor.trim() || undefined;
      await fetch("/api/admin/pages", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ 
          name: editModalPage.name, 
          icon, 
          iconColor,
        }),
      });
      
      setPages((prev) => prev.map((p) => 
        p.name === editModalPage.name 
          ? { ...p, icon, iconColor, hasBackend: !removeBackend && (!!editBackendFile || p.hasBackend) } 
          : p
      ));
      setEditModalPage(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Update failed");
    } finally {
      setUpdatingPage(false);
    }
  };

  if (loading) {
    return (
      <div style={{ display: "flex", alignItems: "center", justifyContent: "center", padding: 40 }}>
        <div style={{ width: 24, height: 24, border: "3px solid var(--md-outline)", borderTopColor: "var(--md-primary)", borderRadius: "50%", animation: "spin 0.8s linear infinite" }} />
      </div>
    );
  }

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
      <style>{spinKeyframes}</style>
      
      {error && (
        <div style={{ padding: "10px 14px", borderRadius: 8, background: "rgba(211,47,47,0.1)", border: "1px solid rgba(211,47,47,0.3)", color: "#ef5350", fontSize: 13 }}>
          {error}
        </div>
      )}

      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
        <h3 style={{ fontSize: 14, fontWeight: 600, color: "var(--md-on-surface)", margin: 0 }}>
          Available Pages ({pages.length})
        </h3>
        <div style={{ display: "flex", gap: 6 }}>
          <div style={{ position: "relative" }}>
            <button onClick={() => setShowTemplates(!showTemplates)}
              style={{
                background: "var(--md-surface-cont)", color: "var(--md-on-surface)",
                border: "1px solid var(--md-outline)", borderRadius: 8,
                padding: "8px 14px", fontSize: 12, fontWeight: 500, cursor: "pointer",
              }}>
              📄 Templates ▾
            </button>
            {showTemplates && (
              <div style={{
                position: "absolute", top: "100%", left: 0, marginTop: 4,
                background: "var(--md-surface)", border: "1px solid var(--md-outline-var)",
                borderRadius: 8, padding: 8, zIndex: 10, minWidth: 180,
                boxShadow: "0 4px 12px rgba(0,0,0,0.15)",
              }}>
                <button onClick={() => { window.open("/page-templates/blank.html", "_blank"); setShowTemplates(false); }}
                  style={{ display: "block", width: "100%", textAlign: "left", background: "none", border: "none", padding: "8px 10px", borderRadius: 6, cursor: "pointer", color: "var(--md-on-surface)", fontSize: 12 }}>
                  📄 blank.html
                </button>
                <button onClick={() => { window.open("/page-templates/backend.py", "_blank"); setShowTemplates(false); }}
                  style={{ display: "block", width: "100%", textAlign: "left", background: "none", border: "none", padding: "8px 10px", borderRadius: 6, cursor: "pointer", color: "var(--md-on-surface)", fontSize: 12 }}>
                  🐍 backend.py
                </button>
                <button onClick={() => { window.open("/page-templates/preprompt.md", "_blank"); setShowTemplates(false); }}
                  style={{ display: "block", width: "100%", textAlign: "left", background: "none", border: "none", padding: "8px 10px", borderRadius: 6, cursor: "pointer", color: "var(--md-on-surface)", fontSize: 12 }}>
                  📖 preprompt.md
                </button>
              </div>
            )}
          </div>
          <button onClick={() => setShowUpload(!showUpload)}
            style={{
              background: "var(--md-primary)", color: "white", border: "none", borderRadius: 8,
              padding: "8px 16px", fontSize: 12, fontWeight: 600, cursor: "pointer",
            }}>
            + Add Page
          </button>
        </div>
      </div>

      {showUpload && (
        <div style={{ background: "var(--md-surface)", borderRadius: 12, padding: 16, border: "1px solid var(--md-outline-var)" }}>
          <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
            <div>
              <label style={{ display: "block", fontSize: 12, fontWeight: 500, opacity: 0.7, color: "var(--md-on-surface)", marginBottom: 4 }}>
                Page Name
              </label>
              <input
                type="text"
                value={newPageName}
                onChange={(e) => setNewPageName(e.target.value)}
                placeholder="e.g., docs, help, dashboard"
                style={{ ...inputStyle, width: "100%" }}
              />
              <p style={{ fontSize: 11, opacity: 0.5, color: "var(--md-on-surface)", margin: "4px 0 0" }}>
                Only letters, numbers, underscores and hyphens
              </p>
            </div>
            <div>
              <label style={{ display: "block", fontSize: 12, fontWeight: 500, opacity: 0.7, color: "var(--md-on-surface)", marginBottom: 4 }}>
                HTML File *
              </label>
              <input
                type="file"
                accept=".html"
                onChange={(e) => setHtmlFile(e.target.files?.[0] ?? null)}
                style={{ fontSize: 12, color: "var(--md-on-surface)" }}
              />
            </div>
            <div>
              <label style={{ display: "block", fontSize: 12, fontWeight: 500, opacity: 0.7, color: "var(--md-on-surface)", marginBottom: 4 }}>
                Backend (optional Python)
              </label>
              <input
                type="file"
                accept=".py"
                onChange={(e) => setBackendFile(e.target.files?.[0] ?? null)}
                style={{ fontSize: 12, color: "var(--md-on-surface)" }}
              />
            </div>
            <div style={{ display: "flex", gap: 8, marginTop: 4 }}>
              <button onClick={handleUpload} disabled={uploading}
                style={{
                  ...primaryBtnStyle,
                  opacity: uploading ? 0.6 : 1,
                  padding: "8px 20px",
                }}>
                {uploading ? "Uploading..." : "Upload"}
              </button>
              <button onClick={() => { setShowUpload(false); setError(""); }}
                style={{
                  background: "var(--md-surface-cont)", color: "var(--md-on-surface)",
                  border: "1px solid var(--md-outline)", borderRadius: 8,
                  padding: "8px 16px", fontSize: 12, cursor: "pointer",
                }}>
                Cancel
              </button>
            </div>
          </div>
        </div>
      )}

      {pages.length === 0 ? (
        <div style={{ textAlign: "center", padding: 40, color: "var(--md-on-surface)", opacity: 0.5 }}>
          No pages available. Upload a page to get started.
        </div>
      ) : (
        <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
          {pages.map((page) => (
            <div key={page.name}
              style={{
                background: "var(--md-surface)", borderRadius: 10, padding: 14,
                border: "1px solid var(--md-outline-var)", display: "flex", alignItems: "center", gap: 12,
              }}>
              <div style={{
                width: 36, height: 36, borderRadius: 8, 
                background: page.iconColor || (page.active ? "var(--md-primary)" : "var(--md-surface-cont)"),
                display: "flex", alignItems: "center", justifyContent: "center", 
                color: page.active ? "white" : "var(--md-on-surface)",
                opacity: page.active ? 1 : 0.4, fontSize: 14, fontWeight: 600,
              }}>
                {page.icon || page.name.charAt(0).toUpperCase()}
              </div>
              <div style={{ flex: 1 }}>
                <div style={{ fontSize: 13, fontWeight: 600, color: "var(--md-on-surface)", opacity: page.active ? 1 : 0.5 }}>
                  {page.name}
                </div>
                <div style={{ fontSize: 11, color: "var(--md-on-surface)", opacity: 0.5 }}>
                  {page.hasBackend ? "✓ Has backend" : "HTML only"}
                  {page.allowedGroups.length > 0 ? ` • Groups: ${page.allowedGroups.join(", ")}` : " • All users"}
                </div>
              </div>
              {editingPage === page.name ? (
                <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                  <input
                    type="text"
                    value={editGroups}
                    onChange={(e) => setEditGroups(e.target.value)}
                    placeholder="group1, group2"
                    style={{ ...inputStyle, width: 160, padding: "6px 10px", fontSize: 12 }}
                  />
                  <button onClick={() => handleSaveGroups(page.name)}
                    style={{ ...primaryBtnStyle, padding: "6px 12px", fontSize: 11 }}>
                    Save
                  </button>
                  <button onClick={() => setEditingPage(null)}
                    style={{ ...ghostBtnStyle }}>
                    ×
                  </button>
                </div>
              ) : (
                <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
                  <label style={{ display: "flex", alignItems: "center", gap: 4, cursor: "pointer" }}>
                    <input
                      type="checkbox"
                      checked={page.active}
                      onChange={(e) => handleToggleActive(page.name, e.target.checked)}
                      style={{ width: 16, height: 16, cursor: "pointer" }}
                    />
                    <span style={{ fontSize: 11, color: "var(--md-on-surface)", opacity: 0.7 }}>Active</span>
                  </label>
                  <button onClick={() => { setEditingPage(page.name); setEditGroups(page.allowedGroups.join(", ")); }}
                    style={{ ...ghostBtnStyle, opacity: 0.6 }}>
                    Groups
                  </button>
                  <button onClick={() => openEditModal(page)}
                    style={{ ...testBtnStyle, padding: "4px 10px", fontSize: 11 }}>
                    Edit
                  </button>
                  {deletingPage === page.name ? (
                    <div style={{ display: "flex", alignItems: "center", gap: 4 }}>
                      <span style={{ fontSize: 11, color: "#ef5350" }}>Delete?</span>
                      <button onClick={() => handleDelete(page.name)}
                        style={{ ...dangerBtnStyle, padding: "4px 8px" }}>
                        Yes
                      </button>
                      <button onClick={() => setDeletingPage(null)}
                        style={{ ...ghostBtnStyle, padding: "4px 8px" }}>
                        No
                      </button>
                    </div>
                  ) : (
                    <button onClick={() => setDeletingPage(page.name)}
                      style={{ ...dangerBtnStyle }}>
                      Remove
                    </button>
                  )}
                </div>
              )}
            </div>
          ))}
        </div>
      )}

      {editModalPage && (
        <div style={{
          position: "fixed", inset: 0, background: "rgba(0,0,0,0.6)", zIndex: 1001,
          display: "flex", alignItems: "center", justifyContent: "center",
        }} onClick={(e) => { if (e.target === e.currentTarget) setEditModalPage(null); }}>
          <div style={{
            background: "var(--md-surface-cont)", borderRadius: 16, padding: 24,
            minWidth: 400, maxWidth: 500, width: "90%",
            boxShadow: "0 24px 48px rgba(0,0,0,0.3)",
          }}>
            <h3 style={{ fontSize: 16, fontWeight: 600, color: "var(--md-on-surface)", margin: "0 0 20px" }}>
              Edit Page: {editModalPage.name}
            </h3>
            
            <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
              <div style={{ display: "flex", gap: 12, alignItems: "center" }}>
                <div style={{ flex: 1 }}>
                  <label style={{ display: "block", fontSize: 11, fontWeight: 500, opacity: 0.7, color: "var(--md-on-surface)", marginBottom: 4 }}>
                    Icon (single character or emoji)
                  </label>
                  <input
                    type="text"
                    value={editIcon}
                    onChange={(e) => setEditIcon(e.target.value.slice(0, 2))}
                    placeholder={editModalPage.name.charAt(0).toUpperCase()}
                    style={{ ...inputStyle, width: "100%", padding: "8px 12px" }}
                  />
                </div>
                <div style={{ flex: 1 }}>
                  <label style={{ display: "block", fontSize: 11, fontWeight: 500, opacity: 0.7, color: "var(--md-on-surface)", marginBottom: 4 }}>
                    Icon Color (CSS)
                  </label>
                  <input
                    type="text"
                    value={editIconColor}
                    onChange={(e) => setEditIconColor(e.target.value)}
                    placeholder="#1a73e8"
                    style={{ ...inputStyle, width: "100%", padding: "8px 12px" }}
                  />
                </div>
              </div>

              <div>
                <label style={{ display: "block", fontSize: 11, fontWeight: 500, opacity: 0.7, color: "var(--md-on-surface)", marginBottom: 4 }}>
                  New HTML File (leave empty to keep existing)
                </label>
                <input
                  type="file"
                  accept=".html"
                  onChange={(e) => setEditHtmlFile(e.target.files?.[0] ?? null)}
                  style={{ fontSize: 12, color: "var(--md-on-surface)" }}
                />
              </div>

              <div>
                <label style={{ display: "block", fontSize: 11, fontWeight: 500, opacity: 0.7, color: "var(--md-on-surface)", marginBottom: 4 }}>
                  New Backend File (leave empty to keep existing)
                </label>
                <input
                  type="file"
                  accept=".py"
                  onChange={(e) => setEditBackendFile(e.target.files?.[0] ?? null)}
                  style={{ fontSize: 12, color: "var(--md-on-surface)" }}
                />
                {editModalPage.hasBackend && (
                  <label style={{ display: "flex", alignItems: "center", gap: 6, marginTop: 8, cursor: "pointer" }}>
                    <input
                      type="checkbox"
                      checked={removeBackend}
                      onChange={(e) => setRemoveBackend(e.target.checked)}
                    />
                    <span style={{ fontSize: 11, color: "#ef5350" }}>Remove existing backend</span>
                  </label>
                )}
              </div>
            </div>

            <div style={{ display: "flex", justifyContent: "flex-end", gap: 10, marginTop: 20 }}>
              <button onClick={() => setEditModalPage(null)}
                style={{
                  background: "var(--md-surface-cont)", color: "var(--md-on-surface)",
                  border: "1px solid var(--md-outline)", borderRadius: 8,
                  padding: "10px 20px", fontSize: 13, cursor: "pointer",
                }}>
                Cancel
              </button>
              <button onClick={handleUpdateFiles} disabled={updatingPage}
                style={{
                  ...primaryBtnStyle,
                  opacity: updatingPage ? 0.6 : 1,
                  padding: "10px 24px",
                }}>
                {updatingPage ? "Updating..." : "Save Changes"}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

// ── Main Admin Modal Component ───────────────────────────────────────────────
export function AdminModal({ onClose }: AdminModalProps) {
  const [activeTab, setActiveTab] = useState<Tab>("llm");
  const [settings, setSettings] = useState<LlmSettings>({
    apiUrl: "", apiKey: "", model: "", systemPrompt: "", modelParams: "", isCustom: false,
    maxTurns: 40, maxToolResultChars: 3000, maxHistoryMessages: 20,
    cleanupDelayMinutes: 120,
  });
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [saveError, setSaveError] = useState("");
  const [testing, setTesting] = useState(false);
  const [testResult, setTestResult] = useState<TestResult | null>(null);
  const [effectiveSystemPrompt, setEffectiveSystemPrompt] = useState("");

  const effectiveSystemPromptPreview = settings.systemPrompt.trim()
    ? settings.systemPrompt
    : effectiveSystemPrompt;

  useEffect(() => {
    fetch("/api/admin")
      .then((r) => r.json())
      .then((data) => {
        const response = data as AdminSettingsResponse;
        const { effectiveSystemPrompt: currentEffectivePrompt, ...rawSettings } = response;
        setSettings({ ...rawSettings, apiKey: response.isCustom ? "***" : "" });
        setEffectiveSystemPrompt(currentEffectivePrompt ?? "");
        setLoading(false);
      })
      .catch(() => { setSaveError("Failed to load settings"); setLoading(false); });
  }, []);

  const handleTest = async () => {
    setTesting(true); setTestResult(null);
    try {
      const res = await fetch("/api/admin", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          apiUrl: settings.apiUrl,
          apiKey: settings.apiKey === "***" ? "" : settings.apiKey,
          model: settings.model,
        }),
      });
      setTestResult(await res.json());
    } catch {
      setTestResult({ ok: false, error: "Network error — could not reach server" });
    } finally { setTesting(false); }
  };

  const handleSave = async () => {
    setSaving(true); setSaveError("");
    try {
      const res = await fetch("/api/admin", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          apiUrl: settings.apiUrl,
          apiKey: settings.apiKey !== "***" ? settings.apiKey : undefined,
          model: settings.model,
          systemPrompt: settings.systemPrompt,
          modelParams: settings.modelParams,
          maxTurns: settings.maxTurns,
          maxToolResultChars: settings.maxToolResultChars,
          maxHistoryMessages: settings.maxHistoryMessages,
          cleanupDelayMinutes: settings.cleanupDelayMinutes,
        }),
      });
      if (!res.ok) throw new Error("Save failed");
      setSaved(true);
      setTimeout(() => setSaved(false), 2000);
    } catch { setSaveError("Failed to save settings"); }
    finally { setSaving(false); }
  };

  const handleReset = async () => {
    setSaving(true);
    try {
      await fetch("/api/admin", { method: "DELETE" });
      const res = await fetch("/api/admin");
      const data = await res.json() as AdminSettingsResponse;
      const { effectiveSystemPrompt: currentEffectivePrompt, ...rawSettings } = data;
      setSettings({ ...rawSettings, apiKey: "" });
      setEffectiveSystemPrompt(currentEffectivePrompt ?? "");
    } catch { setSaveError("Failed to reset"); }
    finally { setSaving(false); }
  };

  return (
    <>
      <style>{spinKeyframes}</style>
      <div
        style={{
          position: "fixed", inset: 0, background: "rgba(0,0,0,0.6)",
          zIndex: 1000, display: "flex", alignItems: "center", justifyContent: "center",
          backdropFilter: "blur(4px)",
        }}
        onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}
      >
      <div style={{
        background: "var(--md-surface-cont)", borderRadius: 20,
        padding: 0, minWidth: 380, maxWidth: 640, width: "94%",
        maxHeight: "85vh", overflow: "hidden",
        boxShadow: "0 24px 48px rgba(0,0,0,0.2), 0 0 0 1px rgba(255,255,255,0.05)",
        display: "flex", flexDirection: "column",
      }}>
        {/* Header - sticky */}
        <div style={{ 
          display: "flex", alignItems: "center", padding: "20px 24px", gap: 14, 
          borderBottom: "1px solid var(--md-outline-var)",
          background: "var(--md-surface-cont)", borderRadius: "20px 20px 0 0",
          flexShrink: 0,
        }}>
          <div style={{
            width: 36, height: 36, borderRadius: 10,
            background: "linear-gradient(135deg, var(--md-primary) 0%, var(--md-primary-muted) 100%)",
            display: "flex", alignItems: "center", justifyContent: "center",
            boxShadow: "0 2px 8px rgba(0,0,0,0.15)",
          }}>
            <svg viewBox="0 0 24 24" width={18} height={18} fill="white">
              <path d="M19.14,12.94c0.04-0.3,0.06-0.61,0.06-0.94c0-0.32-0.02-0.64-0.07-0.94l2.03-1.58c0.18-0.14,0.23-0.41,0.12-0.61l-1.92-3.32c-0.12-0.22-0.37-0.29-0.59-0.22l-2.39,0.96c-0.5-0.38-1.03-0.7-1.62-0.94L14.4,2.81c-0.04-0.24-0.24-0.41-0.48-0.41h-3.84c-0.24,0-0.43,0.17-0.47,0.41L9.25,5.35C8.66,5.59,8.12,5.92,7.63,6.29L5.24,5.33c-0.22-0.08-0.47,0-0.59,0.22L2.74,8.87C2.62,9.08,2.66,9.34,2.86,9.48l2.03,1.58C4.84,11.36,4.8,11.69,4.8,12s0.02,0.64,0.07,0.94l-2.03,1.58c-0.18,0.14-0.23,0.41-0.12,0.61l1.92,3.32c0.12,0.22,0.37,0.29,0.59,0.22l2.39-0.96c0.5,0.38,1.03,0.7,1.62,0.94l0.36,2.54c0.05,0.24,0.24,0.41,0.48,0.41h3.84c0.24,0,0.44-0.17,0.47-0.41l0.36-2.54c0.59-0.24,1.13-0.56,1.62-0.94l2.39,0.96c0.22,0.08,0.47,0,0.59-0.22l1.92-3.32c0.12-0.22,0.07-0.47-0.12-0.61L19.14,12.94z M12,15.6c-1.98,0-3.6-1.62-3.6-3.6s1.62-3.6,3.6-3.6s3.6,1.62,3.6,3.6S13.98,15.6,12,15.6z" />
            </svg>
          </div>
          <div style={{ flex: 1 }}>
            <h2 style={{ fontSize: 18, fontWeight: 600, color: "var(--md-on-surface)", margin: 0, lineHeight: 1.3 }}>Admin Settings</h2>
            <p style={{ fontSize: 12, color: "var(--md-on-surface)", opacity: 0.5, margin: "2px 0 0" }}>Configure LLM and knowledge base</p>
          </div>
          <button onClick={onClose}
            style={{ border: "none", background: "var(--md-surface)", cursor: "pointer",
              color: "var(--md-on-surface)", fontSize: 18, lineHeight: 1, padding: "6px 10px", borderRadius: 10,
              transition: "all 0.15s ease", opacity: 0.7 }}>
            ×
          </button>
        </div>

        {/* Scrollable Content */}
        <div style={{ flex: 1, overflowY: "auto", padding: "0 24px 24px" }}>
          {/* Tab Navigation */}
          <div style={{ display: "flex", gap: 4, marginBottom: 24, marginTop: 20,
            background: "var(--md-surface)", padding: 4, borderRadius: 14 }}>
          <button
            onClick={() => setActiveTab("llm")}
            style={{
              flex: 1, padding: "10px 12px", borderRadius: 10, fontSize: 12, fontWeight: 600,
              cursor: "pointer", border: "none", transition: "all 0.2s ease",
              background: activeTab === "llm" ? "var(--md-primary)" : "transparent",
              color: activeTab === "llm" ? "white" : "var(--md-on-surface)",
              opacity: activeTab === "llm" ? 1 : 0.6,
              boxShadow: activeTab === "llm" ? "0 2px 8px rgba(0,0,0,0.15)" : "none",
            }}
          >
            🤖 LLM
          </button>
          <button
            onClick={() => setActiveTab("knowledge")}
            style={{
              flex: 1, padding: "10px 12px", borderRadius: 10, fontSize: 12, fontWeight: 600,
              cursor: "pointer", border: "none", transition: "all 0.2s ease",
              background: activeTab === "knowledge" ? "var(--md-primary)" : "transparent",
              color: activeTab === "knowledge" ? "white" : "var(--md-on-surface)",
              opacity: activeTab === "knowledge" ? 1 : 0.6,
              boxShadow: activeTab === "knowledge" ? "0 2px 8px rgba(0,0,0,0.15)" : "none",
            }}
          >
            📚 Knowledge
          </button>
          <button
            onClick={() => setActiveTab("additional")}
            style={{
              flex: 1, padding: "10px 12px", borderRadius: 10, fontSize: 12, fontWeight: 600,
              cursor: "pointer", border: "none", transition: "all 0.2s ease",
              background: activeTab === "additional" ? "var(--md-primary)" : "transparent",
              color: activeTab === "additional" ? "white" : "var(--md-on-surface)",
              opacity: activeTab === "additional" ? 1 : 0.6,
              boxShadow: activeTab === "additional" ? "0 2px 8px rgba(0,0,0,0.15)" : "none",
            }}
          >
            ⚙️ Pages
          </button>
        </div>

        {loading && activeTab === "llm" ? (
          <div style={{ display: "flex", alignItems: "center", justifyContent: "center", padding: 40 }}>
            <div style={{ width: 24, height: 24, border: "3px solid var(--md-outline)", borderTopColor: "var(--md-primary)", borderRadius: "50%", animation: "spin 0.8s linear infinite" }} />
          </div>
        ) : activeTab === "llm" ? (
          <div style={{ display: "flex", flexDirection: "column", gap: 20 }}>
            {/* ── LLM connection ── */}
            <section style={{
              background: "var(--md-surface)", borderRadius: 16, padding: 20,
              border: "1px solid var(--md-outline-var)",
            }}>
              <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 16 }}>
                <div style={{ width: 8, height: 8, borderRadius: "50%", background: "var(--md-primary)" }} />
                <h3 style={{ fontSize: 14, fontWeight: 600, color: "var(--md-on-surface)", margin: 0 }}>LLM Connection</h3>
              </div>

            <label style={{ display: "flex", flexDirection: "column", gap: 6 }}>
              <span style={labelStyle}>API URL</span>
              <input type="url" value={settings.apiUrl}
                onChange={(e) => setSettings((s) => ({ ...s, apiUrl: e.target.value }))}
                placeholder="https://api.mistral.ai/v1" style={inputStyle} disabled={saving} />
            </label>

            <label style={{ display: "flex", flexDirection: "column", gap: 6 }}>
              <span style={labelStyle}>API Key{settings.isCustom ? " (overridden)" : ""}</span>
              <input type="password" value={settings.apiKey}
                onChange={(e) => setSettings((s) => ({ ...s, apiKey: e.target.value }))}
                placeholder={settings.isCustom ? "••••• (currently set)" : "Enter API key..."}
                style={inputStyle} disabled={saving} autoComplete="new-password" />
            </label>

            <label style={{ display: "flex", flexDirection: "column", gap: 6 }}>
              <span style={labelStyle}>Model</span>
              <input type="text" value={settings.model}
                onChange={(e) => setSettings((s) => ({ ...s, model: e.target.value }))}
                placeholder="ministral-3b-2512" style={inputStyle} disabled={saving} />
            </label>

            <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
              <button onClick={handleTest}
                disabled={testing || saving || !settings.apiUrl || !settings.model || (!settings.apiKey && !settings.isCustom)}
                style={testBtnStyle} title="Send a minimal test request to verify these credentials work">
                {testing ? "Testing..." : "Test Connection"}
              </button>
              {settings.isCustom && (
                <button onClick={handleReset} disabled={saving} style={ghostBtnStyle}>Reset to env</button>
              )}
            </div>

            {testResult && <TestResultBanner result={testResult} />}
            </section>

            {/* ── System prompt ── */}
            <section style={{
              background: "var(--md-surface)", borderRadius: 16, padding: 20,
              border: "1px solid var(--md-outline-var)",
            }}>
              <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 16 }}>
                <div style={{ width: 8, height: 8, borderRadius: "50%", background: "#9c27b0" }} />
                <h3 style={{ fontSize: 14, fontWeight: 600, color: "var(--md-on-surface)", margin: 0 }}>System Prompt</h3>
              </div>
              <label style={{ display: "flex", flexDirection: "column", gap: 6 }}>
                <span style={labelStyle}>Preprompt — injected as system message before every conversation</span>
                <textarea
                  value={settings.systemPrompt}
                  onChange={(e) => setSettings((s) => ({ ...s, systemPrompt: e.target.value }))}
                  placeholder={`You are Hyperset, an intelligent assistant for Apache Superset analytics...\n\n(Leave blank to use the default built-in prompt)`}
                  rows={5}
                  style={{ ...inputStyle, resize: "vertical", fontFamily: "monospace", fontSize: 12, lineHeight: 1.5 }}
                  disabled={saving}
                />
              </label>
              <label style={{ display: "flex", flexDirection: "column", gap: 6, marginTop: 12 }}>
                <span style={labelStyle}>Currently applied value (default when field is empty)</span>
                <textarea
                  value={effectiveSystemPromptPreview}
                  readOnly
                  rows={4}
                  style={{ ...inputStyle, resize: "vertical", fontFamily: "monospace", fontSize: 11, lineHeight: 1.4, opacity: 0.75, background: "var(--md-surface-cont-hi)" }}
                />
              </label>
            </section>

            {/* ── Model parameters ── */}
            <section style={{
              background: "var(--md-surface)", borderRadius: 16, padding: 20,
              border: "1px solid var(--md-outline-var)",
            }}>
              <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 16 }}>
                <div style={{ width: 8, height: 8, borderRadius: "50%", background: "#2196f3" }} />
                <h3 style={{ fontSize: 14, fontWeight: 600, color: "var(--md-on-surface)", margin: 0 }}>Model Parameters (JSON)</h3>
              </div>
              <label style={{ display: "flex", flexDirection: "column", gap: 6 }}>
                <span style={labelStyle}>Extra parameters merged into every chat completion request</span>
                <textarea
                  value={settings.modelParams}
                  onChange={(e) => setSettings((s) => ({ ...s, modelParams: e.target.value }))}
                  placeholder={`{\n  "temperature": 0.7,\n  "max_tokens": 1024,\n  "top_p": 0.9\n}`}
                  rows={4}
                  style={{ ...inputStyle, resize: "vertical", fontFamily: "monospace", fontSize: 11, lineHeight: 1.4 }}
                  disabled={saving}
                />
              </label>
            </section>

            {/* ── Chat context controls ── */}
            <section style={{
              background: "var(--md-surface)", borderRadius: 16, padding: 20,
              border: "1px solid var(--md-outline-var)",
            }}>
              <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 16 }}>
                <div style={{ width: 8, height: 8, borderRadius: "50%", background: "#4caf50" }} />
                <h3 style={{ fontSize: 14, fontWeight: 600, color: "var(--md-on-surface)", margin: 0 }}>Chat Context</h3>
              </div>
              <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>

                <label style={{ display: "flex", flexDirection: "column", gap: 6 }}>
                  <span style={labelStyle}>Max tool-call turns per response <span style={{ opacity: 0.5 }}>(1 – 200, default 40)</span></span>
                  <input
                    type="number" min={1} max={200}
                    value={settings.maxTurns}
                    onChange={(e) => setSettings((s) => ({ ...s, maxTurns: Math.max(1, Math.min(200, Number(e.target.value) || 1)) }))}
                    style={{ ...inputStyle, width: 100 }}
                    disabled={saving}
                  />
                </label>

                <label style={{ display: "flex", flexDirection: "column", gap: 6 }}>
                  <span style={labelStyle}>Max characters stored per tool result in history <span style={{ opacity: 0.5 }}>(500 – 50 000, default 3 000)</span></span>
                  <input
                    type="number" min={500} max={50000} step={500}
                    value={settings.maxToolResultChars}
                    onChange={(e) => setSettings((s) => ({ ...s, maxToolResultChars: Math.max(500, Math.min(50000, Number(e.target.value) || 500)) }))}
                    style={{ ...inputStyle, width: 120 }}
                    disabled={saving}
                  />
                </label>

                <label style={{ display: "flex", flexDirection: "column", gap: 6 }}>
                  <span style={labelStyle}>Max messages kept in the sliding context window <span style={{ opacity: 0.5 }}>(4 – 200, default 20)</span></span>
                  <input
                    type="number" min={4} max={200}
                    value={settings.maxHistoryMessages}
                    onChange={(e) => setSettings((s) => ({ ...s, maxHistoryMessages: Math.max(4, Math.min(200, Number(e.target.value) || 4)) }))}
                    style={{ ...inputStyle, width: 100 }}
                    disabled={saving}
                  />
                </label>

              </div>
            </section>

            {/* ── AI chart cleanup ── */}
            <section style={{
              background: "var(--md-surface)", borderRadius: 16, padding: 20,
              border: "1px solid var(--md-outline-var)",
            }}>
              <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 16 }}>
                <div style={{ width: 8, height: 8, borderRadius: "50%", background: "#ff9800" }} />
                <h3 style={{ fontSize: 14, fontWeight: 600, color: "var(--md-on-surface)", margin: 0 }}>AI Chart Cleanup</h3>
              </div>
              <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>

                <label style={{ display: "flex", flexDirection: "column", gap: 6 }}>
                  <span style={labelStyle}>
                    Temporary chart lifetime{" "}
                    <span style={{ opacity: 0.5 }}>(minutes before auto-deletion, 1 – 10 080, default 120)</span>
                  </span>
                  <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
                    <input
                      type="number" min={1} max={10080} step={1}
                      value={settings.cleanupDelayMinutes}
                      onChange={(e) => setSettings((s) => ({
                        ...s,
                        cleanupDelayMinutes: Math.max(1, Math.min(10080, Math.round(Number(e.target.value)) || 1)),
                      }))}
                      style={{ ...inputStyle, width: 100 }}
                      disabled={saving}
                    />
                    <span style={{ fontSize: 12, opacity: 0.6, color: "var(--md-on-surface)" }}>
                      {(() => {
                        const m = settings.cleanupDelayMinutes;
                        if (m < 60) return `${m} min`;
                        const h = Math.floor(m / 60);
                        const rem = m % 60;
                        return rem === 0 ? `${h} h` : `${h} h ${rem} min`;
                      })()}
                    </span>
                  </div>
                </label>

                <p style={{ fontSize: 11, opacity: 0.5, margin: 0, lineHeight: 1.6, color: "var(--md-on-surface)" }}>
                  Charts tagged <code style={{ fontSize: 10, background: "var(--md-surface-cont-hi)", padding: "2px 6px", borderRadius: 4 }}>[HYPERSET-AI-TEMPORARY]</code> are deleted after this delay.
                  The MCP server reads this setting dynamically via <code style={{ fontSize: 10, background: "var(--md-surface-cont-hi)", padding: "2px 6px", borderRadius: 4 }}>HYPERSET_DOMAIN</code>.
                </p>

              </div>
            </section>

            {saveError && <p style={{ color: "#ef5350", fontSize: 12, marginTop: 4 }}>{saveError}</p>}

            <div style={{ display: "flex", justifyContent: "flex-end", marginTop: 8, gap: 10 }}>
              <button onClick={handleSave} disabled={saving}
                style={{ 
                  ...primaryBtnStyle, 
                  padding: "12px 28px",
                  boxShadow: saved ? "none" : "0 4px 12px rgba(211, 84, 0, 0.3)",
                  ...(saved ? { background: "#4caf50", boxShadow: "0 4px 12px rgba(76, 175, 80, 0.3)" } : {}),
                }}>
                {saved ? "✓ Saved" : saving ? "Saving..." : "Save Changes"}
              </button>
            </div>
          </div>
        ) : activeTab === "knowledge" ? (
          <KnowledgeBaseTab />
        ) : (
          <PagesTab />
        )}
        </div>
        </div>
        </div>
      </>
  );
}

const labelStyle: React.CSSProperties = { fontSize: 12, fontWeight: 500, opacity: 0.7, color: "var(--md-on-surface)" };

const inputStyle: React.CSSProperties = {
  background: "var(--md-surface-cont)", border: "1px solid var(--md-outline)",
  borderRadius: 10, padding: "10px 14px", fontSize: 13,
  color: "var(--md-on-surface)", outline: "none", width: "100%",
  transition: "all 0.2s ease", boxShadow: "inset 0 1px 2px rgba(0,0,0,0.04)",
};

const primaryBtnStyle: React.CSSProperties = {
  background: "var(--md-primary)", color: "white", border: "none", borderRadius: 10,
  padding: "10px 24px", fontSize: 13, fontWeight: 600, cursor: "pointer", transition: "all 0.2s ease",
};

const dangerBtnStyle: React.CSSProperties = {
  background: "rgba(211,47,47,0.08)", color: "#ef5350", border: "1px solid rgba(211,47,47,0.2)", borderRadius: 8,
  padding: "6px 14px", fontSize: 12, cursor: "pointer", transition: "all 0.2s ease",
};

const testBtnStyle: React.CSSProperties = {
  background: "var(--md-surface-cont)", color: "var(--md-on-surface)",
  border: "1px solid var(--md-outline)", borderRadius: 10,
  padding: "8px 16px", fontSize: 12, fontWeight: 500, cursor: "pointer", opacity: 1,
  transition: "all 0.2s ease", boxShadow: "0 1px 3px rgba(0,0,0,0.05)",
};

const ghostBtnStyle: React.CSSProperties = {
  background: "none", color: "var(--md-on-surface)", border: "none", borderRadius: 8,
  padding: "8px 12px", fontSize: 12, cursor: "pointer", opacity: 0.6, transition: "opacity 0.2s ease",
};
