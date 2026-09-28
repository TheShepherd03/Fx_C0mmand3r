import React, { useState, useEffect } from 'react';
import { StyleSheet, View, Text, FlatList, TouchableOpacity, ActivityIndicator, RefreshControl } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { database, authReady } from '@/firebaseConfig';
import { ref, onValue } from 'firebase/database';
import { useTheme } from '@/contexts/ThemeContext';
import { IconSymbol } from '@/components/ui/icon-symbol';
import { terminalLabel } from '@/components/TerminalStatus';

// How one instrument moved after a release (from MT5 minute bars): % change 15 and
// 60 minutes after the release, plus pips for FX pairs.
interface Reaction {
  m15?: number;
  m60?: number;
  p15?: number;
  p60?: number;
}

// Economic-calendar event as populated by the NewsFeed EA at `calendar/events`
// (single shared node — no account scoping; the EA also stamps
// `calendar/updatedAt` + `calendar/by`, and fills `calendar/extra/{id}` with the
// actual value from MT5's calendar and the price reactions once released). The app
// only READS this.
interface CalendarEvent {
  id: string;
  title: string;
  currency: string;
  impact: string;      // "High" | "Medium" | "Low" | "Holiday"
  timestamp: number;   // event time, UTC unix SECONDS
  forecast: string;
  previous: string;
  actual: string;
  actualImpact?: 'positive' | 'negative';   // MT5's verdict for the currency
  higherIsBetter?: boolean;                  // indicator direction (from MT5)
  reactions?: Record<string, Reaction>;
}

const IMPACT_FILTERS = ['All', 'High', 'High+Med'] as const;
const SCOPE_FILTERS = ['Today', 'This week'] as const;
type ImpactFilter = typeof IMPACT_FILTERS[number];
type ScopeFilter = typeof SCOPE_FILTERS[number];

// Currency -> instruments the trader watches (kept to ~3-4 each). Symbol names
// mirror what the app shows elsewhere (XAUUSD, USA30/USA100, majors, indices).
const CURRENCY_INSTRUMENTS: Record<string, string[]> = {
  USD: ['XAUUSD', 'USA30', 'USA100', 'EURUSD'],
  EUR: ['EURUSD', 'GER40', 'FRA40'],
  GBP: ['GBPUSD', 'UK100'],
  JPY: ['USDJPY', 'JPN225'],
  AUD: ['AUDUSD'],
  CAD: ['USDCAD'],
  CHF: ['USDCHF'],
  NZD: ['NZDUSD'],
  // CNY intentionally skipped
};

const DAY_SECS = 86400;
// The EA re-fetches hourly (checking every 5 min), so older than this = feed down.
const STALE_SECS = 2 * 3600;
const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

// "12 min", "3 h", "2 days"
const durationText = (secs: number) => {
  if (secs < 3600) return `${Math.max(1, Math.floor(secs / 60))} min`;
  if (secs < DAY_SECS) return `${Math.floor(secs / 3600)} h`;
  const d = Math.floor(secs / DAY_SECS);
  return `${d} day${d === 1 ? '' : 's'}`;
};
const agoText = (secs: number) => (secs < 60 ? 'just now' : `${durationText(secs)} ago`);

// "3.7%" -> 3.7, "225K" -> 225000, "-6.2B" -> -6.2e9; null when not a number.
const calNumber = (s: string): number | null => {
  const m = /^\s*([-+]?\d*\.?\d+)\s*([KMBT])?\s*%?\s*$/i.exec(s || '');
  if (!m) return null;
  const mult = { K: 1e3, M: 1e6, B: 1e9, T: 1e12 }[(m[2] || '').toUpperCase() as 'K' | 'M' | 'B' | 'T'] ?? 1;
  return parseFloat(m[1]) * mult;
};
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

// Local midnight (device time) for the day containing `ts` (unix seconds).
const startOfLocalDay = (ts: number) => {
  const d = new Date(ts * 1000);
  d.setHours(0, 0, 0, 0);
  return Math.floor(d.getTime() / 1000);
};

// Rows fed to the FlatList: day headers interleaved with event cards.
type Row =
  | { kind: 'header'; key: string; label: string }
  | { kind: 'event'; key: string; event: CalendarEvent };

