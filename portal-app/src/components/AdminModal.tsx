"use client";

import React, { useState, useEffect } from "react";

interface AdminModalProps {
  onClose: () => void;
}

interface LlmSettings {
  apiUrl: string;
  apiKey: string;
  model: string;
  isCustom: boolean;
}

interface TestResult {
  ok: boolean;
  error?: string;
  model?: string;
}

function TestResultBanner({ result }: { result: TestResult }) {
  const [copied, setCopied] = useState(false);

  const handleCopy = () => {
    const text = result.error ?? (result.model ? `OK — model: ${result.model}` : "OK");
    navigator.clipboard.writeText(text).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    });
  };

  return (
    <div
      style={{
        display: "flex",
        alignItems: "flex-start",
        gap: 8,
        padding: "8px 10px",
        borderRadius: 8,
        background: result.ok ? "rgba(76,175,80,0.12)" : "rgba(211,47,47,0.12)",
        border: `1px solid ${result.ok ? "rgba(76,175,80,0.3)" : "rgba(211,47,47,0.3)"}`,
        fontSize: 12,
      }}
    >
      <span style={{ color: result.ok ? "#4caf50" : "#ef5350", fontWeight: 700, flexShrink: 0 }}>
        {result.ok ? "✓" : "✗"}
      </span>
      <span style={{ flex: 1, wordBreak: "break-word", color: "var(--md-on-surface)", opacity: 0.85 }}>
        {result.ok
          ? `Connected — model: ${result.model ?? "ok"}`
          : result.error ?? "Unknown error"}
      </span>
      <button
        onClick={handleCopy}
        title="Copy to clipboard"
        style={{
          border: "none",
          background: "none",
          cursor: "pointer",
          padding: "0 2px",
          color: "var(--md-on-surface)",
          opacity: 0.5,
          flexShrink: 0,
          fontSize: 13,
        }}
      >
        {copied ? "✓" : "⎘"}
      </button>
    </div>
  );
}

