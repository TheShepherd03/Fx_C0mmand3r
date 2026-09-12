import React, { useEffect, useState } from 'react';
import { View, Text, Modal, StyleSheet, TouchableOpacity, Pressable, TextInput, ScrollView } from 'react-native';
import { Signal } from '@/constants/types';
import { useTheme } from '@/contexts/ThemeContext';
import { IconSymbol } from '@/components/ui/icon-symbol';

interface Props {
  signal: Signal | null;
  balance: number | undefined;
  visible: boolean;
  busy?: boolean;
  onClose: () => void;
  onConfirm: (lots: number, sl: number, tp: number) => void;
}

export function ExecuteSignalModal({ signal, balance, visible, busy, onClose, onConfirm }: Props) {
  const { theme } = useTheme();
  const [lots, setLots] = useState('0.05');
  const [sl, setSl] = useState('');
  const [tp, setTp] = useState('');
  const [riskPct, setRiskPct] = useState('1');

  const canSize = !!(signal && signal.tickValue && signal.tickSize && signal.tickSize > 0 && signal.sl > 0 && balance);

  // Money risked per 1.0 lot if SL is hit (from the signal's tick specs)
  const riskPerLot = (slPrice: number) => {
    if (!signal || !signal.tickValue || !signal.tickSize || signal.tickSize <= 0) return 0;
    const dist = Math.abs(signal.price - slPrice);
    return (dist / signal.tickSize) * signal.tickValue;
  };

  const lotsForRisk = (pct: number, slPrice: number) => {
    const rpl = riskPerLot(slPrice);
    if (!rpl || !balance) return null;
    const raw = (balance * pct / 100) / rpl;
    return Math.max(0.01, Math.round(raw * 100) / 100);
  };

  useEffect(() => {
    if (signal) {
      setSl(signal.sl > 0 ? String(signal.sl) : '');
      setTp(signal.tp > 0 ? String(signal.tp) : '');
      const sized = canSize ? lotsForRisk(1, signal.sl) : null;
      setLots(String(sized ?? signal.lots ?? 0.05));
      setRiskPct('1');
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [signal]);

  if (!signal) return null;

  const onRiskChange = (v: string) => {
    setRiskPct(v);
    const pct = parseFloat(v);
    const slNum = parseFloat(sl);
    if (!isNaN(pct) && pct > 0 && slNum > 0) {
      const sized = lotsForRisk(pct, slNum);
      if (sized) setLots(String(sized));
    }
  };

  // Actual money at risk for the currently chosen lots + SL
  const lotsNum = parseFloat(lots) || 0;
  const slNum = parseFloat(sl) || 0;
  const actualRisk = slNum > 0 ? riskPerLot(slNum) * lotsNum : 0;
  const riskAsPct = actualRisk && balance ? (actualRisk / balance) * 100 : 0;

  const isBuy = signal.action === 'BUY';
  const confirm = () => onConfirm(parseFloat(lots) || 0, parseFloat(sl) || 0, parseFloat(tp) || 0);

  return (
    <Modal animationType="slide" transparent visible={visible} onRequestClose={onClose}>
      <View style={[styles.overlay, { backgroundColor: theme.colors.overlay }]}>
        <Pressable style={StyleSheet.absoluteFill} onPress={onClose} />
        <View style={[styles.sheet, { backgroundColor: theme.colors.card }]}>
          <View style={styles.grabber}><View style={[styles.grabberBar, { backgroundColor: theme.colors.border }]} /></View>
          <ScrollView contentContainerStyle={{ paddingBottom: 28 }} keyboardShouldPersistTaps="handled">
            <View style={styles.header}>
              <View>
                <Text style={[styles.title, { color: theme.colors.text }]}>{signal.symbol}</Text>
                <Text style={[styles.sub, { color: isBuy ? theme.colors.buy : theme.colors.sell }]}>
                  {signal.action} @ {signal.price} · {signal.source}
                </Text>
              </View>
              <TouchableOpacity style={[styles.close, { backgroundColor: theme.colors.input }]} onPress={onClose}>
                <IconSymbol name="xmark" size={16} color={theme.colors.textSecondary} />
              </TouchableOpacity>
            </View>

            {/* Risk sizing */}
            {canSize ? (
              <View style={[styles.riskBox, { backgroundColor: theme.colors.input }]}>
                <Text style={[styles.riskLabel, { color: theme.colors.textSecondary }]}>Size by risk</Text>
                <View style={styles.riskRow}>
                  {['0.5', '1', '2', '3'].map((p) => (
                    <TouchableOpacity
                      key={p}
                      style={[styles.riskChip, { borderColor: theme.colors.border }, riskPct === p && { backgroundColor: theme.colors.primary, borderColor: theme.colors.primary }]}
                      onPress={() => onRiskChange(p)}
                    >
                      <Text style={[styles.riskChipText, { color: riskPct === p ? '#fff' : theme.colors.text }]}>{p}%</Text>
                    </TouchableOpacity>
                  ))}
                  <TextInput
                    style={[styles.riskInput, { backgroundColor: theme.colors.card, color: theme.colors.text, borderColor: theme.colors.border }]}
                    value={riskPct}
                    onChangeText={onRiskChange}
                    keyboardType="numeric"
                    placeholder="%"
                    placeholderTextColor={theme.colors.textTertiary}
                  />
                </View>
              </View>
            ) : (
              <Text style={[styles.note, { color: theme.colors.textTertiary }]}>
                Risk sizing unavailable for this signal (no tick data / SL). Set lots manually.
              </Text>
            )}

            <Field label="Lot Size" value={lots} onChange={setLots} theme={theme} />
            <Field label="Stop Loss" value={sl} onChange={setSl} theme={theme} />
            <Field label="Take Profit" value={tp} onChange={setTp} theme={theme} />

            {slNum > 0 && actualRisk > 0 && (
              <Text style={[styles.riskSummary, { color: theme.colors.loss }]}>
                Risking ~${actualRisk.toFixed(2)}{balance ? `  (${riskAsPct.toFixed(2)}% of balance)` : ''}
              </Text>
            )}

            <TouchableOpacity
              style={[styles.confirmBtn, { backgroundColor: theme.colors.primary, opacity: busy ? 0.7 : 1 }]}
              onPress={confirm}
              disabled={busy}
            >
              <Text style={styles.confirmText}>{busy ? 'Sending…' : `Execute ${signal.action}`}</Text>
            </TouchableOpacity>
          </ScrollView>
        </View>
      </View>
    </Modal>
  );
}

function Field({ label, value, onChange, theme }: { label: string; value: string; onChange: (v: string) => void; theme: any }) {
  return (
    <View style={styles.field}>
      <Text style={[styles.fieldLabel, { color: theme.colors.textSecondary }]}>{label}</Text>
      <TextInput
        style={[styles.fieldInput, { backgroundColor: theme.colors.input, color: theme.colors.text, borderColor: theme.colors.border }]}
        value={value}
        onChangeText={onChange}
        keyboardType="numeric"
        placeholder="0"
        placeholderTextColor={theme.colors.textTertiary}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  overlay: { flex: 1, justifyContent: 'flex-end' },
  sheet: { borderTopLeftRadius: 20, borderTopRightRadius: 20, maxHeight: '88%', paddingHorizontal: 16 },
  grabber: { alignItems: 'center', paddingTop: 10, paddingBottom: 4 },
  grabberBar: { width: 44, height: 5, borderRadius: 3, opacity: 0.6 },
  header: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'flex-start', paddingVertical: 12 },
  title: { fontSize: 22, fontWeight: 'bold' },
  sub: { fontSize: 14, marginTop: 2, fontWeight: '600' },
  close: { width: 30, height: 30, borderRadius: 15, justifyContent: 'center', alignItems: 'center' },
  riskBox: { borderRadius: 12, padding: 12, marginBottom: 12 },
  riskLabel: { fontSize: 13, fontWeight: '600', marginBottom: 8 },
  riskRow: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  riskChip: { paddingHorizontal: 14, paddingVertical: 8, borderRadius: 8, borderWidth: 1 },
  riskChipText: { fontSize: 14, fontWeight: '700' },
  riskInput: { width: 60, borderWidth: 1, borderRadius: 8, paddingHorizontal: 10, paddingVertical: 8, fontSize: 14, textAlign: 'center' },
  note: { fontSize: 13, marginBottom: 12, lineHeight: 18 },
  field: { marginBottom: 12 },
  fieldLabel: { fontSize: 13, fontWeight: '600', marginBottom: 6 },
  fieldInput: { borderWidth: 1, borderRadius: 10, paddingHorizontal: 12, paddingVertical: 12, fontSize: 16, fontFamily: 'monospace' },
  riskSummary: { fontSize: 14, fontWeight: '700', marginTop: 2, marginBottom: 8, textAlign: 'center' },
  confirmBtn: { marginTop: 8, paddingVertical: 16, borderRadius: 12, alignItems: 'center' },
  confirmText: { color: '#fff', fontSize: 16, fontWeight: '700' },
});