export default function NewsScreen() {
  const { theme } = useTheme();
  const [events, setEvents] = useState<CalendarEvent[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState(false);
  const [updatedAt, setUpdatedAt] = useState<number | null>(null);
  const [updatedBy, setUpdatedBy] = useState('');
  const [impactFilter, setImpactFilter] = useState<ImpactFilter>('High+Med');
  const [scopeFilter, setScopeFilter] = useState<ScopeFilter>('This week');
  const [refreshing, setRefreshing] = useState(false);
  const onRefresh = () => { setRefreshing(true); setTimeout(() => setRefreshing(false), 800); };
  // Ticks every 30s so the countdown and the "past" dimming stay fresh.
  const [nowSec, setNowSec] = useState(Math.floor(Date.now() / 1000));

  useEffect(() => {
    const id = setInterval(() => setNowSec(Math.floor(Date.now() / 1000)), 30000);
    return () => clearInterval(id);
  }, []);

  useEffect(() => {
    // Shared node — read directly, not under an account. Wait for sign-in so the
    // first read isn't rejected as "permission denied" (which cancels the listener).
    const calendarRef = ref(database, 'calendar');
    let cancelled = false;
    let unsubscribe = () => {};

    const onDataChange = (snapshot: any) => {
      const cal = snapshot.val() || {};
      const val = cal.events;
      const extra = cal.extra && typeof cal.extra === 'object' ? cal.extra : {};
      if (val && typeof val === 'object') {
        const list: CalendarEvent[] = Object.keys(val)
          .map(key => {
            const x = extra[key] || {};
            return {
              id: key,
              ...val[key],
              actual: val[key]?.actual || x.actual || '',
              actualImpact: x.actualImpact,
              higherIsBetter: typeof x.higherIsBetter === 'boolean' ? x.higherIsBetter : undefined,
              reactions: x.reactions && typeof x.reactions === 'object' ? x.reactions : undefined,
            };
          })
          .filter((item: any) => item && item.title && typeof item.timestamp === 'number')
          .sort((a: CalendarEvent, b: CalendarEvent) => a.timestamp - b.timestamp);
        setEvents(list);
      } else {
        setEvents([]);
      }
      setUpdatedAt(typeof cal.updatedAt === 'number' ? cal.updatedAt : null);
      setUpdatedBy(typeof cal.by === 'string' ? cal.by : '');
      setLoadError(false);
      setLoading(false);
    };

    authReady.then(() => {
      if (cancelled) return;
      unsubscribe = onValue(calendarRef, onDataChange, (error) => {
        console.error('Failed to read the calendar:', error);
        setLoadError(true);
        setLoading(false);
      });
    });
    return () => {
      cancelled = true;
      unsubscribe();
    };
  }, []);

  const impactColor = (impact: string) => {
    switch ((impact || '').toLowerCase()) {
      case 'high': return theme.colors.loss;
      case 'medium': return theme.colors.warning;
      case 'low': return theme.colors.textSecondary;
      default: return theme.colors.textTertiary; // Holiday / unknown
    }
  };

  // Local HH:mm from a unix-seconds timestamp.
  const formatTime = (ts: number) => {
    const d = new Date(ts * 1000);
    const hh = d.getHours().toString().padStart(2, '0');
    const mm = d.getMinutes().toString().padStart(2, '0');
    return `${hh}:${mm}`;
  };

  // Section label for a day-start: "Today", "Tomorrow", or "Wed 24 Sep".
  const dayLabel = (dayStart: number) => {
    const todayStart = startOfLocalDay(nowSec);
    if (dayStart === todayStart) return 'Today';
    if (dayStart === todayStart + DAY_SECS) return 'Tomorrow';
    const d = new Date(dayStart * 1000);
    return `${WEEKDAYS[d.getDay()]} ${d.getDate()} ${MONTHS[d.getMonth()]}`;
  };

  const passesImpact = (impact: string) => {
    const i = (impact || '').toLowerCase();
    if (impactFilter === 'High') return i === 'high';
    if (impactFilter === 'High+Med') return i === 'high' || i === 'medium';
    return true;
  };

  const passesScope = (ts: number) => {
    const todayStart = startOfLocalDay(nowSec);
    if (scopeFilter === 'Today') return ts >= todayStart && ts < todayStart + DAY_SECS;
    return ts >= todayStart && ts < todayStart + 7 * DAY_SECS;
  };

  const filteredEvents = events.filter(e => passesImpact(e.impact) && passesScope(e.timestamp));

  // Build interleaved header/event rows grouped by local day.
  const buildRows = (): Row[] => {
    const rows: Row[] = [];
    let lastDay = -1;
    filteredEvents.forEach(e => {
      const dayStart = startOfLocalDay(e.timestamp);
      if (dayStart !== lastDay) {
        rows.push({ kind: 'header', key: `h-${dayStart}`, label: dayLabel(dayStart) });
        lastDay = dayStart;
      }
      rows.push({ kind: 'event', key: e.id, event: e });
    });
    return rows;
  };

  const rows = buildRows();

  // Feed health: when the EA last published the calendar.
  const feedAge = updatedAt !== null ? Math.max(0, nowSec - updatedAt) : null;
  const feedStale = feedAge !== null && feedAge > STALE_SECS;

  // Why the list is empty, in plain words: the data can exist yet be all in the
  // past (end of the week, before Forex Factory publishes the next one on Sunday).
  const impactWords = impactFilter === 'High' ? 'high-impact ' : impactFilter === 'High+Med' ? 'high/medium-impact ' : '';
  const weekOver = events.length > 0 && events[events.length - 1].timestamp < nowSec;
  const empty = loadError
    ? { title: "Couldn't load the calendar", hint: 'Check your connection, then reopen this tab.' }
    : events.length === 0
      ? { title: 'No calendar data yet', hint: 'The News EA on your MT5 terminals publishes it every hour.' }
      : scopeFilter === 'Today'
        ? { title: `No ${impactWords}events today`, hint: 'Switch to This week to see what is coming up.' }
        : weekOver
          ? { title: "This week's events are done", hint: "Forex Factory publishes next week's calendar on Sunday." }
          : { title: `No more ${impactWords}events this week`, hint: impactFilter !== 'All' ? 'Tap All to include lower-impact events.' : '' };

  // Countdown to the next upcoming high-impact event (device-local wording).
  const nextHigh = filteredEvents.find(
    e => (e.impact || '').toLowerCase() === 'high' && e.timestamp > nowSec
  );
  const countdownLabel = (ts: number) => {
    const secs = ts - nowSec;
    if (secs <= 0) return 'now';
    const h = Math.floor(secs / 3600);
    const m = Math.floor((secs % 3600) / 60);
    if (h > 0) return `in ${h}h ${m}m`;
    return `in ${m}m`;
  };

  // Good or bad for the currency: judged against the forecast SHOWN, using the
  // indicator's direction from MT5 (e.g. lower unemployment is good); MT5's own
  // verdict when there's no comparable forecast; neutral when unknown.
  const actualColor = (e: CalendarEvent) => {
    const a = calNumber(e.actual);
    const f = calNumber(e.forecast);
    if (e.higherIsBetter !== undefined && a !== null && f !== null) {
      if (a === f) return theme.colors.text;
      return (a > f) === e.higherIsBetter ? theme.colors.profit : theme.colors.loss;
    }
    if (e.actualImpact === 'positive') return theme.colors.profit;
    if (e.actualImpact === 'negative') return theme.colors.loss;
    return theme.colors.text;
  };

  // Compact "F: .. P: .. A: .." line, omitting blanks.
  const renderStats = (e: CalendarEvent) => {
    const parts: React.ReactNode[] = [];
    if (e.forecast) parts.push(
      <Text key="f" style={[styles.statText, { color: theme.colors.textSecondary }]}>F: {e.forecast}  </Text>
    );
    if (e.previous) parts.push(
      <Text key="p" style={[styles.statText, { color: theme.colors.textSecondary }]}>P: {e.previous}  </Text>
    );
    if (e.actual) {
      parts.push(
        <Text key="a" style={[styles.statText, { color: actualColor(e), fontWeight: '800' }]}>A: {e.actual}</Text>
      );
    }
    if (parts.length === 0) return null;
    return <View style={styles.statsRow}>{parts}</View>;
  };

  // "▲2.2 pips" for FX pairs, "▲0.13%" for indices / gold.
  const moveText = (pct?: number, pips?: number) => {
    const v = pips ?? pct;
    if (v === undefined) return '—';
    const arrow = v > 0 ? '▲' : v < 0 ? '▼' : '';
    return pips !== undefined ? `${arrow}${Math.abs(pips).toFixed(1)} pips` : `${arrow}${Math.abs(v).toFixed(2)}%`;
  };
  const moveColor = (v?: number) =>
    v === undefined || v === 0 ? theme.colors.textSecondary : v > 0 ? theme.colors.profit : theme.colors.loss;

  // How each affected instrument moved 15 min (and 1 h) after the release.
  const renderReaction = (sym: string, r: Reaction) => (
    <View key={sym} style={[styles.reactionChip, { backgroundColor: theme.colors.input }]}>
      <Text style={[styles.reactionSym, { color: theme.colors.text }]}>{sym}</Text>
      <Text style={[styles.reactionMove, { color: moveColor(r.m15) }]}>
        {moveText(r.m15, r.p15)}<Text style={[styles.reactionWhen, { color: theme.colors.textTertiary }]}>  15m</Text>
      </Text>
      {r.m60 !== undefined && (
        <Text style={[styles.reactionMove, { color: moveColor(r.m60) }]}>
          {moveText(r.m60, r.p60)}<Text style={[styles.reactionWhen, { color: theme.colors.textTertiary }]}>  1h</Text>
        </Text>
      )}
    </View>
  );

  const renderEvent = (e: CalendarEvent) => {
    const isPast = e.timestamp < nowSec;
    const impactClr = impactColor(e.impact);
    const instruments = CURRENCY_INSTRUMENTS[e.currency] || [];
    const reacted = e.reactions ? instruments.filter(sym => e.reactions![sym]) : [];
    // Released events with results stay readable; other past events fade out.
    const opacity = !isPast ? 1 : e.actual || reacted.length > 0 ? 0.9 : 0.5;

    return (
      <View style={[styles.card, { backgroundColor: theme.colors.card, opacity }]}>
        <View style={styles.cardHeader}>
          <View style={styles.timeCol}>
            <Text style={[styles.timeText, { color: theme.colors.text }]}>{formatTime(e.timestamp)}</Text>
            <Text style={[styles.currencyText, { color: theme.colors.textSecondary }]}>{e.currency}</Text>
          </View>
          <View style={styles.titleCol}>
            <View style={styles.titleRow}>
              <View style={[styles.impactBadge, { backgroundColor: impactClr + '20' }]}>
                <Text style={[styles.impactText, { color: impactClr }]}>{(e.impact || '').toUpperCase()}</Text>
              </View>
              <Text style={[styles.title, { color: theme.colors.text }]} numberOfLines={2}>{e.title}</Text>
            </View>
            {renderStats(e)}
            {reacted.length > 0 ? (
              <View style={styles.reactions}>
                <Text style={[styles.reactionCaption, { color: theme.colors.textTertiary }]}>PRICE REACTION</Text>
                <View style={styles.reactionRow}>{reacted.map(sym => renderReaction(sym, e.reactions![sym]))}</View>
              </View>
            ) : instruments.length > 0 && (
              <Text style={[styles.affected, { color: theme.colors.textTertiary }]}>
                Affected: {instruments.join(', ')}
              </Text>
            )}
          </View>
        </View>
      </View>
    );
  };

  const renderItem = ({ item }: { item: Row }) => {
    if (item.kind === 'header') {
      return (
        <Text style={[styles.sectionHeader, { color: theme.colors.textSecondary }]}>{item.label}</Text>
      );
    }
    return renderEvent(item.event);
  };

  const renderChip = (
    label: string,
    active: boolean,
    onPress: () => void,
  ) => (
    <TouchableOpacity
      style={[styles.filterPill, { backgroundColor: active ? theme.colors.primary : theme.colors.card }]}
      onPress={onPress}
    >
      <Text style={[styles.filterText, { color: active ? '#FFF' : theme.colors.textSecondary }]}>{label}</Text>
    </TouchableOpacity>
  );

  return (
    <SafeAreaView style={[styles.container, { backgroundColor: theme.colors.background }]}>
      {/* Impact filter */}
      <View style={styles.filterContainer}>
        <FlatList
          data={IMPACT_FILTERS as unknown as string[]}
          horizontal
          showsHorizontalScrollIndicator={false}
          contentContainerStyle={styles.filterList}
          keyExtractor={item => 'imp-' + item}
          renderItem={({ item }) => renderChip(item, impactFilter === item, () => setImpactFilter(item as ImpactFilter))}
        />
      </View>

      {/* Scope filter */}
      <View style={styles.filterContainer}>
        <FlatList
          data={SCOPE_FILTERS as unknown as string[]}
          horizontal
          showsHorizontalScrollIndicator={false}
          contentContainerStyle={styles.filterList}
          keyExtractor={item => 'scope-' + item}
          renderItem={({ item }) => renderChip(item, scopeFilter === item, () => setScopeFilter(item as ScopeFilter))}
        />
      </View>

      {/* Feed freshness — makes a stopped News EA obvious */}
      {feedAge !== null && (
        <Text
          style={[styles.freshness, { color: feedStale ? theme.colors.warning : theme.colors.textTertiary }]}
          numberOfLines={2}
        >
          {feedStale
            ? `Calendar not updated for ${durationText(feedAge)} — check that an MT5 terminal is running the News EA.`
            : `Forex Factory · updated ${agoText(feedAge)}${updatedBy ? ` by ${terminalLabel(updatedBy)}` : ''}`}
        </Text>
      )}

      {/* Next high-impact countdown */}
      {nextHigh && (
        <View style={[styles.countdown, { backgroundColor: theme.colors.loss + '18' }]}>
          <IconSymbol name="clock.fill" size={16} color={theme.colors.loss} />
          <Text style={[styles.countdownText, { color: theme.colors.text }]} numberOfLines={1}>
            Next high impact: {nextHigh.currency} {nextHigh.title} {countdownLabel(nextHigh.timestamp)}
          </Text>
        </View>
      )}

      <FlatList
        data={rows}
        renderItem={renderItem}
        keyExtractor={item => item.key}
        contentContainerStyle={styles.listContent}
        refreshControl={
          <RefreshControl refreshing={refreshing} onRefresh={onRefresh} tintColor={theme.colors.primary} />
        }
        ListEmptyComponent={
          !loading ? (
            <View style={styles.emptyContainer}>
              <IconSymbol name="calendar" size={48} color={theme.colors.textTertiary} />
              <Text style={[styles.emptyText, { color: theme.colors.textSecondary }]}>{empty.title}</Text>
              {!!empty.hint && (
                <Text style={[styles.emptyHint, { color: theme.colors.textTertiary }]}>{empty.hint}</Text>
              )}
            </View>
          ) : (
            <ActivityIndicator style={{ marginTop: 40 }} size="large" color={theme.colors.primary} />
          )
        }
      />
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
  },
  filterContainer: {
    marginBottom: 12,
  },
  filterList: {
    paddingHorizontal: 16,
    gap: 8,
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
  countdown: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    marginHorizontal: 16,
    marginBottom: 12,
    paddingHorizontal: 12,
    paddingVertical: 10,
    borderRadius: 12,
  },
  countdownText: {
    flex: 1,
    fontSize: 13,
    fontWeight: '600',
  },
  listContent: {
    padding: 16,
    paddingTop: 0,
  },
  sectionHeader: {
    fontSize: 13,
    fontWeight: '800',
    textTransform: 'uppercase',
    letterSpacing: 0.5,
    marginTop: 8,
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
  cardHeader: {
    flexDirection: 'row',
    gap: 12,
  },
  timeCol: {
    width: 52,
    alignItems: 'flex-start',
  },
  timeText: {
    fontSize: 16,
    fontWeight: '800',
  },
  currencyText: {
    fontSize: 12,
    fontWeight: '700',
    marginTop: 2,
  },
  titleCol: {
    flex: 1,
  },
  titleRow: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    gap: 8,
  },
  impactBadge: {
    paddingHorizontal: 6,
    paddingVertical: 2,
    borderRadius: 4,
    marginTop: 1,
  },
  impactText: {
    fontSize: 10,
    fontWeight: '800',
  },
  title: {
    flex: 1,
    fontSize: 15,
    fontWeight: '600',
  },
  statsRow: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    marginTop: 8,
  },
  statText: {
    fontSize: 13,
  },
  affected: {
    fontSize: 12,
    marginTop: 6,
  },
  reactions: {
    marginTop: 10,
  },
  reactionCaption: {
    fontSize: 10,
    fontWeight: '800',
    letterSpacing: 0.6,
    marginBottom: 6,
  },
  reactionRow: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 6,
  },
  reactionChip: {
    borderRadius: 10,
    paddingHorizontal: 10,
    paddingVertical: 6,
    minWidth: 104,
  },
  reactionSym: {
    fontSize: 12,
    fontWeight: '800',
    marginBottom: 2,
  },
  reactionMove: {
    fontSize: 12,
    fontWeight: '700',
    fontFamily: 'monospace',
  },
  reactionWhen: {
    fontSize: 10,
    fontWeight: '600',
  },
  emptyContainer: {
    alignItems: 'center',
    marginTop: 40,
  },
  emptyText: {
    marginTop: 16,
    fontSize: 16,
  },
  emptyHint: {
    marginTop: 6,
    fontSize: 13,
    textAlign: 'center',
    paddingHorizontal: 32,
  },
  freshness: {
    fontSize: 12,
    fontWeight: '600',
    marginHorizontal: 16,
    marginTop: -4,
    marginBottom: 10,
  },
});
