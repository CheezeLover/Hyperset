"use client";

import React from "react";

interface SupersetPanelProps {
  src: string;
  iframeRef: React.RefObject<HTMLIFrameElement | null>;
}

export function SupersetPanel({ src, iframeRef }: SupersetPanelProps) {
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
