import React, { useCallback, useEffect, useRef, useState } from 'react';
import {
  Keyboard,
  Modal,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  View,
  useWindowDimensions,
  type AlertButton,
} from 'react-native';
import Animated, {
  Easing,
  useAnimatedStyle,
  useSharedValue,
  withDelay,
  withSpring,
  withTiming,
} from 'react-native-reanimated';
import { FullWindowOverlay } from 'react-native-screens';
import Svg, { Circle, Path } from 'react-native-svg';
import * as Haptics from 'expo-haptics';

import { useTheme, type Theme } from '@/contexts/ThemeContext';

/**
 * Themed, in-app replacement for React Native's system Alert dialog.
 *
 * Mount <AppDialogProvider> once at the root (inside ThemeProvider), then call
 * `showAlert(title, message?, buttons?, options?)` from anywhere — event
 * handlers, async code, non-component modules — with the same arguments as
 * React Native's Alert API. Pressing a button closes the dialog and then runs its
 * `onPress`; a dialog requested while another is open is queued behind it.
 *
 * Android: a transparent Modal opened after any sheet that is already up, so it
 * always sits on top of it. iOS: a full-window overlay, because a second
 * root-level Modal can't be presented while another Modal is showing there.
 */

export type { AlertButton };

export type AppDialogVariant = 'success' | 'error' | 'warning' | 'info';

export interface ShowAlertOptions {
  /** Android back / backdrop tap dismisses even without a cancel-style button. */
  cancelable?: boolean;
  /** Called when dismissed without a button (back / backdrop, only when cancelable). */
  onDismiss?: () => void;
  /** Icon + haptic. Inferred from the title, message and buttons when omitted. */
  variant?: AppDialogVariant;
}

interface DialogRequest {
  id: number;
  title: string;
  message?: string;
  buttons: AlertButton[];
  options: ShowAlertOptions;
  variant: AppDialogVariant;
}

/* ------------------------------ module API ------------------------------- */

let nextId = 1;
let enqueueDialog: ((req: DialogRequest) => void) | null = null;
// Requests made before the provider mounted; shown as soon as it does.
const earlyRequests: DialogRequest[] = [];

const ERROR_RE = /\b(error|failed|failure|could ?not|couldn['’]t|cannot|can['’]t|unable|invalid|denied)\b/i;
const SUCCESS_RE = /\b(saved|success|successful|successfully|done|updated|sent|completed?|removed|deleted|enabled|resumed)\b/i;
const WARNING_RE =
  /\b(delete|remove|close all|are you sure|kill switch|warning|cannot be undone|missing|required|no account|at least|first)\b/i;

function inferVariant(title: string, message: string | undefined, buttons: AlertButton[]): AppDialogVariant {
  const body = message ?? '';
  if (ERROR_RE.test(title)) return 'error';
  if (SUCCESS_RE.test(title)) return 'success';
  if (buttons.some((b) => b.style === 'destructive')) return 'warning';
  if (WARNING_RE.test(title) || WARNING_RE.test(body)) return 'warning';
  if (ERROR_RE.test(body)) return 'error';
  if (SUCCESS_RE.test(body)) return 'success';
  return 'info';
}

/** Drop-in for RN's Alert: (title, message?, buttons?, options?). No buttons = a single "OK". */
export function showAlert(
  title: string,
  message?: string,
  buttons?: AlertButton[],
  options?: ShowAlertOptions,
): void {
  const list: AlertButton[] = buttons && buttons.length > 0 ? buttons : [{ text: 'OK' }];
  const opts = options ?? {};
  const req: DialogRequest = {
    id: nextId++,
    title: title ?? '',
    message,
    buttons: list,
    options: opts,
    variant: opts.variant ?? inferVariant(title ?? '', message, list),
  };
  if (enqueueDialog) enqueueDialog(req);
  else earlyRequests.push(req);
}

/* -------------------------------- helpers -------------------------------- */

const ENTER_MS = 180;
const EXIT_MS = 140;
const BADGE_SPRING = { damping: 13, stiffness: 240, mass: 0.7 };

const HALO = 64;
const DISC = 48;
const GLYPH = 26;

