'use client';

import { useEffect, useState } from 'react';

interface ThemeColors {
  primary: string;
  primaryDark: string;
  primaryLight: string;
  secondary: string;
  background: string;
  surface: string;
  text: string;
  textMuted: string;
  border: string;
  success: string;
  warning: string;
  error: string;
  info: string;
}

interface ThemeData {
  name?: string;
  hyperset?: {
    colors?: ThemeColors;
  };
}

export function ThemeProvider({ children }: { children: React.ReactNode }) {
  const [themeLoaded, setThemeLoaded] = useState(false);

  useEffect(() => {
    async function loadTheme() {
      try {
        const response = await fetch('/theme.json');
        if (!response.ok) {
          console.log('Theme not found, using defaults');
          return;
        }
        
        const theme: ThemeData = await response.json();
        
        if (theme.hyperset?.colors) {
          const colors = theme.hyperset.colors;
          const root = document.documentElement;
          
          // Set theme color variables (CSS maps these to --md-* variables)
          root.style.setProperty('--theme-primary', colors.primary);
          root.style.setProperty('--theme-primary-dark', colors.primaryDark);
          root.style.setProperty('--theme-primary-light', colors.primaryLight);
          root.style.setProperty('--theme-secondary', colors.secondary);
          root.style.setProperty('--theme-secondary-light', colors.secondary);
          root.style.setProperty('--theme-background', colors.background);
          root.style.setProperty('--theme-surface', colors.surface);
          root.style.setProperty('--theme-text', colors.text);
          root.style.setProperty('--theme-text-muted', colors.textMuted);
          root.style.setProperty('--theme-border', colors.border);
          root.style.setProperty('--theme-border-muted', colors.border);
          root.style.setProperty('--theme-border-light', colors.border);
          
          console.log('[Theme] Runtime theme loaded:', theme.name || 'Custom');
          console.log('[Theme] Primary color set to:', colors.primary);
          console.log('[Theme] CSS variable --md-primary is now:', getComputedStyle(root).getPropertyValue('--md-primary'));
        } else {
          console.log('[Theme] No hyperset.colors found in theme.json');
        }
      } catch (error) {
        console.error('Failed to load theme:', error);
      } finally {
        setThemeLoaded(true);
      }
    }

    loadTheme();
  }, []);

  return <>{children}</>;
}
