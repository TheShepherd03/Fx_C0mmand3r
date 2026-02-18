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

    // Text colors
    text: string;
    textSecondary: string;
    textTertiary: string;

    // Brand colors
    primary: string;
    primaryText: string;

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
  };
  isDark: boolean;
}

const lightTheme: Theme = {
  colors: {
    background: '#F5F5F5',
    surface: '#FFFFFF',
    card: '#FFFFFF',
    overlay: 'rgba(0, 0, 0, 0.5)',

    text: '#333333',
    textSecondary: '#666666',
    textTertiary: '#999999',

    primary: '#007AFF',
    primaryText: '#FFFFFF',

    success: '#4CAF50',
    error: '#F44336',
    warning: '#FF9800',
    info: '#2196F3',

    border: '#E0E0E0',
    divider: '#F0F0F0',

    buttonBackground: '#007AFF',
    buttonText: '#FFFFFF',
    buttonSecondary: '#F8F9FA',

    profit: '#4CAF50',
    loss: '#F44336',
    buy: '#4CAF50',
    sell: '#F44336',
  },
  isDark: false,
};

const darkTheme: Theme = {
  colors: {
    background: '#121212',
    surface: '#1E1E1E',
    card: '#2D2D2D',
    overlay: 'rgba(0, 0, 0, 0.7)',

    text: '#FFFFFF',
    textSecondary: '#B3B3B3',
    textTertiary: '#808080',

    primary: '#0A84FF',
    primaryText: '#FFFFFF',

    success: '#30D158',
    error: '#FF453A',
    warning: '#FF9F0A',
    info: '#007AFF',

    border: '#3A3A3A',
    divider: '#2A2A2A',

    buttonBackground: '#0A84FF',
    buttonText: '#FFFFFF',
    buttonSecondary: '#2A2A2A',

    profit: '#30D158',
    loss: '#FF453A',
    buy: '#30D158',
    sell: '#FF453A',
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