function withAlpha(color: string, alpha: number) {
  let hex = /^#([0-9a-f]{6})$/i.exec(color || '')?.[1];
  if (!hex) {
    const short = /^#([0-9a-f]{3})$/i.exec(color || '');
    if (short) hex = short[1].split('').map((c) => c + c).join('');
  }
  if (!hex) return color;
  const n = parseInt(hex, 16);
  return `rgba(${(n >> 16) & 255}, ${(n >> 8) & 255}, ${n & 255}, ${alpha})`;
}

function variantColor(variant: AppDialogVariant, theme: Theme) {
  switch (variant) {
    case 'success':
      return theme.colors.profit;
    case 'error':
      return theme.colors.loss;
    case 'warning':
      return theme.colors.warning;
    default:
      return theme.colors.primary;
  }
}

function playHaptic(variant: AppDialogVariant) {
  try {
    const type = Haptics.NotificationFeedbackType;
    const done =
      variant === 'success'
        ? Haptics.notificationAsync(type.Success)
        : variant === 'error'
          ? Haptics.notificationAsync(type.Error)
          : variant === 'warning'
            ? Haptics.notificationAsync(type.Warning)
            : Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
    done.catch(() => {});
  } catch {
    // haptics are best-effort
  }
}

/** Two buttons sit side by side (cancel on the left); three or more stack (cancel last). */
function arrangeButtons(buttons: AlertButton[]) {
  const isCancel = (b: AlertButton) => b.style === 'cancel';
  const cancelLast = [...buttons.filter((b) => !isCancel(b)), ...buttons.filter(isCancel)];
  // Three or more, or two labels too long to sit side by side: stack them.
  if (buttons.length >= 3 || (buttons.length === 2 && buttons.some((b) => (b.text ?? '').length > 16))) {
    return { stacked: true, ordered: cancelLast };
  }
  const ordered = buttons.length === 2 && isCancel(buttons[1]) && !isCancel(buttons[0])
    ? [buttons[1], buttons[0]]
    : buttons;
  return { stacked: false, ordered };
}

/* ------------------------------- rendering ------------------------------- */

function VariantGlyph({ variant, color }: { variant: AppDialogVariant; color: string }) {
  const line = {
    stroke: color,
    strokeWidth: 2.4,
    strokeLinecap: 'round' as const,
    strokeLinejoin: 'round' as const,
    fill: 'none',
  };
  return (
    <Svg width={GLYPH} height={GLYPH} viewBox="0 0 24 24">
      {variant === 'success' && <Path d="M5.5 12.5l4.25 4.25L18.5 8" {...line} />}
      {variant === 'error' && <Path d="M7.5 7.5l9 9M16.5 7.5l-9 9" {...line} />}
      {variant === 'warning' && (
        <>
          <Path d="M12 6.5v7.5" {...line} />
          <Circle cx={12} cy={18} r={1.5} fill={color} />
        </>
      )}
      {variant === 'info' && (
        <>
          <Circle cx={12} cy={6.5} r={1.5} fill={color} />
          <Path d="M12 10.5v7.5" {...line} />
        </>
      )}
    </Svg>
  );
}

function DialogButton({
  button,
  theme,
  grow,
  onPress,
}: {
  button: AlertButton;
  theme: Theme;
  grow: boolean;
  onPress: () => void;
}) {
  const label = button.text || 'OK';
  const isCancel = button.style === 'cancel';
  const backgroundColor =
    button.style === 'destructive' ? theme.colors.loss : isCancel ? theme.colors.input : theme.colors.primary;
  const color = isCancel ? theme.colors.textSecondary : theme.colors.primaryText;

  return (
    <Pressable
      onPress={onPress}
      accessibilityRole="button"
      accessibilityLabel={label}
      style={({ pressed }) => [
        styles.button,
        grow && styles.buttonGrow,
        { backgroundColor },
        pressed && styles.buttonPressed,
      ]}>
      <Text style={[styles.buttonText, isCancel && styles.buttonTextCancel, { color }]} numberOfLines={1}>
        {label}
      </Text>
    </Pressable>
  );
}

