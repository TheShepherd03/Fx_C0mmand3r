import React, { createContext, useContext, useState, useEffect, ReactNode } from 'react';
import { useColorScheme } from 'react-native';
import AsyncStorage from '@react-native-async-storage/async-storage';

export interface Theme {
  colors: {
    // Background colors
    background: string;
    surface: string;
    card: string;
    overlay: string;
    input: string;

    // Text colors
    text: string;
    textSecondary: string;
    textTertiary: string;

    // Brand colors
    primary: string;
    primaryText: string;
    accent: string;

    // Status colors
    success: string;
    error: string;
    warning: string;
    info: string;

    // Border colors
    border: string;
    divider: string;

    // Interactive colors
    buttonBackground: string;
    buttonText: string;
    buttonSecondary: string;

    // Trading specific
    profit: string;
    loss: string;
    buy: string;
    sell: string;
    buyBackground: string;
    sellBackground: string;
  };
  isDark: boolean;
}

const lightTheme: Theme = {
  colors: {
    background: '#F8FAFC', // Slate 50
    surface: '#FFFFFF',
    card: '#FFFFFF',
    overlay: 'rgba(0, 0, 0, 0.5)',
    input: '#F1F5F9',      // Slate 100

    text: '#0F172A',       // Slate 900
    textSecondary: '#64748B', // Slate 500
    textTertiary: '#94A3B8',  // Slate 400

    primary: '#3B82F6',    // Blue 500
    primaryText: '#FFFFFF',
    accent: '#60A5FA',     // Blue 400

    success: '#10B981',    // Emerald 500
    error: '#EF4444',      // Red 500
    warning: '#F59E0B',    // Amber 500
    info: '#3B82F6',       // Blue 500

    border: '#E2E8F0',     // Slate 200
    divider: '#F1F5F9',    // Slate 100

    buttonBackground: '#3B82F6',
    buttonText: '#FFFFFF',
    buttonSecondary: '#F1F5F9',

    profit: '#10B981',
    loss: '#EF4444',
    buy: '#10B981',
    sell: '#EF4444',
    buyBackground: '#ECFDF5',
    sellBackground: '#FEF2F2',
  },
  isDark: false,
};

const darkTheme: Theme = {
  colors: {
    background: '#0F172A', // Slate 900
    surface: '#1E293B',    // Slate 800
    card: '#1E293B',       // Slate 800
    overlay: 'rgba(0, 0, 0, 0.7)',
    input: '#334155',      // Slate 700

    text: '#F8FAFC',       // Slate 50
    textSecondary: '#94A3B8', // Slate 400
    textTertiary: '#64748B',  // Slate 500

    primary: '#3B82F6',    // Blue 500
    primaryText: '#FFFFFF',
    accent: '#60A5FA',     // Blue 400

    success: '#10B981',    // Emerald 500
    error: '#EF4444',      // Red 500
    warning: '#F59E0B',    // Amber 500
    info: '#3B82F6',       // Blue 500

    border: '#334155',     // Slate 700
    divider: '#334155',    // Slate 700

    buttonBackground: '#3B82F6',
    buttonText: '#FFFFFF',
    buttonSecondary: '#334155',

    profit: '#10B981',
    loss: '#EF4444',
    buy: '#10B981',
    sell: '#EF4444',
    buyBackground: 'rgba(16, 185, 129, 0.15)',
    sellBackground: 'rgba(239, 68, 68, 0.15)',
  },
  isDark: true,
};

interface ThemeContextType {
  theme: Theme;
  toggleTheme: () => void;
  setTheme: (theme: 'light' | 'dark' | 'system') => void;
  themePreference: 'light' | 'dark' | 'system';
}

const ThemeContext = createContext<ThemeContextType | undefined>(undefined);

interface ThemeProviderProps {
  children: ReactNode;
}

const THEME_STORAGE_KEY = '@theme_preference';

export function ThemeProvider({ children }: ThemeProviderProps) {
  const systemColorScheme = useColorScheme();
  const [themePreference, setThemePreference] = useState<'light' | 'dark' | 'system'>('system');
  const [currentTheme, setCurrentTheme] = useState<Theme>(
    systemColorScheme === 'dark' ? darkTheme : lightTheme
  );

  // Load theme preference from storage
  useEffect(() => {
    const loadThemePreference = async () => {
      try {
        const storedTheme = await AsyncStorage.getItem(THEME_STORAGE_KEY);
        if (storedTheme && ['light', 'dark', 'system'].includes(storedTheme)) {
          setThemePreference(storedTheme as 'light' | 'dark' | 'system');
        }
      } catch (error) {
        console.log('Error loading theme preference:', error);
      }
    };
    loadThemePreference();
  }, []);

  // Update theme when preference or system theme changes
  useEffect(() => {
    let effectiveTheme: Theme;

    switch (themePreference) {
      case 'light':
        effectiveTheme = lightTheme;
        break;
      case 'dark':
        effectiveTheme = darkTheme;
        break;
      case 'system':
      default:
        effectiveTheme = systemColorScheme === 'dark' ? darkTheme : lightTheme;
        break;
    }

    setCurrentTheme(effectiveTheme);
  }, [themePreference, systemColorScheme]);

  const setTheme = async (newTheme: 'light' | 'dark' | 'system') => {
    try {
      await AsyncStorage.setItem(THEME_STORAGE_KEY, newTheme);
      setThemePreference(newTheme);
    } catch (error) {
      console.log('Error saving theme preference:', error);
    }
  };

  const toggleTheme = () => {
    const nextTheme = currentTheme.isDark ? 'light' : 'dark';
    setTheme(nextTheme);
  };

  return (
    <ThemeContext.Provider
      value={{
        theme: currentTheme,
        toggleTheme,
        setTheme,
        themePreference,
      }}
    >
      {children}
    </ThemeContext.Provider>
  );
}

export function useTheme() {
  const context = useContext(ThemeContext);
  if (context === undefined) {
    throw new Error('useTheme must be used within a ThemeProvider');
  }
  return context;
}

// Helper hook for creating themed styles
export function useThemedStyles<T>(styleCreator: (theme: Theme) => T): T {
  const { theme } = useTheme();
  return styleCreator(theme);
}
