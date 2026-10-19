import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  Modal,
  Pressable,
  ScrollView,
  StyleSheet,
  Switch,
  Text,
  TouchableOpacity,
  View,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import * as Haptics from 'expo-haptics';
import { get, limitToLast, onValue, query, ref, remove, set, update } from 'firebase/database';

import { authReady, database } from '@/firebaseConfig';
import { useTheme, type Theme } from '@/contexts/ThemeContext';
import { IconSymbol } from '@/components/ui/icon-symbol';
import { showAlert } from '@/components/AppDialog';
import { AutoTradeSection } from '@/components/AutoTradeSection';
import { terminalLabel } from '@/components/TerminalStatus';
import { GRADES, type Grade } from '@/constants/types';

type IconName = React.ComponentProps<typeof IconSymbol>['name'];

/* -------------------------------------------------------------------------- *
 * Signal preferences — `prefs/signals` (one global node, not per account).
 * The APP writes it; the signal EAs read it to decide whether to send pushes.
 *
 *   sources:      { "<sourceKey>": { notify, feed } }    missing entry/flag = true
 *   mutedSymbols: { "<symbolKey>": true }
 *   quiet:        { enabled, start, end, tzOffsetMin }    start/end = minutes of the LOCAL
 *                                                          day (0-1439, start > end wraps
 *                                                          midnight); tzOffsetMin = minutes
 *                                                          to ADD to UTC for local time
 *   zonesMinGrade: 'A' | 'B' | 'C'                        lowest zone-signal grade that pushes
 *                                                          and auto trades (missing = 'C' = every grade)
 *
 * Source AND symbol keys use the EAs' SignalLib_SymbolKey rule (each of
 * space . $ # [ ] / becomes '_'), e.g. "Supply/Demand" -> "Supply_Demand",
 * "Volatility 10 Index" -> "Volatility_10_Index". Names are shown as-is.
 * -------------------------------------------------------------------------- */

/** Real `source` values the signal EAs publish; merged with whatever the feed and log show. */
export const DEFAULT_SIGNAL_SOURCES = [
  'Zones',            // M3 CHoCH / BOS (A), M5 engulfing (B) / sweep (C since 2026-10-07); one stream since 2026-10-05
  'Supply/Demand',
  'Support/Resistance',
  'Range Breakout',
  'AMD',
  'DriftRegime',
];

/** Synthetic source used by the cloud watchdog for terminal offline/back-online pushes (no feed). */
export const WATCHDOG_SOURCE = 'Watchdog';

/** The zone EA's proximity pushes (approaching / tested / broken) — separate from its "Zones" signals, no feed. */
export const ZONE_ALERTS_SOURCE = 'Zone alerts';

/** The zone refresh's "drafts ready to review" pushes (the PC script reads this flag before pushing). */
export const ZONE_DRAFTS_SOURCE = 'Zone drafts';

/** The Bridge EA's "auto trade opened / failed" pushes. */
export const AUTO_TRADES_SOURCE = 'Auto trades';

/** Push-only sources: they never appear in the feed, so they get their own toggles. */
const PUSH_ONLY_SOURCES = [WATCHDOG_SOURCE, ZONE_ALERTS_SOURCE, ZONE_DRAFTS_SOURCE, AUTO_TRADES_SOURCE];

export interface SourcePrefs {
  notify?: boolean;
  feed?: boolean;
}

export interface QuietPrefs {
  enabled: boolean;
  start: number;
  end: number;
  /** As stored; null if the node has none yet. */
  tzOffsetMin: number | null;
}

export interface SignalPrefs {
  sources: Record<string, SourcePrefs>;
  mutedSymbols: Record<string, boolean>;
  quiet: QuietPrefs | null;
  zonesMinGrade: Grade;
}

export const EMPTY_SIGNAL_PREFS: SignalPrefs = { sources: {}, mutedSymbols: {}, quiet: null, zonesMinGrade: 'C' };

/** Zone-signal push levels; the zone EA pushes grades at or above the stored one. */
const GRADE_PUSH_OPTIONS: { value: Grade; label: string }[] = [
  { value: 'A', label: 'Grade A only' },
  { value: 'B', label: 'A + B' },
  { value: 'C', label: 'All grades' },
];

const PREFS_PATH = 'prefs/signals';
const DAY_MIN = 24 * 60;
const DEFAULT_QUIET = { enabled: false, start: 22 * 60, end: 7 * 60 };

