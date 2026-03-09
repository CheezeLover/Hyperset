import type { Metadata } from "next";
import "./globals.css";
import { getCurrentUser } from "@/lib/auth";
import { ThemeProvider } from "@/components/ThemeProvider";
import { readFileSync } from "fs";
import { join } from "path";

export const metadata: Metadata = {
  title: "Hyperset",
  description: "Analytics Portal",
  icons: { icon: "/logos/hyperset-logo-only.png" },
};

// Read theme at build time for SSR
function getThemeScript() {
  try {
    // Try multiple possible locations for theme.json
    const possiblePaths = [
      join(process.cwd(), "theme.json"),
      join(process.cwd(), "..", "theme.json"),
      "/app/theme.json",
    ];
    
    for (const themePath of possiblePaths) {
      try {
        const themeContent = readFileSync(themePath, "utf-8");
        const theme = JSON.parse(themeContent);
        
        // Use new simplified palette structure
        const palette = theme.palette;
        if (palette) {
          // Light mode colors
          const primary = palette.primary?.base || '#D35400';
          const primaryDark = palette.primary?.dark || '#A04000';
          const primaryLight = palette.primary?.light || '#E67E22';
          const textPrimary = palette.text?.primary?.light || '#1F2937';
          const textMuted = palette.text?.muted?.light || '#6B7280';
          const iconPrimaryLight = palette.icon?.primary?.light || '#D35400';
          const background = palette.background?.light || '#F8F9FA';
          const surface = palette.surface?.light || '#FFFFFF';
          const border = palette.border?.light || '#DEE2E6';
          const secondary = palette.secondary?.base || '#57606F';
          
          // Dark mode colors
          const primaryDarkMode = palette.primary?.muted || '#FF8A5C';
          const primaryDarkDark = palette.primary?.dark || '#FF6B35';
          const textDarkMode = palette.text?.primary?.dark || '#FAFAFA';
          const textMutedDark = palette.text?.muted?.dark || '#A3A3A3';
          const textInverseDark = palette.text?.inverse?.dark || '#0A0A0A';
          const iconPrimaryDark = palette.icon?.primary?.dark || '#FF8A5C';
          const backgroundDark = palette.background?.dark || '#0A0A0A';
          const surfaceDark = palette.surface?.dark || '#141414';
          const borderDark = palette.border?.dark || '#404040';
          const secondaryDark = palette.secondary?.muted || '#9CA3AF';
          
          return `
            (function() {
              const root = document.documentElement;
              const isDark = window.matchMedia('(prefers-color-scheme: dark)').matches;
              
              if (isDark) {
                // Dark mode
                root.style.setProperty('--theme-primary', '${primaryDarkMode}');
                root.style.setProperty('--theme-primary-dark', '${primaryDarkDark}');
                root.style.setProperty('--theme-primary-light', '${primaryDarkMode}');
                root.style.setProperty('--theme-primary-text', '${textInverseDark}');
                root.style.setProperty('--theme-icon-primary', '${iconPrimaryDark}');
                root.style.setProperty('--theme-secondary', '${secondaryDark}');
                root.style.setProperty('--theme-secondary-light', '${secondaryDark}');
                root.style.setProperty('--theme-background', '${backgroundDark}');
                root.style.setProperty('--theme-surface', '${surfaceDark}');
                root.style.setProperty('--theme-text', '${textDarkMode}');
                root.style.setProperty('--theme-text-muted', '${textMutedDark}');
                root.style.setProperty('--theme-border', '${borderDark}');
                root.style.setProperty('--theme-border-muted', '${borderDark}');
                root.style.setProperty('--theme-border-light', '${borderDark}');
                root.style.setProperty('--theme-is-dark', '1');
              } else {
                // Light mode
                root.style.setProperty('--theme-primary', '${primary}');
                root.style.setProperty('--theme-primary-dark', '${primaryDark}');
                root.style.setProperty('--theme-primary-light', '${primaryLight}');
                root.style.setProperty('--theme-primary-text', '#FFFFFF');
                root.style.setProperty('--theme-icon-primary', '${iconPrimaryLight}');
                root.style.setProperty('--theme-secondary', '${secondary}');
                root.style.setProperty('--theme-secondary-light', '${secondary}');
                root.style.setProperty('--theme-background', '${background}');
                root.style.setProperty('--theme-surface', '${surface}');
                root.style.setProperty('--theme-text', '${textPrimary}');
                root.style.setProperty('--theme-text-muted', '${textMuted}');
                root.style.setProperty('--theme-border', '${border}');
                root.style.setProperty('--theme-border-muted', '${border}');
                root.style.setProperty('--theme-border-light', '${border}');
                root.style.setProperty('--theme-is-dark', '0');
              }
              
              console.log('[Theme] Build-time theme loaded: ${theme.name || "Custom"}');
            })();
          `;
        }
      } catch (e) {
        // Try next path
      }
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
        <link rel="icon" href="/logos/hyperset-logo-only.png" />
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
