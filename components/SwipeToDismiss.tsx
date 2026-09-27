import React, { useCallback, useEffect, useRef } from 'react';
import { StyleSheet, Text, View, type StyleProp, type ViewStyle } from 'react-native';
import ReanimatedSwipeable, {
  type SwipeableMethods,
} from 'react-native-gesture-handler/ReanimatedSwipeable';
import Animated, {
  Extrapolation,
  interpolate,
  runOnJS,
  useAnimatedReaction,
  useAnimatedStyle,
  type SharedValue,
} from 'react-native-reanimated';
import * as Haptics from 'expo-haptics';

import { IconSymbol } from '@/components/ui/icon-symbol';
import { useTheme } from '@/contexts/ThemeContext';

/**
 * Full-swipe-to-dismiss row (either direction), built on RNGH's ReanimatedSwipeable.
 *
 * Drag past THRESHOLD and let go: the row slides off-screen and `onDismiss` fires.
 * Let go earlier and it springs back. A "Dismiss" panel is revealed behind the row
 * while dragging, and a haptic tick marks the point where releasing will commit.
 * Needs a GestureHandlerRootView at the app root.
 */

const THRESHOLD = 80;
// RNGH's default spring is heavily over-damped (long slow tail); this settles in ~0.2s.
const SPRING = { mass: 1, stiffness: 420, damping: 30 };

type Side = 'left' | 'right';

function tick() {
  Haptics.selectionAsync().catch(() => {});
}

function DismissPanel({
  side,
  translation,
  label,
  radius,
}: {
  side: Side;
  translation: SharedValue<number>;
  label: string;
  radius: number;
}) {
  const { theme } = useTheme();
  // The left panel is uncovered while the row moves right (+x); the right one while it moves left.
  const dir = side === 'left' ? 1 : -1;

  // Tick when the drag crosses the commit threshold (and again if it's pulled back).
  useAnimatedReaction(
    () => translation.value * dir >= THRESHOLD,
    (armed, wasArmed) => {
      if (wasArmed !== null && armed !== wasArmed) runOnJS(tick)();
    },
  );

  const contentStyle = useAnimatedStyle(() => {
    const d = Math.max(0, translation.value * dir);
    return {
      opacity: interpolate(d, [12, THRESHOLD * 0.75], [0, 1], Extrapolation.CLAMP),
      transform: [{ scale: interpolate(d, [0, THRESHOLD], [0.75, 1], Extrapolation.CLAMP) }],
    };
  });
  const fillStyle = useAnimatedStyle(() => {
    const d = Math.max(0, translation.value * dir);
    return { opacity: interpolate(d, [0, THRESHOLD], [0.45, 1], Extrapolation.CLAMP) };
  });

  return (
    <View style={[styles.panel, { borderRadius: radius }]}>
      <Animated.View
        style={[StyleSheet.absoluteFill, { backgroundColor: theme.colors.error + '2E' }, fillStyle]}
      />
      <Animated.View
        style={[styles.panelContent, side === 'left' ? styles.start : styles.end, contentStyle]}>
        <View style={[styles.iconCircle, { backgroundColor: theme.colors.error }]}>
          <IconSymbol name="xmark" size={16} color="#FFF" />
        </View>
        <Text style={[styles.panelLabel, { color: theme.colors.error }]}>{label}</Text>
      </Animated.View>
    </View>
  );
}

interface Props {
  children: React.ReactNode;
  onDismiss: () => void;
  enabled?: boolean;
  /** Outer row style (put the row's margin here, not on the child card). */
  style?: StyleProp<ViewStyle>;
  /** Corner radius of the revealed panel — match the card. */
  radius?: number;
  label?: string;
}

export function SwipeToDismiss({
  children,
  onDismiss,
  enabled = true,
  style,
  radius = 16,
  label = 'Dismiss',
}: Props) {
  const swipeRef = useRef<SwipeableMethods>(null);
  const onDismissRef = useRef(onDismiss);
  const resetTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    onDismissRef.current = onDismiss;
  }, [onDismiss]);

  useEffect(
    () => () => {
      if (resetTimer.current) clearTimeout(resetTimer.current);
    },
    [],
  );

  const handleOpen = useCallback(() => {
    onDismissRef.current();
    // Normally the row unmounts as soon as the dismiss lands. If it's still here a
    // moment later (e.g. the write was refused), slide it back instead of leaving a gap.
    if (resetTimer.current) clearTimeout(resetTimer.current);
    resetTimer.current = setTimeout(() => swipeRef.current?.close(), 900);
  }, []);

  const renderLeft = useCallback(
    (_progress: SharedValue<number>, translation: SharedValue<number>) => (
      <DismissPanel side="left" translation={translation} label={label} radius={radius} />
    ),
    [label, radius],
  );
  const renderRight = useCallback(
    (_progress: SharedValue<number>, translation: SharedValue<number>) => (
      <DismissPanel side="right" translation={translation} label={label} radius={radius} />
    ),
    [label, radius],
  );

  return (
    <ReanimatedSwipeable
      ref={swipeRef}
      enabled={enabled}
      friction={1}
      leftThreshold={THRESHOLD}
      rightThreshold={THRESHOLD}
      overshootLeft={false}
      overshootRight={false}
      animationOptions={SPRING}
      renderLeftActions={renderLeft}
      renderRightActions={renderRight}
      onSwipeableOpen={handleOpen}
      containerStyle={[styles.container, style]}>
      {children}
    </ReanimatedSwipeable>
  );
}

const styles = StyleSheet.create({
  // Visible (RNGH defaults to hidden) so the card keeps its shadow and slides off-screen.
  container: {
    overflow: 'visible',
  },
  panel: {
    flex: 1,
    justifyContent: 'center',
    overflow: 'hidden',
  },
  panelContent: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
    paddingHorizontal: 22,
  },
  start: {
    alignSelf: 'flex-start',
  },
  end: {
    alignSelf: 'flex-end',
    flexDirection: 'row-reverse',
  },
  iconCircle: {
    width: 30,
    height: 30,
    borderRadius: 15,
    alignItems: 'center',
    justifyContent: 'center',
  },
  panelLabel: {
    fontSize: 14,
    fontWeight: '800',
    letterSpacing: 0.3,
  },
});
