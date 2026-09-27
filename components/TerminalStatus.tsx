import React, { useEffect, useState } from 'react';
import { AppState, StyleSheet, Text, View, type StyleProp, type ViewStyle } from 'react-native';
import { ref, onValue } from 'firebase/database';
import { database, authReady } from '@/firebaseConfig';
import { useAccount } from '@/contexts/AccountContext';
import { useTheme, type Theme } from '@/contexts/ThemeContext';

/**
 * Connection health of EVERY MT5 terminal running the Bridge EA.
 *
 * Each Bridge EA writes a heartbeat to `accounts/{accountId}/lastUpdated`
 * (UTC epoch SECONDS, from TimeGMT()). The heartbeat's age classifies it:
 *   age < 90s        LIVE     (green)
 *   90s <= age < 10m STALE    (amber)  "2m ago"
 *   10m <= age < 2d  OFFLINE  (red)    "offline 5h"
 *   age >= 2 days    RETIRED  (hidden — old accounts linger in the node)
 */

export type TerminalHealth = 'live' | 'stale' | 'offline' | 'retired';

export const LIVE_MAX_AGE_S = 90;
export const STALE_MAX_AGE_S = 600;
export const RETIRED_AGE_S = 2 * 86400;

// Ages are re-evaluated on this cadence so labels tick without new data.
const TICK_MS = 15000;

export function terminalHealth(ageSec: number): TerminalHealth {
  if (ageSec < LIVE_MAX_AGE_S) return 'live';
  if (ageSec < STALE_MAX_AGE_S) return 'stale';
  if (ageSec < RETIRED_AGE_S) return 'offline';
  return 'retired';
}

// Compact duration: "45s", "2m", "5h", "1d".
function compactAge(sec: number): string {
  if (sec < 60) return `${Math.floor(sec)}s`;
  if (sec < 3600) return `${Math.floor(sec / 60)}m`;
  if (sec < 86400) return `${Math.floor(sec / 3600)}h`;
  return `${Math.floor(sec / 86400)}d`;
}

function healthText(health: TerminalHealth, ageSec: number): string {
  if (health === 'live') return 'LIVE';
  if (health === 'stale') return `${compactAge(ageSec)} ago`;
  return `offline ${compactAge(ageSec)}`;
}

function healthColor(health: TerminalHealth, theme: Theme): string {
  if (health === 'live') return theme.colors.profit;
  if (health === 'stale') return theme.colors.warning;
  return theme.colors.loss;
}

// Brands people actually use, where the broker's company name starts differently.
const BROKER_ALIASES: Record<string, string> = {
  HF: 'HFM', // "HF Markets (SA) (Pty) Ltd"
};

/**
 * Short label from an account key (Company_Server_Login, sanitized):
 *   HF_Markets_SA__Pty__Ltd_HFMarketsSA_Live2_55029630 -> "HFM · 55029630"
 *   Deriv__SVG__LLC_DerivSVG_Server_03_140421845      -> "Deriv · 140421845"
 */
export function terminalLabel(accountId: string): string {
  const first = accountId.split('_').find((w) => w.length > 0) ?? accountId;
  const broker = BROKER_ALIASES[first] ?? first;
  const login = /(\d+)$/.exec(accountId)?.[1];
  return login ? `${broker} · ${login}` : broker;
}

// Heartbeat value -> epoch seconds (0 = missing/invalid). Tolerates epoch ms.
function toEpochSeconds(v: unknown): number {
  const n = typeof v === 'number' ? v : typeof v === 'string' ? Number(v) : NaN;
  if (!Number.isFinite(n) || n <= 0) return 0;
  return n > 1e12 ? Math.floor(n / 1000) : n;
}

interface Heartbeat {
  id: string;
  lastUpdated: number;
}

