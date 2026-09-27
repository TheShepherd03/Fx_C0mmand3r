import React, { useMemo, useRef, useState } from 'react';
import {
  Modal,
  Platform,
  Pressable,
  StyleSheet,
  Text,
  View,
  useWindowDimensions,
} from 'react-native';
import type { BottomTabBarProps } from '@react-navigation/bottom-tabs';
import Animated, {
  Extrapolation,
  interpolate,
  useAnimatedStyle,
  useSharedValue,
  withSpring,
  withTiming,
  type SharedValue,
} from 'react-native-reanimated';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import * as Haptics from 'expo-haptics';

import { IconSymbol } from '@/components/ui/icon-symbol';
import { useLiveStatus } from '@/components/LiveStatusBar';
import { useTheme, type Theme } from '@/contexts/ThemeContext';

/**
 * Floating "command dock" that replaces the bottom tab bar.
 *
 * Closed: a floating pill with live P/L (left), a single nav button (center)
 * and Risk (right). Open: the screen dims and a menu card grows out of the
 * button with every destination as a tile; tapping one navigates and the menu
 * collapses back into the button. Routing/state are untouched — this only
 * renders the navigator's tab bar.
 */

const FAB = 56;
const HALO = 64;
const DOCK_H = 68;
const DOCK_PAD_BOTTOM = 8;
const SPRING = { damping: 18, stiffness: 190, mass: 0.9 };

function withAlpha(color: string, alpha: number) {
  let m = /^#([0-9a-f]{6})$/i.exec(color || '');
  let hex = m?.[1];
  if (!hex) {
    const s = /^#([0-9a-f]{3})$/i.exec(color || '');
    if (s) hex = s[1].split('').map((c) => c + c).join('');
  }
  if (!hex) return color;
  const n = parseInt(hex, 16);
  return `rgba(${(n >> 16) & 255}, ${(n >> 8) & 255}, ${n & 255}, ${alpha})`;
}

function haptic(kind: 'open' | 'select') {
  try {
    if (Platform.OS === 'ios' && kind === 'open') {
      Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light).catch(() => {});
    } else {
      Haptics.selectionAsync().catch(() => {});
    }
  } catch {
    // haptics are best-effort
  }
}

type FabProps = {
  theme: Theme;
  progress: SharedValue<number>;
  onPress: () => void;
  label: string;
};

/** The round nav button; its grid icon spins into a close (×) as the menu opens. */
function FabButton({ theme, progress, onPress, label }: FabProps) {
  const press = useSharedValue(1);

  const scaleStyle = useAnimatedStyle(() => ({ transform: [{ scale: press.value }] }));
  const gridStyle = useAnimatedStyle(() => ({
    opacity: interpolate(progress.value, [0, 0.5], [1, 0], Extrapolation.CLAMP),
    transform: [{ rotate: `${interpolate(progress.value, [0, 1], [0, 90])}deg` }],
  }));
  const closeStyle = useAnimatedStyle(() => ({
    opacity: interpolate(progress.value, [0.5, 1], [0, 1], Extrapolation.CLAMP),
    transform: [{ rotate: `${interpolate(progress.value, [0, 1], [-90, 0])}deg` }],
  }));

  return (
    <View style={[styles.halo, { backgroundColor: withAlpha(theme.colors.primary, 0.16) }]}>
      <Animated.View style={scaleStyle}>
        <Pressable
          onPress={onPress}
          onPressIn={() => (press.value = withSpring(0.9, SPRING))}
          onPressOut={() => (press.value = withSpring(1, SPRING))}
          accessibilityRole="button"
          accessibilityLabel={label}
          hitSlop={8}
          style={[
            styles.fab,
            { backgroundColor: theme.colors.primary, shadowColor: theme.colors.primary },
          ]}>
          <Animated.View style={[styles.fabIcon, gridStyle]}>
            <IconSymbol name="square.grid.2x2" size={26} color="#FFFFFF" />
          </Animated.View>
          <Animated.View style={[styles.fabIcon, closeStyle]}>
            <IconSymbol name="xmark" size={26} color="#FFFFFF" />
          </Animated.View>
        </Pressable>
      </Animated.View>
    </View>
  );
}

type TileProps = {
  index: number;
  progress: SharedValue<number>;
  theme: Theme;
  label: string;
  icon: React.ReactNode;
  active: boolean;
  onPress: () => void;
};

