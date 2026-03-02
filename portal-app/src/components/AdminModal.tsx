"use client";

import React, { useState, useEffect, useCallback } from "react";

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

type Tab = "llm" | "knowledge";

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
  const [selectedFile, setSelectedFile] = useState<File | null>(null);
  const [description, setDescription] = useState("");
  const [textContent, setTextContent] = useState("");
  const [textName, setTextName] = useState("");
  const [uploadMode, setUploadMode] = useState<"file" | "text">("file");
  const [routingGuide, setRoutingGuide] = useState("");
  const [routingGuideSaving, setRoutingGuideSaving] = useState(false);

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
    if (!selectedFile) return;

    setUploading(true);
    setError("");

    try {
      const formData = new FormData();
      formData.append("file", selectedFile);
      formData.append("description", description);

      const res = await fetch("/api/knowledge-base", {
        method: "POST",
        body: formData,
      });

      if (!res.ok) {
        const data = await res.json();
        throw new Error(data.error || "Upload failed");
      }

      setSelectedFile(null);
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
    <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
      {/* Upload Section */}
      <div>
        <p style={{ fontSize: 11, fontWeight: 600, opacity: 0.45, textTransform: "uppercase", letterSpacing: "0.06em", margin: "0 0 12px" }}>
          Upload Document
        </p>

        <div style={{ display: "flex", gap: 8, marginBottom: 12 }}>
          <button
            onClick={() => setUploadMode("file")}
            style={{
              ...tabBtnStyle,
              background: uploadMode === "file" ? "var(--md-primary)" : "var(--md-surface)",
              color: uploadMode === "file" ? "#fff" : "var(--md-on-surface)",
            }}
          >
            File Upload
          </button>
          <button
            onClick={() => setUploadMode("text")}
            style={{
              ...tabBtnStyle,
              background: uploadMode === "text" ? "var(--md-primary)" : "var(--md-surface)",
              color: uploadMode === "text" ? "#fff" : "var(--md-on-surface)",
            }}
          >
            Text Input
          </button>
        </div>

        {uploadMode === "file" ? (
          <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
            <label style={{ display: "flex", flexDirection: "column", gap: 3 }}>
              <span style={labelStyle}>Select .md file</span>
              <input
                type="file"
                accept=".md"
                onChange={(e) => setSelectedFile(e.target.files?.[0] || null)}
                style={{ ...inputStyle, padding: "5px 10px" }}
                disabled={uploading}
              />
            </label>
            {selectedFile && (
              <p style={{ fontSize: 11, opacity: 0.6, margin: 0 }}>
                Selected: {selectedFile.name} ({formatBytes(selectedFile.size)})
              </p>
            )}
            <label style={{ display: "flex", flexDirection: "column", gap: 3 }}>
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
            <button
              onClick={handleFileUpload}
              disabled={!selectedFile || uploading}
              style={{ ...primaryBtnStyle, alignSelf: "flex-start", opacity: (!selectedFile || uploading) ? 0.5 : 1 }}
            >
              {uploading ? "Uploading..." : "Upload"}
            </button>
          </div>
        ) : (
          <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
            <label style={{ display: "flex", flexDirection: "column", gap: 3 }}>
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
            <label style={{ display: "flex", flexDirection: "column", gap: 3 }}>
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
            <label style={{ display: "flex", flexDirection: "column", gap: 3 }}>
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
              {uploading ? "Uploading..." : "Upload"}
            </button>
          </div>
        )}
      </div>

      {/* Documents List */}
      <div style={{ borderTop: "1px solid var(--md-outline-var)", paddingTop: 16 }}>
        <p style={{ fontSize: 11, fontWeight: 600, opacity: 0.45, textTransform: "uppercase", letterSpacing: "0.06em", margin: "0 0 12px" }}>
          Knowledge Base Documents ({documents.length})
        </p>

        {loading ? (
          <p style={{ opacity: 0.6, fontSize: 13 }}>Loading documents...</p>
        ) : documents.length === 0 ? (
          <p style={{ opacity: 0.6, fontSize: 13, fontStyle: "italic" }}>
            No documents in knowledge base. Upload .md files to enrich LLM responses with company-specific information.
          </p>
        ) : (
          <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
            {documents.map((doc) => (
              <div
                key={doc.id}
                style={{
                  display: "flex",
                  alignItems: "flex-start",
                  gap: 12,
                  padding: 12,
                  background: "var(--md-surface)",
                  borderRadius: 8,
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
                  <p style={{ fontSize: 10, opacity: 0.5, margin: 0 }}>
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
                  {deletingId === doc.id ? "..." : "Delete"}
                </button>
              </div>
            ))}
          </div>
        )}
      </div>

      {/* Routing Guide Editor */}
      <div style={{ borderTop: "1px solid var(--md-outline-var)", paddingTop: 16, marginTop: 8 }}>
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 8 }}>
          <p style={{ fontSize: 11, fontWeight: 600, opacity: 0.45, textTransform: "uppercase", letterSpacing: "0.06em", margin: 0 }}>
            Routing Guide — Which Document to Use When
          </p>
          <span style={{ fontSize: 10, opacity: 0.5 }}>
            {routingGuide.length} chars
          </span>
        </div>
        <p style={{ fontSize: 11, opacity: 0.6, margin: "0 0 8px", lineHeight: 1.4 }}>
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
          style={{ ...inputStyle, resize: "vertical", fontFamily: "monospace", fontSize: 12, lineHeight: 1.5, marginBottom: 8 }}
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
            } catch (e) {
              setError("Failed to save routing guide");
            } finally {
              setRoutingGuideSaving(false);
            }
          }}
          disabled={routingGuideSaving}
          style={{ ...primaryBtnStyle, alignSelf: "flex-start", opacity: routingGuideSaving ? 0.5 : 1 }}
        >
          {routingGuideSaving ? "Saving..." : "Save Routing Guide"}
        </button>
      </div>

      {error && (
        <div style={{ padding: "8px 10px", borderRadius: 8, background: "rgba(211,47,47,0.12)", border: "1px solid rgba(211,47,47,0.3)" }}>
          <span style={{ color: "#ef5350", fontSize: 12 }}>{error}</span>
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

  useEffect(() => {
    fetch("/api/admin")
      .then((r) => r.json())
      .then((data) => {
        setSettings({ ...data, apiKey: data.isCustom ? "***" : "" });
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
      const data = await res.json();
      setSettings({ ...data, apiKey: "" });
    } catch { setSaveError("Failed to reset"); }
    finally { setSaving(false); }
  };

  return (
    <div
      style={{
        position: "fixed", inset: 0, background: "rgba(0,0,0,0.55)",
        zIndex: 1000, display: "flex", alignItems: "center", justifyContent: "center",
      }}
      onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}
    >
      <div style={{
        background: "var(--md-surface-cont)", borderRadius: "var(--radius-l)",
        padding: 24, minWidth: 360, maxWidth: 600, width: "92%",
        maxHeight: "90vh", overflowY: "auto",
        boxShadow: "0 8px 32px rgba(0,0,0,0.28)",
        display: "flex", flexDirection: "column", gap: 0,
      }}>
        {/* Header */}
        <div style={{ display: "flex", alignItems: "center", marginBottom: 20, gap: 10 }}>
          <svg viewBox="0 0 24 24" width={18} height={18} fill="var(--md-secondary)">
            <path d="M19.14,12.94c0.04-0.3,0.06-0.61,0.06-0.94c0-0.32-0.02-0.64-0.07-0.94l2.03-1.58c0.18-0.14,0.23-0.41,0.12-0.61l-1.92-3.32c-0.12-0.22-0.37-0.29-0.59-0.22l-2.39,0.96c-0.5-0.38-1.03-0.7-1.62-0.94L14.4,2.81c-0.04-0.24-0.24-0.41-0.48-0.41h-3.84c-0.24,0-0.43,0.17-0.47,0.41L9.25,5.35C8.66,5.59,8.12,5.92,7.63,6.29L5.24,5.33c-0.22-0.08-0.47,0-0.59,0.22L2.74,8.87C2.62,9.08,2.66,9.34,2.86,9.48l2.03,1.58C4.84,11.36,4.8,11.69,4.8,12s0.02,0.64,0.07,0.94l-2.03,1.58c-0.18,0.14-0.23,0.41-0.12,0.61l1.92,3.32c0.12,0.22,0.37,0.29,0.59,0.22l2.39-0.96c0.5,0.38,1.03,0.7,1.62,0.94l0.36,2.54c0.05,0.24,0.24,0.41,0.48,0.41h3.84c0.24,0,0.44-0.17,0.47-0.41l0.36-2.54c0.59-0.24,1.13-0.56,1.62-0.94l2.39,0.96c0.22,0.08,0.47,0,0.59-0.22l1.92-3.32c0.12-0.22,0.07-0.47-0.12-0.61L19.14,12.94z M12,15.6c-1.98,0-3.6-1.62-3.6-3.6s1.62-3.6,3.6-3.6s3.6,1.62,3.6,3.6S13.98,15.6,12,15.6z" />
          </svg>
          <h2 style={{ fontSize: 15, fontWeight: 600, flex: 1, color: "var(--md-on-surface)" }}>Admin Settings</h2>
          <button onClick={onClose}
            style={{ border: "none", background: "none", cursor: "pointer",
              color: "var(--md-on-surface)", fontSize: 18, lineHeight: 1, padding: "2px 6px", borderRadius: 6 }}>
            ×
          </button>
        </div>

        {/* Tab Navigation */}
        <div style={{ display: "flex", gap: 0, marginBottom: 20, borderBottom: "1px solid var(--md-outline-var)" }}>
          <button
            onClick={() => setActiveTab("llm")}
            style={{
              ...tabBtnStyle,
              borderBottom: activeTab === "llm" ? "2px solid var(--md-primary)" : "2px solid transparent",
              background: "none",
              color: activeTab === "llm" ? "var(--md-primary)" : "var(--md-on-surface)",
              opacity: activeTab === "llm" ? 1 : 0.7,
              borderRadius: 0,
              padding: "8px 16px",
            }}
          >
            LLM Settings
          </button>
          <button
            onClick={() => setActiveTab("knowledge")}
            style={{
              ...tabBtnStyle,
              borderBottom: activeTab === "knowledge" ? "2px solid var(--md-primary)" : "2px solid transparent",
              background: "none",
              color: activeTab === "knowledge" ? "var(--md-primary)" : "var(--md-on-surface)",
              opacity: activeTab === "knowledge" ? 1 : 0.7,
              borderRadius: 0,
              padding: "8px 16px",
            }}
          >
            Knowledge Base
          </button>
        </div>

        {loading && activeTab === "llm" ? (
          <p style={{ opacity: 0.6, textAlign: "center", fontSize: 13 }}>Loading...</p>
        ) : activeTab === "llm" ? (
          <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
            {/* ── LLM connection ── */}
            <p style={{ fontSize: 11, fontWeight: 600, opacity: 0.45, textTransform: "uppercase", letterSpacing: "0.06em", margin: 0 }}>
              LLM Connection
            </p>

            <label style={{ display: "flex", flexDirection: "column", gap: 3 }}>
              <span style={labelStyle}>API URL</span>
              <input type="url" value={settings.apiUrl}
                onChange={(e) => setSettings((s) => ({ ...s, apiUrl: e.target.value }))}
                placeholder="https://api.mistral.ai/v1" style={inputStyle} disabled={saving} />
            </label>

            <label style={{ display: "flex", flexDirection: "column", gap: 3 }}>
              <span style={labelStyle}>API Key{settings.isCustom ? " (overridden)" : ""}</span>
              <input type="password" value={settings.apiKey}
                onChange={(e) => setSettings((s) => ({ ...s, apiKey: e.target.value }))}
                placeholder={settings.isCustom ? "••••• (currently set)" : "Enter API key..."}
                style={inputStyle} disabled={saving} />
            </label>

            <label style={{ display: "flex", flexDirection: "column", gap: 3 }}>
              <span style={labelStyle}>Model</span>
              <input type="text" value={settings.model}
                onChange={(e) => setSettings((s) => ({ ...s, model: e.target.value }))}
                placeholder="ministral-3b-2512" style={inputStyle} disabled={saving} />
            </label>

            <div style={{ display: "flex", gap: 6, alignItems: "center" }}>
              <button onClick={handleTest}
                disabled={testing || saving || !settings.apiUrl || !settings.model || (!settings.apiKey && !settings.isCustom)}
                style={testBtnStyle} title="Send a minimal test request to verify these credentials work">
                {testing ? "Testing..." : "Test connection"}
              </button>
              {settings.isCustom && (
                <button onClick={handleReset} disabled={saving} style={ghostBtnStyle}>Reset to env</button>
              )}
            </div>

            {testResult && <TestResultBanner result={testResult} />}

            {/* ── System prompt ── */}
            <div style={{ marginTop: 8, borderTop: "1px solid var(--md-outline-var)", paddingTop: 12 }}>
              <p style={{ fontSize: 11, fontWeight: 600, opacity: 0.45, textTransform: "uppercase", letterSpacing: "0.06em", margin: "0 0 8px" }}>
                System Prompt
              </p>
              <label style={{ display: "flex", flexDirection: "column", gap: 3 }}>
                <span style={labelStyle}>Preprompt — injected as system message before every conversation</span>
                <textarea
                  value={settings.systemPrompt}
                  onChange={(e) => setSettings((s) => ({ ...s, systemPrompt: e.target.value }))}
                  placeholder={`You are Hyperset, an intelligent assistant for Apache Superset analytics...\n\n(Leave blank to use the default built-in prompt)`}
                  rows={6}
                  style={{ ...inputStyle, resize: "vertical", fontFamily: "monospace", fontSize: 12, lineHeight: 1.5 }}
                  disabled={saving}
                />
              </label>
            </div>

            {/* ── Model parameters ── */}
            <div style={{ marginTop: 8, borderTop: "1px solid var(--md-outline-var)", paddingTop: 12 }}>
              <p style={{ fontSize: 11, fontWeight: 600, opacity: 0.45, textTransform: "uppercase", letterSpacing: "0.06em", margin: "0 0 8px" }}>
                Model Parameters (JSON)
              </p>
              <label style={{ display: "flex", flexDirection: "column", gap: 3 }}>
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
            </div>

            {/* ── Chat context controls ── */}
            <div style={{ marginTop: 8, borderTop: "1px solid var(--md-outline-var)", paddingTop: 12 }}>
              <p style={{ fontSize: 11, fontWeight: 600, opacity: 0.45, textTransform: "uppercase", letterSpacing: "0.06em", margin: "0 0 8px" }}>
                Chat Context
              </p>
              <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>

                <label style={{ display: "flex", flexDirection: "column", gap: 3 }}>
                  <span style={labelStyle}>Max tool-call turns per response <span style={{ opacity: 0.5 }}>(1 – 200, default 40)</span></span>
                  <input
                    type="number" min={1} max={200}
                    value={settings.maxTurns}
                    onChange={(e) => setSettings((s) => ({ ...s, maxTurns: Math.max(1, Math.min(200, Number(e.target.value) || 1)) }))}
                    style={{ ...inputStyle, width: 100 }}
                    disabled={saving}
                  />
                </label>

                <label style={{ display: "flex", flexDirection: "column", gap: 3 }}>
                  <span style={labelStyle}>Max characters stored per tool result in history <span style={{ opacity: 0.5 }}>(500 – 50 000, default 3 000)</span></span>
                  <input
                    type="number" min={500} max={50000} step={500}
                    value={settings.maxToolResultChars}
                    onChange={(e) => setSettings((s) => ({ ...s, maxToolResultChars: Math.max(500, Math.min(50000, Number(e.target.value) || 500)) }))}
                    style={{ ...inputStyle, width: 120 }}
                    disabled={saving}
                  />
                </label>

                <label style={{ display: "flex", flexDirection: "column", gap: 3 }}>
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
            </div>

            {/* ── AI chart cleanup ── */}
            <div style={{ marginTop: 8, borderTop: "1px solid var(--md-outline-var)", paddingTop: 12 }}>
              <p style={{ fontSize: 11, fontWeight: 600, opacity: 0.45, textTransform: "uppercase", letterSpacing: "0.06em", margin: "0 0 8px" }}>
                AI Chart Cleanup
              </p>
              <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>

                <label style={{ display: "flex", flexDirection: "column", gap: 3 }}>
                  <span style={labelStyle}>
                    Temporary chart lifetime{" "}
                    <span style={{ opacity: 0.5 }}>(minutes before auto-deletion, 1 – 10 080, default 120)</span>
                  </span>
                  <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
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
                    <span style={{ fontSize: 11, opacity: 0.5 }}>
                      {(() => {
                        const m = settings.cleanupDelayMinutes;
                        if (m < 60) return `${m} min`;
                        const h = Math.floor(m / 60);
                        const rem = m % 60;
                        return rem === 0 ? `${h} h` : `${h} h ${rem} min`;
                      })()}
                      {" "}— charts tagged <code style={{ fontSize: 10, background: "var(--md-surface-cont-hi)", padding: "1px 4px", borderRadius: 4 }}>[HYPERSET-AI-TEMPORARY]</code> are deleted after this delay
                    </span>
                  </div>
                </label>

                <p style={{ fontSize: 11, opacity: 0.45, margin: 0, lineHeight: 1.5 }}>
                  The MCP server reads this setting dynamically via{" "}
                  <code style={{ fontSize: 10, background: "var(--md-surface-cont-hi)", padding: "1px 4px", borderRadius: 4 }}>HYPERSET_DOMAIN</code>
                  {" "}— changes take effect on the next cleanup cycle without restarting the server.
                  For local dev without a domain, set{" "}
                  <code style={{ fontSize: 10, background: "var(--md-surface-cont-hi)", padding: "1px 4px", borderRadius: 4 }}>HYPERSET_PORTAL_URL</code>
                  {" "}(e.g. <code style={{ fontSize: 10, background: "var(--md-surface-cont-hi)", padding: "1px 4px", borderRadius: 4 }}>http://localhost:3000</code>) in the MCP server's{" "}
                  <code style={{ fontSize: 10, background: "var(--md-surface-cont-hi)", padding: "1px 4px", borderRadius: 4 }}>.env</code>.
                </p>

              </div>
            </div>

            {saveError && <p style={{ color: "#ef5350", fontSize: 12, marginTop: 4 }}>{saveError}</p>}

            <div style={{ display: "flex", justifyContent: "flex-end", marginTop: 8 }}>
              <button onClick={handleSave} disabled={saving}
                style={{ ...primaryBtnStyle, ...(saved ? { background: "#4caf50" } : {}) }}>
                {saved ? "Saved ✓" : saving ? "Saving..." : "Save"}
              </button>
            </div>
          </div>
        ) : (
          <KnowledgeBaseTab />
        )}
      </div>
    </div>
  );
}

const labelStyle: React.CSSProperties = { fontSize: 11, fontWeight: 500, opacity: 0.65 };

const inputStyle: React.CSSProperties = {
  background: "var(--md-surface)", border: "1px solid var(--md-outline-var)",
  borderRadius: 8, padding: "7px 10px", fontSize: 12,
  color: "var(--md-on-surface)", outline: "none", width: "100%",
};

const primaryBtnStyle: React.CSSProperties = {
  background: "var(--md-primary)", color: "#fff", border: "none", borderRadius: 8,
  padding: "8px 20px", fontSize: 13, fontWeight: 600, cursor: "pointer", transition: "background 0.2s",
};

const dangerBtnStyle: React.CSSProperties = {
  background: "rgba(211,47,47,0.1)", color: "#ef5350", border: "1px solid rgba(211,47,47,0.3)", borderRadius: 8,
  padding: "5px 12px", fontSize: 12, cursor: "pointer", transition: "all 0.2s",
};

const testBtnStyle: React.CSSProperties = {
  background: "var(--md-surface)", color: "var(--md-on-surface)",
  border: "1px solid var(--md-outline-var)", borderRadius: 8,
  padding: "5px 12px", fontSize: 12, cursor: "pointer", opacity: 1,
};

const ghostBtnStyle: React.CSSProperties = {
  background: "none", color: "var(--md-on-surface)", border: "none", borderRadius: 8,
  padding: "5px 10px", fontSize: 12, cursor: "pointer", opacity: 0.55, textDecoration: "underline",
};

const tabBtnStyle: React.CSSProperties = {
  border: "none", borderRadius: 8,
  padding: "6px 12px", fontSize: 13, cursor: "pointer", fontWeight: 500,
  transition: "all 0.2s",
};
