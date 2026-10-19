import React, { useCallback, useState } from 'react';
import { StyleSheet, Text, View } from 'react-native';
import { useFocusEffect } from 'expo-router';
import { useTheme, type Theme } from '@/contexts/ThemeContext';
import {
  ZoneChart,
  type Candle,
  type DraftBand,
  type LiveZone,
  type ZoneState,
  type ZoneStatus,
} from '@/components/ZoneChart';

// Stable empties so the memoised chart doesn't re-render on every tick.
const EMPTY_CANDLES: Candle[] = [];
const EMPTY_ZONES: LiveZone[] = [];

// Freshness of the node, same thresholds as the terminal heartbeat
// (fresh < 90s, stale < 10m, else offline).
const FRESH_S = 90;
const STALE_S = 600;

const STATE_LABEL: Record<ZoneState, string> = { inside: 'INSIDE', near: 'NEAR', far: 'FAR' };

// The EA's zone events in trader terms: price came into the zone = "tested",
// a bar CLOSED through the far side = "broken" (the zone flips role).
function eventLabel(ev: string, theme: Theme): { text: string; color: string } {
  switch (ev) {
    case 'entered': return { text: 'tested', color: theme.colors.warning };
    case 'crossed': return { text: 'broken', color: theme.colors.loss };
    case 'approached': return { text: 'approaching', color: theme.colors.text };
    case 'signal': return { text: 'signal fired', color: theme.colors.info };
    default: return { text: ev, color: theme.colors.text };
  }
}

/** Heat colour of a zone state — shared with the symbol chips' alert dot. */
export function zoneStateColor(state: ZoneState, theme: Theme): string {
  if (state === 'inside') return theme.colors.error;
  if (state === 'near') return theme.colors.warning;
  return theme.colors.textTertiary;
}

function ago(sec: number): string {
  const s = Math.max(0, Math.floor(sec));
  if (s < 60) return `${s}s ago`;
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  return `${Math.floor(s / 86400)}d ago`;
}

// "0.8 · 0.65×ATR" (distance trimmed to the symbol's precision).
function distanceText(z: LiveZone, digits: number): string {
  if (z.state === 'inside') return 'in zone';
  const parts: string[] = [];
  if (z.dist !== null) parts.push(String(parseFloat(Math.abs(z.dist).toFixed(digits))));
  if (z.distAtr !== null) parts.push(`${Math.abs(z.distAtr).toFixed(2)}×ATR`);
  return parts.length ? parts.join(' · ') : '—';
}

/**
 * Live view of one zoned symbol from `zonestatus/{accountId}/{symbolKey}`:
 * header (symbol, timeframe, ATR, price, freshness), the zone chart, and a
 * compact list of the EA's zones with role, range, state, distance and last event.
 */