/** One destination tile; tiles cascade in with a staggered spring. */
function NavTile({ index, progress, theme, label, icon, active, onPress }: TileProps) {
  const style = useAnimatedStyle(() => {
    const start = 0.1 + index * 0.06;
    const t = interpolate(progress.value, [start, start + 0.45], [0, 1], Extrapolation.CLAMP);
    return {
      opacity: t,
      transform: [{ translateY: (1 - t) * 18 }, { scale: 0.88 + 0.12 * t }],
    };
  });

  return (
    <Animated.View style={[styles.tileWrap, style]}>
      <Pressable
        onPress={onPress}
        accessibilityRole="button"
        accessibilityLabel={label}
        accessibilityState={{ selected: active }}
        style={({ pressed }) => [
          styles.tile,
          {
            backgroundColor: active ? withAlpha(theme.colors.primary, 0.12) : 'transparent',
            borderColor: active ? withAlpha(theme.colors.primary, 0.55) : 'transparent',
          },
          pressed && { opacity: 0.65 },
        ]}>
        <View
          style={[
            styles.tileIcon,
            {
              backgroundColor: active
                ? withAlpha(theme.colors.primary, 0.2)
                : theme.colors.surface,
            },
          ]}>
          {icon}
        </View>
        <Text
          numberOfLines={2}
          style={[
            styles.tileLabel,
            { color: active ? theme.colors.primary : theme.colors.text },
          ]}>
          {label}
        </Text>
      </Pressable>
    </Animated.View>
  );
}

export function FloatingNav({ state, descriptors, navigation }: BottomTabBarProps) {
  const { theme } = useTheme();
  const insets = useSafeAreaInsets();
  const { width } = useWindowDimensions();
  const live = useLiveStatus();

  const [open, setOpen] = useState(false);
  const progress = useSharedValue(0);
  const closeTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  // The overlay spans the full screen (status + nav bars are translucent) just
  // like the edge-to-edge app, so anchoring it to the bottom with the dock's own
  // safe-area math puts the menu's close button exactly on top of the real one.
  const haloBottom = insets.bottom + DOCK_PAD_BOTTOM + (DOCK_H - HALO) / 2;

  // Visible destinations only (expo-router hides `href: null` routes like "explore").
  const routes = useMemo(
    () =>
      state.routes.filter((r) => {
        const o: any = descriptors[r.key]?.options ?? {};
        if (o.href === null) return false;
        if (o.tabBarItemStyle?.display === 'none') return false;
        if (r.name.startsWith('+') || r.name.startsWith('_')) return false;
        return true;
      }),
    [state.routes, descriptors],
  );
  const activeKey = state.routes[state.index]?.key;

  const openMenu = () => {
    if (closeTimer.current) {
      clearTimeout(closeTimer.current);
      closeTimer.current = null;
    }
    haptic('open');
    progress.value = 0;
    setOpen(true);
    progress.value = withSpring(1, SPRING);
  };

  const closeMenu = () => {
    progress.value = withTiming(0, { duration: 180 });
    if (closeTimer.current) clearTimeout(closeTimer.current);
    closeTimer.current = setTimeout(() => {
      setOpen(false);
      closeTimer.current = null;
    }, 190);
  };

  const go = (route: (typeof state.routes)[number]) => {
    haptic('select');
    const isFocused = route.key === activeKey;
    const event = navigation.emit({ type: 'tabPress', target: route.key, canPreventDefault: true });
    if (!isFocused && !event.defaultPrevented) {
      navigation.navigate(route.name, route.params);
    }
    closeMenu();
  };

  const backdropStyle = useAnimatedStyle(() => ({
    opacity: interpolate(progress.value, [0, 1], [0, 1], Extrapolation.CLAMP),
  }));
  const cardStyle = useAnimatedStyle(() => {
    const p = progress.value;
    return {
      opacity: interpolate(p, [0, 0.3], [0, 1], Extrapolation.CLAMP),
      transform: [
        { translateY: interpolate(p, [0, 1], [48, 0]) },
        { scale: interpolate(p, [0, 1], [0.55, 1]) },
      ],
    };
  });

  const cardW = Math.min(width - 32, 420);
  const fab = (
    <FabButton theme={theme} progress={progress} onPress={openMenu} label="Open navigation" />
  );

  return (
    <View
      style={[
        styles.dockOuter,
        { backgroundColor: theme.colors.background, paddingBottom: insets.bottom + DOCK_PAD_BOTTOM },
      ]}>
      {live.enabled ? (
        <View
          style={[
            styles.pill,
            { backgroundColor: theme.colors.card, borderColor: theme.colors.border },
          ]}>
          <View style={styles.side}>
            <Text style={[styles.sideLabel, { color: theme.colors.textSecondary }]}>P/L</Text>
            <Text style={[styles.sideValue, { color: live.pnlColor }]} numberOfLines={1}>
              {live.pnlText}
            </Text>
          </View>
          {fab}
          <View style={styles.side}>
            <Text style={[styles.sideLabel, { color: theme.colors.textSecondary }]}>RISK</Text>
            <Text style={[styles.sideValue, { color: live.riskColor }]} numberOfLines={1}>
              {live.riskText}
            </Text>
          </View>
        </View>
      ) : (
        <View style={styles.solo}>{fab}</View>
      )}

      <Modal
        visible={open}
        transparent
        animationType="none"
        statusBarTranslucent
        navigationBarTranslucent
        onRequestClose={closeMenu}>
        <View style={StyleSheet.absoluteFill}>
          <Animated.View
            style={[
              StyleSheet.absoluteFill,
              { backgroundColor: theme.isDark ? 'rgba(0,0,0,0.62)' : 'rgba(12,22,38,0.45)' },
              backdropStyle,
            ]}>
            <Pressable
              style={StyleSheet.absoluteFill}
              onPress={closeMenu}
              accessibilityLabel="Close navigation"
            />
          </Animated.View>

          {/* Column anchored to the dock button: menu card above, close button on top of the real one. */}
          <View pointerEvents="box-none" style={[styles.column, { bottom: haloBottom }]}>
            <Animated.View
              style={[
                styles.card,
                {
                  width: cardW,
                  backgroundColor: theme.colors.card,
                  borderColor: theme.colors.border,
                },
                cardStyle,
              ]}>
              <View style={[styles.grabber, { backgroundColor: theme.colors.border }]} />
              <Text style={[styles.cardTitle, { color: theme.colors.textSecondary }]}>NAVIGATE</Text>
              <View style={styles.grid}>
                {routes.map((r, i) => {
                  const o = descriptors[r.key].options;
                  const active = r.key === activeKey;
                  const color = active ? theme.colors.primary : theme.colors.text;
                  const label =
                    typeof o.tabBarLabel === 'string' ? o.tabBarLabel : o.title ?? r.name;
                  return (
                    <NavTile
                      key={r.key}
                      index={i}
                      progress={progress}
                      theme={theme}
                      label={label}
                      active={active}
                      icon={o.tabBarIcon?.({ focused: active, color, size: 26 })}
                      onPress={() => go(r)}
                    />
                  );
                })}
              </View>
            </Animated.View>
            <FabButton theme={theme} progress={progress} onPress={closeMenu} label="Close navigation" />
          </View>
        </View>
      </Modal>
    </View>
  );
}