/** Full-screen layer the dialog lives in — always above any sheet that is already open. */
function DialogLayer({ children, onRequestClose }: { children: React.ReactNode; onRequestClose: () => void }) {
  if (Platform.OS === 'ios') {
    return <FullWindowOverlay unstable_accessibilityContainerViewIsModal>{children}</FullWindowOverlay>;
  }
  return (
    <Modal
      visible
      transparent
      animationType="none"
      statusBarTranslucent
      navigationBarTranslucent
      onRequestClose={onRequestClose}>
      {children}
    </Modal>
  );
}

function AppDialogHost() {
  const { theme } = useTheme();
  const { width, height } = useWindowDimensions();

  const [current, setCurrent] = useState<DialogRequest | null>(null);
  const currentRef = useRef<DialogRequest | null>(null);
  const queueRef = useRef<DialogRequest[]>([]);
  const closingRef = useRef(false);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const backdrop = useSharedValue(0);
  const card = useSharedValue(0);
  const badge = useSharedValue(0);

  const present = useCallback((req: DialogRequest) => {
    Keyboard.dismiss();
    closingRef.current = false;
    currentRef.current = req;
    setCurrent(req);
  }, []);

  const enqueue = useCallback(
    (req: DialogRequest) => {
      if (currentRef.current) queueRef.current.push(req);
      else present(req);
    },
    [present],
  );

  useEffect(() => {
    enqueueDialog = enqueue;
    earlyRequests.splice(0).forEach(enqueue);
    return () => {
      if (enqueueDialog === enqueue) enqueueDialog = null;
      if (timerRef.current) clearTimeout(timerRef.current);
    };
  }, [enqueue]);

  // Animate each dialog in; a queued one swaps in under the backdrop that is already there.
  useEffect(() => {
    if (!current) return;
    card.value = 0;
    badge.value = 0;
    backdrop.value = withTiming(1, { duration: ENTER_MS, easing: Easing.out(Easing.quad) });
    card.value = withTiming(1, { duration: ENTER_MS, easing: Easing.out(Easing.cubic) });
    badge.value = withDelay(70, withSpring(1, BADGE_SPRING));
    playHaptic(current.variant);
  }, [current, backdrop, card, badge]);

  const settle = useCallback(() => {
    timerRef.current = null;
    const next = queueRef.current.shift();
    if (next) {
      present(next);
      return;
    }
    currentRef.current = null;
    closingRef.current = false;
    setCurrent(null);
  }, [present]);

  // Close first, then run the handler (like Alert). Anything the handler shows is
  // queued behind this dialog and swaps in once it has animated out.
  const close = useCallback(
    (after?: () => void) => {
      if (!currentRef.current || closingRef.current) return;
      closingRef.current = true;
      card.value = withTiming(0, { duration: EXIT_MS, easing: Easing.in(Easing.quad) });
      try {
        after?.();
      } finally {
        if (queueRef.current.length === 0) {
          backdrop.value = withTiming(0, { duration: EXIT_MS, easing: Easing.in(Easing.quad) });
        }
        if (timerRef.current) clearTimeout(timerRef.current);
        timerRef.current = setTimeout(settle, EXIT_MS + 10);
      }
    },
    [backdrop, card, settle],
  );

  // Android back / backdrop tap: act as the cancel button if there is one, else
  // dismiss only when the caller made the dialog cancelable.
  const requestClose = useCallback(() => {
    const req = currentRef.current;
    if (!req || closingRef.current) return;
    const cancel = req.buttons.find((b) => b.style === 'cancel');
    if (cancel) close(cancel.onPress ? () => cancel.onPress?.() : undefined);
    else if (req.options.cancelable) close(req.options.onDismiss);
  }, [close]);

  const backdropStyle = useAnimatedStyle(() => ({ opacity: backdrop.value }));
  const cardStyle = useAnimatedStyle(() => ({
    opacity: card.value,
    transform: [{ scale: 0.92 + 0.08 * card.value }],
  }));
  const badgeStyle = useAnimatedStyle(() => ({
    opacity: Math.min(1, badge.value * 1.5),
    transform: [{ scale: 0.55 + 0.45 * badge.value }],
  }));

  if (!current) return null;

  const accent = variantColor(current.variant, theme);
  const { stacked, ordered } = arrangeButtons(current.buttons);

  return (
    <DialogLayer onRequestClose={requestClose}>
      <View style={styles.root} accessibilityViewIsModal>
        <Animated.View style={[StyleSheet.absoluteFill, { backgroundColor: theme.colors.overlay }, backdropStyle]}>
          <Pressable
            style={StyleSheet.absoluteFill}
            onPress={requestClose}
            accessible={false}
            importantForAccessibility="no"
          />
        </Animated.View>

        <Animated.View
          accessibilityRole="alert"
          style={[
            styles.card,
            {
              width: Math.min(width - 48, 360),
              backgroundColor: theme.colors.card,
              // Shadows vanish on black — a hairline keeps the card's edge in dark mode.
              borderWidth: theme.isDark ? StyleSheet.hairlineWidth : 0,
              borderColor: theme.colors.border,
            },
            cardStyle,
          ]}>
          <Animated.View
            style={[
              styles.badgeHalo,
              { backgroundColor: withAlpha(accent, theme.isDark ? 0.12 : 0.1) },
              badgeStyle,
            ]}>
            <View style={[styles.badgeDisc, { backgroundColor: withAlpha(accent, theme.isDark ? 0.22 : 0.18) }]}>
              <VariantGlyph variant={current.variant} color={accent} />
            </View>
          </Animated.View>

          {!!current.title && (
            <Text style={[styles.title, { color: theme.colors.text }]} accessibilityRole="header">
              {current.title}
            </Text>
          )}

          {!!current.message && (
            <ScrollView
              style={[styles.messageScroll, !current.title && styles.messageNoTitle, { maxHeight: height * 0.45 }]}
              bounces={false}
              showsVerticalScrollIndicator={false}>
              <Text style={[styles.message, { color: theme.colors.textSecondary }]}>{current.message}</Text>
            </ScrollView>
          )}

          <View style={[styles.actions, stacked ? styles.actionsStacked : styles.actionsRow]}>
            {ordered.map((b, i) => (
              <DialogButton
                key={`${current.id}-${i}`}
                button={b}
                theme={theme}
                grow={!stacked}
                onPress={() => close(b.onPress ? () => b.onPress?.() : undefined)}
              />
            ))}
          </View>
        </Animated.View>
      </View>
    </DialogLayer>
  );
}

