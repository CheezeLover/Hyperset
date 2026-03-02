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
          
          // Map theme colors to CSS variables
          root.style.setProperty('--md-primary', colors.primary || '#20a7c9');
          root.style.setProperty('--md-primary-muted', colors.primaryLight || '#4dbdd6');
          root.style.setProperty('--md-primary-cont', colors.border || '#e0f4f8');
          root.style.setProperty('--md-on-primary-cont', colors.primaryDark || '#0c6a82');
          
          root.style.setProperty('--md-secondary', colors.secondary || '#c75b39');
          root.style.setProperty('--md-secondary-muted', colors.secondary || '#e8845f');
          root.style.setProperty('--md-secondary-cont', colors.border || '#fbe9e7');
          root.style.setProperty('--md-on-sec-cont', colors.textMuted || '#7f2e14');
          
          root.style.setProperty('--md-surface', colors.background || '#f5f3f0');
          root.style.setProperty('--md-surface-cont', colors.surface || '#ffffff');
          root.style.setProperty('--md-surface-cont-hi', colors.border || '#eceae7');
          root.style.setProperty('--md-on-surface', colors.text || '#1c1b1f');
          root.style.setProperty('--md-outline', colors.border || '#cac5be');
          root.style.setProperty('--md-outline-var', colors.border || '#ddd8d2');
          
          console.log('Theme loaded:', theme.name || 'Custom');
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