/** SignalLib_SymbolKey: each of space . $ # [ ] / becomes '_' (also makes it a legal Firebase key). */
const prefsKey = (name: string) => name.replace(/[ .$#[\]/]/g, '_');

export const symbolKeyFor = prefsKey;
export const sourceKeyFor = prefsKey;

/** Minutes EAST of UTC for this device right now (SAST = +120). */
export const deviceTzOffsetMin = () => -new Date().getTimezoneOffset();

export const isSourceInFeed = (prefs: SignalPrefs, source?: string) =>
  !source || prefs.sources[sourceKeyFor(source)]?.feed !== false;

export const isSourceNotifying = (prefs: SignalPrefs, source?: string) =>
  !source || prefs.sources[sourceKeyFor(source)]?.notify !== false;

export const isSymbolMuted = (prefs: SignalPrefs, symbol?: string) =>
  !!symbol && prefs.mutedSymbols[symbolKeyFor(symbol)] === true;

const toMinuteOfDay = (v: unknown, fallback: number) => {
  const n = typeof v === 'number' ? v : typeof v === 'string' ? parseInt(v, 10) : NaN;
  if (!Number.isFinite(n)) return fallback;
  return ((Math.round(n) % DAY_MIN) + DAY_MIN) % DAY_MIN;
};

function normalizePrefs(val: any): SignalPrefs {
  const sources: Record<string, SourcePrefs> = {};
  if (val?.sources && typeof val.sources === 'object') {
    Object.keys(val.sources).forEach((k) => {
      const s = val.sources[k];
      if (s && typeof s === 'object') {
        sources[k] = {
          feed: typeof s.feed === 'boolean' ? s.feed : undefined,
          notify: typeof s.notify === 'boolean' ? s.notify : undefined,
        };
      }
    });
  }

  const mutedSymbols: Record<string, boolean> = {};
  if (val?.mutedSymbols && typeof val.mutedSymbols === 'object') {
    Object.keys(val.mutedSymbols).forEach((k) => {
      if (val.mutedSymbols[k] === true) mutedSymbols[k] = true;
    });
  }

  const q = val?.quiet;
  const quiet: QuietPrefs | null =
    q && typeof q === 'object'
      ? {
          enabled: q.enabled === true,
          start: toMinuteOfDay(q.start, DEFAULT_QUIET.start),
          end: toMinuteOfDay(q.end, DEFAULT_QUIET.end),
          tzOffsetMin: typeof q.tzOffsetMin === 'number' ? q.tzOffsetMin : null,
        }
      : null;

  const zonesMinGrade: Grade = (GRADES as readonly string[]).includes(val?.zonesMinGrade)
    ? (val.zonesMinGrade as Grade)
    : 'C';

  return { sources, mutedSymbols, quiet, zonesMinGrade };
}

/** Live `prefs/signals`, attached once signed in. */
export function useSignalPrefs() {
  const [prefs, setPrefs] = useState<SignalPrefs>(EMPTY_SIGNAL_PREFS);
  const [loaded, setLoaded] = useState(false);

  useEffect(() => {
    let cancelled = false;
    let unsubscribe = () => {};

    authReady.then(() => {
      if (cancelled) return;
      unsubscribe = onValue(
        ref(database, PREFS_PATH),
        (snapshot) => {
          setPrefs(normalizePrefs(snapshot.val()));
          setLoaded(true);
        },
        () => setLoaded(true),
      );
    });

    return () => {
      cancelled = true;
      unsubscribe();
    };
  }, []);

  return { prefs, loaded };
}

/** Sets just the given flag(s) for a source; an absent flag means true to the EAs. */
export function saveSourcePrefs(source: string, patch: SourcePrefs) {
  const key = sourceKeyFor(source);
  if (!key) return Promise.reject(new Error('Missing source name'));
  const values: Record<string, boolean> = {};
  if (typeof patch.feed === 'boolean') values.feed = patch.feed;
  if (typeof patch.notify === 'boolean') values.notify = patch.notify;
  return update(ref(database, `${PREFS_PATH}/sources/${key}`), values);
}

export function saveMutedSymbolKey(key: string, muted: boolean) {
  if (!key) return Promise.reject(new Error('Missing symbol'));
  const r = ref(database, `${PREFS_PATH}/mutedSymbols/${key}`);
  return muted ? set(r, true) : remove(r);
}

export const saveSymbolMuted = (symbol: string, muted: boolean) =>
  saveMutedSymbolKey(symbolKeyFor(symbol), muted);

export const saveZonesMinGrade = (grade: Grade) => set(ref(database, `${PREFS_PATH}/zonesMinGrade`), grade);

function saveQuiet(q: { enabled: boolean; start: number; end: number }) {
  return update(ref(database, `${PREFS_PATH}/quiet`), {
    enabled: q.enabled,
    start: q.start,
    end: q.end,
    tzOffsetMin: deviceTzOffsetMin(),
  });
}

/* ------------------------------ time helpers ------------------------------ */

const pad2 = (n: number) => String(n).padStart(2, '0');

const tzLabel = (offsetMin: number) => {
  const a = Math.abs(offsetMin);
  return `UTC${offsetMin < 0 ? '-' : '+'}${pad2(Math.floor(a / 60))}:${pad2(a % 60)}`;
};

const stepHour = (m: number, dir: 1 | -1) => (m + dir * 60 + DAY_MIN) % DAY_MIN;

// Minutes move in 5s and wrap within the hour (like a picker column).
const stepMinute = (m: number, dir: 1 | -1) => {
  const h = Math.floor(m / 60);
  const mm = m % 60;
  const next = dir > 0 ? (Math.floor(mm / 5) + 1) * 5 : (Math.ceil(mm / 5) - 1) * 5;
  return h * 60 + (((next % 60) + 60) % 60);
};

const windowSummary = (start: number, end: number) => {
  if (start === end) return 'Start and end are the same — pick a window';
  const len = (end - start + DAY_MIN) % DAY_MIN;
  const h = Math.floor(len / 60);
  const m = len % 60;
  return `${m ? `${h}h ${m}m` : `${h}h`} quiet${end < start ? ', overnight' : ''}`;
};

type QuietDraft = { enabled: boolean; start: number; end: number };

const draftFrom = (q: QuietPrefs | null): QuietDraft =>
  q ? { enabled: q.enabled, start: q.start, end: q.end } : { ...DEFAULT_QUIET };

/* ------------------------------- sub-parts -------------------------------- */

function SectionTitle({ icon, title, theme }: { icon: IconName; title: string; theme: Theme }) {
  return (
    <View style={styles.sectionTitleRow}>
      <IconSymbol name={icon} size={14} color={theme.colors.textSecondary} />
      <Text style={[styles.sectionTitle, { color: theme.colors.textSecondary }]}>{title}</Text>
    </View>
  );
}

/** Tap to step once; press and hold to keep stepping. */
function RepeatButton({
  icon,
  label,
  onStep,
  theme,
}: {
  icon: IconName;
  label: string;
  onStep: () => void;
  theme: Theme;
}) {
  const stepRef = useRef(onStep);
  const repeat = useRef<ReturnType<typeof setInterval> | null>(null);

  useEffect(() => {
    stepRef.current = onStep;
  }, [onStep]);

  const stop = useCallback(() => {
    if (repeat.current) {
      clearInterval(repeat.current);
      repeat.current = null;
    }
  }, []);

  useEffect(() => stop, [stop]);

  return (
    <Pressable
      onPress={() => {
        Haptics.selectionAsync().catch(() => {});
        stepRef.current();
      }}
      onLongPress={() => {
        stop();
        stepRef.current();
        repeat.current = setInterval(() => stepRef.current(), 90);
      }}
      delayLongPress={350}
      onPressOut={stop}
      hitSlop={6}
      accessibilityRole="button"
      accessibilityLabel={label}
      style={({ pressed }) => [styles.stepBtn, pressed && { backgroundColor: theme.colors.border }]}>
      <IconSymbol name={icon} size={22} color={theme.colors.textSecondary} />
    </Pressable>
  );
}

function TimeStepper({
  label,
  minutes,
  disabled,
  onStep,
  theme,
}: {
  label: string;
  minutes: number;
  disabled: boolean;
  onStep: (unit: 'h' | 'm', dir: 1 | -1) => void;
  theme: Theme;
}) {
  const unit = (u: 'h' | 'm', value: string, name: string) => (
    <View style={styles.stepCol}>
      <RepeatButton icon="chevron.up" label={`${label} ${name} up`} onStep={() => onStep(u, 1)} theme={theme} />
      <Text style={[styles.timeValue, { color: theme.colors.text }]}>{value}</Text>
      <RepeatButton icon="chevron.down" label={`${label} ${name} down`} onStep={() => onStep(u, -1)} theme={theme} />
    </View>
  );

  return (
    <View
      pointerEvents={disabled ? 'none' : 'auto'}
      style={[styles.timeCard, { backgroundColor: theme.colors.input, opacity: disabled ? 0.45 : 1 }]}>
      <Text style={[styles.timeLabel, { color: theme.colors.textSecondary }]}>{label.toUpperCase()}</Text>
      <View style={styles.timeRow}>
        {unit('h', pad2(Math.floor(minutes / 60)), 'hour')}
        <Text style={[styles.timeColon, { color: theme.colors.textSecondary }]}>:</Text>
        {unit('m', pad2(minutes % 60), 'minute')}
      </View>
    </View>
  );
}

/* --------------------------------- sheet ---------------------------------- */

interface Props {
  visible: boolean;
  onClose: () => void;
  prefs: SignalPrefs;
  /** Account whose outcome log contributes source names. */
  account: string | null;
  /** Sources present in the current signals feed. */
  feedSources: string[];
  /** Symbols present in the current feed — used to show muted keys by their real name. */
  feedSymbols: string[];
}

export function SignalSettingsSheet({ visible, onClose, prefs, account, feedSources, feedSymbols }: Props) {
  const { theme } = useTheme();
  const insets = useSafeAreaInsets();
  const [logSources, setLogSources] = useState<string[]>([]);
  const [logSymbols, setLogSymbols] = useState<string[]>([]);

  // Sources/symbols seen in the outcome log (recent window), read once each time the sheet opens.
  useEffect(() => {
    if (!visible || !account) return;
    let alive = true;
    get(query(ref(database, `signalLog/${account}`), limitToLast(500)))
      .then((snap) => {
        if (!alive) return;
        const srcs = new Set<string>();
        const syms = new Set<string>();
        snap.forEach((child) => {
          const v = child.val();
          if (v && typeof v.source === 'string' && v.source) srcs.add(v.source);
          if (v && typeof v.symbol === 'string' && v.symbol) syms.add(v.symbol);
        });
        setLogSources(Array.from(srcs));
        setLogSymbols(Array.from(syms));
      })
      .catch(() => {});
    return () => {
      alive = false;
    };
  }, [visible, account]);

  // Union of defaults, live feed, outcome log and anything already in prefs (so a
  // hidden source can always be switched back on). De-duplicated by key; real names
  // are added before bare prefs keys so "Supply/Demand" wins over "Supply_Demand".
  // Push-only sources (watchdog, zone alerts) have their own toggles below.
  const sources = useMemo(() => {
    const pushOnlyKeys = new Set(PUSH_ONLY_SOURCES.map(sourceKeyFor));
    const byKey = new Map<string, string>();
    const add = (name?: string) => {
      if (!name) return;
      const key = sourceKeyFor(name);
      if (key && !pushOnlyKeys.has(key) && !byKey.has(key)) byKey.set(key, name);
    };
    DEFAULT_SIGNAL_SOURCES.forEach(add);
    feedSources.forEach(add);
    logSources.forEach(add);
    Object.keys(prefs.sources).forEach(add);
    return Array.from(byKey.values()).sort((a, b) =>
      a.localeCompare(b, undefined, { sensitivity: 'base' }),
    );
  }, [feedSources, logSources, prefs.sources]);

  const muted = useMemo(() => {
    const names = new Map<string, string>();
    [...feedSymbols, ...logSymbols].forEach((s) => names.set(symbolKeyFor(s), s));
    return Object.keys(prefs.mutedSymbols)
      .filter((k) => prefs.mutedSymbols[k] === true)
      .map((key) => ({ key, label: names.get(key) ?? key }))
      .sort((a, b) => a.label.localeCompare(b.label));
  }, [prefs.mutedSymbols, feedSymbols, logSymbols]);

  const toggleSource = (source: string, field: 'feed' | 'notify', value: boolean) => {
    Haptics.selectionAsync().catch(() => {});
    saveSourcePrefs(source, { [field]: value }).catch(() =>
      showAlert('Error', 'Could not save that setting. Check your connection.'),
    );
  };

  const setMinGrade = (grade: Grade) => {
    Haptics.selectionAsync().catch(() => {});
    saveZonesMinGrade(grade).catch(() =>
      showAlert('Error', 'Could not save that setting. Check your connection.'),
    );
  };

  const unmute = (key: string) => {
    Haptics.selectionAsync().catch(() => {});
    saveMutedSymbolKey(key, false).catch(() =>
      showAlert('Error', 'Could not unmute that symbol. Check your connection.'),
    );
  };

  // ---- Quiet hours: edited locally, saved (debounced) so press-and-hold stepping
  // doesn't fire a write per step. Flushed immediately when the sheet closes.
  const [quiet, setQuiet] = useState<QuietDraft>(() => draftFrom(prefs.quiet));
  const dirty = useRef(false);
  const pending = useRef<QuietDraft | null>(null);
  const saveTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Seed from the stored prefs (on open, or when they arrive) until the user edits.
  useEffect(() => {
    if (visible && !dirty.current) setQuiet(draftFrom(prefs.quiet));
  }, [visible, prefs.quiet]);

  const flushQuiet = useCallback(() => {
    if (saveTimer.current) {
      clearTimeout(saveTimer.current);
      saveTimer.current = null;
    }
    const q = pending.current;
    pending.current = null;
    if (q) {
      saveQuiet(q).catch(() => showAlert('Error', 'Could not save quiet hours. Check your connection.'));
    }
  }, []);

  useEffect(() => {
    if (!dirty.current) return;
    pending.current = quiet;
    if (saveTimer.current) clearTimeout(saveTimer.current);
    saveTimer.current = setTimeout(flushQuiet, 500);
  }, [quiet, flushQuiet]);

  // Never drop an unsaved edit on unmount.
  useEffect(() => () => flushQuiet(), [flushQuiet]);

  const editQuiet = (fn: (q: QuietDraft) => QuietDraft) => {
    dirty.current = true;
    setQuiet((prev) => fn(prev));
  };

  const stepTime = (field: 'start' | 'end') => (unit: 'h' | 'm', dir: 1 | -1) =>
    editQuiet((q) => ({ ...q, [field]: unit === 'h' ? stepHour(q[field], dir) : stepMinute(q[field], dir) }));

  const close = () => {
    flushQuiet();
    dirty.current = false;
    onClose();
  };

  const deviceTz = deviceTzOffsetMin();
  const storedTz = prefs.quiet?.tzOffsetMin;
  const tzDrift = !dirty.current && storedTz != null && storedTz !== deviceTz;
  const switchTrack = { false: theme.colors.border, true: theme.colors.primary };
  const divider = { borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: theme.colors.border };

  return (
    <Modal animationType="slide" transparent visible={visible} onRequestClose={close}>
      <View style={[styles.overlay, { backgroundColor: theme.colors.overlay }]}>
        <Pressable style={StyleSheet.absoluteFill} onPress={close} accessibilityLabel="Close signal settings" />
        <View
          style={[
            styles.sheet,
            { backgroundColor: theme.colors.card },
            // No shadow on black — a hairline keeps the sheet's edge visible in dark mode.
            theme.isDark && { borderWidth: StyleSheet.hairlineWidth, borderBottomWidth: 0, borderColor: theme.colors.border },
          ]}>
          <View style={styles.grabber}>
            <View style={[styles.grabberBar, { backgroundColor: theme.colors.border }]} />
          </View>

          <View style={styles.header}>
            <View style={styles.headerText}>
              <Text style={[styles.title, { color: theme.colors.text }]}>Signal settings</Text>
              <Text style={[styles.subtitle, { color: theme.colors.textSecondary }]}>
                Synced to your EAs — they use these to decide which alerts to push.
              </Text>
            </View>
            <TouchableOpacity
              style={[styles.close, { backgroundColor: theme.colors.input }]}
              onPress={close}
              accessibilityRole="button"
              accessibilityLabel="Close">
              <IconSymbol name="xmark" size={16} color={theme.colors.textSecondary} />
            </TouchableOpacity>
          </View>

          <ScrollView
            contentContainerStyle={{ paddingBottom: Math.max(insets.bottom, 12) + 20 }}
            showsVerticalScrollIndicator={false}>
            {/* Sources */}
            <SectionTitle icon="antenna.radiowaves.left.and.right" title="Sources" theme={theme} />
            <View style={[styles.group, { borderColor: theme.colors.border }]}>
              <View style={styles.tableHead}>
                <Text style={[styles.th, styles.thName, { color: theme.colors.textTertiary }]}>SOURCE</Text>
                <Text style={[styles.th, styles.thToggle, { color: theme.colors.textTertiary }]}>
                  SHOW IN{'\n'}FEED
                </Text>
                <Text style={[styles.th, styles.thToggle, { color: theme.colors.textTertiary }]}>
                  PUSH{'\n'}NOTIFICATIONS
                </Text>
              </View>
              {sources.map((s) => (
                <View key={s} style={[styles.sourceRow, divider]}>
                  <Text style={[styles.sourceName, { color: theme.colors.text }]} numberOfLines={1}>
                    {s}
                  </Text>
                  <View style={styles.toggleCell}>
                    <Switch
                      value={isSourceInFeed(prefs, s)}
                      onValueChange={(v) => toggleSource(s, 'feed', v)}
                      trackColor={switchTrack}
                      thumbColor="#FFF"
                      accessibilityLabel={`Show ${s} in feed`}
                    />
                  </View>
                  <View style={styles.toggleCell}>
                    <Switch
                      value={isSourceNotifying(prefs, s)}
                      onValueChange={(v) => toggleSource(s, 'notify', v)}
                      trackColor={switchTrack}
                      thumbColor="#FFF"
                      accessibilityLabel={`Push notifications for ${s}`}
                    />
                  </View>
                </View>
              ))}
            </View>

            {/* Auto trade (per account): the Bridge EA opens these sources' new signals by itself */}
            <SectionTitle
              icon="bolt.fill"
              title={account ? `Auto trade · ${terminalLabel(account)}` : 'Auto trade'}
              theme={theme}
            />
            <AutoTradeSection account={account} sources={sources} />

            {/* Zone signals: which grades push and auto trade. Every grade still shows in the feed. */}
            <SectionTitle icon="square.stack.3d.up" title="Zone signal grades" theme={theme} />
            <View style={[styles.group, styles.quietGroup, { borderColor: theme.colors.border }]}>
              <Text style={[styles.rowSub, { color: theme.colors.textSecondary, marginTop: 0 }]}>
                Pushes and auto trades use these grades; every grade still shows in the feed. A = structure
                turned in the zone (M3 CHoCH or BOS), B = engulfing, C = sweep, or an engulfing that broke
                through the zone.
              </Text>
              <View style={[styles.segment, { backgroundColor: theme.colors.input }]}>
                {GRADE_PUSH_OPTIONS.map((o) => {
                  const active = prefs.zonesMinGrade === o.value;
                  return (
                    <TouchableOpacity
                      key={o.value}
                      style={[styles.segmentBtn, active && { backgroundColor: theme.colors.primary }]}
                      onPress={() => setMinGrade(o.value)}
                      accessibilityRole="button"
                      accessibilityState={{ selected: active }}
                      accessibilityLabel={`Zone signal grades: ${o.label}`}>
                      <Text style={[styles.segmentText, { color: active ? '#FFF' : theme.colors.textSecondary }]}>
                        {o.label}
                      </Text>
                    </TouchableOpacity>
                  );
                })}
              </View>
            </View>

            {/* Push-only alerts: zone proximity (zone EA) and terminal health (cloud watchdog) */}
            <SectionTitle icon="cpu" title="Alerts" theme={theme} />
            <View style={[styles.group, styles.rowGroup, { borderColor: theme.colors.border }]}>
              <View style={styles.rowGroupText}>
                <Text style={[styles.rowTitle, { color: theme.colors.text }]}>Zone alerts</Text>
                <Text style={[styles.rowSub, { color: theme.colors.textSecondary }]}>
                  Price approaching, testing or breaking one of your zones. Zone signals are under Sources.
                </Text>
              </View>
              <Switch
                value={isSourceNotifying(prefs, ZONE_ALERTS_SOURCE)}
                onValueChange={(v) => toggleSource(ZONE_ALERTS_SOURCE, 'notify', v)}
                trackColor={switchTrack}
                thumbColor="#FFF"
                accessibilityLabel="Zone alerts"
              />
            </View>
            <View style={[styles.group, styles.rowGroup, { borderColor: theme.colors.border, marginTop: 8 }]}>
              <View style={styles.rowGroupText}>
                <Text style={[styles.rowTitle, { color: theme.colors.text }]}>Zone drafts ready</Text>
                <Text style={[styles.rowSub, { color: theme.colors.textSecondary }]}>
                  New zone drafts to approve (after each refresh, or when a choppy zone is retired).
                </Text>
              </View>
              <Switch
                value={isSourceNotifying(prefs, ZONE_DRAFTS_SOURCE)}
                onValueChange={(v) => toggleSource(ZONE_DRAFTS_SOURCE, 'notify', v)}
                trackColor={switchTrack}
                thumbColor="#FFF"
                accessibilityLabel="Zone drafts ready"
              />
            </View>
            <View style={[styles.group, styles.rowGroup, { borderColor: theme.colors.border, marginTop: 8 }]}>
              <View style={styles.rowGroupText}>
                <Text style={[styles.rowTitle, { color: theme.colors.text }]}>Auto trades</Text>
                <Text style={[styles.rowSub, { color: theme.colors.textSecondary }]}>
                  When the Bridge EA opens an auto trade, or the broker rejects one.
                </Text>
              </View>
              <Switch
                value={isSourceNotifying(prefs, AUTO_TRADES_SOURCE)}
                onValueChange={(v) => toggleSource(AUTO_TRADES_SOURCE, 'notify', v)}
                trackColor={switchTrack}
                thumbColor="#FFF"
                accessibilityLabel="Auto trades"
              />
            </View>
            <View style={[styles.group, styles.rowGroup, { borderColor: theme.colors.border, marginTop: 8 }]}>
              <View style={styles.rowGroupText}>
                <Text style={[styles.rowTitle, { color: theme.colors.text }]}>Terminal offline / back online</Text>
                <Text style={[styles.rowSub, { color: theme.colors.textSecondary }]}>
                  Push from the cloud watchdog when an MT5 terminal stops reporting or recovers.
                </Text>
              </View>
              <Switch
                value={isSourceNotifying(prefs, WATCHDOG_SOURCE)}
                onValueChange={(v) => toggleSource(WATCHDOG_SOURCE, 'notify', v)}
                trackColor={switchTrack}
                thumbColor="#FFF"
                accessibilityLabel="Terminal alerts"
              />
            </View>

            {/* Muted symbols */}
            <SectionTitle icon="bell.slash" title="Muted symbols" theme={theme} />
            {muted.length === 0 ? (
              <Text style={[styles.emptyNote, { color: theme.colors.textTertiary }]}>
                No muted symbols. Use ••• on a signal card to mute its symbol — it disappears from the
                feed and stops pushing.
              </Text>
            ) : (
              <View style={[styles.group, { borderColor: theme.colors.border }]}>
                {muted.map((m, i) => (
                  <View key={m.key} style={[styles.mutedRow, i > 0 && divider]}>
                    <IconSymbol name="bell.slash" size={16} color={theme.colors.textTertiary} />
                    <Text style={[styles.mutedName, { color: theme.colors.text }]} numberOfLines={1}>
                      {m.label}
                    </Text>
                    <TouchableOpacity
                      style={[styles.unmuteBtn, { borderColor: theme.colors.primary }]}
                      onPress={() => unmute(m.key)}
                      accessibilityRole="button"
                      accessibilityLabel={`Unmute ${m.label}`}>
                      <Text style={[styles.unmuteText, { color: theme.colors.primary }]}>Unmute</Text>
                    </TouchableOpacity>
                  </View>
                ))}
              </View>
            )}

            {/* Quiet hours */}
            <SectionTitle icon="moon.fill" title="Quiet hours" theme={theme} />
            <View style={[styles.group, styles.quietGroup, { borderColor: theme.colors.border }]}>
              <View style={styles.quietHead}>
                <View style={styles.quietHeadText}>
                  <Text style={[styles.rowTitle, { color: theme.colors.text }]}>Pause push alerts</Text>
                  <Text style={[styles.rowSub, { color: theme.colors.textSecondary }]}>
                    No pushes in this window. Signals still arrive in the feed.
                  </Text>
                </View>
                <Switch
                  value={quiet.enabled}
                  onValueChange={(v) => {
                    Haptics.selectionAsync().catch(() => {});
                    editQuiet((q) => ({ ...q, enabled: v }));
                  }}
                  trackColor={switchTrack}
                  thumbColor="#FFF"
                  accessibilityLabel="Quiet hours"
                />
              </View>

              <View style={styles.timesRow}>
                <TimeStepper
                  label="From"
                  minutes={quiet.start}
                  disabled={!quiet.enabled}
                  onStep={stepTime('start')}
                  theme={theme}
                />
                <IconSymbol name="chevron.right" size={20} color={theme.colors.textTertiary} />
                <TimeStepper
                  label="To"
                  minutes={quiet.end}
                  disabled={!quiet.enabled}
                  onStep={stepTime('end')}
                  theme={theme}
                />
              </View>

              <Text style={[styles.quietNote, { color: theme.colors.textTertiary }]}>
                {windowSummary(quiet.start, quiet.end)} · local time ({tzLabel(deviceTz)})
              </Text>
              {tzDrift && (
                <Text style={[styles.quietNote, { color: theme.colors.warning }]}>
                  Saved for {tzLabel(storedTz as number)} — adjust any time to switch to this device’s zone.
                </Text>
              )}
            </View>
          </ScrollView>
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
    maxHeight: '88%',
    paddingHorizontal: 16,
  },
  grabber: {
    alignItems: 'center',
    paddingTop: 10,
    paddingBottom: 4,
  },
  grabberBar: {
    width: 44,
    height: 5,
    borderRadius: 3,
    opacity: 0.6,
  },
  header: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    gap: 12,
    paddingVertical: 12,
  },
  headerText: {
    flex: 1,
  },
  title: {
    fontSize: 22,
    fontWeight: 'bold',
  },
  subtitle: {
    fontSize: 13,
    marginTop: 4,
    lineHeight: 18,
  },
  close: {
    width: 30,
    height: 30,
    borderRadius: 15,
    justifyContent: 'center',
    alignItems: 'center',
  },
  sectionTitleRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    marginTop: 14,
    marginBottom: 8,
  },
  sectionTitle: {
    fontSize: 12,
    fontWeight: '800',
    letterSpacing: 0.8,
    textTransform: 'uppercase',
  },
  group: {
    borderWidth: StyleSheet.hairlineWidth,
    borderRadius: 14,
    overflow: 'hidden',
  },
  tableHead: {
    flexDirection: 'row',
    alignItems: 'flex-end',
    paddingHorizontal: 12,
    paddingTop: 10,
    paddingBottom: 8,
  },
  th: {
    fontSize: 9,
    fontWeight: '800',
    letterSpacing: 0.6,
  },
  thName: {
    flex: 1,
  },
  thToggle: {
    width: 84,
    textAlign: 'center',
  },
  sourceRow: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 12,
    paddingVertical: 8,
  },
  sourceName: {
    flex: 1,
    fontSize: 15,
    fontWeight: '600',
  },
  toggleCell: {
    width: 84,
    alignItems: 'center',
  },
  emptyNote: {
    fontSize: 13,
    lineHeight: 18,
  },
  mutedRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
    paddingHorizontal: 12,
    paddingVertical: 10,
  },
  mutedName: {
    flex: 1,
    fontSize: 15,
    fontWeight: '600',
  },
  unmuteBtn: {
    borderWidth: 1,
    borderRadius: 8,
    paddingHorizontal: 12,
    paddingVertical: 6,
  },
  unmuteText: {
    fontSize: 13,
    fontWeight: '700',
  },
  rowGroup: {
    flexDirection: 'row',
    alignItems: 'center',
    padding: 12,
  },
  rowGroupText: {
    flex: 1,
    paddingRight: 12,
  },
  quietGroup: {
    padding: 12,
  },
  segment: {
    flexDirection: 'row',
    borderRadius: 10,
    padding: 3,
    marginTop: 10,
  },
  segmentBtn: {
    flex: 1,
    borderRadius: 8,
    paddingVertical: 8,
    alignItems: 'center',
  },
  segmentText: {
    fontSize: 13,
    fontWeight: '700',
  },
  quietHead: {
    flexDirection: 'row',
    alignItems: 'center',
  },
  quietHeadText: {
    flex: 1,
    paddingRight: 12,
  },
  rowTitle: {
    fontSize: 15,
    fontWeight: '600',
  },
  rowSub: {
    fontSize: 12,
    marginTop: 2,
    lineHeight: 16,
  },
  timesRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    marginTop: 12,
  },
  timeCard: {
    flex: 1,
    borderRadius: 12,
    paddingVertical: 8,
    alignItems: 'center',
  },
  timeLabel: {
    fontSize: 10,
    fontWeight: '800',
    letterSpacing: 0.8,
  },
  timeRow: {
    flexDirection: 'row',
    alignItems: 'center',
  },
  stepCol: {
    alignItems: 'center',
  },
  stepBtn: {
    width: 40,
    height: 28,
    borderRadius: 8,
    alignItems: 'center',
    justifyContent: 'center',
  },
  timeValue: {
    fontSize: 24,
    fontWeight: '800',
    fontFamily: 'monospace',
    minWidth: 36,
    textAlign: 'center',
  },
  timeColon: {
    fontSize: 22,
    fontWeight: '800',
    marginHorizontal: 2,
  },
  quietNote: {
    fontSize: 12,
    marginTop: 10,
    lineHeight: 16,
  },
});