/** Mount once at the app root, inside ThemeProvider. Renders the dialog above everything else. */
export function AppDialogProvider({ children }: { children: React.ReactNode }) {
  return (
    <>
      {children}
      <AppDialogHost />
    </>
  );
}

const styles = StyleSheet.create({
  root: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
  },
  card: {
    borderRadius: 20,
    paddingTop: 26,
    paddingHorizontal: 22,
    paddingBottom: 20,
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 14 },
    shadowOpacity: 0.18,
    shadowRadius: 28,
    elevation: 16,
  },
  badgeHalo: {
    alignSelf: 'center',
    width: HALO,
    height: HALO,
    borderRadius: HALO / 2,
    alignItems: 'center',
    justifyContent: 'center',
    marginBottom: 16,
  },
  badgeDisc: {
    width: DISC,
    height: DISC,
    borderRadius: DISC / 2,
    alignItems: 'center',
    justifyContent: 'center',
  },
  title: {
    fontSize: 18,
    fontWeight: '700',
    letterSpacing: -0.2,
    textAlign: 'center',
  },
  messageScroll: {
    flexGrow: 0,
    marginTop: 8,
  },
  messageNoTitle: {
    marginTop: 0,
  },
  message: {
    fontSize: 15,
    lineHeight: 21,
    textAlign: 'center',
  },
  actions: {
    marginTop: 22,
    gap: 10,
  },
  actionsRow: {
    flexDirection: 'row',
  },
  actionsStacked: {
    flexDirection: 'column',
  },
  button: {
    minHeight: 48,
    borderRadius: 14,
    paddingHorizontal: 16,
    paddingVertical: 12,
    alignItems: 'center',
    justifyContent: 'center',
  },
  buttonGrow: {
    flex: 1,
  },
  buttonPressed: {
    opacity: 0.82,
    transform: [{ scale: 0.98 }],
  },
  buttonText: {
    fontSize: 16,
    fontWeight: '700',
  },
  buttonTextCancel: {
    fontWeight: '600',
  },
});
