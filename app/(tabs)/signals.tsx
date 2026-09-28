import React, { useState, useEffect, useMemo, useReducer } from 'react';
import { StyleSheet, View, Text, FlatList, TouchableOpacity, ActivityIndicator, TextInput, RefreshControl, Pressable } from 'react-native';
import * as Haptics from 'expo-haptics';
import { SafeAreaView } from 'react-native-safe-area-context';
import { database } from '@/firebaseConfig';
import { ref, query, orderByChild, limitToLast, onValue, set, update } from 'firebase/database';
import { AccountSelector } from '@/components/AccountSelector';
import { useAccount } from '@/contexts/AccountContext';
import { useTheme } from '@/contexts/ThemeContext';
import { Signal } from '@/constants/types';
import { IconSymbol } from '@/components/ui/icon-symbol';
import { ExecuteSignalModal } from '@/components/ExecuteSignalModal';
import { useAccountData } from '@/hooks/useAccountData';
import { SwipeToDismiss } from '@/components/SwipeToDismiss';
import { SignalActionSheet, type SignalAction } from '@/components/SignalActionSheet';
import { UndoToast, type ToastData } from '@/components/UndoToast';
import {
  SignalSettingsSheet,
  isSourceInFeed,
  isSymbolMuted,
  saveSourcePrefs,
  saveSymbolMuted,
  useSignalPrefs,
} from '@/components/SignalSettingsSheet';
import { showAlert } from '@/components/AppDialog';

const FILTERS = ['All Signals', 'Pending', 'Winning'];
const SNOOZE_SECS = 3600; // "Snooze 1h"

// Inbox fields the APP writes on a signal node (via multi-path update). The EA
// replaces the whole node when a NEW signal lands on that key — which clears
// these — and only ever patches status/currentPrice itself, so the app never
// writes those two.
type InboxSignal = Signal & {
  dismissed?: boolean;
  snoozedUntil?: number; // UTC epoch secs; hidden from the feed until then
  tag?: string;          // e.g. "sweep" / "engulf" / "reject" for Zones
};

// Local wall-clock HH:MM for a UTC epoch-seconds timestamp.
const clockTime = (sec: number) => {
  const d = new Date(sec * 1000);
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
};

const isSnoozed = (s: InboxSignal, now: number) =>
  typeof s.snoozedUntil === 'number' && s.snoozedUntil > now;

