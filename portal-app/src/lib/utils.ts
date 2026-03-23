// ── Shared formatting helpers ──────────────────────────────────────────────────
// This file is imported by both server and client components — keep it free of
// any Node.js or server-only dependencies.

export function formatBytes(bytes: number): string {
  if (bytes === 0) return "0 B";
  const k = 1024;
  const sizes = ["B", "KB", "MB", "GB"];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return parseFloat((bytes / Math.pow(k, i)).toFixed(1)) + " " + sizes[i];
}
