import React from 'react';
import { StyleSheet, Text, View } from 'react-native';

import type { Theme } from '@/contexts/ThemeContext';
import { EMA_KEYS, EMA_LABEL, type EmaPos, type EmaState } from '@/constants/types';

const ARROW: Record<EmaPos, string> = { above: '▲', inside: '◆', below: '▼' };

/**
 * A signal's position against the user's M3 EMA ribbon (TradingView "Moving Average Ribbon -
 * 5 MAs": EMA 5 and EMA 100 bands of lows/highs, EMA 200 of closes). "At signal" = the entry
 * when it fired; "Now" = live while it's open. A "Now" cell that moved since the signal is bold.
 */
export function EmaPosition({ at, now, theme }: { at?: EmaState; now?: EmaState; theme: Theme }) {
  if (!at && !now) return null;
  const color = (p?: EmaPos) =>
    p === 'above' ? theme.colors.buy : p === 'below' ? theme.colors.sell : theme.colors.textSecondary;
  const tf = at?.tf || now?.tf || 'M3';

  const row = (label: string, s: EmaState | undefined, ref?: EmaState) => (
    <View style={styles.row}>
      <Text style={[styles.rowLabel, { color: theme.colors.textSecondary }]}>{label}</Text>
      {EMA_KEYS.map((k) => {
        const p = s?.[k];
        const moved = !!ref && !!p && !!ref[k] && ref[k] !== p;
        return (
          <Text
            key={k}
            style={[styles.cell, { color: color(p) }, moved && styles.moved]}
            numberOfLines={1}
            accessibilityLabel={`${EMA_LABEL[k]} ${p ?? 'unknown'}`}>
            {p ? `${ARROW[p]} ${p}` : '—'}
          </Text>
        );
      })}
    </View>
  );

  return (
    <View style={[styles.wrap, { borderColor: theme.colors.border }]}>
      <View style={styles.row}>
        <Text style={[styles.head, styles.rowLabel, { color: theme.colors.textTertiary }]}>{tf} EMAs</Text>
        {EMA_KEYS.map((k) => (
          <Text key={k} style={[styles.head, styles.cell, { color: theme.colors.textTertiary }]}>
            {EMA_LABEL[k].replace('EMA ', '')}
          </Text>
        ))}
      </View>
      {!!at && row('At signal', at)}
      {!!now && row('Now', now, at)}
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: {
    marginTop: 12,
    marginBottom: 8,
    paddingTop: 10,
    borderTopWidth: StyleSheet.hairlineWidth,
    gap: 4,
  },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
  },
  head: {
    fontSize: 10,
    fontWeight: '800',
    letterSpacing: 0.4,
  },
  rowLabel: {
    width: 74,
    fontSize: 12,
    fontWeight: '600',
  },
  cell: {
    flex: 1,
    fontSize: 12,
    fontWeight: '600',
  },
  moved: {
    fontWeight: '900',
  },
});