export default function SignalsScreen() {
  const { selectedAccount } = useAccount();
  const { theme } = useTheme();
  const [signals, setSignals] = useState<InboxSignal[]>([]);
  const [loading, setLoading] = useState(true);
  const [executingIds, setExecutingIds] = useState<Set<string>>(new Set());
  const [activeFilter, setActiveFilter] = useState('All Signals');
  const [activeSource, setActiveSource] = useState('All');
  const [searchQuery, setSearchQuery] = useState('');
  const [showSearch, setShowSearch] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const onRefresh = () => { setRefreshing(true); setTimeout(() => setRefreshing(false), 800); };
  const [execSignal, setExecSignal] = useState<Signal | null>(null);
  const [execVisible, setExecVisible] = useState(false);
  // Raw text the user has dialled in per signal (via -/+ or manual typing).
  const [lotOverrides, setLotOverrides] = useState<Record<string, string>>({});
  // Signals executed/rejected this session — filtered locally, NOT written to the
  // shared node, because the EA owns each signal's status (winning/pending) and
  // would overwrite an 'executed'/'rejected' flag, making the signal reappear.
  const [actedIds, setActedIds] = useState<Set<string>>(new Set());
  const { data: acctData } = useAccountData();

  // --- Inbox controls: dismiss / snooze / mute / hide source + settings -------
  const { prefs } = useSignalPrefs();
  const [settingsVisible, setSettingsVisible] = useState(false);
  const [menuVisible, setMenuVisible] = useState(false);
  const [menuSignal, setMenuSignal] = useState<InboxSignal | null>(null);
  const [toast, setToast] = useState<ToastData | null>(null);
  // Periodic re-render so snoozed signals reappear on time (and the expiry
  // countdowns stay fresh between the EA's live-price pushes).
  const [, bumpClock] = useReducer((n: number) => n + 1, 0);
  useEffect(() => {
    const id = setInterval(bumpClock, 15000);
    return () => clearInterval(id);
  }, []);

  const LOT_STEP = 0.01;
  const LOT_MIN = 0.01;
  // Numeric lot for a signal: parsed override if valid, else the signal's own lot, else default.
  const lotFor = (item: Signal) => {
    const raw = lotOverrides[item.id];
    const parsed = raw !== undefined ? parseFloat(raw) : NaN;
    if (!isNaN(parsed) && parsed > 0) return parsed;
    return item.lots > 0 ? item.lots : 0.05;
  };
  // Text shown in the editable field (raw override if present, else the default).
  const lotText = (item: Signal) =>
    lotOverrides[item.id] ?? (item.lots > 0 ? item.lots : 0.05).toFixed(2);
  // Manual edit: keep only digits + a single decimal point so the field stays valid.
  const setLotText = (item: Signal, text: string) => {
    const clean = text.replace(/[^0-9.]/g, '').replace(/(\..*)\./g, '$1');
    setLotOverrides(prev => ({ ...prev, [item.id]: clean }));
  };
  const adjustLot = (item: Signal, delta: number) => {
    const next = Math.max(LOT_MIN, Math.round((lotFor(item) + delta) * 100) / 100);
    setLotOverrides(prev => ({ ...prev, [item.id]: next.toFixed(2) }));
  };
  // On blur, normalise an empty/invalid field back to a clean value.
  const normalizeLot = (item: Signal) => {
    setLotOverrides(prev => ({ ...prev, [item.id]: lotFor(item).toFixed(2) }));
  };

  useEffect(() => {
    if (!selectedAccount) {
      setSignals([]);
      setLoading(false);
      return;
    }

    const signalsRef = query(
      ref(database, `signals/${selectedAccount}`),
      orderByChild('timestamp'),
      limitToLast(50)
    );

    const onDataChange = (snapshot: any) => {
      const val = snapshot.val();
      if (val) {
        const list = Object.keys(val).map(key => ({
          id: key,
          ...val[key]
        }))
          .filter((item: any) => {
            return item.symbol &&
              (item.action === 'BUY' || item.action === 'SELL') &&
              typeof item.price === 'number' && !isNaN(item.price);
          })
          .sort((a: Signal, b: Signal) => b.timestamp - a.timestamp);

        setSignals(list);
      } else {
        setSignals([]);
      }
      setLoading(false);
    };

    const unsubscribe = onValue(signalsRef, onDataChange);

    return () => unsubscribe();
  }, [selectedAccount]);

  const executeSignal = (signal: Signal) => {
    if (!selectedAccount) {
      showAlert("Error", "No account selected.");
      return;
    }
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium).catch(() => {});
    setExecSignal(signal);
    setExecVisible(true);
  };

  // Called from the confirm sheet with the chosen lots/SL/TP.
  // orderKind 'market' fills now (type 0/1); 'stop' places a pending stop at `entry`
  // (type 2=BUY_STOP above price, 3=SELL_STOP below price).
  const doExecute = async (lots: number, sl: number, tp: number, orderKind: 'market' | 'stop' = 'market', entry = 0) => {
    if (!selectedAccount || !execSignal) return;
    const signal = execSignal;
    const isBuy = signal.action === 'BUY';
    const type = orderKind === 'stop' ? (isBuy ? 2 : 3) : (isBuy ? 0 : 1);
    setExecutingIds(prev => new Set([...prev, signal.id]));
    try {
      const commandRef = ref(database, `commands/${selectedAccount}/latest`);
      const command: any = {
        action: 'OPEN_POSITION',
        symbol: signal.symbol,
        type,
        lots,
        sl,
        tp,
        entry,   // signal's intended entry — lets the EA re-anchor SL/TP to the fill (preserve R:R on market orders)
        status: 'PENDING',
        timestamp: Math.floor(Date.now() / 1000)
      };
      if (orderKind === 'stop') command.price = entry;   // trigger price for the pending order
      await set(commandRef, command);
      setActedIds(prev => new Set(prev).add(signal.id));   // hide locally; EA owns the node
      Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success).catch(() => {});
      setExecVisible(false);
      setExecSignal(null);
    } catch {
      showAlert("Error", "Failed to execute signal.");
    } finally {
      setExecutingIds(prev => {
        const newSet = new Set(prev);
        newSet.delete(signal.id);
        return newSet;
      });
    }
  };

  const rejectSignal = (signal: Signal) => {
    // Hide locally for this session; the EA owns the node and prunes it on
    // SL/TP hit or expiry. (No shared-node write — see actedIds.)
    setActedIds(prev => new Set(prev).add(signal.id));
  };

  // ---- Inbox actions --------------------------------------------------------
  const showToast = (message: string, onUndo?: () => void) =>
    setToast({ id: Date.now(), message, onAction: onUndo, actionLabel: onUndo ? 'Undo' : undefined });

  // Dismiss = a synced `dismissed` flag on each node, all in ONE multi-path update
  // (never touches status/currentPrice). Undo clears the flag the same way.
  const dismissSignals = (items: InboxSignal[], message: string) => {
    if (!selectedAccount || items.length === 0) return;
    const acct = selectedAccount;
    const keys = items.map(s => s.id);
    const patch: Record<string, true> = {};
    keys.forEach(k => { patch[`${k}/dismissed`] = true; });
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light).catch(() => {});
    update(ref(database, `signals/${acct}`), patch)
      .catch(() => showAlert('Error', 'Could not dismiss. Check your connection and try again.'));
    showToast(message, () => {
      const undo: Record<string, null> = {};
      keys.forEach(k => { undo[`${k}/dismissed`] = null; });
      update(ref(database, `signals/${acct}`), undo).catch(() => {});
    });
  };

  const dismissOne = (s: InboxSignal) => dismissSignals([s], `Dismissed ${s.symbol}`);

  const clearAll = (items: InboxSignal[]) =>
    dismissSignals(items, `Cleared ${items.length} signal${items.length === 1 ? '' : 's'}`);

  const snoozeSignal = (s: InboxSignal) => {
    if (!selectedAccount) return;
    const acct = selectedAccount;
    const until = Math.floor(Date.now() / 1000) + SNOOZE_SECS;
    update(ref(database, `signals/${acct}`), { [`${s.id}/snoozedUntil`]: until })
      .catch(() => showAlert('Error', 'Could not snooze. Check your connection and try again.'));
    showToast(`Snoozed ${s.symbol} until ${clockTime(until)}`, () => {
      update(ref(database, `signals/${acct}`), { [`${s.id}/snoozedUntil`]: null }).catch(() => {});
    });
  };

  const muteSymbol = (s: InboxSignal) => {
    const symbol = s.symbol;
    saveSymbolMuted(symbol, true)
      .catch(() => showAlert('Error', 'Could not mute that symbol. Check your connection.'));
    showToast(`Muted ${symbol}`, () => { saveSymbolMuted(symbol, false).catch(() => {}); });
  };

  const hideSource = (s: InboxSignal) => {
    if (!s.source) return;
    const source = s.source;
    saveSourcePrefs(source, { feed: false })
      .catch(() => showAlert('Error', 'Could not hide that source. Check your connection.'));
    showToast(`Hid ${source} from the feed`, () => { saveSourcePrefs(source, { feed: true }).catch(() => {}); });
  };

  const openMenu = (s: InboxSignal) => {
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium).catch(() => {});
    setMenuSignal(s);
    setMenuVisible(true);
  };

  const menuActions = (s: InboxSignal): SignalAction[] => {
    const actions: SignalAction[] = [
      {
        key: 'snooze',
        icon: 'zzz',
        label: 'Snooze 1h',
        hint: `Hide until ${clockTime(Math.floor(Date.now() / 1000) + SNOOZE_SECS)}, then it comes back`,
        onPress: () => snoozeSignal(s),
      },
      {
        key: 'mute',
        icon: 'bell.slash',
        label: `Mute ${s.symbol}`,
        hint: 'Hide its signals and silence its pushes',
        onPress: () => muteSymbol(s),
      },
    ];
    if (s.source) {
      actions.push({
        key: 'hide-source',
        icon: 'eye.slash.fill',
        label: `Hide source ${s.source}`,
        hint: 'Remove this strategy from your feed',
        onPress: () => hideSource(s),
      });
    }
    actions.push({
      key: 'dismiss',
      icon: 'xmark',
      label: 'Dismiss',
      hint: 'Remove this signal from the inbox',
      destructive: true,
      onPress: () => dismissOne(s),
    });
    return actions;
  };

  const formatTime = (timestamp: number) => {
    if (!timestamp) return "";
    const now = Math.floor(Date.now() / 1000);
    const diff = now - timestamp;

    if (diff < 60) return `${diff}s ago`;
    if (diff < 3600) return `${Math.floor(diff / 60)}m ago`;
    if (diff < 86400) return `${Math.floor(diff / 3600)}h ago`;
    return new Date(timestamp * 1000).toLocaleDateString();
  };

  // Countdown for discrete signals that carry an expiry (recomputed on each re-render;
  // signal cards re-render on the EA's live price pushes, so it stays fresh).
  const expiryLabel = (expiresAt?: number) => {
    if (!expiresAt) return '';
    const secs = expiresAt - Math.floor(Date.now() / 1000);
    if (secs <= 0) return 'expired';
    if (secs < 60) return `expires in ${secs}s`;
    if (secs < 3600) return `expires in ${Math.floor(secs / 60)}m`;
    return `expires in ${Math.floor(secs / 3600)}h`;
  };

  const nowSec = Math.floor(Date.now() / 1000);

  // Inbox rules: dismissed, snoozed, muted symbol, or source switched off for the feed.
  const hiddenByInbox = (s: InboxSignal, now: number) =>
    s.dismissed === true ||
    isSnoozed(s, now) ||
    isSymbolMuted(prefs, s.symbol) ||
    !isSourceInFeed(prefs, s.source);

  const sources = Array.from(new Set(
    signals.filter(s => !hiddenByInbox(s, nowSec)).map(s => s.source).filter(Boolean)
  )).sort();

  // If the selected source chip disappears (dismissed/hidden/muted away), fall back to All.
  const sourcesKey = sources.join('\n');
  useEffect(() => {
    if (activeSource !== 'All' && !sourcesKey.split('\n').includes(activeSource)) {
      setActiveSource('All');
    }
  }, [sourcesKey, activeSource]);

  // Every source/symbol in the feed (including hidden ones) — lets the settings
  // sheet list sources and show muted symbols by their real names.
  const feedSources = useMemo(
    () => Array.from(new Set(signals.map(s => s.source).filter(Boolean))),
    [signals]
  );
  const feedSymbols = useMemo(
    () => Array.from(new Set(signals.map(s => s.symbol).filter(Boolean))),
    [signals]
  );

  const getFilteredSignals = () => {
    const now = Math.floor(Date.now() / 1000);
    // Show only valid, actionable signals: drop expired, ones acted on this session,
    // and any legacy executed/rejected. (SL/TP-hit signals are pruned by the EA.)
    // Then apply the inbox rules (dismissed / snoozed / muted / hidden source).
    let filtered = signals.filter(s =>
      !(s.expiresAt && s.expiresAt < now) &&
      !actedIds.has(s.id) &&
      s.status !== 'executed' &&
      s.status !== 'rejected' &&
      !hiddenByInbox(s, now)
    );

    // Source filter
    if (activeSource !== 'All') {
      filtered = filtered.filter(s => (s.source || '') === activeSource);
    }

    // Search filter
    if (searchQuery) {
      const q = searchQuery.toLowerCase();
      filtered = filtered.filter(s =>
        s.symbol.toLowerCase().includes(q) ||
        (s.source && s.source.toLowerCase().includes(q))
      );
    }

    // Tab filter
    switch (activeFilter) {
      case 'Pending':
        return filtered.filter(s => s.status === 'pending');
      case 'Winning':
        return filtered.filter(s => s.status === 'winning');
      default:
        return filtered;
    }
  };

  const visibleSignals = getFilteredSignals();

  // Live signals kept out of the feed by snooze / mute / hidden source (footer hint).
  const live = signals.filter(s =>
    !(s.expiresAt && s.expiresAt < nowSec) &&
    !actedIds.has(s.id) &&
    s.status !== 'executed' &&
    s.status !== 'rejected' &&
    s.dismissed !== true
  );
  const snoozedCount = live.filter(s => isSnoozed(s, nowSec)).length;
  const mutedCount = live.filter(s =>
    !isSnoozed(s, nowSec) && (isSymbolMuted(prefs, s.symbol) || !isSourceInFeed(prefs, s.source))
  ).length;
  const hiddenNote = [
    snoozedCount ? `${snoozedCount} snoozed` : '',
    mutedCount ? `${mutedCount} muted or hidden` : '',
  ].filter(Boolean).join(' · ');

  const renderItem = ({ item }: { item: InboxSignal }) => {
    const isPending = item.status === 'pending';
    const isWinning = item.status === 'winning';
    const isProcessing = executingIds.has(item.id);
    const isBuy = item.action === 'BUY';
    const statusColor = isPending ? theme.colors.warning
                      : (isWinning || item.status === 'executed') ? theme.colors.success
                      : theme.colors.error;

    // Symbol Color (Simple hash)
    const getSymbolColor = (symbol: string) => {
      if (symbol.includes('XAU') || symbol.includes('Gold')) return '#F59E0B'; // Gold
      if (symbol.includes('EUR')) return '#3B82F6'; // Blue
      if (symbol.includes('GBP')) return '#8B5CF6'; // Indigo
      if (symbol.includes('JPY')) return '#EF4444'; // Red
      if (symbol.includes('USD')) return '#10B981'; // Green
      return theme.colors.textSecondary;
    };

    const symbolColor = getSymbolColor(item.symbol);

    // Where is price now, between SL and TP, and relative to the signal's entry?
    // Lets the trader judge: enter now (near entry), chase (moved toward TP), or wait.
    const hasLevels = item.sl > 0 && item.tp > 0;
    const cur = (item.currentPrice && item.currentPrice > 0) ? item.currentPrice : item.price;
    let pricePct: number | null = null;
    let entryPct: number | null = null;
    if (hasLevels) {
      const span = isBuy ? (item.tp - item.sl) : (item.sl - item.tp);
      if (span !== 0) {
        const pos = (p: number) => (isBuy ? (p - item.sl) : (item.sl - p)) / span;
        pricePct = Math.max(0, Math.min(1, pos(cur))) * 100;
        entryPct = Math.max(0, Math.min(1, pos(item.price))) * 100;
      }
    }
    const drift = pricePct !== null && entryPct !== null ? pricePct - entryPct : 0;
    const priceHint = Math.abs(drift) < 6 ? 'near entry — good to enter'
                    : drift > 0 ? 'moved toward TP — chasing' : 'pulled toward SL — can wait';

    return (
      // Swipe either way to dismiss; long-press (or •••) for snooze / mute / hide source.
      <SwipeToDismiss onDismiss={() => dismissOne(item)} enabled={!isProcessing} style={styles.swipeRow}>
      <Pressable
        onLongPress={() => openMenu(item)}
        delayLongPress={350}
        accessibilityHint="Swipe sideways to dismiss. Long-press for more options."
        style={[styles.card, styles.cardInRow, { backgroundColor: theme.colors.card }]}
      >
        {/* Header */}
        <View style={styles.cardHeader}>
          <View style={styles.headerLeft}>
            <View style={[styles.symbolIcon, { backgroundColor: symbolColor }]}>
              <Text style={styles.symbolIconText}>{item.symbol.substring(0, 3)}</Text>
            </View>
            <View style={styles.headerText}>
              <View style={styles.titleRow}>
                <Text style={[styles.symbolText, { color: theme.colors.text }]}>{item.symbol}</Text>
                <View style={[styles.statusBadge, { backgroundColor: statusColor + '20' }]}>
                  <Text style={[styles.statusText, { color: statusColor }]}>
                    {item.status.toUpperCase()}
                  </Text>
                </View>
              </View>
              <Text style={[styles.metaText, { color: theme.colors.textSecondary }]}>
                {item.source || 'Signal Feed'}{item.tag ? ` · ${item.tag}` : ''} • {formatTime(item.timestamp)}
                {item.expiresAt ? ` • ${expiryLabel(item.expiresAt)}` : ''}
              </Text>
            </View>
          </View>

          {/* Confidence Ring (Simulated) */}
          <View style={styles.confidenceWrapper}>
            <View style={[styles.confidenceRing, { borderColor: theme.colors.primary }]}>
              <Text style={[styles.confidenceValue, { color: theme.colors.text }]}>{item.confidence}%</Text>
            </View>
            <Text style={[styles.confidenceLabel, { color: theme.colors.textSecondary }]}>Confidence</Text>
          </View>

          {/* Inbox controls: dismiss + more (snooze / mute / hide source) */}
          <View style={styles.cardTools}>
            <TouchableOpacity
              style={[styles.toolBtn, { backgroundColor: theme.colors.input }]}
              onPress={() => dismissOne(item)}
              disabled={isProcessing}
              hitSlop={{ top: 6, bottom: 6, left: 6, right: 6 }}
              accessibilityRole="button"
              accessibilityLabel={`Dismiss ${item.symbol} signal`}
            >
              <IconSymbol name="xmark" size={15} color={theme.colors.textSecondary} />
            </TouchableOpacity>
            <TouchableOpacity
              style={[styles.toolBtn, { backgroundColor: theme.colors.input }]}
              onPress={() => openMenu(item)}
              hitSlop={{ top: 6, bottom: 6, left: 6, right: 6 }}
              accessibilityRole="button"
              accessibilityLabel={`More actions for ${item.symbol}`}
            >
              <IconSymbol name="ellipsis" size={17} color={theme.colors.textSecondary} />
            </TouchableOpacity>
          </View>
        </View>

        {/* Signal Details */}
        <View style={[styles.detailsContainer, { backgroundColor: theme.colors.input }]}>
          <View style={styles.typeRow}>
            <Text style={[
              styles.actionText,
              { color: isBuy ? theme.colors.buy : theme.colors.sell }
            ]}>
              {isBuy ? 'BUY MARKET' : 'SELL MARKET'}
            </Text>
            {(isPending || isWinning) ? (
              <View style={styles.lotStepper}>
                <Text style={[styles.lotStepLabel, { color: theme.colors.textSecondary }]}>Lot</Text>
                <TouchableOpacity
                  style={[styles.lotStepBtn, { borderColor: theme.colors.border }]}
                  onPress={() => adjustLot(item, -LOT_STEP)}
                  disabled={isProcessing}
                  hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
                >
                  <Text style={[styles.lotStepSign, { color: theme.colors.text }]}>−</Text>
                </TouchableOpacity>
                <TextInput
                  style={[styles.lotStepValue, styles.lotStepInput, { color: theme.colors.text, borderColor: theme.colors.border }]}
                  value={lotText(item)}
                  onChangeText={(t) => setLotText(item, t)}
                  onBlur={() => normalizeLot(item)}
                  keyboardType="numeric"
                  selectTextOnFocus
                  editable={!isProcessing}
                  placeholder="0.00"
                  placeholderTextColor={theme.colors.textTertiary}
                />
                <TouchableOpacity
                  style={[styles.lotStepBtn, { borderColor: theme.colors.border }]}
                  onPress={() => adjustLot(item, LOT_STEP)}
                  disabled={isProcessing}
                  hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
                >
                  <Text style={[styles.lotStepSign, { color: theme.colors.text }]}>+</Text>
                </TouchableOpacity>
              </View>
            ) : (
              <Text style={[styles.lotText, { color: theme.colors.text }]}>Lot: {item.lots}</Text>
            )}
          </View>

          <View style={styles.grid}>
            <View style={styles.gridItem}>
              <Text style={[styles.gridLabel, { color: theme.colors.textSecondary }]}>ENTRY</Text>
              <Text style={[styles.gridValue, { color: theme.colors.text }]}>{item.price.toFixed(5)}</Text>
            </View>
            <View style={[styles.gridItem, styles.gridBorder, { borderColor: theme.colors.border }]}>
              <Text style={[styles.gridLabel, { color: theme.colors.textSecondary }]}>STOP LOSS</Text>
              <Text style={[styles.gridValue, { color: theme.colors.loss }]}>{item.sl > 0 ? item.sl.toFixed(5) : '-'}</Text>
            </View>
            <View style={styles.gridItem}>
              <Text style={[styles.gridLabel, { color: theme.colors.textSecondary }]}>TAKE PROFIT</Text>
              <Text style={[styles.gridValue, { color: theme.colors.profit }]}>{item.tp > 0 ? item.tp.toFixed(5) : '-'}</Text>
            </View>
          </View>
        </View>

        {/* Price position: where price sits between SL and TP, vs the signal's entry */}
        {hasLevels && pricePct !== null && entryPct !== null && (
          <View style={styles.progWrap}>
            <View style={styles.progLabels}>
              <Text style={[styles.progEnd, { color: theme.colors.loss }]}>SL</Text>
              <Text style={[styles.progNow, { color: theme.colors.text }]}>{cur.toFixed(5)}</Text>
              <Text style={[styles.progEnd, { color: theme.colors.profit }]}>TP</Text>
            </View>
            <View style={[styles.progTrack, { backgroundColor: theme.colors.input }]}>
              {/* entry reference tick */}
              <View style={[styles.entryTick, { left: `${entryPct}%`, backgroundColor: theme.colors.textSecondary }]} />
              {/* live price marker */}
              <View style={[styles.priceMarker, {
                left: `${pricePct}%`,
                backgroundColor: drift > 0 ? theme.colors.profit : (drift < -6 ? theme.colors.loss : theme.colors.text),
              }]} />
            </View>
            <Text style={[styles.progHint, { color: theme.colors.textTertiary }]}>
              Entry {item.price.toFixed(5)} • {priceHint}
            </Text>
          </View>
        )}

        {/* Actions (live signals are actionable whether pending or already winning) */}
        {(isPending || isWinning) && (
          <View style={styles.actionRow}>
            <TouchableOpacity
              style={[styles.rejectBtn, { borderColor: theme.colors.border }]}
              onPress={() => rejectSignal(item)}
              disabled={isProcessing}
            >
              {isProcessing && executingIds.has(item.id) ? (
                <ActivityIndicator size="small" color={theme.colors.textSecondary} />
              ) : (
                <Text style={[styles.rejectText, { color: theme.colors.textSecondary }]}>Reject</Text>
              )}
            </TouchableOpacity>

            <TouchableOpacity
              style={[styles.executeBtn, { backgroundColor: theme.colors.primary }]}
              onPress={() => executeSignal(item)}
              disabled={isProcessing}
            >
              {isProcessing && executingIds.has(item.id) ? (
                <ActivityIndicator size="small" color="#FFF" />
              ) : (
                <>
                  <IconSymbol name="checkmark" size={16} color="#FFF" />
                  <Text style={styles.executeText}>Execute Trade</Text>
                </>
              )}
            </TouchableOpacity>
          </View>
        )}

        {item.status === 'executed' && (
          <TouchableOpacity style={[styles.detailsBtn, { borderColor: theme.colors.border }]}>
            <Text style={[styles.detailsBtnText, { color: theme.colors.textSecondary }]}>View Trade Details →</Text>
          </TouchableOpacity>
        )}
      </Pressable>
      </SwipeToDismiss>
    );
  };

  return (
    <SafeAreaView style={[styles.container, { backgroundColor: theme.colors.background }]}>
      {/* Header — title/subtitle removed (bottom nav shows the screen); inbox count + actions */}
      <View style={[styles.header, { backgroundColor: theme.colors.background }]}>
        <View style={styles.headerTop}>
          <Text style={[styles.inboxCount, { color: theme.colors.textSecondary }]} numberOfLines={1}>
            {loading ? '' : `${visibleSignals.length} ${visibleSignals.length === 1 ? 'signal' : 'signals'}`}
          </Text>
          <View style={styles.headerIcons}>
            <TouchableOpacity
              onPress={() => clearAll(visibleSignals)}
              disabled={visibleSignals.length === 0}
              style={[styles.clearBtn, { backgroundColor: theme.colors.card, opacity: visibleSignals.length === 0 ? 0.45 : 1 }]}
              accessibilityRole="button"
              accessibilityLabel="Clear all visible signals"
            >
              <IconSymbol name="xmark.bin" size={18} color={theme.colors.text} />
              <Text style={[styles.clearText, { color: theme.colors.text }]}>Clear all</Text>
            </TouchableOpacity>
            <TouchableOpacity
              onPress={() => setSettingsVisible(true)}
              style={[styles.iconBtn, { backgroundColor: theme.colors.card }]}
              accessibilityRole="button"
              accessibilityLabel="Signal settings"
            >
              <IconSymbol name="gear" size={20} color={theme.colors.text} />
            </TouchableOpacity>
            <TouchableOpacity onPress={() => setShowSearch(!showSearch)} style={[styles.iconBtn, { backgroundColor: theme.colors.card }]}>
              <IconSymbol name="magnifyingglass" size={20} color={theme.colors.text} />
            </TouchableOpacity>
          </View>
        </View>

        {showSearch && (
          <TextInput
            style={[styles.searchInput, { backgroundColor: theme.colors.card, color: theme.colors.text }]}
            placeholder="Search symbol or source..."
            placeholderTextColor={theme.colors.textSecondary}
            value={searchQuery}
            onChangeText={setSearchQuery}
          />
        )}
      </View>

      {/* Filters */}
      <View style={styles.filterContainer}>
        <FlatList
          data={FILTERS}
          horizontal
          showsHorizontalScrollIndicator={false}
          contentContainerStyle={styles.filterList}
          keyExtractor={item => item}
          renderItem={({ item }) => (
            <TouchableOpacity
              style={[
                styles.filterPill,
                { backgroundColor: activeFilter === item ? theme.colors.primary : theme.colors.card }
              ]}
              onPress={() => setActiveFilter(item)}
            >
              <Text style={[
                styles.filterText,
                { color: activeFilter === item ? '#FFF' : theme.colors.textSecondary }
              ]}>{item}</Text>
            </TouchableOpacity>
          )}
        />
      </View>

      {/* Source filter (by signal strategy) */}
      {sources.length > 0 && (
        <View style={styles.filterContainer}>
          <FlatList
            data={['All', ...sources]}
            horizontal
            showsHorizontalScrollIndicator={false}
            contentContainerStyle={styles.filterList}
            keyExtractor={item => 'src-' + item}
            renderItem={({ item }) => (
              <TouchableOpacity
                style={[
                  styles.sourcePill,
                  { borderColor: theme.colors.border },
                  activeSource === item && { backgroundColor: theme.colors.info + '22', borderColor: theme.colors.info }
                ]}
                onPress={() => setActiveSource(item)}
              >
                <Text style={[styles.sourceText, { color: activeSource === item ? theme.colors.info : theme.colors.textSecondary }]}>
                  {item === 'All' ? 'All sources' : item}
                </Text>
              </TouchableOpacity>
            )}
          />
        </View>
      )}

      <AccountSelector />

      {/* Signal List */}
      <FlatList
        data={visibleSignals}
        renderItem={renderItem}
        keyExtractor={item => item.id}
        contentContainerStyle={styles.listContent}
        refreshControl={
          <RefreshControl refreshing={refreshing} onRefresh={onRefresh} tintColor={theme.colors.primary} />
        }
        ListEmptyComponent={
          !loading ? (
            <View style={styles.emptyContainer}>
              <IconSymbol name="antenna.radiowaves.left.and.right.slash" size={48} color={theme.colors.textTertiary} />
              <Text style={[styles.emptyText, { color: theme.colors.textSecondary }]}>No signals found</Text>
            </View>
          ) : (
            <ActivityIndicator style={{ marginTop: 40 }} size="large" color={theme.colors.primary} />
          )
        }
        ListFooterComponent={
          !loading && hiddenNote ? (
            <TouchableOpacity
              style={styles.hiddenNote}
              onPress={() => setSettingsVisible(true)}
              accessibilityRole="button"
              accessibilityLabel={`${hiddenNote}. Open signal settings`}
            >
              <IconSymbol name="eye.slash.fill" size={14} color={theme.colors.textTertiary} />
              <Text style={[styles.hiddenNoteText, { color: theme.colors.textTertiary }]}>
                {hiddenNote} · <Text style={{ color: theme.colors.primary, fontWeight: '700' }}>Manage</Text>
              </Text>
            </TouchableOpacity>
          ) : null
        }
      />

      <ExecuteSignalModal
        signal={execSignal}
        balance={acctData?.balance}
        currency={acctData?.currency}
        initialLots={execSignal ? lotFor(execSignal) : undefined}
        visible={execVisible}
        busy={execSignal ? executingIds.has(execSignal.id) : false}
        onClose={() => setExecVisible(false)}
        onConfirm={doExecute}
      />

      <SignalActionSheet
        visible={menuVisible}
        title={menuSignal ? `${menuSignal.symbol} · ${menuSignal.action}` : ''}
        subtitle={menuSignal ? [menuSignal.source, menuSignal.tag].filter(Boolean).join(' · ') : undefined}
        actions={menuSignal ? menuActions(menuSignal) : []}
        onClose={() => setMenuVisible(false)}
      />

      <SignalSettingsSheet
        visible={settingsVisible}
        onClose={() => setSettingsVisible(false)}
        prefs={prefs}
        account={selectedAccount}
        feedSources={feedSources}
        feedSymbols={feedSymbols}
      />

      <UndoToast toast={toast} onHide={() => setToast(null)} bottom={12} />
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
  },
  // Signal price-position bar (SL <- entry/price -> TP)
  progWrap: {
    marginTop: 12,
  },
  progLabels: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    marginBottom: 6,
  },
  progEnd: {
    fontSize: 11,
    fontWeight: '700',
  },
  progNow: {
    fontSize: 11,
    fontWeight: '600',
  },
  progTrack: {
    height: 6,
    borderRadius: 3,
    position: 'relative',
    justifyContent: 'center',
  },
  entryTick: {
    position: 'absolute',
    width: 2,
    height: 14,
    borderRadius: 1,
    marginLeft: -1,
    opacity: 0.9,
  },
  priceMarker: {
    position: 'absolute',
    width: 10,
    height: 10,
    borderRadius: 5,
    marginLeft: -5,
    borderWidth: 2,
    borderColor: '#00000030',
  },
  progHint: {
    fontSize: 11,
    marginTop: 6,
    textAlign: 'center',
  },
  header: {
    padding: 16,
    paddingBottom: 8,
  },
  headerTop: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
  },
  headerTitle: {
    fontSize: 28,
    fontWeight: 'bold',
  },
  inboxCount: {
    flex: 1,
    fontSize: 14,
    fontWeight: '600',
    marginRight: 12,
  },
  headerIcons: {
    flexDirection: 'row',
    gap: 12,
  },
  iconBtn: {
    width: 40,
    height: 40,
    borderRadius: 12,
    justifyContent: 'center',
    alignItems: 'center',
  },
  clearBtn: {
    height: 40,
    borderRadius: 12,
    paddingHorizontal: 12,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
  },
  clearText: {
    fontSize: 13,
    fontWeight: '700',
  },
  headerSubtitle: {
    fontSize: 14,
    marginTop: 4,
  },
  searchInput: {
    marginTop: 12,
    padding: 12,
    borderRadius: 12,
    fontSize: 16,
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
  sourcePill: {
    paddingHorizontal: 14,
    paddingVertical: 6,
    borderRadius: 16,
    borderWidth: 1,
  },
  sourceText: {
    fontSize: 13,
    fontWeight: '600',
  },
  listContent: {
    padding: 16,
    paddingTop: 0,
  },
  // Swipeable row wrapper carries the spacing so the revealed panel matches the card.
  swipeRow: {
    marginBottom: 16,
    borderRadius: 16,
  },
  card: {
    borderRadius: 16,
    padding: 16,
    marginBottom: 16,
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 2 },
    shadowOpacity: 0.05,
    shadowRadius: 8,
    elevation: 2,
  },
  cardInRow: {
    marginBottom: 0,
  },
  cardHeader: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    marginBottom: 16,
  },
  headerLeft: {
    flexDirection: 'row',
    gap: 12,
    flex: 1,
  },
  headerText: {
    flex: 1,
  },
  cardTools: {
    marginLeft: 10,
    gap: 6,
  },
  toolBtn: {
    width: 28,
    height: 28,
    borderRadius: 8,
    justifyContent: 'center',
    alignItems: 'center',
  },
  symbolIcon: {
    width: 48,
    height: 48,
    borderRadius: 12,
    justifyContent: 'center',
    alignItems: 'center',
  },
  symbolIconText: {
    color: '#FFF',
    fontWeight: 'bold',
    fontSize: 12,
  },
  titleRow: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    alignItems: 'center',
    gap: 8,
    marginBottom: 4,
  },
  symbolText: {
    fontSize: 18,
    fontWeight: 'bold',
    flexShrink: 1,
  },
  statusBadge: {
    paddingHorizontal: 6,
    paddingVertical: 2,
    borderRadius: 4,
  },
  statusText: {
    fontSize: 10,
    fontWeight: '800',
  },
  metaText: {
    fontSize: 12,
  },
  confidenceWrapper: {
    alignItems: 'center',
  },
  confidenceRing: {
    width: 44,
    height: 44,
    borderRadius: 22,
    borderWidth: 3,
    justifyContent: 'center',
    alignItems: 'center',
    marginBottom: 4,
  },
  confidenceValue: {
    fontSize: 12,
    fontWeight: 'bold',
  },
  confidenceLabel: {
    fontSize: 10,
  },
  detailsContainer: {
    borderRadius: 12,
    padding: 16,
    marginBottom: 16,
  },
  typeRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    marginBottom: 12,
    paddingBottom: 12,
    borderBottomWidth: 1,
    borderBottomColor: 'rgba(150,150,150,0.1)',
  },
  actionText: {
    fontSize: 14,
    fontWeight: '800',
  },
  lotText: {
    fontSize: 14,
    fontWeight: '600',
  },
  lotStepper: {
    flexDirection: 'row',
    alignItems: 'center',
  },
  lotStepLabel: {
    fontSize: 13,
    fontWeight: '600',
    marginRight: 8,
  },
  lotStepBtn: {
    width: 30,
    height: 30,
    borderRadius: 8,
    borderWidth: 1,
    justifyContent: 'center',
    alignItems: 'center',
  },
  lotStepSign: {
    fontSize: 20,
    fontWeight: '700',
    lineHeight: 22,
  },
  lotStepValue: {
    fontSize: 15,
    fontWeight: '700',
    minWidth: 46,
    textAlign: 'center',
    fontFamily: 'monospace',
  },
  lotStepInput: {
    borderWidth: 1,
    borderRadius: 6,
    paddingVertical: 4,
    paddingHorizontal: 6,
    marginHorizontal: 2,
    minWidth: 64,
  },
  grid: {
    flexDirection: 'row',
    justifyContent: 'space-between',
  },
  gridItem: {
    alignItems: 'center',
    flex: 1,
  },
  gridBorder: {
    borderLeftWidth: 1,
    borderRightWidth: 1,
  },
  gridLabel: {
    fontSize: 10,
    fontWeight: '700',
    marginBottom: 4,
  },
  gridValue: {
    fontSize: 15,
    fontWeight: '700',
  },
  actionRow: {
    flexDirection: 'row',
    gap: 12,
  },
  rejectBtn: {
    flex: 1,
    paddingVertical: 14,
    borderRadius: 12,
    borderWidth: 1,
    alignItems: 'center',
    justifyContent: 'center',
  },
  rejectText: {
    fontSize: 16,
    fontWeight: '600',
  },
  executeBtn: {
    flex: 2,
    paddingVertical: 14,
    borderRadius: 12,
    flexDirection: 'row',
    gap: 8,
    alignItems: 'center',
    justifyContent: 'center',
  },
  executeText: {
    color: '#FFF',
    fontSize: 16,
    fontWeight: '700',
  },
  detailsBtn: {
    paddingVertical: 12,
    borderRadius: 12,
    borderWidth: 1,
    alignItems: 'center',
  },
  detailsBtnText: {
    fontSize: 14,
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
  hiddenNote: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 6,
    paddingVertical: 12,
    marginBottom: 12,
  },
  hiddenNoteText: {
    fontSize: 12,
    fontWeight: '600',
  },
});
