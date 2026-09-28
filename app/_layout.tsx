import { DarkTheme, DefaultTheme, ThemeProvider as NavigationThemeProvider } from '@react-navigation/native';
import { Stack } from 'expo-router';
import { StatusBar } from 'expo-status-bar';
import * as SystemUI from 'expo-system-ui';
import React, { useEffect, useMemo } from 'react';
import { View, ActivityIndicator } from 'react-native';
import { SafeAreaProvider } from 'react-native-safe-area-context';
import { GestureHandlerRootView } from 'react-native-gesture-handler';
import 'react-native-reanimated';

import { AccountProvider } from '@/contexts/AccountContext';
import { ThemeProvider, useTheme } from '@/contexts/ThemeContext';
import { AuthProvider, useAuth } from '@/contexts/AuthContext';
import { PrivacyProvider } from '@/contexts/PrivacyContext';
import { LoginScreen } from '@/components/LoginScreen';
import { AppDialogProvider } from '@/components/AppDialog';

export const unstable_settings = {
  anchor: '(tabs)',
};

// Status-bar icons and the native window behind the React tree follow the APP
// theme (which can differ from the system one), so dark mode is black edge to edge.
function SystemChrome() {
  const { theme } = useTheme();
  useEffect(() => {
    SystemUI.setBackgroundColorAsync(theme.colors.background).catch(() => {});
  }, [theme.colors.background]);
  return <StatusBar style={theme.isDark ? 'light' : 'dark'} />;
}

// Shows a spinner while restoring the session, the login screen if signed out,
// or the app once authenticated.
function AuthGate({ children }: { children: React.ReactNode }) {
  const { user, initializing } = useAuth();
  const { theme } = useTheme();
  if (initializing) {
    return (
      <View style={{ flex: 1, justifyContent: 'center', alignItems: 'center', backgroundColor: theme.colors.background }}>
        <ActivityIndicator size="large" />
      </View>
    );
  }
  if (!user) return <LoginScreen />;
  return <>{children}</>;
}

// The navigators paint this behind every screen: dark mode uses the app's own
// black palette instead of React Navigation's defaults; light mode is unchanged.
function ThemedNavigation({ children }: { children: React.ReactNode }) {
  const { theme } = useTheme();
  const navTheme = useMemo(
    () =>
      theme.isDark
        ? {
            ...DarkTheme,
            colors: {
              ...DarkTheme.colors,
              primary: theme.colors.primary,
              background: theme.colors.background,
              card: theme.colors.card,
              text: theme.colors.text,
              border: theme.colors.border,
            },
          }
        : DefaultTheme,
    [theme],
  );
  return <NavigationThemeProvider value={navTheme}>{children}</NavigationThemeProvider>;
}

export default function RootLayout() {
  return (
    <GestureHandlerRootView style={{ flex: 1 }}>
      <SafeAreaProvider>
        <ThemeProvider>
          {/* Themed replacement for the system Alert — rendered above every screen and sheet. */}
          <AppDialogProvider>
            <SystemChrome />
            <AuthProvider>
              <AuthGate>
                <AccountProvider>
                  <PrivacyProvider>
                    <ThemedNavigation>
                      <Stack>
                        <Stack.Screen name="(tabs)" options={{ headerShown: false }} />
                        <Stack.Screen name="modal" options={{ presentation: 'modal', title: 'Modal' }} />
                      </Stack>
                    </ThemedNavigation>
                  </PrivacyProvider>
                </AccountProvider>
              </AuthGate>
            </AuthProvider>
          </AppDialogProvider>
        </ThemeProvider>
      </SafeAreaProvider>
    </GestureHandlerRootView>
  );
}
