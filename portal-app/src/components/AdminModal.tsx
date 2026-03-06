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

interface TestResult {
  ok: boolean;
  error?: string;
  model?: string;
}

export function AdminModal({ onClose }: AdminModalProps) {
  const [settings, setSettings] = useState<LlmSettings>({
    apiUrl: "", apiKey: "", model: "", systemPrompt: "", modelParams: "", isCustom: false,
    maxTurns: 40, maxToolResultChars: 3000, maxHistoryMessages: 20, cleanupDelayMinutes: 120,
  });
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [saveError, setSaveError] = useState("");
  const [testing, setTesting] = useState(false);
  const [testResult, setTestResult] = useState<TestResult | null>(null);

  // Load settings in background without blocking UI
  useEffect(() => {
    let cancelled = false;
    fetch("/api/admin")
      .then((r) => r.json())
      .then((data) => {
        if (cancelled) return;
        setSettings({
          apiUrl: data.apiUrl ?? "",
          apiKey: data.isCustom ? "***" : "",
          model: data.model ?? "",
          systemPrompt: data.systemPrompt ?? "",
          modelParams: data.modelParams ?? "",
          isCustom: data.isCustom ?? false,
          maxTurns: data.maxTurns ?? 40,
          maxToolResultChars: data.maxToolResultChars ?? 3000,
          maxHistoryMessages: data.maxHistoryMessages ?? 20,
          cleanupDelayMinutes: data.cleanupDelayMinutes ?? 120,
        });
      })
      .catch(() => { /* silent fail - user can still edit */ });
    return () => { cancelled = true; };
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
      setTestResult(await res.json());
    } catch {
      setTestResult({ ok: false, error: "Network error" });
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
      setSettings({
        apiUrl: data.apiUrl ?? "",
        apiKey: "",
        model: data.model ?? "",
        systemPrompt: data.systemPrompt ?? "",
        modelParams: data.modelParams ?? "",
        isCustom: data.isCustom ?? false,
        maxTurns: data.maxTurns ?? 40,
        maxToolResultChars: data.maxToolResultChars ?? 3000,
        maxHistoryMessages: data.maxHistoryMessages ?? 20,
        cleanupDelayMinutes: data.cleanupDelayMinutes ?? 120,
      });
    } catch { 
      setSaveError("Failed to reset"); 
    } finally { 
      setSaving(false); 
    }
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
        padding: 20, minWidth: 320, maxWidth: 480, width: "92%",
        maxHeight: "85vh", overflowY: "auto",
        boxShadow: "0 8px 32px rgba(0,0,0,0.28)",
      }}>
        {/* Header */}
        <div style={{ display: "flex", alignItems: "center", marginBottom: 16, gap: 8 }}>
          <h2 style={{ fontSize: 15, fontWeight: 600, flex: 1, color: "var(--md-on-surface)", margin: 0 }}>
            LLM Settings
          </h2>
          <button onClick={onClose}
            style={{ border: "none", background: "none", cursor: "pointer",
              color: "var(--md-on-surface)", fontSize: 20, lineHeight: 1, padding: "2px 6px" }}>
            ×
          </button>
        </div>

        <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
          {/* API URL */}
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

          {/* API Key */}
          <label style={{ display: "flex", flexDirection: "column", gap: 3 }}>
            <span style={labelStyle}>API Key {settings.isCustom && "(set)"}</span>
            <input 
              type="password" 
              value={settings.apiKey}
              onChange={(e) => setSettings((s) => ({ ...s, apiKey: e.target.value }))}
              placeholder={settings.isCustom ? "•••••" : "Enter API key..."}
              style={inputStyle} 
              disabled={saving} 
            />
          </label>

          {/* Model */}
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

          {/* Test & Reset */}
          <div style={{ display: "flex", gap: 8 }}>
            <button 
              onClick={handleTest}
              disabled={testing || saving || !settings.apiUrl || !settings.model}
              style={testBtnStyle}
            >
              {testing ? "Testing..." : "Test"}
            </button>
            {settings.isCustom && (
              <button onClick={handleReset} disabled={saving} style={ghostBtnStyle}>
                Reset
              </button>
            )}
          </div>

          {/* Test Result */}
          {testResult && (
            <div style={{
              padding: "8px 10px", borderRadius: 6,
              background: testResult.ok ? "rgba(76,175,80,0.12)" : "rgba(211,47,47,0.12)",
              border: `1px solid ${testResult.ok ? "#4caf50" : "#ef5350"}`,
              fontSize: 12,
            }}>
              {testResult.ok ? `✓ Connected: ${testResult.model}` : `✗ ${testResult.error}`}
            </div>
          )}

          {/* System Prompt */}
          <label style={{ display: "flex", flexDirection: "column", gap: 3 }}>
            <span style={labelStyle}>System Prompt</span>
            <textarea
              value={settings.systemPrompt}
              onChange={(e) => setSettings((s) => ({ ...s, systemPrompt: e.target.value }))}
              placeholder="Custom system prompt..."
              rows={4}
              style={{ ...inputStyle, resize: "vertical", fontFamily: "monospace", fontSize: 12 }}
              disabled={saving}
            />
          </label>

          {/* Advanced toggle */}
          <details style={{ marginTop: 4 }}>
            <summary style={{ fontSize: 12, opacity: 0.7, cursor: "pointer" }}>
              Advanced parameters
            </summary>
            <div style={{ display: "flex", flexDirection: "column", gap: 10, marginTop: 10 }}>
              <label style={{ display: "flex", flexDirection: "column", gap: 3 }}>
                <span style={labelStyle}>Model Params (JSON)</span>
                <textarea
                  value={settings.modelParams}
                  onChange={(e) => setSettings((s) => ({ ...s, modelParams: e.target.value }))}
                  placeholder={`{"temperature": 0.7}`}
                  rows={2}
                  style={{ ...inputStyle, fontFamily: "monospace", fontSize: 11 }}
                  disabled={saving}
                />
              </label>

              <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 8 }}>
                <label style={{ display: "flex", flexDirection: "column", gap: 3 }}>
                  <span style={labelStyle}>Max Turns</span>
                  <input
                    type="number"
                    min={1} max={200}
                    value={settings.maxTurns}
                    onChange={(e) => setSettings((s) => ({ ...s, maxTurns: Number(e.target.value) || 1 }))}
                    style={inputStyle}
                    disabled={saving}
                  />
                </label>

                <label style={{ display: "flex", flexDirection: "column", gap: 3 }}>
                  <span style={labelStyle}>Context Size</span>
                  <input
                    type="number"
                    min={4} max={200}
                    value={settings.maxHistoryMessages}
                    onChange={(e) => setSettings((s) => ({ ...s, maxHistoryMessages: Number(e.target.value) || 4 }))}
                    style={inputStyle}
                    disabled={saving}
                  />
                </label>
              </div>
            </div>
          </details>

          {/* Error */}
          {saveError && (
            <p style={{ color: "#ef5350", fontSize: 12, margin: 0 }}>{saveError}</p>
          )}

          {/* Save Button */}
          <button 
            onClick={handleSave} 
            disabled={saving}
            style={{ 
              ...primaryBtnStyle, 
              marginTop: 8,
              background: saved ? "#4caf50" : "var(--md-primary)"
            }}
          >
            {saved ? "Saved ✓" : saving ? "Saving..." : "Save"}
          </button>
        </div>
      </div>
    </div>
  );
}

