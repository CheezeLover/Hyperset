import type { Metadata } from "next";
import "./globals.css";
import { getCurrentUser } from "@/lib/auth";
import { ThemeProvider } from "@/components/ThemeProvider";
import { readFileSync } from "fs";
import { join } from "path";

export const metadata: Metadata = {
  title: "Hyperset",
  description: "Analytics Portal",
  icons: { icon: "/logo_hyperset.png" },
};

// Read theme at build time for SSR
function getThemeScript() {
  try {
    const themePath = join(process.cwd(), "..", "theme.json");
    const themeContent = readFileSync(themePath, "utf-8");
    const theme = JSON.parse(themeContent);
    
    if (theme.hyperset?.colors) {
      const colors = theme.hyperset.colors;
      return `
        (function() {
          const root = document.documentElement;
          root.style.setProperty('--theme-primary', '${colors.primary}');
          root.style.setProperty('--theme-primary-dark', '${colors.primaryDark}');
          root.style.setProperty('--theme-primary-light', '${colors.primaryLight}');
          root.style.setProperty('--theme-secondary', '${colors.secondary}');
          root.style.setProperty('--theme-secondary-light', '${colors.secondary}');
          root.style.setProperty('--theme-background', '${colors.background}');
          root.style.setProperty('--theme-surface', '${colors.surface}');
          root.style.setProperty('--theme-text', '${colors.text}');
          root.style.setProperty('--theme-text-muted', '${colors.textMuted}');
          root.style.setProperty('--theme-border', '${colors.border}');
          root.style.setProperty('--theme-border-muted', '${colors.border}');
          root.style.setProperty('--theme-border-light', '${colors.border}');
        })();
      `;
    }
  } catch (e) {
    console.log("Theme not found at build time, will load at runtime");
  }
  return "";
}

export default async function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  const user = await getCurrentUser();
  const themeScript = getThemeScript();

  return (
    <html lang="en">
      <head>
        {themeScript && (
          <script dangerouslySetInnerHTML={{ __html: themeScript }} />
        )}
      </head>
      <body data-user-id={user.id} data-is-admin={user.isAdmin ? "true" : "false"}>
        <ThemeProvider>
          {children}
        </ThemeProvider>
      </body>
    </html>
  );
}
