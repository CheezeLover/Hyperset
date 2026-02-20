import type { Metadata } from "next";
import "./globals.css";
import { getCurrentUser } from "@/lib/auth";
import "@copilotkit/react-ui/styles.css";

export const metadata: Metadata = {
  title: "Hyperset",
  description: "Analytics Portal",
  icons: { icon: "/logo_hyperset.png" },
};

export default async function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  const user = await getCurrentUser();

  return (
    <html lang="en">
      <body data-user-id={user.id} data-is-admin={user.isAdmin ? "true" : "false"}>
        {children}
      </body>
    </html>
  );
}
