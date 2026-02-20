"use client";

import React, { useState, useEffect } from "react";

interface AdminModalProps {
  onClose: () => void;
}

interface AdminSettings {
  apiUrl: string;
  apiKey: string;
  model: string;
  isCustom: boolean;
}

export function AdminModal({ onClose }: AdminModalProps) {
  const [settings, setSettings] = useState<AdminSettings>({
    apiUrl: "",
    apiKey: "",
    model: "",
    isCustom: false,
  });
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState("");

  useEffect(() => {
    fetch("/api/admin")
      .then((r) => r.json())
      .then((data) => {
        setSettings({
          apiUrl: data.apiUrl ?? "",
          apiKey: data.apiKey ?? "",
          model: data.model ?? "",
          isCustom: data.isCustom ?? false,
        });
        setLoading(false);
      })
      .catch(() => {
        setError("Failed to load settings");
        setLoading(false);
      });
  }, []);

  const handleSave = async () => {
    setSaving(true);
    setError("");
    try {
      const res = await fetch("/api/admin", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          apiUrl: settings.apiUrl || undefined,
          apiKey: settings.apiKey || undefined,
          model: settings.model || undefined,
        }),
      });
      if (!res.ok) throw new Error("Save failed");
      setSaved(true);
      setTimeout(() => setSaved(false), 2000);
    } catch {
      setError("Failed to save settings");
    } finally {
      setSaving(false);
    }
  };

  const handleReset = async () => {
    setSaving(true);
    try {
      await fetch("/api/admin", { method: "DELETE" });
      // Reload to get env defaults
      const res = await fetch("/api/admin");
      const data = await res.json();
      setSettings({
        apiUrl: data.apiUrl ?? "",
        apiKey: "",
        model: data.model ?? "",
        isCustom: false,
      });
    } catch {
      setError("Failed to reset");
    } finally {
      setSaving(false);
    }
  };

  return (
    <div
      style={{
        position: "fixed",
        inset: 0,
        background: "rgba(0,0,0,0.5)",
        zIndex: 1000,
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
      }}
      onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}
    >
      <div
        style={{
          background: "var(--md-surface-cont)",
          borderRadius: "var(--radius-l)",
          padding: 24,
          minWidth: 340,
          maxWidth: 480,
          width: "90%",
          boxShadow: "0 8px 32px rgba(0,0,0,0.24)",
        }}
      >
        <div
          style={{
            display: "flex",
            alignItems: "center",
            marginBottom: 20,
            gap: 10,
          }}
        >
          <svg viewBox="0 0 24 24" width={20} height={20} fill="var(--md-secondary)">
            <path d="M19.14,12.94c0.04-0.3,0.06-0.61,0.06-0.94c0-0.32-0.02-0.64-0.07-0.94l2.03-1.58c0.18-0.14,0.23-0.41,0.12-0.61 l-1.92-3.32c-0.12-0.22-0.37-0.29-0.59-0.22l-2.39,0.96c-0.5-0.38-1.03-0.7-1.62-0.94L14.4,2.81c-0.04-0.24-0.24-0.41-0.48-0.41 h-3.84c-0.24,0-0.43,0.17-0.47,0.41L9.25,5.35C8.66,5.59,8.12,5.92,7.63,6.29L5.24,5.33c-0.22-0.08-0.47,0-0.59,0.22L2.74,8.87 C2.62,9.08,2.66,9.34,2.86,9.48l2.03,1.58C4.84,11.36,4.8,11.69,4.8,12s0.02,0.64,0.07,0.94l-2.03,1.58 c-0.18,0.14-0.23,0.41-0.12,0.61l1.92,3.32c0.12,0.22,0.37,0.29,0.59,0.22l2.39-0.96c0.5,0.38,1.03,0.7,1.62,0.94l0.36,2.54 c0.05,0.24,0.24,0.41,0.48,0.41h3.84c0.24,0,0.44-0.17,0.47-0.41l0.36-2.54c0.59-0.24,1.13-0.56,1.62-0.94l2.39,0.96 c0.22,0.08,0.47,0,0.59-0.22l1.92-3.32c0.12-0.22,0.07-0.47-0.12-0.61L19.14,12.94z M12,15.6c-1.98,0-3.6-1.62-3.6-3.6 s1.62-3.6,3.6-3.6s3.6,1.62,3.6,3.6S13.98,15.6,12,15.6z" />
          </svg>
          <h2 style={{ fontSize: 16, fontWeight: 600, flex: 1 }}>
            Admin LLM Settings
          </h2>
          <button
            onClick={onClose}
            style={{
              border: "none",
              background: "none",
              cursor: "pointer",
              color: "var(--md-on-surface)",
              fontSize: 20,
              lineHeight: 1,
              padding: "2px 6px",
              borderRadius: 6,
            }}
          >
            ×
          </button>
        </div>

        {loading ? (
          <p style={{ color: "var(--md-on-surface)", opacity: 0.6, textAlign: "center" }}>
            Loading...
          </p>
        ) : (
          <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
            <label style={{ display: "flex", flexDirection: "column", gap: 4 }}>
              <span style={{ fontSize: 12, fontWeight: 500, opacity: 0.7 }}>
                API URL
              </span>
              <input
                type="url"
                value={settings.apiUrl}
                onChange={(e) =>
                  setSettings((s) => ({ ...s, apiUrl: e.target.value }))
                }
                placeholder="https://api.openai.com/v1"
                style={inputStyle}
              />
            </label>

            <label style={{ display: "flex", flexDirection: "column", gap: 4 }}>
              <span style={{ fontSize: 12, fontWeight: 500, opacity: 0.7 }}>
                API Key {settings.isCustom && "(overridden)"}
              </span>
              <input
                type="password"
                value={settings.apiKey}
                onChange={(e) =>
                  setSettings((s) => ({ ...s, apiKey: e.target.value }))
                }
                placeholder={settings.isCustom ? "••••• (currently set)" : "sk-..."}
                style={inputStyle}
              />
            </label>

            <label style={{ display: "flex", flexDirection: "column", gap: 4 }}>
              <span style={{ fontSize: 12, fontWeight: 500, opacity: 0.7 }}>
                Model
              </span>
              <input
                type="text"
                value={settings.model}
                onChange={(e) =>
                  setSettings((s) => ({ ...s, model: e.target.value }))
                }
                placeholder="gpt-4o"
                style={inputStyle}
              />
            </label>

            {error && (
              <p style={{ color: "var(--md-secondary)", fontSize: 12 }}>{error}</p>
            )}

            <div style={{ display: "flex", gap: 8, justifyContent: "flex-end", marginTop: 4 }}>
              {settings.isCustom && (
                <button
                  onClick={handleReset}
                  disabled={saving}
                  style={secondaryBtnStyle}
                >
                  Reset to defaults
                </button>
              )}
              <button
                onClick={handleSave}
                disabled={saving}
                style={{
                  ...primaryBtnStyle,
                  ...(saved ? { background: "#4caf50" } : {}),
                }}
              >
                {saved ? "Saved!" : saving ? "Saving..." : "Save"}
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

const inputStyle: React.CSSProperties = {
  background: "var(--md-surface)",
  border: "1px solid var(--md-outline-var)",
  borderRadius: 8,
  padding: "8px 12px",
  fontSize: 13,
  color: "var(--md-on-surface)",
  outline: "none",
  width: "100%",
};

const primaryBtnStyle: React.CSSProperties = {
  background: "var(--md-primary)",
  color: "#fff",
  border: "none",
  borderRadius: 8,
  padding: "8px 18px",
  fontSize: 13,
  fontWeight: 600,
  cursor: "pointer",
  transition: "background 0.2s",
};

const secondaryBtnStyle: React.CSSProperties = {
  background: "var(--md-surface)",
  color: "var(--md-on-surface)",
  border: "1px solid var(--md-outline-var)",
  borderRadius: 8,
  padding: "8px 18px",
  fontSize: 13,
  cursor: "pointer",
};
