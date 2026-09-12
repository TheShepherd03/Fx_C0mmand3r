import React from 'react';
import { View, Text, Modal, StyleSheet, TouchableOpacity, Pressable, ScrollView } from 'react-native';
import { ClosedTrade } from '@/constants/types';
import { useTheme } from '@/contexts/ThemeContext';
import { IconSymbol } from '@/components/ui/icon-symbol';

interface ClosedTradeModalProps {
  trade: ClosedTrade | null;
  visible: boolean;
  onClose: () => void;
}

export function ClosedTradeModal({ trade, visible, onClose }: ClosedTradeModalProps) {
  const { theme } = useTheme();
  if (!trade) return null;

  const isBuy = trade.type === 0;
  const profitColor = trade.profit >= 0 ? theme.colors.profit : theme.colors.loss;

  const money = (n: number) =>
    `${n >= 0 ? '+' : '-'}$${Math.abs(n).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

  const dt = (unix: number) => (unix ? new Date(unix * 1000).toLocaleString() : '—');

  const duration = () => {
    const secs = Math.max(0, trade.closeTime - trade.openTime);
    const d = Math.floor(secs / 86400);
    const h = Math.floor((secs % 86400) / 3600);
    const m = Math.floor((secs % 3600) / 60);
    if (d > 0) return `${d}d ${h}h ${m}m`;
    if (h > 0) return `${h}h ${m}m`;
    return `${m}m`;
  };

  const Row = ({ label, value, color }: { label: string; value: string; color?: string }) => (
    <View style={styles.row}>
      <Text style={[styles.label, { color: theme.colors.textSecondary }]}>{label}</Text>
      <Text style={[styles.value, { color: color || theme.colors.text }]}>{value}</Text>
    </View>
  );

  return (
    <Modal animationType="slide" transparent visible={visible} onRequestClose={onClose}>
      <View style={[styles.overlay, { backgroundColor: theme.colors.overlay }]}>
        <Pressable style={StyleSheet.absoluteFill} onPress={onClose} />
        <View style={[styles.sheet, { backgroundColor: theme.colors.card }]}>
          <View style={styles.grabber}>
            <View style={[styles.grabberBar, { backgroundColor: theme.colors.border }]} />
          </View>
          <ScrollView contentContainerStyle={{ paddingBottom: 32 }} showsVerticalScrollIndicator persistentScrollbar>
            <View style={[styles.header, { borderBottomColor: theme.colors.border }]}>
              <View style={{ flex: 1 }}>
                <Text style={[styles.symbol, { color: theme.colors.text }]}>{trade.symbol}</Text>
                <Text style={[styles.ticket, { color: theme.colors.textSecondary }]}>Ticket #{trade.ticket}</Text>
              </View>
              <TouchableOpacity style={[styles.closeBtn, { backgroundColor: theme.colors.input }]} onPress={onClose}>
                <IconSymbol name="xmark" size={16} color={theme.colors.textSecondary} />
              </TouchableOpacity>
            </View>

            <View style={styles.statusRow}>
              <View style={[styles.badge, { backgroundColor: isBuy ? theme.colors.buyBackground : theme.colors.sellBackground }]}>
                <Text style={[styles.badgeText, { color: isBuy ? theme.colors.buy : theme.colors.sell }]}>
                  {isBuy ? 'BUY' : 'SELL'} {trade.lots} LOT
                </Text>
              </View>
              <Text style={[styles.profit, { color: profitColor }]}>{money(trade.profit)}</Text>
            </View>

            <View style={[styles.section, { borderTopColor: theme.colors.border }]}>
              <Row label="Entry Price" value={String(trade.entryPrice)} />
              <Row label="Exit Price" value={String(trade.exitPrice)} />
              <Row label="Realized P&L" value={money(trade.profit)} color={profitColor} />
            </View>

            <View style={[styles.section, { borderTopColor: theme.colors.border }]}>
              <Row label="Opened" value={dt(trade.openTime)} />
              <Row label="Closed" value={dt(trade.closeTime)} />
              <Row label="Duration" value={duration()} />
            </View>
          </ScrollView>
        </View>
      </View>
    </Modal>
  );
}

const styles = StyleSheet.create({
  overlay: { flex: 1, justifyContent: 'flex-end' },
  sheet: { borderTopLeftRadius: 20, borderTopRightRadius: 20, maxHeight: '80%', paddingHorizontal: 16 },
  grabber: { alignItems: 'center', paddingTop: 10, paddingBottom: 4 },
  grabberBar: { width: 44, height: 5, borderRadius: 3, opacity: 0.6 },
  header: {
    flexDirection: 'row', alignItems: 'flex-start', justifyContent: 'space-between',
    paddingVertical: 14, borderBottomWidth: 1,
  },
  symbol: { fontSize: 22, fontWeight: 'bold' },
  ticket: { fontSize: 13, marginTop: 2 },
  closeBtn: { width: 30, height: 30, borderRadius: 15, justifyContent: 'center', alignItems: 'center' },
  statusRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingVertical: 16 },
  badge: { paddingHorizontal: 12, paddingVertical: 6, borderRadius: 20 },
  badgeText: { fontWeight: 'bold', fontSize: 14 },
  profit: { fontSize: 20, fontWeight: '800' },
  section: { paddingVertical: 12, borderTopWidth: 1 },
  row: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', marginBottom: 12 },
  label: { fontSize: 15 },
  value: { fontSize: 15, fontWeight: '600' },
});
