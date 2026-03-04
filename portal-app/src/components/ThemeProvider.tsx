'use client';

import { useEffect, useState, useCallback } from 'react';

interface ThemeColors {
  primary: string;
  primaryDark: string;
  primaryLight: string;
  primaryText?: string;
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
    colorsDark?: ThemeColors;
  };
}

function getSystemDarkMode(): boolean {
  if (typeof window !== 'undefined') {
    return window.matchMedia('(prefers-color-scheme: dark)').matches;
  }
  return false;
}

function applyColors(colors: ThemeColors, isDark: boolean) {
  const root = document.documentElement;
  
  root.style.setProperty('--theme-primary', colors.primary);
  root.style.setProperty('--theme-primary-dark', colors.primaryDark);
  root.style.setProperty('--theme-primary-light', colors.primaryLight);
  root.style.setProperty('--theme-primary-text', colors.primaryText || (isDark ? '#0A0A0A' : '#FFFFFF'));
  root.style.setProperty('--theme-secondary', colors.secondary);
  root.style.setProperty('--theme-secondary-light', colors.secondary);
  root.style.setProperty('--theme-background', colors.background);
  root.style.setProperty('--theme-surface', colors.surface);
  root.style.setProperty('--theme-text', colors.text);
  root.style.setProperty('--theme-text-muted', colors.textMuted);
  root.style.setProperty('--theme-border', colors.border);
  root.style.setProperty('--theme-border-muted', colors.border);
  root.style.setProperty('--theme-border-light', colors.border);
  
  root.style.setProperty('--theme-is-dark', isDark ? '1' : '0');
  
  if (isDark) {
    root.style.setProperty('--theme-dark-primary', colors.primary);
    root.style.setProperty('--theme-dark-primary-dark', colors.primaryDark);
    root.style.setProperty('--theme-dark-primary-light', colors.primaryLight);
    root.style.setProperty('--theme-dark-primary-text', colors.primaryText || '#0A0A0A');
    root.style.setProperty('--theme-dark-secondary', colors.secondary);
    root.style.setProperty('--theme-dark-background', colors.background);
    root.style.setProperty('--theme-dark-surface', colors.surface);
    root.style.setProperty('--theme-dark-text', colors.text);
    root.style.setProperty('--theme-dark-text-muted', colors.textMuted);
    root.style.setProperty('--theme-dark-border', colors.border);
  }
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
    const colors = isDark && theme.hyperset?.colorsDark 
      ? theme.hyperset.colorsDark 
      : theme.hyperset?.colors;
    
    if (colors) {
      applyColors(colors, isDark);
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