export function AdminModal({ onClose }: AdminModalProps) {
  const [settings, setSettings] = useState<LlmSettings>({
    apiUrl: "", apiKey: "", model: "", isCustom: false,
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
      .catch(() => {
        setSaveError("Failed to load settings");
        setLoading(false);
      });
  }, []);

  const handleTest = async () => {
    setTesting(true);
    setTestResult(null);
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
      const data = await res.json();
      setTestResult(data);
    } catch {
      setTestResult({ ok: false, error: "Network error — could not reach server" });
    } finally {
      setTesting(false);
    }
  };

  const handleSave = async () => {
    setSaving(true);
    setSaveError("");
    try {
      const res = await fetch("/api/admin", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          apiUrl: settings.apiUrl,
          apiKey: settings.apiKey !== "***" ? settings.apiKey : undefined,
          model: settings.model,
        }),
      });
      if (!res.ok) throw new Error("Save failed");
      setSaved(true);
      setTimeout(() => setSaved(false), 2000);
    } catch {
      setSaveError("Failed to save settings");
    } finally {
      setSaving(false);
    }
  };

  const handleReset = async () => {
    setSaving(true);
    try {
      await fetch("/api/admin", { method: "DELETE" });
      const res = await fetch("/api/admin");
      const data = await res.json();
      setSettings({ ...data, apiKey: "" });
    } catch {
      setSaveError("Failed to reset");
    } finally {
      setSaving(false);
    }
  };

  return (
    <div
      style={{
        position: "fixed", inset: 0,
        background: "rgba(0,0,0,0.55)",
        zIndex: 1000,
        display: "flex", alignItems: "center", justifyContent: "center",
      }}
      onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}
    >
      <div
        style={{
          background: "var(--md-surface-cont)",
          borderRadius: "var(--radius-l)",
          padding: 24,
          minWidth: 360,
          maxWidth: 480,
          width: "92%",
          maxHeight: "90vh",
          overflowY: "auto",
          boxShadow: "0 8px 32px rgba(0,0,0,0.28)",
          display: "flex",
          flexDirection: "column",
          gap: 0,
        }}
      >
        {/* Header */}
        <div style={{ display: "flex", alignItems: "center", marginBottom: 20, gap: 10 }}>
          <svg viewBox="0 0 24 24" width={18} height={18} fill="var(--md-secondary)">
            <path d="M19.14,12.94c0.04-0.3,0.06-0.61,0.06-0.94c0-0.32-0.02-0.64-0.07-0.94l2.03-1.58c0.18-0.14,0.23-0.41,0.12-0.61l-1.92-3.32c-0.12-0.22-0.37-0.29-0.59-0.22l-2.39,0.96c-0.5-0.38-1.03-0.7-1.62-0.94L14.4,2.81c-0.04-0.24-0.24-0.41-0.48-0.41h-3.84c-0.24,0-0.43,0.17-0.47,0.41L9.25,5.35C8.66,5.59,8.12,5.92,7.63,6.29L5.24,5.33c-0.22-0.08-0.47,0-0.59,0.22L2.74,8.87C2.62,9.08,2.66,9.34,2.86,9.48l2.03,1.58C4.84,11.36,4.8,11.69,4.8,12s0.02,0.64,0.07,0.94l-2.03,1.58c-0.18,0.14-0.23,0.41-0.12,0.61l1.92,3.32c0.12,0.22,0.37,0.29,0.59,0.22l2.39-0.96c0.5,0.38,1.03,0.7,1.62,0.94l0.36,2.54c0.05,0.24,0.24,0.41,0.48,0.41h3.84c0.24,0,0.44-0.17,0.47-0.41l0.36-2.54c0.59-0.24,1.13-0.56,1.62-0.94l2.39,0.96c0.22,0.08,0.47,0,0.59-0.22l1.92-3.32c0.12-0.22,0.07-0.47-0.12-0.61L19.14,12.94z M12,15.6c-1.98,0-3.6-1.62-3.6-3.6s1.62-3.6,3.6-3.6s3.6,1.62,3.6,3.6S13.98,15.6,12,15.6z" />
          </svg>
          <h2 style={{ fontSize: 15, fontWeight: 600, flex: 1, color: "var(--md-on-surface)" }}>
            LLM Settings
          </h2>
          <button
            onClick={onClose}
            style={{ border: "none", background: "none", cursor: "pointer",
              color: "var(--md-on-surface)", fontSize: 18, lineHeight: 1, padding: "2px 6px", borderRadius: 6 }}
          >×</button>
        </div>

        {loading ? (
          <p style={{ opacity: 0.6, textAlign: "center", fontSize: 13 }}>Loading…</p>
        ) : (
          <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
            <label style={{ display: "flex", flexDirection: "column", gap: 3 }}>
              <span style={labelStyle}>API URL</span>
              <input
                type="url"
                value={settings.apiUrl}
                onChange={(e) => setSettings((s) => ({ ...s, apiUrl: e.target.value }))}
                placeholder="https://api.mistral.ai/v1"
                style={inputStyle}
                disabled={saving}
              />
            </label>

            <label style={{ display: "flex", flexDirection: "column", gap: 3 }}>
              <span style={labelStyle}>API Key{settings.isCustom ? " (overridden)" : ""}</span>
              <input
                type="password"
                value={settings.apiKey}
                onChange={(e) => setSettings((s) => ({ ...s, apiKey: e.target.value }))}
                placeholder={settings.isCustom ? "••••• (currently set)" : "Enter API key…"}
                style={inputStyle}
                disabled={saving}
              />
            </label>

            <label style={{ display: "flex", flexDirection: "column", gap: 3 }}>
              <span style={labelStyle}>Model</span>
              <input
                type="text"
                value={settings.model}
                onChange={(e) => setSettings((s) => ({ ...s, model: e.target.value }))}
                placeholder="ministral-3b-2512"
                style={inputStyle}
                disabled={saving}
              />
            </label>

            <div style={{ display: "flex", gap: 6, alignItems: "center" }}>
              <button
                onClick={handleTest}
                disabled={testing || saving || !settings.apiUrl || !settings.model || (!settings.apiKey && !settings.isCustom)}
                style={testBtnStyle}
                title="Send a minimal test request to verify these credentials work"
              >
                {testing ? "Testing…" : "Test connection"}
              </button>
              {settings.isCustom && (
                <button onClick={handleReset} disabled={saving} style={ghostBtnStyle}>
                  Reset to env
                </button>
              )}
            </div>

            {testResult && <TestResultBanner result={testResult} />}

            {saveError && (
              <p style={{ color: "#ef5350", fontSize: 12, marginTop: 4 }}>{saveError}</p>
            )}

            <div style={{ display: "flex", justifyContent: "flex-end", marginTop: 8 }}>
              <button
                onClick={handleSave}
                disabled={saving}
                style={{
                  ...primaryBtnStyle,
                  ...(saved ? { background: "#4caf50" } : {}),
                }}
              >
                {saved ? "Saved ✓" : saving ? "Saving…" : "Save"}
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

const labelStyle: React.CSSProperties = {
  fontSize: 11, fontWeight: 500, opacity: 0.65,
};

const inputStyle: React.CSSProperties = {
  background: "var(--md-surface)",
  border: "1px solid var(--md-outline-var)",
  borderRadius: 8,
  padding: "7px 10px",
  fontSize: 12,
  color: "var(--md-on-surface)",
  outline: "none",
  width: "100%",
};

const primaryBtnStyle: React.CSSProperties = {
  background: "var(--md-primary)",
  color: "#fff",
  border: "none",
  borderRadius: 8,
  padding: "8px 20px",
  fontSize: 13,
  fontWeight: 600,
  cursor: "pointer",
  transition: "background 0.2s",
};

const testBtnStyle: React.CSSProperties = {
  background: "var(--md-surface)",
  color: "var(--md-on-surface)",
  border: "1px solid var(--md-outline-var)",
  borderRadius: 8,
  padding: "5px 12px",
  fontSize: 12,
  cursor: "pointer",
  opacity: 1,
};

const ghostBtnStyle: React.CSSProperties = {
  background: "none",
  color: "var(--md-on-surface)",
  border: "none",
  borderRadius: 8,
  padding: "5px 10px",
  fontSize: 12,
  cursor: "pointer",
  opacity: 0.55,
  textDecoration: "underline",
};