const styles = StyleSheet.create({
  dockOuter: {
    paddingHorizontal: 14,
    paddingTop: 6,
  },
  pill: {
    height: DOCK_H,
    borderRadius: DOCK_H / 2,
    borderWidth: StyleSheet.hairlineWidth,
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 2,
    shadowColor: '#000',
    shadowOpacity: 0.12,
    shadowRadius: 12,
    shadowOffset: { width: 0, height: 4 },
    elevation: 6,
  },
  solo: {
    height: DOCK_H,
    alignItems: 'center',
    justifyContent: 'center',
  },
  side: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
  },
  sideLabel: {
    fontSize: 10,
    fontWeight: '700',
    letterSpacing: 0.9,
  },
  sideValue: {
    fontSize: 14,
    fontWeight: '800',
    fontFamily: 'monospace',
    marginTop: 1,
  },
  halo: {
    width: HALO,
    height: HALO,
    borderRadius: HALO / 2,
    alignItems: 'center',
    justifyContent: 'center',
  },
  fab: {
    width: FAB,
    height: FAB,
    borderRadius: FAB / 2,
    alignItems: 'center',
    justifyContent: 'center',
    shadowOpacity: 0.45,
    shadowRadius: 10,
    shadowOffset: { width: 0, height: 4 },
    elevation: 8,
  },
  fabIcon: {
    position: 'absolute',
  },
  column: {
    position: 'absolute',
    left: 0,
    right: 0,
    alignItems: 'center',
    justifyContent: 'flex-end',
  },
  card: {
    borderRadius: 28,
    borderWidth: StyleSheet.hairlineWidth,
    paddingHorizontal: 12,
    paddingTop: 10,
    paddingBottom: 12,
    marginBottom: 14,
    transformOrigin: 'bottom',
    shadowColor: '#000',
    shadowOpacity: 0.25,
    shadowRadius: 24,
    shadowOffset: { width: 0, height: 10 },
    elevation: 16,
  },
  grabber: {
    alignSelf: 'center',
    width: 36,
    height: 4,
    borderRadius: 2,
    marginBottom: 8,
    opacity: 0.8,
  },
  cardTitle: {
    fontSize: 11,
    fontWeight: '800',
    letterSpacing: 1.4,
    marginLeft: 8,
    marginBottom: 6,
  },
  grid: {
    flexDirection: 'row',
    flexWrap: 'wrap',
  },
  tileWrap: {
    width: '33.333%',
    padding: 4,
  },
  tile: {
    alignItems: 'center',
    paddingVertical: 12,
    paddingHorizontal: 4,
    borderRadius: 18,
    borderWidth: 1,
  },
  tileIcon: {
    width: 52,
    height: 52,
    borderRadius: 16,
    alignItems: 'center',
    justifyContent: 'center',
    marginBottom: 8,
  },
  tileLabel: {
    fontSize: 12,
    fontWeight: '700',
    textAlign: 'center',
  },
});
