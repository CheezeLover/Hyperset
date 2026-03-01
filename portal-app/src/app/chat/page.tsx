import type { Metadata } from "next";
import { getCurrentUser } from "@/lib/auth";
import { MobileChatPage } from "./MobileChatPage";

export const metadata: Metadata = {
  title: "Chat – Hyperset",
  description: "Ask questions about your data",
};

export default async function ChatRoute() {
  const user = await getCurrentUser();

  const supersetUrl =
    process.env.SUPERSET_PUBLIC_URL ??
    `https://superset.${process.env.HYPERSET_DOMAIN ?? "hyperset.internal"}`;

  return <MobileChatPage supersetUrl={supersetUrl} isAdmin={user.isAdmin} />;
}
