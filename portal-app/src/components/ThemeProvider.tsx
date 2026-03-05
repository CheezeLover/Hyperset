'use client';

import { useEffect, useState, useCallback } from 'react';

// Simplified palette structure matching theme.json v2
interface Palette {
  primary: {
    base: string;
    dark: string;
    light: string;
    muted: string;
  };
  secondary: {
    base: string;
    light: string;
    muted: string;
  };
  background: {
    light: string;
    dark: string;
  };
  surface: {
    light: string;
    dark: string;
    higher: string;
  };
  text: {
    primary: { light: string; dark: string };
    secondary: { light: string; dark: string };
    muted: { light: string; dark: string };
    inverse: { light: string; dark: string };
  };
  icon: {
    primary: { light: string; dark: string };
    secondary: { light: string; dark: string };
  };
  border: {
    light: string;
    dark: string;
    secondaryLight: string;
    secondaryDark: string;
  };
}

interface ThemeData {
  name?: string;
  palette?: Palette;
}

function getSystemDarkMode(): boolean {
  if (typeof window !== 'undefined') {
    return window.matchMedia('(prefers-color-scheme: dark)').matches;
  }
  return false;
}

function applyThemeColors(palette: Palette, isDark: boolean) {
  const root = document.documentElement;
  
  if (isDark) {
    // Dark mode - use inverted colors for better contrast
    root.style.setProperty('--theme-primary', palette.primary.muted);
    root.style.setProperty('--theme-primary-dark', palette.primary.dark);
    root.style.setProperty('--theme-primary-light', palette.primary.muted);
    root.style.setProperty('--theme-primary-text', palette.text.inverse.dark); // Dark text on orange
    root.style.setProperty('--theme-icon-primary', palette.icon?.primary?.dark || palette.primary.muted);
    root.style.setProperty('--theme-secondary', palette.secondary.muted);
    root.style.setProperty('--theme-secondary-light', palette.secondary.muted);
    root.style.setProperty('--theme-background', palette.background.dark);
    root.style.setProperty('--theme-surface', palette.surface.dark);
    root.style.setProperty('--theme-text', palette.text.primary.dark);
    root.style.setProperty('--theme-text-muted', palette.text.muted.dark);
    root.style.setProperty('--theme-border', palette.border.dark);
    root.style.setProperty('--theme-border-muted', palette.border.secondaryDark);
    root.style.setProperty('--theme-border-light', palette.border.secondaryDark);
  } else {
    // Light mode
    root.style.setProperty('--theme-primary', palette.primary.base);
    root.style.setProperty('--theme-primary-dark', palette.primary.dark);
    root.style.setProperty('--theme-primary-light', palette.primary.light);
    root.style.setProperty('--theme-primary-text', '#FFFFFF');
    root.style.setProperty('--theme-icon-primary', palette.icon?.primary?.light || palette.primary.base);
    root.style.setProperty('--theme-secondary', palette.secondary.base);
    root.style.setProperty('--theme-secondary-light', palette.secondary.light);
    root.style.setProperty('--theme-background', palette.background.light);
    root.style.setProperty('--theme-surface', palette.surface.light);
    root.style.setProperty('--theme-text', palette.text.primary.light);
    root.style.setProperty('--theme-text-muted', palette.text.muted.light);
    root.style.setProperty('--theme-border', palette.border.light);
    root.style.setProperty('--theme-border-muted', palette.border.secondaryLight);
    root.style.setProperty('--theme-border-light', palette.border.secondaryLight);
  }
  
  root.style.setProperty('--theme-is-dark', isDark ? '1' : '0');
}

export function ThemeProvider({ children }: { children: React.ReactNode }) {
  const [themeLoaded, setThemeLoaded] = useState(false);

  const loadTheme = useCallback(async () => {
    try {
      const response = await fetch('/theme.json');
      if (!response.ok) {
        console.log('Theme not found, using defaults');
        return null;
      }
      
      const theme: ThemeData = await response.json();
      console.log('[Theme] Runtime theme loaded:', theme.name || 'Custom');
      return theme;
    } catch (error) {
      console.error('Failed to load theme:', error);
      return null;
    }
  }, []);

  const applyTheme = useCallback((theme: ThemeData, isDark: boolean) => {
    if (theme.palette) {
      applyThemeColors(theme.palette, isDark);
      console.log('[Theme] Applied', isDark ? 'dark' : 'light', 'mode colors');
    }
  }, []);

  useEffect(() => {
    async function init() {
      const theme = await loadTheme();
      if (theme) {
        const isDark = getSystemDarkMode();
        applyTheme(theme, isDark);
        
        const mediaQuery = window.matchMedia('(prefers-color-scheme: dark)');
        const handleChange = (e: MediaQueryListEvent) => {
          applyTheme(theme, e.matches);
        };
        mediaQuery.addEventListener('change', handleChange);
        
        setThemeLoaded(true);
      } else {
        setThemeLoaded(true);
      }
    }

    init();
  }, [loadTheme, applyTheme]);

  return <>{children}</>;
}
