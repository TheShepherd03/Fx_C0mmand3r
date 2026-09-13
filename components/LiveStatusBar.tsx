import React from 'react';
import { View, Text, StyleSheet } from 'react-native';
import { useAccountData } from '@/hooks/useAccountData';
import { usePrivacy } from '@/contexts/PrivacyContext';
import { useTheme } from '@/contexts/ThemeContext';
import { totalRisk, totalPnL } from '@/utils/positionMath';

/**
 * Compact always-visible strip (rendered just above the tab bar) showing live
 * floating P/L and total risk-to-SL, so they're visible from every screen.
 */
export function LiveStatusBar() {
  const { data } = useAccountData();
  const { theme } = useTheme();
  const { hidden } = usePrivacy();

  const positions = data?.positions ?? [];
  const pnl = totalPnL(positions);
  const { risk } = totalRisk(positions);

  const money = (n: number) => `${n < 0 ? '-' : ''}$${Math.abs(n).toFixed(2)}`;
  const MASK = '••••';

  return (
    <View style={[styles.bar, { backgroundColor: theme.colors.card, borderTopColor: theme.colors.border }]}>
      <View style={styles.cell}>
        <Text style={[styles.label, { color: theme.colors.textSecondary }]}>P/L</Text>
        <Text style={[styles.value, { color: pnl >= 0 ? theme.colors.profit : theme.colors.loss }]}>
          {hidden ? MASK : `${pnl >= 0 ? '+' : ''}${money(pnl)}`}
        </Text>
      </View>
      <View style={[styles.divider, { backgroundColor: theme.colors.border }]} />
      <View style={styles.cell}>
        <Text style={[styles.label, { color: theme.colors.textSecondary }]}>Risk</Text>
        <Text style={[styles.value, { color: risk > 0 ? theme.colors.loss : theme.colors.textSecondary }]}>
          {hidden ? MASK : (risk > 0 ? `-$${risk.toFixed(2)}` : '$0.00')}
        </Text>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  bar: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-around',
    paddingVertical: 6,
    borderTopWidth: StyleSheet.hairlineWidth,
  },
  cell: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
  },
  label: {
    fontSize: 12,
    fontWeight: '600',
    letterSpacing: 0.5,
  },
  value: {
    fontSize: 15,
    fontWeight: '800',
    fontFamily: 'monospace',
  },
  divider: {
    width: StyleSheet.hairlineWidth,
    height: 20,
  },
});