function Pill({
  theme,
  color,
  label,
  status,
  selected = false,
}: {
  theme: Theme;
  color: string;
  label: string;
  status: string;
  selected?: boolean;
}) {
  return (
    <View
      accessible
      accessibilityLabel={`${label}, ${status}${selected ? ', selected account' : ''}`}
      style={[
        styles.pill,
        {
          backgroundColor: color + '33',
          borderColor: selected ? theme.colors.primary : 'transparent',
        },
      ]}
    >
      <View style={[styles.dot, { backgroundColor: color }]} />
      <Text style={[styles.label, { color: theme.colors.text }]} numberOfLines={1}>
        {label}
      </Text>
      <Text style={[styles.status, { color }]} numberOfLines={1}>
        {status}
      </Text>
    </View>
  );
}

/**
 * Compact row of pills — one per active terminal (dot + label + status).
 * The terminal whose data the screen is showing (the selected account) is
 * outlined in the primary colour.
 */
export function TerminalStatus({ style }: { style?: StyleProp<ViewStyle> }) {
  const { theme } = useTheme();
  const { selectedAccount } = useAccount();
  // null until the first snapshot arrives.
  const [beats, setBeats] = useState<Heartbeat[] | null>(null);
  const [, setTick] = useState(0);

  // Live read of the whole `accounts` node (AccountContext listens here too, so
  // the SDK shares one server listener). Only each account's `lastUpdated` leaf
  // is materialised — positions/orders are never converted to JS objects here.
  useEffect(() => {
    const accountsRef = ref(database, 'accounts');
    let cancelled = false;
    let unsubscribe = () => {};

    // Wait for sign-in before reading, so the listener isn't cancelled with
    // "permission denied" under the auth-locked rules.
    authReady.then(() => {
      if (cancelled) return;
      unsubscribe = onValue(
        accountsRef,
        (snapshot) => {
          const list: Heartbeat[] = [];
          snapshot.forEach((child) => {
            const ts = toEpochSeconds(child.child('lastUpdated').val());
            if (child.key && ts > 0) list.push({ id: child.key, lastUpdated: ts });
          });
          list.sort((a, b) => a.id.localeCompare(b.id));
          setBeats(list);
        },
        (error) => {
          console.error('Failed to read terminal heartbeats:', error);
          setBeats([]);
        }
      );
    });

    return () => {
      cancelled = true;
      unsubscribe();
    };
  }, []);

  // Re-evaluate ages every 15s, and immediately on returning to the foreground.
  useEffect(() => {
    const bump = () => setTick((t) => t + 1);
    const id = setInterval(bump, TICK_MS);
    const sub = AppState.addEventListener('change', (state) => {
      if (state === 'active') bump();
    });
    return () => {
      clearInterval(id);
      sub.remove();
    };
  }, []);

  if (beats === null) {
    return (
      <View style={[styles.row, style]}>
        <Pill theme={theme} color={theme.colors.textTertiary} label="Terminals" status="…" />
      </View>
    );
  }

  const now = Math.floor(Date.now() / 1000);
  const terminals = beats
    .map((b) => {
      const age = Math.max(0, now - b.lastUpdated); // clamp phone-clock skew
      return { ...b, age, health: terminalHealth(age) };
    })
    .filter((t) => t.health !== 'retired');

  if (terminals.length === 0) {
    return (
      <View style={[styles.row, style]}>
        <Pill theme={theme} color={theme.colors.loss} label="No terminals" status="OFFLINE" />
      </View>
    );
  }

  return (
    <View style={[styles.row, style]}>
      {terminals.map((t) => (
        <Pill
          key={t.id}
          theme={theme}
          color={healthColor(t.health, theme)}
          label={terminalLabel(t.id)}
          status={healthText(t.health, t.age)}
          selected={t.id === selectedAccount}
        />
      ))}
    </View>
  );
}

const styles = StyleSheet.create({
  row: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    alignItems: 'center',
    alignContent: 'center',
    gap: 6,
  },
  pill: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    paddingHorizontal: 10,
    paddingVertical: 5,
    borderRadius: 20,
    borderWidth: 1,
  },
  dot: {
    width: 8,
    height: 8,
    borderRadius: 4,
  },
  label: {
    fontSize: 12,
    fontWeight: '700',
  },
  status: {
    fontSize: 11,
    fontWeight: '800',
    letterSpacing: 0.3,
  },
});
