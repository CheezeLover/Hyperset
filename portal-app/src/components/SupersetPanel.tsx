"use client";

import React from "react";

interface SupersetPanelProps {
  src: string;
  iframeRef: React.RefObject<HTMLIFrameElement | null>;
}

export function SupersetPanel({ src, iframeRef }: SupersetPanelProps) {
  return (
    <div style={{ position: "relative", width: "100%", height: "100%", overflow: "hidden" }}>
      <iframe
        ref={iframeRef}
        src={src}
        title="Superset Dashboard"
        style={{
          position: "absolute",
          top: 0,
          left: 0,
          border: "none",
          width: "calc(100% + 20px)",
          height: "calc(100% + 20px)",
          display: "block",
        }}
        allow="fullscreen"
      />
    </div>
  );
}