const labelStyle: React.CSSProperties = { 
  fontSize: 11, 
  fontWeight: 500, 
  opacity: 0.7 
};

const inputStyle: React.CSSProperties = {
  background: "var(--md-surface)", 
  border: "1px solid var(--md-outline-var)",
  borderRadius: 6, 
  padding: "6px 10px", 
  fontSize: 13,
  color: "var(--md-on-surface)", 
  outline: "none", 
  width: "100%",
};

const primaryBtnStyle: React.CSSProperties = {
  background: "var(--md-primary)", 
  color: "var(--md-on-primary-cont)", 
  border: "none", 
  borderRadius: 6,
  padding: "10px 20px", 
  fontSize: 13, 
  fontWeight: 600, 
  cursor: "pointer",
};

const testBtnStyle: React.CSSProperties = {
  background: "var(--md-surface)", 
  color: "var(--md-on-surface)",
  border: "1px solid var(--md-outline)", 
  borderRadius: 6,
  padding: "6px 14px", 
  fontSize: 12, 
  cursor: "pointer",
};

const ghostBtnStyle: React.CSSProperties = {
  background: "none", 
  color: "var(--md-on-surface)", 
  border: "none",
  padding: "6px 10px", 
  fontSize: 12, 
  cursor: "pointer", 
  opacity: 0.6,
  textDecoration: "underline",
};
