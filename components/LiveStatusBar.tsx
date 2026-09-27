import React from 'react';
import { View, Text, StyleSheet } from 'react-native';
import { useAccountData } from '@/hooks/useAccountData';
import { usePrivacy } from '@/contexts/PrivacyContext';
import { useTheme } from '@/contexts/ThemeContext';
import { totalRisk, totalPnL } from '@/utils/positionMath';
import { currencySymbol } from '@/utils/currency';

/**
 * Live floating P/L and total risk-to-SL for the selected account, already
 * formatted (and masked when balances are hidden). Shared by the standalone
 * LiveStatusBar strip and the FloatingNav dock.
 */
export function useLiveStatus() {
  const { data } = useAccountData();
  const { theme } = useTheme();
  const { hidden, statusBarEnabled } = usePrivacy();

  const positions = data?.positions ?? [];
  const pnl = totalPnL(positions);
  const { risk } = totalRisk(positions);

  const cur = currencySymbol(data?.currency);
  const money = (n: number) => `${n < 0 ? '-' : ''}${cur}${Math.abs(n).toFixed(2)}`;
  const MASK = '••••';

  return {
    enabled: statusBarEnabled,
    pnlText: hidden ? MASK : `${pnl >= 0 ? '+' : ''}${money(pnl)}`,
    pnlColor: pnl >= 0 ? theme.colors.profit : theme.colors.loss,
    riskText: hidden ? MASK : risk > 0 ? `-${cur}${risk.toFixed(2)}` : `${cur}0.00`,
    riskColor: risk > 0 ? theme.colors.loss : theme.colors.textSecondary,
  };
}

/**
 * Compact always-visible strip showing live floating P/L and total risk-to-SL.
 */
export function LiveStatusBar() {
  const { theme } = useTheme();
  const s = useLiveStatus();

  if (!s.enabled) return null;

  return (
    <View style={[styles.bar, { backgroundColor: theme.colors.card, borderTopColor: theme.colors.border }]}>
      <View style={styles.cell}>
        <Text style={[styles.label, { color: theme.colors.textSecondary }]}>P/L</Text>
        <Text style={[styles.value, { color: s.pnlColor }]}>{s.pnlText}</Text>
      </View>
      <View style={[styles.divider, { backgroundColor: theme.colors.border }]} />
      <View style={styles.cell}>
        <Text style={[styles.label, { color: theme.colors.textSecondary }]}>Risk</Text>
        <Text style={[styles.value, { color: s.riskColor }]}>{s.riskText}</Text>
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
