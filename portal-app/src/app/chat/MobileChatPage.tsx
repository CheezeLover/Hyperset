"use client";

import { useRef, useState } from "react";
import { ChatPanel, type Message } from "@/components/ChatPanel";

interface MobileChatPageProps {
  supersetUrl: string;
  isAdmin: boolean;
}

/**
 * Full-screen chat UI served at chat.{HYPERSET_DOMAIN}.
 *
 * There is no Superset iframe on this page; all iframe refs are null and
 * navigation postMessages are no-ops (ChatPanel guards every access with
 * optional chaining).  The supersetUrl is still needed so the markdown
 * renderer can whitelist embedded chart iframes and construct correct links.
 */
export function MobileChatPage({ supersetUrl, isAdmin }: MobileChatPageProps) {
  // Null ref — no Superset iframe present on this page.
  const nullIframeRef = useRef<HTMLIFrameElement | null>(null);
  const [messages, setMessages] = useState<Message[]>([]);
  const [supersetContext, setSupersetContext] = useState<{ dashboardId?: string; chartId?: string; url: string }>({ url: "" });

  return (
    // 100dvh accounts for mobile browser chrome (dynamic viewport height).
    <div style={{ height: "100dvh", display: "flex", flexDirection: "column" }}>
      <ChatPanel
        isAdmin={isAdmin}
        supersetIframeRef={nullIframeRef}
        supersetUrl={supersetUrl}
        injectedMessage={null}
        onInjectionConsumed={() => {}}
        messages={messages}
        onMessagesChange={setMessages}
        supersetContext={supersetContext}
        onSupersetContextChange={setSupersetContext}
      />
    </div>
  );
}
