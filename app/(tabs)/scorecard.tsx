import React, { useEffect, useMemo, useState } from 'react';
import {
  ActivityIndicator,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TouchableOpacity,
  View,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import Animated, { FadeIn } from 'react-native-reanimated';
import Svg, { Circle, Line, Path } from 'react-native-svg';
import { onValue, ref } from 'firebase/database';

import { database } from '@/firebaseConfig';
import { AccountSelector } from '@/components/AccountSelector';
import { IconSymbol } from '@/components/ui/icon-symbol';
import { useAccount } from '@/contexts/AccountContext';
import { useTheme, type Theme } from '@/contexts/ThemeContext';

// One closed signal, written by the signal EAs when it hits TP/SL or expires:
// signalLog/{accountId}/{openedMinute_Source_Symbol}. Keys are NOT ordered by close
// time, so everything here sorts/filters on the record's `closedAt`. Read-only.
interface Outcome {
  id: string;
  source: string;
  symbol: string;
  action: string;   // 'BUY' | 'SELL'
  tag: string;      // '' when the EA sent none (Zones: sweep / engulf / reject)
  outcome: string;  // 'tp' | 'sl' | 'expired'
  r: number;        // R-multiple: TP ≈ +reward/risk, SL = -1, expired = mark-to-market
  closedAt: number; // UTC epoch secs
}

type Range = '7D' | '30D' | 'All';
const RANGES: Range[] = ['7D', '30D', 'All'];
const RANGE_DAYS: Record<Range, number | null> = { '7D': 7, '30D': 30, All: null };
const SMALL_SAMPLE = 20;
const RECENT_LIMIT = 20;
const DAY = 86400;

interface Stats {
  n: number;
  winRate: number;   // share of outcomes with r > 0
  avgR: number;
  totalR: number;
  grossWin: number;  // sum of positive r
  grossLoss: number; // |sum of negative r|
}

interface Group {
  name: string;
  list: Outcome[]; // oldest -> newest
  stats: Stats;
}

/* ------------------------------ data helpers ------------------------------ */

const num = (v: unknown) =>
  typeof v === 'number' ? v : typeof v === 'string' ? parseFloat(v) : NaN;

function parseLog(val: any): Outcome[] {
  if (!val || typeof val !== 'object') return [];
  const out: Outcome[] = [];
  Object.keys(val).forEach((id) => {
    const e = val[id];
    if (!e || typeof e !== 'object') return;
    const r = num(e.r);
    const closedAt = num(e.closedAt);
    if (!Number.isFinite(r) || !Number.isFinite(closedAt)) return;
    out.push({
      id,
      source: typeof e.source === 'string' && e.source.trim() ? e.source.trim() : 'Unknown',
      symbol: typeof e.symbol === 'string' && e.symbol ? e.symbol : '—',
      action: typeof e.action === 'string' ? e.action.toUpperCase() : '',
      tag: typeof e.tag === 'string' ? e.tag.trim() : '',
      outcome: typeof e.outcome === 'string' ? e.outcome.toLowerCase() : '',
      r,
      closedAt,
    });
  });
  return out.sort((a, b) => a.closedAt - b.closedAt);
}

function computeStats(list: Outcome[]): Stats {
  let wins = 0;
  let totalR = 0;
  let grossWin = 0;
  let grossLoss = 0;
  list.forEach((o) => {
    totalR += o.r;
    if (o.r > 0) {
      wins++;
      grossWin += o.r;
    } else if (o.r < 0) {
      grossLoss -= o.r;
    }
  });
  const n = list.length;
  return { n, winRate: n ? wins / n : 0, avgR: n ? totalR / n : 0, totalR, grossWin, grossLoss };
}

/** Groups keep the input's chronological order; groups are sorted by total R (best first). */
function groupBy(list: Outcome[], keyOf: (o: Outcome) => string): Group[] {
  const map = new Map<string, Outcome[]>();
  list.forEach((o) => {
    const k = keyOf(o);
    const arr = map.get(k);
    if (arr) arr.push(o);
    else map.set(k, [o]);
  });
  return Array.from(map, ([name, items]) => ({ name, list: items, stats: computeStats(items) })).sort(
    (a, b) => b.stats.totalR - a.stats.totalR || b.stats.n - a.stats.n,
  );
}

const fmtR = (r: number, digits = 2) =>
  `${r > 0 ? '+' : r < 0 ? '-' : ''}${Math.abs(r).toFixed(digits)}R`;

const fmtPct = (x: number) => `${Math.round(x * 100)}%`;

/** Profit factor = gross win R / gross loss R; "∞" with wins and no losses. */
const fmtPF = (s: Stats) =>
  s.grossLoss > 0 ? (s.grossWin / s.grossLoss).toFixed(2) : s.grossWin > 0 ? '∞' : '—';

const timeAgo = (ts: number, now: number) => {
  const diff = Math.max(0, now - ts);
  if (diff < 60) return 'just now';
  if (diff < 3600) return `${Math.floor(diff / 60)}m ago`;
  if (diff < DAY) return `${Math.floor(diff / 3600)}h ago`;
  if (diff < 30 * DAY) return `${Math.floor(diff / DAY)}d ago`;
  return new Date(ts * 1000).toLocaleDateString();
};

// Non-semantic palette (no reds/greens — those mean loss/profit here).
const SOURCE_COLORS = ['#3B82F6', '#8B5CF6', '#F59E0B', '#06B6D4', '#EC4899', '#6366F1', '#14B8A6', '#F97316'];

const sourceColor = (name: string) => {
  let h = 0;
  for (let i = 0; i < name.length; i++) h = (h * 31 + name.charCodeAt(i)) | 0;
  return SOURCE_COLORS[Math.abs(h) % SOURCE_COLORS.length];
};

// "Supply/Demand" -> "SD", "Range Breakout" -> "RB", "DriftRegime" -> "DR", "AMD" -> "AMD", "Zones" -> "ZO".
const initials = (name: string) => {
  const clean = name.replace(/[^A-Za-z0-9 /_-]/g, '');
  if (clean.length <= 3 && clean.length > 0) return clean.toUpperCase();
  const words = clean.split(/[\s/_-]+/).filter(Boolean);
  if (words.length >= 2) return (words[0][0] + words[1][0]).toUpperCase();
  const caps = clean.match(/[A-Z]/g);
  if (caps && caps.length >= 2) return caps[0] + caps[1];
  return clean.slice(0, 2).toUpperCase() || '?';
};

/* ------------------------------- components ------------------------------- */

function Sparkline({
  values,
  width,
  height,
  color,
  baseline,
}: {
  values: number[];
  width: number;
  height: number;
  color: string;
  baseline: string;
}) {
  // Cumulative R after each outcome, starting from break-even.
  const pts = [0, ...values];
  let min = 0;
  let max = 0;
  pts.forEach((v) => {
    if (v < min) min = v;
    if (v > max) max = v;
  });
  const span = max - min || 1;
  const pad = 3;
  const x = (i: number) => pad + (i * (width - pad * 2)) / Math.max(1, pts.length - 1);
  const y = (v: number) => pad + (1 - (v - min) / span) * (height - pad * 2);
  const line = pts.map((v, i) => `${i ? 'L' : 'M'}${x(i).toFixed(1)} ${y(v).toFixed(1)}`).join(' ');
  const zeroY = y(0).toFixed(1);
  const last = pts.length - 1;
  const area = `${line} L${x(last).toFixed(1)} ${zeroY} L${x(0).toFixed(1)} ${zeroY} Z`;

  return (
    <Svg width={width} height={height}>
      <Path d={area} fill={color} fillOpacity={0.12} />
      <Line x1={pad} x2={width - pad} y1={zeroY} y2={zeroY} stroke={baseline} strokeWidth={1} strokeDasharray="3 3" />
      <Path d={line} stroke={color} strokeWidth={1.8} fill="none" strokeLinejoin="round" strokeLinecap="round" />
      <Circle cx={x(last)} cy={y(pts[last])} r={2.6} fill={color} />
    </Svg>
  );
}

function SmallSampleTag({ theme }: { theme: Theme }) {
  return (
    <View style={[styles.smallTag, { backgroundColor: theme.colors.warning + '1F' }]}>
      <Text style={[styles.smallTagText, { color: theme.colors.warning }]}>SMALL SAMPLE</Text>
    </View>
  );
}

function Stat({ label, value, color, theme }: { label: string; value: string; color?: string; theme: Theme }) {
  return (
    <View style={styles.stat}>
      <Text style={[styles.statLabel, { color: theme.colors.textTertiary }]}>{label}</Text>
      <Text style={[styles.statValue, { color: color ?? theme.colors.text }]} numberOfLines={1}>
        {value}
      </Text>
    </View>
  );
}

function BreakdownTable({
  title,
  rows,
  theme,
  rColor,
}: {
  title: string;
  rows: Group[];
  theme: Theme;
  rColor: (r: number) => string;
}) {
  const anySmall = rows.some((g) => g.stats.n < SMALL_SAMPLE);
  const head = [styles.th, { color: theme.colors.textTertiary }];
  return (
    <View style={styles.table}>
      <Text style={[styles.detailTitle, { color: theme.colors.textSecondary }]}>{title}</Text>
      <View style={styles.tr}>
        <Text style={[...head, styles.cName]}> </Text>
        <Text style={[...head, styles.cN]}>N</Text>
        <Text style={[...head, styles.cWin]}>WIN</Text>
        <Text style={[...head, styles.cAvg]}>AVG R</Text>
        <Text style={[...head, styles.cPf]}>PF</Text>
        <Text style={[...head, styles.cTotal]}>TOTAL</Text>
      </View>
      {rows.map((g) => {
        const small = g.stats.n < SMALL_SAMPLE;
        return (
          <View key={g.name} style={[styles.tr, styles.trBody, { borderTopColor: theme.colors.border }]}>
            <Text style={[styles.td, styles.cName, { color: theme.colors.text, fontWeight: '700' }]} numberOfLines={1}>
              {g.name}
            </Text>
            <Text style={[styles.td, styles.cN, { color: small ? theme.colors.textTertiary : theme.colors.textSecondary }]}>
              {g.stats.n}
              {small ? '*' : ''}
            </Text>
            <Text style={[styles.td, styles.cWin, { color: theme.colors.text }]}>{fmtPct(g.stats.winRate)}</Text>
            <Text style={[styles.td, styles.cAvg, { color: rColor(g.stats.avgR) }]}>{fmtR(g.stats.avgR)}</Text>
            <Text style={[styles.td, styles.cPf, { color: theme.colors.text }]}>{fmtPF(g.stats)}</Text>
            <Text style={[styles.td, styles.cTotal, { color: rColor(g.stats.totalR), fontWeight: '800' }]}>
              {fmtR(g.stats.totalR, 1)}
            </Text>
          </View>
        );
      })}
      {anySmall && (
        <Text style={[styles.footnote, { color: theme.colors.textTertiary }]}>
          * fewer than {SMALL_SAMPLE} outcomes — small sample, read with caution
        </Text>
      )}
    </View>
  );
}

function OutcomeRow({
  o,
  now,
  theme,
  rColor,
}: {
  o: Outcome;
  now: number;
  theme: Theme;
  rColor: (r: number) => string;
}) {
  const badge =
    o.outcome === 'tp'
      ? { label: 'TP', color: theme.colors.profit }
      : o.outcome === 'sl'
        ? { label: 'SL', color: theme.colors.loss }
        : o.outcome === 'expired'
          ? { label: 'EXPIRED', color: theme.colors.textSecondary }
          : { label: (o.outcome || '?').toUpperCase(), color: theme.colors.textSecondary };
  const actionColor =
    o.action === 'BUY' ? theme.colors.buy : o.action === 'SELL' ? theme.colors.sell : theme.colors.textTertiary;

  return (
    <View style={[styles.outRow, { borderTopColor: theme.colors.border }]}>
      <View style={styles.outMain}>
        <Text style={[styles.outSymbol, { color: theme.colors.text }]} numberOfLines={1}>
          {o.symbol}
        </Text>
        <Text style={[styles.outMeta, { color: theme.colors.textTertiary }]} numberOfLines={1}>
          <Text style={{ color: actionColor, fontWeight: '800' }}>{o.action || '—'}</Text>
          {o.tag ? ` · ${o.tag}` : ''}
        </Text>
      </View>
      <View style={[styles.outBadge, { backgroundColor: badge.color + '22' }]}>
        <Text style={[styles.outBadgeText, { color: badge.color }]}>{badge.label}</Text>
      </View>
      <Text style={[styles.outR, { color: rColor(o.r) }]}>{fmtR(o.r)}</Text>
      <Text style={[styles.outAgo, { color: theme.colors.textTertiary }]} numberOfLines={1}>
        {timeAgo(o.closedAt, now)}
      </Text>
    </View>
  );
}

function SourceDetail({
  group,
  now,
  theme,
  rColor,
}: {
  group: Group;
  now: number;
  theme: Theme;
  rColor: (r: number) => string;
}) {
  const bySymbol = useMemo(() => groupBy(group.list, (o) => o.symbol), [group.list]);
  const hasTags = group.list.some((o) => o.tag);
  const byTag = useMemo(
    () => (hasTags ? groupBy(group.list, (o) => o.tag || '(none)') : []),
    [group.list, hasTags],
  );
  const recent = useMemo(() => group.list.slice(-RECENT_LIMIT).reverse(), [group.list]);

  return (
    <Animated.View entering={FadeIn.duration(180)} style={[styles.detail, { borderTopColor: theme.colors.border }]}>
      <BreakdownTable title="By symbol" rows={bySymbol} theme={theme} rColor={rColor} />
      {hasTags && <BreakdownTable title="By setup tag" rows={byTag} theme={theme} rColor={rColor} />}
      <Text style={[styles.detailTitle, { color: theme.colors.textSecondary }]}>
        Last {recent.length} {recent.length === 1 ? 'outcome' : 'outcomes'}
      </Text>
      {recent.map((o) => (
        <OutcomeRow key={o.id} o={o} now={now} theme={theme} rColor={rColor} />
      ))}
    </Animated.View>
  );
}

function SourceCard({
  group,
  expanded,
  onToggle,
  now,
  theme,
  rColor,
}: {
  group: Group;
  expanded: boolean;
  onToggle: () => void;
  now: number;
  theme: Theme;
  rColor: (r: number) => string;
}) {
  const s = group.stats;
  const cumulative = useMemo(() => {
    let c = 0;
    return group.list.map((o) => (c += o.r));
  }, [group.list]);

  return (
    <View style={[styles.card, { backgroundColor: theme.colors.card }]}>
      <Pressable
        onPress={onToggle}
        accessibilityRole="button"
        accessibilityState={{ expanded }}
        accessibilityLabel={`${group.name}: ${s.n} outcomes, total ${fmtR(s.totalR, 1)}`}
        style={({ pressed }) => pressed && { opacity: 0.85 }}>
        <View style={styles.cardTop}>
          <View style={[styles.badge, { backgroundColor: sourceColor(group.name) }]}>
            <Text style={styles.badgeText}>{initials(group.name)}</Text>
          </View>
          <View style={styles.cardTitleCol}>
            <Text style={[styles.sourceName, { color: theme.colors.text }]} numberOfLines={1}>
              {group.name}
            </Text>
            <View style={styles.metaRow}>
              <Text style={[styles.meta, { color: theme.colors.textSecondary }]}>
                {s.n} {s.n === 1 ? 'outcome' : 'outcomes'}
              </Text>
              {s.n < SMALL_SAMPLE && <SmallSampleTag theme={theme} />}
            </View>
          </View>
          <Sparkline
            values={cumulative}
            width={96}
            height={36}
            color={s.totalR >= 0 ? theme.colors.profit : theme.colors.loss}
            baseline={theme.colors.border}
          />
        </View>

        <View style={[styles.statsRow, { borderTopColor: theme.colors.border }]}>
          <Stat label="WIN RATE" value={fmtPct(s.winRate)} theme={theme} />
          <Stat label="AVG R" value={fmtR(s.avgR)} color={rColor(s.avgR)} theme={theme} />
          <Stat label="PF" value={fmtPF(s)} theme={theme} />
          <Stat label="TOTAL R" value={fmtR(s.totalR, 1)} color={rColor(s.totalR)} theme={theme} />
          <IconSymbol name={expanded ? 'chevron.up' : 'chevron.down'} size={22} color={theme.colors.textTertiary} />
        </View>
      </Pressable>

      {expanded && <SourceDetail group={group} now={now} theme={theme} rColor={rColor} />}
    </View>
  );
}

/* --------------------------------- screen --------------------------------- */

export default function ScorecardScreen() {
  const { selectedAccount } = useAccount();
  const { theme } = useTheme();
  const [log, setLog] = useState<Outcome[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [range, setRange] = useState<Range>('All');
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  // Ticks each minute so the range cut-off and "x ago" labels stay current.
  const [now, setNow] = useState(() => Math.floor(Date.now() / 1000));

  useEffect(() => {
    const id = setInterval(() => setNow(Math.floor(Date.now() / 1000)), 60000);
    return () => clearInterval(id);
  }, []);

  // Live outcome log for the selected account; re-attached on account change.
  useEffect(() => {
    setExpanded(new Set());
    setLog([]);
    setError(null);
    if (!selectedAccount) {
      setLoading(false);
      return;
    }
    setLoading(true);
    const unsubscribe = onValue(
      ref(database, `signalLog/${selectedAccount}`),
      (snapshot) => {
        setLog(parseLog(snapshot.val()));
        setLoading(false);
      },
      (err) => {
        setError(err.message);
        setLoading(false);
      },
    );
    return () => unsubscribe();
  }, [selectedAccount]);

  const inRange = useMemo(() => {
    const days = RANGE_DAYS[range];
    if (days == null) return log;
    const cutoff = now - days * DAY;
    return log.filter((o) => o.closedAt >= cutoff);
  }, [log, range, now]);

  const overall = useMemo(() => computeStats(inRange), [inRange]);
  const bySource = useMemo(() => groupBy(inRange, (o) => o.source), [inRange]);

  const rColor = (r: number) =>
    r > 0 ? theme.colors.profit : r < 0 ? theme.colors.loss : theme.colors.textSecondary;

  const toggle = (name: string) =>
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(name)) next.delete(name);
      else next.add(name);
      return next;
    });

  const rangeLabel = range === 'All' ? 'all time' : `last ${RANGE_DAYS[range]} days`;

  const renderBody = () => {
    if (!selectedAccount) {
      return (
        <View style={styles.empty}>
          <IconSymbol name="chart.bar.fill" size={48} color={theme.colors.textTertiary} />
          <Text style={[styles.emptyTitle, { color: theme.colors.textSecondary }]}>No account selected</Text>
        </View>
      );
    }
    if (loading) {
      return <ActivityIndicator style={{ marginTop: 40 }} size="large" color={theme.colors.primary} />;
    }
    if (error) {
      return (
        <View style={[styles.errorCard, { backgroundColor: theme.colors.error + '20' }]}>
          <Text style={[styles.errorText, { color: theme.colors.error }]}>Could not load results: {error}</Text>
        </View>
      );
    }
    if (log.length === 0) {
      return (
        <View style={styles.empty}>
          <IconSymbol name="chart.bar.fill" size={48} color={theme.colors.textTertiary} />
          <Text style={[styles.emptyTitle, { color: theme.colors.textSecondary }]}>
            No results yet — outcomes appear here as signals hit TP or SL, or expire.
          </Text>
        </View>
      );
    }
    if (inRange.length === 0) {
      return (
        <View style={styles.empty}>
          <IconSymbol name="chart.bar.fill" size={48} color={theme.colors.textTertiary} />
          <Text style={[styles.emptyTitle, { color: theme.colors.textSecondary }]}>
            No outcomes closed in the {rangeLabel}.
          </Text>
          <TouchableOpacity onPress={() => setRange('All')} accessibilityRole="button">
            <Text style={[styles.emptyLink, { color: theme.colors.primary }]}>Show all time</Text>
          </TouchableOpacity>
        </View>
      );
    }

    return (
      <>
        {/* Summary strip */}
        <View style={[styles.card, styles.summaryCard, { backgroundColor: theme.colors.card }]}>
          <View style={styles.summaryHead}>
            <Text style={[styles.summaryTitle, { color: theme.colors.textSecondary }]}>
              ALL SOURCES · {rangeLabel.toUpperCase()}
            </Text>
            {overall.n < SMALL_SAMPLE && <SmallSampleTag theme={theme} />}
          </View>
          <View style={styles.summaryRow}>
            <Stat label="SIGNALS" value={String(overall.n)} theme={theme} />
            <Stat label="WIN RATE" value={fmtPct(overall.winRate)} theme={theme} />
            <Stat label="AVG R" value={fmtR(overall.avgR)} color={rColor(overall.avgR)} theme={theme} />
            <Stat label="TOTAL R" value={fmtR(overall.totalR, 1)} color={rColor(overall.totalR)} theme={theme} />
          </View>
        </View>

        <Text style={[styles.sectionHeader, { color: theme.colors.textSecondary }]}>By source</Text>
        {bySource.map((g) => (
          <SourceCard
            key={g.name}
            group={g}
            expanded={expanded.has(g.name)}
            onToggle={() => toggle(g.name)}
            now={now}
            theme={theme}
            rColor={rColor}
          />
        ))}

        <Text style={[styles.legend, { color: theme.colors.textTertiary }]}>
          R = result in multiples of the signal’s risk (entry to SL). Win = R above 0. PF = winning R ÷
          losing R. Groups under {SMALL_SAMPLE} outcomes are a small sample — treat them as early reads.
        </Text>
      </>
    );
  };

  return (
    <SafeAreaView style={[styles.container, { backgroundColor: theme.colors.background }]}>
      {/* Time filter (by close time) */}
      <View style={styles.filterRow}>
        {RANGES.map((r) => {
          const active = range === r;
          return (
            <TouchableOpacity
              key={r}
              style={[styles.filterPill, { backgroundColor: active ? theme.colors.primary : theme.colors.card }]}
              onPress={() => setRange(r)}
              accessibilityRole="button"
              accessibilityState={{ selected: active }}>
              <Text style={[styles.filterText, { color: active ? '#FFF' : theme.colors.textSecondary }]}>{r}</Text>
            </TouchableOpacity>
          );
        })}
      </View>

      <ScrollView contentContainerStyle={styles.content}>
        <AccountSelector />
        {renderBody()}
      </ScrollView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
  },
  filterRow: {
    flexDirection: 'row',
    gap: 8,
    paddingHorizontal: 16,
    marginBottom: 12,
  },
  filterPill: {
    paddingHorizontal: 16,
    paddingVertical: 8,
    borderRadius: 20,
  },
  filterText: {
    fontSize: 14,
    fontWeight: '600',
  },
  content: {
    padding: 16,
    paddingTop: 0,
  },
  sectionHeader: {
    fontSize: 13,
    fontWeight: '800',
    textTransform: 'uppercase',
    letterSpacing: 0.5,
    marginTop: 4,
    marginBottom: 8,
  },
  card: {
    borderRadius: 16,
    padding: 16,
    marginBottom: 12,
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 2 },
    shadowOpacity: 0.05,
    shadowRadius: 8,
    elevation: 2,
  },
  summaryCard: {
    marginBottom: 16,
  },
  summaryHead: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: 8,
    marginBottom: 12,
  },
  summaryTitle: {
    flex: 1,
    fontSize: 11,
    fontWeight: '800',
    letterSpacing: 0.8,
  },
  summaryRow: {
    flexDirection: 'row',
  },
  stat: {
    flex: 1,
  },
  statLabel: {
    fontSize: 10,
    fontWeight: '800',
    letterSpacing: 0.6,
    marginBottom: 4,
  },
  statValue: {
    fontSize: 16,
    fontWeight: '800',
  },
  smallTag: {
    paddingHorizontal: 6,
    paddingVertical: 2,
    borderRadius: 4,
  },
  smallTagText: {
    fontSize: 9,
    fontWeight: '800',
    letterSpacing: 0.4,
  },
  cardTop: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
  },
  badge: {
    width: 40,
    height: 40,
    borderRadius: 12,
    alignItems: 'center',
    justifyContent: 'center',
  },
  badgeText: {
    color: '#FFF',
    fontSize: 13,
    fontWeight: '800',
  },
  cardTitleCol: {
    flex: 1,
  },
  sourceName: {
    fontSize: 17,
    fontWeight: '800',
  },
  metaRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    marginTop: 3,
  },
  meta: {
    fontSize: 12,
    fontWeight: '600',
  },
  statsRow: {
    flexDirection: 'row',
    alignItems: 'center',
    marginTop: 14,
    paddingTop: 12,
    borderTopWidth: StyleSheet.hairlineWidth,
  },
  detail: {
    marginTop: 12,
    paddingTop: 4,
    borderTopWidth: StyleSheet.hairlineWidth,
  },
  detailTitle: {
    fontSize: 11,
    fontWeight: '800',
    letterSpacing: 0.8,
    textTransform: 'uppercase',
    marginTop: 12,
    marginBottom: 6,
  },
  table: {
    marginBottom: 4,
  },
  tr: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingVertical: 6,
  },
  trBody: {
    borderTopWidth: StyleSheet.hairlineWidth,
  },
  th: {
    fontSize: 9,
    fontWeight: '800',
    letterSpacing: 0.5,
  },
  td: {
    fontSize: 12,
    fontWeight: '600',
  },
  cName: {
    flex: 1,
    paddingRight: 6,
  },
  cN: {
    width: 30,
    textAlign: 'right',
  },
  cWin: {
    width: 40,
    textAlign: 'right',
  },
  cAvg: {
    width: 52,
    textAlign: 'right',
  },
  cPf: {
    width: 38,
    textAlign: 'right',
  },
  cTotal: {
    width: 56,
    textAlign: 'right',
  },
  footnote: {
    fontSize: 11,
    marginTop: 4,
    fontStyle: 'italic',
  },
  outRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    paddingVertical: 8,
    borderTopWidth: StyleSheet.hairlineWidth,
  },
  outMain: {
    flex: 1,
  },
  outSymbol: {
    fontSize: 13,
    fontWeight: '700',
  },
  outMeta: {
    fontSize: 11,
    marginTop: 1,
  },
  outBadge: {
    paddingHorizontal: 6,
    paddingVertical: 2,
    borderRadius: 4,
  },
  outBadgeText: {
    fontSize: 10,
    fontWeight: '800',
  },
  outR: {
    width: 58,
    textAlign: 'right',
    fontSize: 13,
    fontWeight: '800',
    fontFamily: 'monospace',
  },
  outAgo: {
    width: 56,
    textAlign: 'right',
    fontSize: 11,
  },
  legend: {
    fontSize: 11,
    lineHeight: 16,
    marginTop: 4,
    marginBottom: 16,
  },
  empty: {
    alignItems: 'center',
    marginTop: 40,
    paddingHorizontal: 24,
  },
  emptyTitle: {
    marginTop: 16,
    fontSize: 15,
    lineHeight: 21,
    textAlign: 'center',
  },
  emptyLink: {
    marginTop: 12,
    fontSize: 14,
    fontWeight: '700',
  },
  errorCard: {
    borderRadius: 12,
    padding: 16,
  },
  errorText: {
    fontSize: 14,
    fontWeight: '600',
  },
});
