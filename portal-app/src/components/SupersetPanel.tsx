"use client";

import React, { useEffect, useRef } from "react";

interface SupersetPanelProps {
  src: string;
  iframeRef: React.RefObject<HTMLIFrameElement | null>;
}

export function SupersetPanel({ src, iframeRef }: SupersetPanelProps) {
  const lastUrlRef = useRef<string>(src);

  useEffect(() => {
    const reportUrl = async () => {
      const currentUrl = iframeRef.current?.src;
      if (currentUrl && currentUrl !== lastUrlRef.current) {
        lastUrlRef.current = currentUrl;
        try {
          await fetch("/api/superset-iframe-url", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ url: currentUrl }),
          });
        } catch {
          // Silently ignore errors - URL reporting is best-effort
        }
      }
    };

    const interval = setInterval(reportUrl, 2000);
    reportUrl();

    return () => clearInterval(interval);
  }, [iframeRef]);

  return (
    <iframe
      ref={iframeRef}
      src={src}
      title="Superset Dashboard"
      style={{
        flex: 1,
        border: "none",
        width: "100%",
        height: "100%",
        display: "block",
      }}
      allow="fullscreen"
    />
  );
}
