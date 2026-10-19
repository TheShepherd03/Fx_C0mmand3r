import React, { useEffect, useMemo, useState } from 'react';
import {
  ActivityIndicator,
  Modal,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TouchableOpacity,
  View,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import * as Haptics from 'expo-haptics';
import { get, ref } from 'firebase/database';

import { authReady, database } from '@/firebaseConfig';
import { useTheme } from '@/contexts/ThemeContext';
import { IconSymbol } from '@/components/ui/icon-symbol';

/** Same key rule as the EAs and the Bridge: each of space . $ # [ ] / becomes '_'. */
const keyFor = (name: string) => name.replace(/[ .$#[\]/]/g, '_');

/** "Profitable only" needs at least this many results on a symbol. */
const MIN_RESULTS = 5;
const SMALL_SAMPLE = 20;

type Range = '7D' | '30D' | 'All';
const RANGES: Range[] = ['7D', '30D', 'All'];
const RANGE_DAYS: Record<Range, number | null> = {
  '7D': 7,
  '30D': 30,
  All: null,
};

interface SymbolRow {
  key: string;
  name: string;
  n: number;
  winRate: number;
  totalR: number;
}

const fmtR = (r: number) => `${r > 0 ? '+' : r < 0 ? '-' : ''}${Math.abs(r).toFixed(1)}R`;

/**
 * Which symbols one source may auto trade on one account. Lists every symbol the source has
 * signalled there with its paper results (signalLog: every signal to TP / SL / expiry), so the
 * list can follow what actually worked. Saves `autotrade/{account}/sources/{key}/symbols`.
 */
export function AutoTradeSymbolsSheet({
  visible,
  onClose,
  account,
  source,
  current,
  onSave,
}: {
  visible: boolean;
  onClose: () => void;
  account: string;
  source: string;
  /** Symbol keys on the list now; null = every symbol. */
  current: string[] | null;
  onSave: (symbolKeys: string[] | null) => Promise<void>;
}) {
  const { theme } = useTheme();
  const insets = useSafeAreaInsets();
  const [rows, setRows] = useState<SymbolRow[] | null>(null);
  const [range, setRange] = useState<Range>('30D');
  const [onlyThese, setOnlyThese] = useState(false);
  const [picked, setPicked] = useState<Set<string>>(new Set());
  const [problem, setProblem] = useState('');
  const [saving, setSaving] = useState(false);

  // Fresh draft and results each time the sheet opens.
  useEffect(() => {
    if (!visible) return;
    setRows(null);
    let cancelled = false;
    authReady
      .then(() => get(ref(database, `signalLog/${account}`)))
      .then((snap) => {
        if (cancelled) return;
        const days = RANGE_DAYS[range];
        const cutoff = days == null ? 0 : Math.floor(Date.now() / 1000) - days * 86400;
        const by = new Map<string, { name: string; n: number; wins: number; totalR: number }>();
        snap.forEach((child) => {
          const e = child.val();
          if (!e || e.source !== source || typeof e.symbol !== 'string') return;
          if (cutoff && !(Number(e.closedAt) >= cutoff)) return;
          const r = typeof e.r === 'number' ? e.r : parseFloat(e.r);
          if (!Number.isFinite(r)) return;
          const k = keyFor(e.symbol);
          const g = by.get(k) ?? { name: e.symbol, n: 0, wins: 0, totalR: 0 };
          g.n++;
          if (r > 0) g.wins++;
          g.totalR += r;
          by.set(k, g);
        });
        const list: SymbolRow[] = Array.from(by, ([key, g]) => ({
          key,
          name: g.name,
          n: g.n,
          winRate: g.n ? g.wins / g.n : 0,
          totalR: g.totalR,
        }));
        // Symbols on the saved list that have no results yet still show.
        (current ?? []).forEach((k) => {
          if (!by.has(k))
            list.push({
              key: k,
              name: k.replace(/_/g, ' '),
              n: 0,
              winRate: 0,
              totalR: 0,
            });
        });
        list.sort((a, b) => b.totalR - a.totalR || b.n - a.n);
        setRows(list);
      })
      .catch(() => !cancelled && setRows([]));
    return () => {
      cancelled = true;
    };
  }, [visible, account, source, current, range]);

  // The draft survives a range change; only the results reload.
  useEffect(() => {
    if (!visible) return;
    setOnlyThese(!!current);
    setPicked(new Set(current ?? []));
    setProblem('');
  }, [visible, current]);

  const profitable = useMemo(
    () => (rows ?? []).filter((r) => r.n >= MIN_RESULTS && r.totalR > 0).map((r) => r.key),
    [rows],
  );

  const toggle = (key: string) => {
    Haptics.selectionAsync().catch(() => {});
    setProblem('');
    setOnlyThese(true);
    setPicked((prev) => {
      const next = new Set(onlyThese ? prev : []);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  };

  const pickProfitable = () => {
    Haptics.selectionAsync().catch(() => {});
    if (profitable.length === 0) {
      setProblem(`No symbol has ${MIN_RESULTS}+ results and a positive total yet.`);
      return;
    }
    setProblem('');
    setOnlyThese(true);
    setPicked(new Set(profitable));
  };

  const pickAll = () => {
    Haptics.selectionAsync().catch(() => {});
    setProblem('');
    setOnlyThese(false);
  };

  const save = async () => {
    if (onlyThese && picked.size === 0) {
      setProblem('Pick at least one symbol, or choose Every symbol.');
      return;
    }
    setSaving(true);
    try {
      await onSave(onlyThese ? Array.from(picked) : null);
      onClose();
    } catch {
      setProblem('Could not save. Check your connection.');
    } finally {
      setSaving(false);
    }
  };

  const rColor = (r: number) => (r > 0 ? theme.colors.profit : r < 0 ? theme.colors.loss : theme.colors.textSecondary);

  return (
    <Modal animationType="slide" transparent visible={visible} onRequestClose={onClose}>
      <View style={[styles.overlay, { backgroundColor: theme.colors.overlay }]}>
        <Pressable style={StyleSheet.absoluteFill} onPress={onClose} accessibilityLabel="Close symbols" />
        <View
          style={[
            styles.sheet,
            {
              backgroundColor: theme.colors.card,
              paddingBottom: Math.max(insets.bottom, 12) + 12,
            },
            theme.isDark && {
              borderWidth: StyleSheet.hairlineWidth,
              borderBottomWidth: 0,
              borderColor: theme.colors.border,
            },
          ]}>
          <View style={styles.grabber}>
            <View style={[styles.grabberBar, { backgroundColor: theme.colors.border }]} />
          </View>
          <Text style={[styles.title, { color: theme.colors.text }]}>{source} · symbols</Text>
          <Text style={[styles.subtitle, { color: theme.colors.textSecondary }]}>
            Auto trade {source} only on the symbols you tick. Results are every {source} signal on this account (paper:
            to TP, SL or expiry), for the period on the right.
          </Text>

          <View style={[styles.segment, { backgroundColor: theme.colors.input }]}>
            <TouchableOpacity
              style={[styles.segmentBtn, !onlyThese && { backgroundColor: theme.colors.primary }]}
              onPress={pickAll}
              accessibilityRole="button"
              accessibilityState={{ selected: !onlyThese }}>
              <Text style={[styles.segmentText, { color: !onlyThese ? '#FFF' : theme.colors.textSecondary }]}>
                Every symbol
              </Text>
            </TouchableOpacity>
            <TouchableOpacity
              style={[styles.segmentBtn, onlyThese && { backgroundColor: theme.colors.primary }]}
              onPress={() => {
                setProblem('');
                setOnlyThese(true);
              }}
              accessibilityRole="button"
              accessibilityState={{ selected: onlyThese }}>
              <Text style={[styles.segmentText, { color: onlyThese ? '#FFF' : theme.colors.textSecondary }]}>
                Only these{onlyThese ? ` (${picked.size})` : ''}
              </Text>
            </TouchableOpacity>
          </View>

          <View style={styles.quickRow}>
            <TouchableOpacity
              style={[styles.quick, { borderColor: theme.colors.primary }]}
              onPress={pickProfitable}
              accessibilityRole="button"
              accessibilityLabel={`Tick the profitable symbols: ${MIN_RESULTS} or more results and a positive total`}>
              <IconSymbol name="chart.line.uptrend.xyaxis" size={16} color={theme.colors.primary} />
              <Text style={[styles.quickText, { color: theme.colors.primary }]}>
                Profitable only ({profitable.length})
              </Text>
            </TouchableOpacity>
            <View style={styles.ranges}>
              {RANGES.map((r) => {
                const active = range === r;
                return (
                  <TouchableOpacity
                    key={r}
                    style={[
                      styles.rangePill,
                      {
                        backgroundColor: active ? theme.colors.primary : theme.colors.input,
                      },
                    ]}
                    onPress={() => setRange(r)}
                    accessibilityRole="button"
                    accessibilityState={{ selected: active }}
                    accessibilityLabel={
                      r === 'All' ? 'Results of all time' : `Results of the last ${RANGE_DAYS[r]} days`
                    }>
                    <Text style={[styles.rangeText, { color: active ? '#FFF' : theme.colors.textSecondary }]}>{r}</Text>
                  </TouchableOpacity>
                );
              })}
            </View>
          </View>

          {rows === null ? (
            <ActivityIndicator style={{ marginVertical: 24 }} color={theme.colors.primary} />
          ) : rows.length === 0 ? (
            <Text style={[styles.empty, { color: theme.colors.textTertiary }]}>
              {source} has no results on this account{' '}
              {range === 'All' ? 'yet' : `in the last ${RANGE_DAYS[range]} days`}.
            </Text>
          ) : (
            <ScrollView style={styles.listScroll} contentContainerStyle={styles.list} bounces={false}>
              {rows.map((r) => {
                const on = !onlyThese || picked.has(r.key);
                return (
                  <TouchableOpacity
                    key={r.key}
                    style={[styles.row, { borderTopColor: theme.colors.border }]}
                    onPress={() => toggle(r.key)}
                    accessibilityRole="checkbox"
                    accessibilityState={{ checked: on }}
                    accessibilityLabel={`${r.name}: ${r.n} results, ${Math.round(r.winRate * 100)}% won, total ${fmtR(r.totalR)}`}>
                    <View
                      style={[
                        styles.check,
                        {
                          borderColor: on ? theme.colors.primary : theme.colors.border,
                        },
                        on && {
                          backgroundColor: onlyThese ? theme.colors.primary : theme.colors.primary + '55',
                        },
                      ]}>
                      {on && <IconSymbol name="checkmark" size={14} color="#FFF" />}
                    </View>
                    <Text style={[styles.name, { color: theme.colors.text }]} numberOfLines={1}>
                      {r.name}
                    </Text>
                    <Text style={[styles.meta, { color: theme.colors.textTertiary }]}>
                      {r.n ? `${r.n}${r.n < SMALL_SAMPLE ? '*' : ''} · ${Math.round(r.winRate * 100)}%` : 'no results'}
                    </Text>
                    <Text style={[styles.total, { color: rColor(r.totalR) }]}>{r.n ? fmtR(r.totalR) : ''}</Text>
                  </TouchableOpacity>
                );
              })}
              <Text style={[styles.note, { color: theme.colors.textTertiary }]}>
                * under {SMALL_SAMPLE} results — an early read. Profitable only = {MIN_RESULTS}+ results and a positive
                total.
              </Text>
            </ScrollView>
          )}

          {!!problem && <Text style={[styles.problem, { color: theme.colors.error }]}>{problem}</Text>}

          <View style={styles.btns}>
            <TouchableOpacity
              style={[styles.btn, { backgroundColor: theme.colors.input }]}
              onPress={onClose}
              accessibilityRole="button">
              <Text style={[styles.btnText, { color: theme.colors.text }]}>Cancel</Text>
            </TouchableOpacity>
            <TouchableOpacity
              style={[styles.btn, { backgroundColor: theme.colors.primary }, saving && { opacity: 0.6 }]}
              onPress={save}
              disabled={saving}
              accessibilityRole="button"
              accessibilityLabel={`Save the ${source} symbols`}>
              <Text style={[styles.btnText, { color: '#FFF' }]}>Save</Text>
            </TouchableOpacity>
          </View>
        </View>
      </View>
    </Modal>
  );
}

const styles = StyleSheet.create({
  overlay: {
    flex: 1,
    justifyContent: 'flex-end',
  },
  sheet: {
    borderTopLeftRadius: 20,
    borderTopRightRadius: 20,
    paddingHorizontal: 16,
    maxHeight: '88%',
  },
  grabber: {
    alignItems: 'center',
    paddingTop: 10,
    paddingBottom: 8,
  },
  grabberBar: {
    width: 40,
    height: 4,
    borderRadius: 2,
  },
  title: {
    fontSize: 18,
    fontWeight: '800',
  },
  subtitle: {
    fontSize: 13,
    lineHeight: 18,
    marginTop: 4,
  },
  segment: {
    flexDirection: 'row',
    borderRadius: 10,
    padding: 3,
    marginTop: 14,
  },
  segmentBtn: {
    flex: 1,
    borderRadius: 8,
    paddingVertical: 9,
    alignItems: 'center',
  },
  segmentText: {
    fontSize: 13,
    fontWeight: '700',
  },
  quickRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    marginTop: 12,
  },
  quick: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    borderWidth: 1,
    borderRadius: 16,
    paddingHorizontal: 12,
    paddingVertical: 6,
  },
  ranges: {
    flexDirection: 'row',
    gap: 6,
  },
  rangePill: {
    borderRadius: 14,
    paddingHorizontal: 10,
    paddingVertical: 6,
  },
  rangeText: {
    fontSize: 12,
    fontWeight: '700',
  },
  quickText: {
    fontSize: 13,
    fontWeight: '700',
  },
  empty: {
    fontSize: 13,
    marginVertical: 20,
    textAlign: 'center',
  },
  listScroll: {
    marginTop: 10,
    flexGrow: 0,
  },
  list: {
    paddingBottom: 4,
  },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
    paddingVertical: 11,
    borderTopWidth: StyleSheet.hairlineWidth,
  },
  check: {
    width: 22,
    height: 22,
    borderRadius: 6,
    borderWidth: 1.5,
    justifyContent: 'center',
    alignItems: 'center',
  },
  name: {
    flex: 1,
    fontSize: 15,
    fontWeight: '600',
  },
  meta: {
    fontSize: 12,
    fontWeight: '600',
  },
  total: {
    width: 58,
    textAlign: 'right',
    fontSize: 14,
    fontWeight: '800',
  },
  note: {
    fontSize: 11,
    lineHeight: 15,
    marginTop: 8,
  },
  problem: {
    fontSize: 13,
    marginTop: 8,
  },
  btns: {
    flexDirection: 'row',
    gap: 10,
    marginTop: 12,
  },
  btn: {
    flex: 1,
    borderRadius: 14,
    paddingVertical: 14,
    alignItems: 'center',
  },
  btnText: {
    fontSize: 15,
    fontWeight: '700',
  },
});
