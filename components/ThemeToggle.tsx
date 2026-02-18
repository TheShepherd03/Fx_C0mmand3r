import React from 'react';
import { TouchableOpacity, Text, StyleSheet } from 'react-native';
import { useTheme } from '@/contexts/ThemeContext';

export function ThemeToggle() {
  const { theme, toggleTheme } = useTheme();

  return (
    <TouchableOpacity 
      style={[styles.toggleButton, { backgroundColor: theme.colors.buttonSecondary }]} 
      onPress={toggleTheme}
    >
      <Text style={[styles.toggleText, { color: theme.colors.text }]}>
        {theme.isDark ? '☀️' : '🌙'}
      </Text>
    </TouchableOpacity>
  );
}

const styles = StyleSheet.create({
  toggleButton: {
    width: 44,
    height: 44,
    borderRadius: 22,
    justifyContent: 'center',
    alignItems: 'center',
  },
  toggleText: {
    fontSize: 20,
  },
});