export function ZoneStatusPanel({
  symbol,
  status,
  drafts,
}: {
  symbol: string;
  status: ZoneStatus | null;
  /** Zone drafts awaiting approval, drawn on the chart in cyan. */
  drafts?: DraftBand[];
}) {
  const { theme } = useTheme();
  const [, setTick] = useState(0);

  // Tick every second while the screen is focused so "updated Xs ago" and the
  // zones' "3m ago" stay live between EA pushes (the chart is memoised, so
  // only the text re-renders).
  useFocusEffect(
    useCallback(() => {
      const bump = () => setTick((t) => t + 1);
      bump();
      const id = setInterval(bump, 1000);
      return () => clearInterval(id);
    }, [])
  );

  const now = Math.floor(Date.now() / 1000);
  const digits = status?.digits ?? 2;
  const price = status?.price ?? null;
  const atr = status?.atr ?? null;
  const fmt = (v: number) => v.toFixed(digits);

  const age = status && status.updated > 0 ? Math.max(0, now - status.updated) : null;
  const freshColor =
    age === null
      ? theme.colors.textTertiary
      : age < FRESH_S
        ? theme.colors.textSecondary
        : age < STALE_S
          ? theme.colors.warning
          : theme.colors.loss;
  const freshText = !status ? 'waiting for the EA' : age === null ? 'no timestamp' : `updated ${ago(age)}`;

  return (
    <View style={[styles.card, { backgroundColor: theme.colors.card }]}>
      {/* Header */}
      <View style={styles.header}>
        <View style={styles.titleCol}>
          <Text style={[styles.symbol, { color: theme.colors.text }]} numberOfLines={1}>
            {status?.symbol || symbol}
          </Text>
          <View style={styles.metaRow}>
            {!!status?.tf && (
              <View style={[styles.badge, { backgroundColor: theme.colors.input }]}>
                <Text style={[styles.badgeText, { color: theme.colors.textSecondary }]}>{status.tf}</Text>
              </View>
            )}
            {atr !== null && (
              <Text style={[styles.meta, { color: theme.colors.textTertiary }]}>ATR {fmt(atr)}</Text>
            )}
          </View>
        </View>
        <View style={styles.priceCol}>
          <Text style={[styles.price, { color: theme.colors.text }]}>{price !== null ? fmt(price) : '—'}</Text>
          <Text style={[styles.updated, { color: freshColor }]}>{freshText}</Text>
        </View>
      </View>

      <ZoneChart
        candles={status?.candles ?? EMPTY_CANDLES}
        zones={status?.zones ?? EMPTY_ZONES}
        drafts={drafts}
        price={price}
        digits={digits}
      />

      {/* Zones as the EA sees them (top -> bottom, like the chart) */}
      {status &&
        (status.zones.length === 0 ? (
          <Text style={[styles.noZones, { color: theme.colors.textTertiary }]}>
            {drafts && drafts.length > 0
              ? 'No live zones yet. Approve a draft below to send it to the EA.'
              : 'No zones reported by the EA yet.'}
          </Text>
        ) : (
          <View style={styles.zoneList}>
            {status.zones.map((z, i) => {
              const roleColor = z.role === 'supply' ? theme.colors.loss : theme.colors.profit;
              const stateColor = zoneStateColor(z.state, theme);
              return (
                <View key={i} style={[styles.zoneRow, { borderTopColor: theme.colors.border }]}>
                  <View style={styles.zoneLine}>
                    <View style={[styles.badge, { backgroundColor: roleColor + '20' }]}>
                      <Text style={[styles.badgeText, { color: roleColor }]}>
                        {z.role === 'supply' ? 'SUPPLY' : 'DEMAND'}
                      </Text>
                    </View>
                    <Text style={[styles.range, { color: theme.colors.text }]} numberOfLines={1}>
                      {fmt(z.high)} – {fmt(z.low)}
                    </Text>
                    <View style={[styles.badge, { backgroundColor: stateColor + '20' }]}>
                      <Text style={[styles.badgeText, { color: stateColor }]}>{STATE_LABEL[z.state]}</Text>
                    </View>
                  </View>
                  <View style={[styles.zoneLine, styles.zoneSub]}>
                    <Text style={[styles.meta, styles.grow, { color: theme.colors.textSecondary }]} numberOfLines={1}>
                      {distanceText(z, digits)}
                    </Text>
                    {z.lastEvent ? (
                      <Text style={[styles.meta, { color: theme.colors.textSecondary }]} numberOfLines={1}>
                        <Text style={[styles.event, { color: eventLabel(z.lastEvent, theme).color }]}>
                          {eventLabel(z.lastEvent, theme).text}
                        </Text>
                        {z.lastEventAt > 0 ? ` · ${ago(now - z.lastEventAt)}` : ''}
                      </Text>
                    ) : (
                      <Text style={[styles.meta, { color: theme.colors.textTertiary }]}>no events yet</Text>
                    )}
                  </View>
                </View>
              );
            })}
          </View>
        ))}
    </View>
  );
}

const styles = StyleSheet.create({
  card: {
    borderRadius: 16,
    padding: 16,
    marginBottom: 16,
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 2 },
    shadowOpacity: 0.05,
    shadowRadius: 8,
    elevation: 2,
  },
  header: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'flex-start',
    gap: 12,
    marginBottom: 12,
  },
  titleCol: {
    flex: 1,
  },
  symbol: {
    fontSize: 16,
    fontWeight: '800',
  },
  metaRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    marginTop: 4,
  },
  priceCol: {
    alignItems: 'flex-end',
  },
  price: {
    fontSize: 16,
    fontWeight: '800',
    fontFamily: 'monospace',
  },
  updated: {
    fontSize: 11,
    fontWeight: '600',
    marginTop: 4,
  },
  badge: {
    paddingHorizontal: 6,
    paddingVertical: 2,
    borderRadius: 4,
  },
  badgeText: {
    fontSize: 10,
    fontWeight: '800',
  },
  meta: {
    fontSize: 12,
  },
  grow: {
    flex: 1,
  },
  event: {
    fontWeight: '600',
  },
  zoneList: {
    marginTop: 8,
  },
  zoneRow: {
    paddingVertical: 10,
    borderTopWidth: 1,
  },
  zoneLine: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
  },
  zoneSub: {
    marginTop: 6,
  },
  range: {
    flex: 1,
    fontSize: 14,
    fontWeight: '700',
    fontFamily: 'monospace',
  },
  noZones: {
    fontSize: 13,
    marginTop: 12,
  },
});
