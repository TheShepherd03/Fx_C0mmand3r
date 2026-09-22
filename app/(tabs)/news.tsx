import React, { useState, useEffect } from 'react';
import { StyleSheet, View, Text, FlatList, TouchableOpacity, ActivityIndicator, RefreshControl } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { database } from '@/firebaseConfig';
import { ref, onValue } from 'firebase/database';
import { useTheme } from '@/contexts/ThemeContext';
import { IconSymbol } from '@/components/ui/icon-symbol';

// Economic-calendar event as populated by the EA at `calendar/events`
// (single shared node — no account scoping). The app only READS this.
interface CalendarEvent {
  id: string;
  title: string;
  currency: string;
  impact: string;      // "High" | "Medium" | "Low" | "Holiday"
  timestamp: number;   // event time, UTC unix SECONDS
  forecast: string;
  previous: string;
  actual: string;
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
const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
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
    // Shared node — read directly, not under an account.
    const eventsRef = ref(database, 'calendar/events');

    const onDataChange = (snapshot: any) => {
      const val = snapshot.val();
      if (val) {
        const list: CalendarEvent[] = Object.keys(val)
          .map(key => ({ id: key, ...val[key] }))
          .filter((item: any) => item && item.title && typeof item.timestamp === 'number')
          .sort((a: CalendarEvent, b: CalendarEvent) => a.timestamp - b.timestamp);
        setEvents(list);
      } else {
        setEvents([]);
      }
      setLoading(false);
    };

    const unsubscribe = onValue(eventsRef, onDataChange);
    return () => unsubscribe();
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

  // Compact "F: .. P: .. A: .." line, omitting blanks. Actual coloured green
  // when it clearly beats the forecast (both numeric); neutral otherwise.
  const renderStats = (e: CalendarEvent) => {
    const parts: React.ReactNode[] = [];
    if (e.forecast) parts.push(
      <Text key="f" style={[styles.statText, { color: theme.colors.textSecondary }]}>F: {e.forecast}  </Text>
    );
    if (e.previous) parts.push(
      <Text key="p" style={[styles.statText, { color: theme.colors.textSecondary }]}>P: {e.previous}  </Text>
    );
    if (e.actual) {
      const fNum = parseFloat(e.forecast);
      const aNum = parseFloat(e.actual);
      const beats = !isNaN(fNum) && !isNaN(aNum) && aNum > fNum;
      parts.push(
        <Text key="a" style={[styles.statText, { color: beats ? theme.colors.profit : theme.colors.text, fontWeight: '700' }]}>A: {e.actual}</Text>
      );
    }
    if (parts.length === 0) return null;
    return <View style={styles.statsRow}>{parts}</View>;
  };

  const renderEvent = (e: CalendarEvent) => {
    const isPast = e.timestamp < nowSec;
    const impactClr = impactColor(e.impact);
    const instruments = CURRENCY_INSTRUMENTS[e.currency] || [];

    return (
      <View style={[styles.card, { backgroundColor: theme.colors.card, opacity: isPast ? 0.5 : 1 }]}>
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
            {instruments.length > 0 && (
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
              <Text style={[styles.emptyText, { color: theme.colors.textSecondary }]}>No calendar data yet</Text>
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
  emptyContainer: {
    alignItems: 'center',
    marginTop: 40,
  },
  emptyText: {
    marginTop: 16,
    fontSize: 16,
  },
});
