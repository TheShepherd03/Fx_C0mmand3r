import React, { useEffect, useRef } from 'react';
import { StyleSheet, Text, TouchableOpacity } from 'react-native';
import Animated, { FadeInDown, FadeOutDown } from 'react-native-reanimated';

import { useTheme } from '@/contexts/ThemeContext';

export interface ToastData {
  /** Unique per toast — a new id restarts the timer and the entry animation. */
  id: number;
  message: string;
  actionLabel?: string;
  onAction?: () => void;
}

const VISIBLE_MS = 5000;

/**
 * Snackbar-style toast ("Dismissed XAUUSD · UNDO"). Render it as the last child of
 * a screen container; it floats over the content and hides itself after 5s.
 */
export function UndoToast({
  toast,
  onHide,
  bottom = 16,
}: {
  toast: ToastData | null;
  onHide: () => void;
  bottom?: number;
}) {
  const { theme } = useTheme();
  const hideRef = useRef(onHide);

  useEffect(() => {
    hideRef.current = onHide;
  }, [onHide]);

  useEffect(() => {
    if (!toast) return;
    const t = setTimeout(() => hideRef.current(), VISIBLE_MS);
    return () => clearTimeout(t);
  }, [toast]);

  if (!toast) return null;

  // Inverted surface so it stands out in both themes.
  const bg = theme.colors.text;
  const fg = theme.colors.background;
  const accent = theme.isDark ? theme.colors.primary : theme.colors.accent;
  const actionLabel = toast.actionLabel ?? 'Undo';

  return (
    <Animated.View
      key={toast.id}
      entering={FadeInDown.duration(220)}
      exiting={FadeOutDown.duration(160)}
      accessibilityLiveRegion="polite"
      style={[styles.toast, { bottom, backgroundColor: bg }]}>
      <Text style={[styles.message, { color: fg }]} numberOfLines={2}>
        {toast.message}
      </Text>
      {toast.onAction ? (
        <TouchableOpacity
          onPress={() => {
            toast.onAction?.();
            hideRef.current();
          }}
          hitSlop={{ top: 10, bottom: 10, left: 10, right: 10 }}
          accessibilityRole="button"
          accessibilityLabel={actionLabel}>
          <Text style={[styles.action, { color: accent }]}>{actionLabel.toUpperCase()}</Text>
        </TouchableOpacity>
      ) : null}
    </Animated.View>
  );
}

const styles = StyleSheet.create({
  toast: {
    position: 'absolute',
    left: 16,
    right: 16,
    minHeight: 48,
    borderRadius: 14,
    paddingHorizontal: 16,
    paddingVertical: 12,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 16,
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 6 },
    shadowOpacity: 0.25,
    shadowRadius: 14,
    elevation: 10,
  },
  message: {
    flex: 1,
    fontSize: 14,
    fontWeight: '600',
  },
  action: {
    fontSize: 13,
    fontWeight: '800',
    letterSpacing: 0.8,
  },
});
