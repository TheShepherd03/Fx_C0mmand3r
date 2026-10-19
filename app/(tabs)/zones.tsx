import React, { useState, useEffect, useMemo, useRef } from 'react';
import { StyleSheet, View, Text, FlatList, TouchableOpacity, ActivityIndicator, TextInput, Switch, ScrollView, KeyboardAvoidingView, Platform, Keyboard, Modal, Pressable } from 'react-native';
import * as Haptics from 'expo-haptics';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useLocalSearchParams } from 'expo-router';
import { database, authReady } from '@/firebaseConfig';
import { ref, onValue, set, remove, update } from 'firebase/database';
import { AccountSelector } from '@/components/AccountSelector';
import { useAccount } from '@/contexts/AccountContext';
import { useTheme } from '@/contexts/ThemeContext';
import { IconSymbol } from '@/components/ui/icon-symbol';
import { parseZoneStatus, zoneAlertLevel, DRAFT_COLOR } from '@/components/ZoneChart';
import { ZoneStatusPanel, zoneStateColor } from '@/components/ZoneStatusPanel';
import { ZoneDraftsCard, draftDigits, type ZoneDraft } from '@/components/ZoneDraftsCard';
import { showAlert } from '@/components/AppDialog';
import { AiTradeCard } from '@/components/AiTradeCard';

// Zone drafts the refresh proposed for one symbol: zoneDrafts/{acct}/{symbolKey}.
interface DraftNode {
  symbol: string;
  batch?: number;
  items?: Record<string, Omit<ZoneDraft, 'id'>>;
}

// A supply/demand zone node as stored by the app and read by the MT5 EA at
// `zones/{accountId}/{symbolKey}`. The app OWNS this node (writes it); the EA
// only reads it to decide when price enters a zone and emit a signal.
interface ZoneNode {
  symbol: string;      // REAL symbol string, unsanitized (e.g. 'Volatility 10 Index', 'XAUUSDb')
  zones: string;       // pipe-separated HIGH:LOW pairs, e.g. '1234.5:1230.2|1250.0:1245.0'
  active: boolean;
  expiresAt: number;   // 0 = never; else Unix epoch SECONDS of upcoming local midnight
}

// One editable High/Low pair in the editor.
interface ZoneRow {
  high: number;
  low: number;
}

// A saved symbol as surfaced in the "existing zones" list.
interface SavedSymbol {
  key: string;         // Firebase-safe symbol key
  node: ZoneNode;
}

// Sanitize a symbol into a valid Firebase key: the EA uses the IDENTICAL rule,
// replacing each of space . $ # [ ] / with '_'. Keep in lock-step with the EA.
const symbolKeyFor = (symbol: string) =>
  symbol.replace(/[ .$#\[\]/]/g, '_');

// Parse the compact `zones` string back into editable rows. Guards NaN and
// enforces HIGH > LOW (swaps if needed) so display always makes sense.
const parseZones = (zones: string | undefined): ZoneRow[] => {
  if (!zones) return [];
  return zones
    .split('|')
    .map((pair) => {
      const [h, l] = pair.split(':');
      const high = parseFloat(h);
      const low = parseFloat(l);
      if (isNaN(high) || isNaN(low)) return null;
      return high >= low ? { high, low } : { high: low, low: high };
    })
    .filter((r): r is ZoneRow => r !== null);
};

// Build the compact `zones` string the EA parses. Uses '.' decimals.
const buildZonesString = (rows: ZoneRow[]) =>
  rows.map((r) => `${r.high}:${r.low}`).join('|');

// Unix epoch SECONDS of the upcoming local midnight (end of today, device time).
const endOfTodayEpoch = () => {
  const d = new Date();
  d.setHours(24, 0, 0, 0); // rolls to 00:00 of the next local day
  return Math.floor(d.getTime() / 1000);
};

// Zone clean-up (prefs/zones), enforced on the PC by the zone watcher every 5 minutes for
// every account: a symbol over maxPerSymbol loses the zones farthest from price (a zone
// that just went live last); zones leave validityHours after they went live (0 = never).
// Defaults match the watcher (zone-refresh/approvals.py HK_MAX / HK_HOURS).
const ZONE_LIMIT_DEFAULT = 6;
const ZONE_HOURS_DEFAULT = 48;
const ZONE_LIMIT_OPTIONS = [4, 6, 8, 10];
const ZONE_HOURS_OPTIONS = [
  { label: '12 h', hours: 12 },
  { label: '24 h', hours: 24 },
  { label: '48 h', hours: 48 },
  { label: '1 week', hours: 168 },
  { label: 'Never', hours: 0 },
];
const MAX_CUSTOM_HOURS = 2160; // 90 days

// Key of one zone in zoneBorn/{acct}/{symbolKey} (when it went live): the watcher's rule,
// 6 decimals without trailing zeros, '.' -> '_', so it survives the zone string being rewritten.
const num6 = (x: number) => {
  const s = x.toFixed(6).replace(/0+$/, '').replace(/\.$/, '');
  return s === '' || s === '-0' ? '0' : s;
};
const bornKey = (high: number, low: number) =>
  `${num6(Math.max(high, low))}:${num6(Math.min(high, low))}`.replace(/\./g, '_');
const durationText = (hours: number) =>
  hours < 1 ? `${Math.max(1, Math.round(hours * 60))} min` : hours <= 72 ? `${Math.round(hours)} h` : `${Math.round(hours / 24)} d`;
const validityText = (hours: number) =>
  ZONE_HOURS_OPTIONS.find((o) => o.hours === hours)?.label ?? durationText(hours);

export default function ZonesScreen() {
  const { selectedAccount } = useAccount();
  const { theme } = useTheme();

  const [saved, setSaved] = useState<SavedSymbol[]>([]);
  const [loading, setLoading] = useState(true);

  // The broker's REAL symbol list, published by the EA at `symbols/{accountId}`
  // as a JSON array of exact case-sensitive names. Used to power the symbol
  // autocomplete so users tap the exact string instead of mistyping the case.
  const [symbols, setSymbols] = useState<string[]>([]);
  // Whether the symbol input is focused (controls suggestion dropdown visibility).
  const [symbolFocused, setSymbolFocused] = useState(false);

  // --- Editor state (the symbol currently being created/edited) ---------------
  const [symbolInput, setSymbolInput] = useState('');
  const [rows, setRows] = useState<ZoneRow[]>([]);
  const [active, setActive] = useState(true);
  const [expireEod, setExpireEod] = useState(false);
  const [saving, setSaving] = useState(false);

  // Draft High/Low for the "add zone" row.
  const [highDraft, setHighDraft] = useState('');
  const [lowDraft, setLowDraft] = useState('');

  // Live read of this account's zones — same account-id key as signals/{acct}.
  useEffect(() => {
    if (!selectedAccount) {
      setSaved([]);
      setLoading(false);
      return;
    }
    const zonesRef = ref(database, `zones/${selectedAccount}`);
    const unsubscribe = onValue(zonesRef, (snapshot: any) => {
      const val = snapshot.val();
      if (val) {
        const list: SavedSymbol[] = Object.keys(val)
          .map((key) => ({ key, node: val[key] as ZoneNode }))
          .filter((s) => s.node && typeof s.node.symbol === 'string')
          .sort((a, b) => a.node.symbol.localeCompare(b.node.symbol));
        setSaved(list);
      } else {
        setSaved([]);
      }
      setLoading(false);
    });
    return () => unsubscribe();
  }, [selectedAccount]);

  // Live read of this account's broker symbol list — same account-id key as
  // zones/{acct}. Firebase may return an array (sequential int keys) or an
  // object; the EA may not have published for this account yet (null).
  useEffect(() => {
    if (!selectedAccount) {
      setSymbols([]);
      return;
    }
    const symbolsRef = ref(database, `symbols/${selectedAccount}`);
    const unsubscribe = onValue(symbolsRef, (snapshot: any) => {
      const val = snapshot.val();
      if (Array.isArray(val)) {
        setSymbols(val.filter((x: any): x is string => typeof x === 'string'));
      } else if (val && typeof val === 'object') {
        setSymbols(Object.values(val).filter((x: any): x is string => typeof x === 'string'));
      } else {
        setSymbols([]);
      }
    });
    return () => unsubscribe();
  }, [selectedAccount]);

  // Live zone status the zone EA publishes at `zonestatus/{accountId}` — one
  // child per zoned symbol, under the same sanitized key as zones/{acct}. This
  // single listener feeds both the chips' near/inside dots and the selected
  // symbol's live chart. The app only READS this node.
  const [zoneStatusAll, setZoneStatusAll] = useState<Record<string, unknown>>({});
  useEffect(() => {
    setZoneStatusAll({});
    if (!selectedAccount) return;
    const statusRef = ref(database, `zonestatus/${selectedAccount}`);
    let cancelled = false;
    let unsubscribe = () => {};
    authReady.then(() => {
      if (cancelled) return;
      unsubscribe = onValue(
        statusRef,
        (snapshot: any) => {
          const val = snapshot.val();
          setZoneStatusAll(val && typeof val === 'object' ? val : {});
        },
        (error) => console.error('Failed to read zone status:', error)
      );
    });
    return () => {
      cancelled = true;
      unsubscribe();
    };
  }, [selectedAccount]);

  // Zone drafts awaiting the user's decision, per symbol key (zoneDrafts/{acct}).
  const [draftsAll, setDraftsAll] = useState<Record<string, DraftNode>>({});
  const [selectedDraftId, setSelectedDraftId] = useState<string | null>(null);
  const [deciding, setDeciding] = useState(false);
  useEffect(() => {
    setDraftsAll({});
    if (!selectedAccount) return;
    let cancelled = false;
    let unsubscribe = () => {};
    authReady.then(() => {
      if (cancelled) return;
      unsubscribe = onValue(
        ref(database, `zoneDrafts/${selectedAccount}`),
        (snapshot: any) => {
          const val = snapshot.val();
          setDraftsAll(val && typeof val === 'object' ? val : {});
        },
        (error) => console.error('Failed to read zone drafts:', error)
      );
    });
    return () => {
      cancelled = true;
      unsubscribe();
    };
  }, [selectedAccount]);

  // Zone clean-up settings (prefs/zones, every account) and when each live zone went
  // live (zoneBorn/{acct}/{symbolKey}/{bornKey}, stamped by the PC's zone watcher).
  // autoApprove / autoApproveByAccount: below the limit, waiting drafts go live at once (the PC's watcher; default on)
  const [zonePrefs, setZonePrefs] = useState({
    maxPerSymbol: ZONE_LIMIT_DEFAULT,
    validityHours: ZONE_HOURS_DEFAULT,
    autoApprove: true,
    autoApproveByAccount: {} as Record<string, boolean>,
  });
  const [bornAll, setBornAll] = useState<Record<string, Record<string, number>>>({});
  const [customHours, setCustomHours] = useState<string | null>(null); // null = custom input closed
  useEffect(() => {
    let cancelled = false;
    let unsubscribe = () => {};
    authReady.then(() => {
      if (cancelled) return;
      unsubscribe = onValue(
        ref(database, 'prefs/zones'),
        (snapshot: any) => {
          const v = snapshot.val() || {};
          setZonePrefs({
            maxPerSymbol: typeof v.maxPerSymbol === 'number' && v.maxPerSymbol >= 1 ? v.maxPerSymbol : ZONE_LIMIT_DEFAULT,
            validityHours: typeof v.validityHours === 'number' && v.validityHours >= 0 ? v.validityHours : ZONE_HOURS_DEFAULT,
            autoApprove: v.autoApprove !== false,
            autoApproveByAccount:
              v.autoApproveByAccount && typeof v.autoApproveByAccount === 'object' ? v.autoApproveByAccount : {},
          });
        },
        (error) => console.error('Failed to read zone clean-up settings:', error)
      );
    });
    return () => {
      cancelled = true;
      unsubscribe();
    };
  }, []);
  useEffect(() => {
    setBornAll({});
    if (!selectedAccount) return;
    let cancelled = false;
    let unsubscribe = () => {};
    authReady.then(() => {
      if (cancelled) return;
      unsubscribe = onValue(
        ref(database, `zoneBorn/${selectedAccount}`),
        (snapshot: any) => {
          const val = snapshot.val();
          setBornAll(val && typeof val === 'object' ? val : {});
        },
        (error) => console.error('Failed to read zone ages:', error)
      );
    });
    return () => {
      cancelled = true;
      unsubscribe();
    };
  }, [selectedAccount]);

  const saveZonePref = (field: 'maxPerSymbol' | 'validityHours', value: number) => {
    Haptics.selectionAsync().catch(() => {});
    update(ref(database, 'prefs/zones'), { [field]: value }).catch(() =>
      showAlert('Error', 'Could not save that setting. Check your connection.')
    );
  };

  // Auto-approve for the selected account (prefs/zones/autoApproveByAccount/{acct}; missing = on).
  const autoApproveOn =
    zonePrefs.autoApprove && !!selectedAccount && zonePrefs.autoApproveByAccount[selectedAccount] !== false;
  const saveAutoApprove = (value: boolean) => {
    if (!selectedAccount) return;
    Haptics.selectionAsync().catch(() => {});
    update(ref(database, 'prefs/zones/autoApproveByAccount'), { [selectedAccount]: value }).catch(() =>
      showAlert('Error', 'Could not save that setting. Check your connection.')
    );
  };

  const saveCustomHours = () => {
    const h = parseFloat((customHours ?? '').replace(',', '.'));
    if (!Number.isFinite(h) || h <= 0 || h > MAX_CUSTOM_HOURS) {
      showAlert('Zone validity', `Enter a number of hours above 0 and up to ${MAX_CUSTOM_HOURS} (90 days).`);
      return;
    }
    saveZonePref('validityHours', Math.round(h * 10) / 10);
    setCustomHours(null);
    Keyboard.dismiss();
  };

  // Pending drafts per symbol key, best style match first.
  const pendingByKey = useMemo(() => {
    const out: Record<string, { symbol: string; drafts: ZoneDraft[] }> = {};
    for (const key of Object.keys(draftsAll)) {
      const node = draftsAll[key];
      if (!node || typeof node.symbol !== 'string') continue;
      const drafts = Object.entries(node.items ?? {})
        .map(([id, it]) => ({ ...(it as Omit<ZoneDraft, 'id'>), id }))
        .filter((d) => d.status === 'pending' && typeof d.hi === 'number' && typeof d.lo === 'number')
        .sort((a, b) => (b.score ?? 0) - (a.score ?? 0));
      if (drafts.length) out[key] = { symbol: node.symbol, drafts };
    }
    return out;
  }, [draftsAll]);
  const totalPending = Object.values(pendingByKey).reduce((n, p) => n + p.drafts.length, 0);

  // Chip indicator: hottest zone state per symbol key ('inside' beats 'near').
  const alertByKey = useMemo(() => {
    const out: Record<string, 'inside' | 'near'> = {};
    for (const key of Object.keys(zoneStatusAll)) {
      const level = zoneAlertLevel(zoneStatusAll[key]);
      if (level) out[key] = level;
    }
    return out;
  }, [zoneStatusAll]);

  // Case-insensitive substring matches for the current input, capped at 15.
  const symbolMatches = useMemo(() => {
    const q = symbolInput.trim().toLowerCase();
    if (!q) return [];
    return symbols.filter((s) => s.toLowerCase().includes(q)).slice(0, 15);
  }, [symbols, symbolInput]);

  // Only show the dropdown while focused with matches, and not when the input
  // already exactly equals the sole match (i.e. user has already picked it).
  const showSuggestions =
    symbolFocused &&
    symbolMatches.length > 0 &&
    !(symbolMatches.length === 1 && symbolMatches[0] === symbolInput.trim());

  // Live status of the symbol in the editor. Shown for saved symbols (even
  // before the EA has published) and for any symbol the EA already reports on.
  // zonestatus uses the exact zones key; a case-insensitive fallback covers a
  // symbol typed in a different case than the saved entry (same instrument).
  const editorSymbol = symbolInput.trim();
  const editorKey = editorSymbol ? symbolKeyFor(editorSymbol) : '';
  const liveKey = useMemo(() => {
    if (!editorKey) return '';
    if (Object.prototype.hasOwnProperty.call(zoneStatusAll, editorKey)) return editorKey;
    const lower = editorKey.toLowerCase();
    return Object.keys(zoneStatusAll).find((k) => k.toLowerCase() === lower) ?? '';
  }, [editorKey, zoneStatusAll]);
  const liveRaw = liveKey ? zoneStatusAll[liveKey] : undefined;
  const liveStatus = useMemo(() => parseZoneStatus(liveRaw), [liveRaw]);
  const showLive =
    !!editorSymbol && (liveRaw != null || saved.some((s) => s.node.symbol === editorSymbol));

  // "live 5 h · expires in 43 h" under each SAVED zone of the symbol in the editor.
  const savedEntry = saved.find((s) => s.node.symbol === editorSymbol);
  const savedZoneKeys = useMemo(
    () => new Set(parseZones(savedEntry?.node.zones).map((r) => bornKey(r.high, r.low))),
    [savedEntry?.node.zones]
  );
  const bornHere = (savedEntry && bornAll[savedEntry.key]) || {};
  const zoneAge = (row: ZoneRow): string | null => {
    const k = bornKey(row.high, row.low);
    if (!savedZoneKeys.has(k)) return null; // not saved yet
    const born = bornHere[k];
    if (typeof born !== 'number') return 'just went live';
    const live = Math.max(0, Date.now() / 1000 - born);
    const liveText = `live ${durationText(live / 3600)}`;
    if (!zonePrefs.validityHours) return liveText;
    const left = zonePrefs.validityHours * 3600 - live;
    return `${liveText} · ${left > 0 ? `expires in ${durationText(left / 3600)}` : 'expiring now'}`;
  };

  // Drafts for the symbol in the editor (draft keys use the same sanitized key as zones/).
  const editorDrafts = useMemo(
    () => (editorKey ? pendingByKey[editorKey]?.drafts ?? [] : []),
    [editorKey, pendingByKey]
  );
  const editorDigits = draftDigits(editorDrafts, liveStatus?.digits);
  const chartDrafts = useMemo(
    () => editorDrafts.map((d) => ({ high: d.hi, low: d.lo, selected: d.id === selectedDraftId })),
    [editorDrafts, selectedDraftId]
  );

  // Approve / reject drafts. One multi-path update: approved zones join the live
  // set the EA reads (zones/), the draft is marked decided, the decision is saved
  // as a training example (zoneFeedback/ - the refresh retrains on these), and
  // zoneSync/ tells the PC's zone watcher to redraw TradingView.
  const decideDrafts = async (key: string, symbol: string, items: ZoneDraft[], decision: 'approved' | 'rejected') => {
    if (!selectedAccount || items.length === 0) return;
    const acct = selectedAccount;
    const now = Math.floor(Date.now() / 1000);
    const batch = draftsAll[key]?.batch ?? 0;
    const updates: Record<string, unknown> = {};
    for (const it of items) {
      updates[`zoneDrafts/${acct}/${key}/items/${it.id}/status`] = decision;
      updates[`zoneDrafts/${acct}/${key}/items/${it.id}/decidedAt`] = now;
      updates[`zoneFeedback/${acct}/${key}__${it.id}`] = {
        symbol,
        hi: it.hi,
        lo: it.lo,
        side: it.side ?? '',
        layer: it.layer ?? '',
        reason: it.reason ?? '',
        score: it.score ?? 0,
        f: it.f ?? null,
        fv: it.fv ?? 0,
        batch,
        decision,
        at: now,
      };
    }
    let newRows: ZoneRow[] | null = null;
    if (decision === 'approved') {
      const node = saved.find((s) => s.key === key)?.node;
      newRows = parseZones(node?.zones);
      for (const it of items) {
        if (!newRows.some((r) => r.high === it.hi && r.low === it.lo)) newRows.push({ high: it.hi, low: it.lo });
      }
      newRows.sort((a, b) => b.high - a.high);
      updates[`zones/${acct}/${key}/zones`] = buildZonesString(newRows);
      updates[`zones/${acct}/${key}/symbol`] = symbol;
      updates[`zones/${acct}/${key}/updatedAt`] = now;
      if (!node) {
        updates[`zones/${acct}/${key}/active`] = true;
        updates[`zones/${acct}/${key}/expiresAt`] = 0;
      }
    }
    updates[`zoneSync/${acct}`] = now;
    setDeciding(true);
    try {
      await update(ref(database), updates);
      if (newRows && symbolInput.trim() === symbol) setRows(newRows);    // keep the open editor in step
      setSelectedDraftId(null);
      Haptics.notificationAsync(
        decision === 'approved' ? Haptics.NotificationFeedbackType.Success : Haptics.NotificationFeedbackType.Warning
      ).catch(() => {});
    } catch {
      showAlert('Error', 'Could not save your decision. Check your connection and try again.');
    } finally {
      setDeciding(false);
    }
  };

  // Open a symbol from the review list (it may have drafts but no live zones yet).
  const openForReview = (key: string) => {
    const s = saved.find((x) => x.key === key);
    if (s) loadSymbol(s);
    else {
      Haptics.selectionAsync().catch(() => {});
      setSymbolInput(pendingByKey[key]?.symbol ?? '');
      setRows([]);
      setActive(true);
      setExpireEod(false);
    }
    setSelectedDraftId(null);
  };

  // Tap a suggestion: set the field to the EXACT broker string (no transform).
  const selectSymbol = (sym: string) => {
    Haptics.selectionAsync().catch(() => {});
    setSymbolInput(sym);
    setSymbolFocused(false);
    Keyboard.dismiss();
  };

  // Load a saved symbol into the editor (tap to edit; also used by push deep links).
  const loadSymbol = (s: SavedSymbol, haptic = true) => {
    if (haptic) Haptics.selectionAsync().catch(() => {});
    setSymbolInput(s.node.symbol);
    setRows(parseZones(s.node.zones));
    setActive(s.node.active !== false);
    setExpireEod((s.node.expiresAt || 0) > 0);
    setHighDraft('');
    setLowDraft('');
  };

  // Reset the editor to a blank new symbol.
  const clearEditor = () => {
    setSymbolInput('');
    setRows([]);
    setActive(true);
    setExpireEod(false);
    setHighDraft('');
    setLowDraft('');
  };

  // Push deep link (`/(tabs)/zones?symbol=…&ts=…`, see usePushNotifications):
  // preselect that symbol as soon as it's in this account's saved list. The
  // link carries the broker's resolved name, which may differ in CASE from the
  // saved entry (e.g. typed "volatility 10 index"), so match case-insensitively
  // on the entry's symbol or its sanitized key. `ts` is unique per tap, so a
  // second alert for the same symbol re-selects it even if the editor has
  // moved on; an already-handled link never re-applies.
  const linkParams = useLocalSearchParams<{ symbol?: string | string[]; ts?: string | string[] }>();
  const firstParam = (v: string | string[] | undefined) => (Array.isArray(v) ? v[0] : v) ?? '';
  const linkSymbol = firstParam(linkParams.symbol).trim();
  const linkTs = firstParam(linkParams.ts);
  const handledLinkRef = useRef('');
  useEffect(() => {
    if (!linkSymbol) return;
    const linkId = `${linkSymbol}|${linkTs}`;
    if (handledLinkRef.current === linkId) return;
    const wanted = linkSymbol.toLowerCase();
    const wantedKey = symbolKeyFor(linkSymbol).toLowerCase();
    const match =
      saved.find((s) => s.node.symbol.trim().toLowerCase() === wanted) ??
      saved.find((s) => s.key.toLowerCase() === wantedKey);
    if (!match) return; // list not loaded yet (or not zoned on this account) — retry on the next update
    handledLinkRef.current = linkId;
    loadSymbol(match, false);
  }, [linkSymbol, linkTs, saved]);

  // Keep only digits + a single decimal point.
  const cleanNum = (text: string) =>
    text.replace(/[^0-9.]/g, '').replace(/(\..*)\./g, '$1');

  const addZone = () => {
    const high = parseFloat(highDraft);
    const low = parseFloat(lowDraft);
    if (isNaN(high) || isNaN(low)) {
      showAlert('Invalid zone', 'Enter numeric High and Low values.');
      return;
    }
    if (high === low) {
      showAlert('Invalid zone', 'High and Low cannot be equal.');
      return;
    }
    // Swap if entered the wrong way round so HIGH > LOW always holds.
    const row: ZoneRow = high > low ? { high, low } : { high: low, low: high };
    setRows((prev) => [...prev, row]);
    setHighDraft('');
    setLowDraft('');
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light).catch(() => {});
  };

  const deleteRow = (index: number) => {
    setRows((prev) => prev.filter((_, i) => i !== index));
  };

  const saveSymbol = async () => {
    if (!selectedAccount) {
      showAlert('No account', 'Select an account first.');
      return;
    }
    const symbol = symbolInput.trim();
    if (!symbol) {
      showAlert('Missing symbol', 'Type a symbol (e.g. XAUUSDb).');
      return;
    }
    if (rows.length === 0) {
      showAlert('No zones', 'Add at least one High/Low zone.');
      return;
    }
    setSaving(true);
    try {
      const node: ZoneNode = {
        symbol,
        zones: buildZonesString(rows),
        active,
        expiresAt: expireEod ? endOfTodayEpoch() : 0,
      };
      const nodeRef = ref(database, `zones/${selectedAccount}/${symbolKeyFor(symbol)}`);
      await set(nodeRef, node);
      set(ref(database, `zoneSync/${selectedAccount}`), Math.floor(Date.now() / 1000)).catch(() => {}); // TradingView follows
      Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success).catch(() => {});
      showAlert('Saved', `Zones for ${symbol} saved.`);
    } catch {
      showAlert('Error', 'Failed to save zones.');
    } finally {
      setSaving(false);
    }
  };

  const deleteSymbol = () => {
    if (!selectedAccount) return;
    const symbol = symbolInput.trim();
    if (!symbol) return;
    showAlert(
      'Delete zones',
      `Remove all zones for "${symbol}"? This cannot be undone.`,
      [
        { text: 'Cancel', style: 'cancel' },
        {
          text: 'Delete',
          style: 'destructive',
          onPress: async () => {
            try {
              await remove(ref(database, `zones/${selectedAccount}/${symbolKeyFor(symbol)}`));
              set(ref(database, `zoneSync/${selectedAccount}`), Math.floor(Date.now() / 1000)).catch(() => {});
              Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success).catch(() => {});
              clearEditor();
            } catch {
              showAlert('Error', 'Failed to delete zones.');
            }
          },
        },
      ]
    );
  };

  // ---- Empty state (no account) --------------------------------------------
  if (!selectedAccount && !loading) {
    return (
      <SafeAreaView style={[styles.container, { backgroundColor: theme.colors.background }]}>
        <AccountSelector style={{ marginHorizontal: 16 }} />
        <View style={styles.emptyContainer}>
          <IconSymbol name="square.stack.3d.up" size={48} color={theme.colors.textTertiary} />
          <Text style={[styles.emptyText, { color: theme.colors.textSecondary }]}>No account selected</Text>
        </View>
      </SafeAreaView>
    );
  }

  return (
    <SafeAreaView style={[styles.container, { backgroundColor: theme.colors.background }]}>
      <KeyboardAvoidingView
        style={{ flex: 1 }}
        behavior={Platform.OS === 'ios' ? 'padding' : undefined}
      >
        <ScrollView
          contentContainerStyle={styles.listContent}
          keyboardShouldPersistTaps="handled"
        >
          <AccountSelector />

          {/* AI auto trade: Claude trades this account from its zones (routine on the trading PC) */}
          <AiTradeCard account={selectedAccount} />

          {/* Zone drafts from the automatic refresh, waiting for a decision */}
          {totalPending > 0 && (
            <View style={[styles.card, styles.reviewCard, { backgroundColor: theme.colors.card, borderColor: DRAFT_COLOR + '66' }]}>
              <Text style={[styles.reviewTitle, { color: theme.colors.text }]}>
                {totalPending} zone draft{totalPending === 1 ? '' : 's'} to review
              </Text>
              <Text style={[styles.mutedText, { color: theme.colors.textSecondary, marginBottom: 10 }]}>
                Only zones you approve go live. Tap a symbol to see its drafts on the chart.
              </Text>
              <View style={styles.chipWrap}>
                {Object.entries(pendingByKey).map(([key, p]) => {
                  const isSel = p.symbol === symbolInput.trim();
                  return (
                    <TouchableOpacity
                      key={key}
                      style={[
                        styles.symbolChip,
                        { borderColor: isSel ? DRAFT_COLOR : theme.colors.border, backgroundColor: isSel ? DRAFT_COLOR + '18' : theme.colors.input },
                      ]}
                      onPress={() => openForReview(key)}
                    >
                      <Text style={[styles.symbolChipText, { color: theme.colors.text }]}>{p.symbol}</Text>
                      <View style={[styles.countBadge, { backgroundColor: DRAFT_COLOR }]}>
                        <Text style={[styles.countText, { color: '#FFF' }]}>{p.drafts.length}</Text>
                      </View>
                    </TouchableOpacity>
                  );
                })}
              </View>
            </View>
          )}

          {/* Saved symbols — tap to edit */}
          <Text style={[styles.sectionHeader, { color: theme.colors.textSecondary }]}>Symbols with zones</Text>
          {loading ? (
            <ActivityIndicator style={{ marginVertical: 20 }} size="small" color={theme.colors.primary} />
          ) : saved.length === 0 ? (
            <View style={[styles.card, { backgroundColor: theme.colors.card }]}>
              <Text style={[styles.mutedText, { color: theme.colors.textSecondary }]}>
                No zones saved yet. Add a symbol below.
              </Text>
            </View>
          ) : (
            <View style={styles.chipWrap}>
              {saved.map((s) => {
                const isSel = s.node.symbol === symbolInput.trim();
                const count = parseZones(s.node.zones).length;
                const zoneAlert = alertByKey[s.key]; // price near / inside one of its zones
                return (
                  <TouchableOpacity
                    key={s.key}
                    style={[
                      styles.symbolChip,
                      { borderColor: theme.colors.border, backgroundColor: theme.colors.card },
                      isSel && { borderColor: theme.colors.primary, backgroundColor: theme.colors.primary + '18' },
                      !s.node.active && { opacity: 0.55 },
                    ]}
                    onPress={() => loadSymbol(s)}
                  >
                    <Text style={[styles.symbolChipText, { color: isSel ? theme.colors.primary : theme.colors.text }]}>
                      {s.node.symbol}
                    </Text>
                    <View style={[styles.countBadge, { backgroundColor: theme.colors.input }]}>
                      <Text style={[styles.countText, { color: theme.colors.textSecondary }]}>{count}</Text>
                    </View>
                    {!!pendingByKey[s.key] && (
                      <View style={[styles.countBadge, { backgroundColor: DRAFT_COLOR }]}>
                        <Text style={[styles.countText, { color: '#FFF' }]}>+{pendingByKey[s.key].drafts.length}</Text>
                      </View>
                    )}
                    {zoneAlert && (
                      <View
                        style={[
                          styles.alertDot,
                          { backgroundColor: zoneStateColor(zoneAlert, theme), borderColor: theme.colors.background },
                        ]}
                      />
                    )}
                  </TouchableOpacity>
                );
              })}
            </View>
          )}

          {/* Live chart + zone status for the symbol in the editor */}
          {showLive && (
            <>
              <Text style={[styles.sectionHeader, { color: theme.colors.textSecondary }]}>Live status</Text>
              <ZoneStatusPanel symbol={editorSymbol} status={liveStatus} drafts={chartDrafts} />
            </>
          )}

          {/* Drafts for this symbol: approve / reject */}
          <ZoneDraftsCard
            drafts={editorDrafts}
            price={liveStatus?.price ?? null}
            digits={editorDigits}
            selectedId={selectedDraftId}
            busy={deciding}
            onSelect={(id) => setSelectedDraftId((cur) => (cur === id ? null : id))}
            onDecide={(items, decision) =>
              decideDrafts(editorKey, pendingByKey[editorKey]?.symbol ?? editorSymbol, items, decision)
            }
          />

          {/* Editor */}
          <View style={styles.editorHeaderRow}>
            <Text style={[styles.sectionHeader, { color: theme.colors.textSecondary }]}>
              {saved.some((s) => s.node.symbol === symbolInput.trim()) ? 'Edit zones' : 'New zones'}
            </Text>
            <TouchableOpacity onPress={clearEditor}>
              <Text style={[styles.linkText, { color: theme.colors.primary }]}>Clear / New</Text>
            </TouchableOpacity>
          </View>

          <View style={[styles.card, { backgroundColor: theme.colors.card }]}>
            {/* Symbol input with broker-symbol autocomplete */}
            <Text style={[styles.fieldLabel, { color: theme.colors.textSecondary }]}>Symbol</Text>
            <View style={styles.symbolFieldWrap}>
              <TextInput
                style={[styles.textInput, { backgroundColor: theme.colors.input, color: theme.colors.text }]}
                placeholder="e.g. Volatility 10 Index, XAUUSDb"
                placeholderTextColor={theme.colors.textTertiary}
                value={symbolInput}
                onChangeText={setSymbolInput}
                onFocus={() => setSymbolFocused(true)}
                // Delay so a tap on a suggestion registers before the list hides.
                onBlur={() => setTimeout(() => setSymbolFocused(false), 150)}
                autoCapitalize="none"
                autoCorrect={false}
              />
              {showSuggestions && (
                <View style={[styles.suggestBox, { backgroundColor: theme.colors.card, borderColor: theme.colors.border }]}>
                  {symbolMatches.map((sym, i) => (
                    <TouchableOpacity
                      key={sym}
                      style={[
                        styles.suggestRow,
                        { borderBottomColor: theme.colors.border },
                        i === symbolMatches.length - 1 && { borderBottomWidth: 0 },
                      ]}
                      onPress={() => selectSymbol(sym)}
                    >
                      <IconSymbol name="magnifyingglass" size={14} color={theme.colors.textTertiary} />
                      <Text style={[styles.suggestText, { color: theme.colors.text }]} numberOfLines={1}>
                        {sym}
                      </Text>
                    </TouchableOpacity>
                  ))}
                </View>
              )}
            </View>

            {/* Current zones */}
            <Text style={[styles.fieldLabel, { color: theme.colors.textSecondary, marginTop: 16 }]}>
              Zones (High / Low)
            </Text>
            {rows.length === 0 ? (
              <Text style={[styles.mutedText, { color: theme.colors.textTertiary, marginTop: 4 }]}>
                No zones added yet.
              </Text>
            ) : (
              rows.map((row, index) => {
                const age = zoneAge(row);
                return (
                <View key={index} style={[styles.zoneRow, { borderColor: theme.colors.border }]}>
                  <View style={styles.zoneMain}>
                    <View style={styles.zoneCols}>
                      <View style={styles.zoneCol}>
                        <Text style={[styles.zoneColLabel, { color: theme.colors.textTertiary }]}>HIGH</Text>
                        <Text style={[styles.zoneColValue, { color: theme.colors.profit }]}>{row.high}</Text>
                      </View>
                      <View style={styles.zoneCol}>
                        <Text style={[styles.zoneColLabel, { color: theme.colors.textTertiary }]}>LOW</Text>
                        <Text style={[styles.zoneColValue, { color: theme.colors.loss }]}>{row.low}</Text>
                      </View>
                    </View>
                    {!!age && <Text style={[styles.zoneAge, { color: theme.colors.textTertiary }]}>{age}</Text>}
                  </View>
                  <TouchableOpacity
                    style={[styles.zoneDelete, { backgroundColor: theme.colors.input }]}
                    onPress={() => deleteRow(index)}
                    hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
                  >
                    <IconSymbol name="xmark" size={16} color={theme.colors.error} />
                  </TouchableOpacity>
                </View>
                );
              })
            )}

            {/* Add-zone row */}
            <View style={styles.addRow}>
              <TextInput
                style={[styles.addInput, { backgroundColor: theme.colors.input, color: theme.colors.text }]}
                placeholder="High"
                placeholderTextColor={theme.colors.textTertiary}
                value={highDraft}
                onChangeText={(t) => setHighDraft(cleanNum(t))}
                keyboardType="numeric"
              />
              <TextInput
                style={[styles.addInput, { backgroundColor: theme.colors.input, color: theme.colors.text }]}
                placeholder="Low"
                placeholderTextColor={theme.colors.textTertiary}
                value={lowDraft}
                onChangeText={(t) => setLowDraft(cleanNum(t))}
                keyboardType="numeric"
              />
              <TouchableOpacity
                style={[styles.addBtn, { backgroundColor: theme.colors.primary }]}
                onPress={addZone}
              >
                <IconSymbol name="checkmark" size={16} color="#FFF" />
                <Text style={styles.addBtnText}>Add</Text>
              </TouchableOpacity>
            </View>

            {/* Toggles */}
            <View style={[styles.toggleRow, { borderColor: theme.colors.border }]}>
              <View style={styles.toggleTextCol}>
                <Text style={[styles.toggleTitle, { color: theme.colors.text }]}>Active</Text>
                <Text style={[styles.toggleSub, { color: theme.colors.textSecondary }]}>
                  EA watches these zones while on
                </Text>
              </View>
              <Switch
                value={active}
                onValueChange={setActive}
                trackColor={{ false: theme.colors.border, true: theme.colors.primary }}
                thumbColor="#FFF"
              />
            </View>

            <View style={[styles.toggleRow, { borderColor: theme.colors.border }]}>
              <View style={styles.toggleTextCol}>
                <Text style={[styles.toggleTitle, { color: theme.colors.text }]}>Expire end of day</Text>
                <Text style={[styles.toggleSub, { color: theme.colors.textSecondary }]}>
                  {expireEod ? 'Expires at local midnight tonight' : 'Never expires'}
                </Text>
              </View>
              <Switch
                value={expireEod}
                onValueChange={setExpireEod}
                trackColor={{ false: theme.colors.border, true: theme.colors.primary }}
                thumbColor="#FFF"
              />
            </View>

            {/* Actions */}
            <View style={styles.actionRow}>
              <TouchableOpacity
                style={[styles.deleteBtn, { borderColor: theme.colors.border }]}
                onPress={deleteSymbol}
                disabled={saving}
              >
                <IconSymbol name="trash" size={16} color={theme.colors.error} />
                <Text style={[styles.deleteBtnText, { color: theme.colors.error }]}>Delete</Text>
              </TouchableOpacity>
              <TouchableOpacity
                style={[styles.saveBtn, { backgroundColor: theme.colors.primary }]}
                onPress={saveSymbol}
                disabled={saving}
              >
                {saving ? (
                  <ActivityIndicator size="small" color="#FFF" />
                ) : (
                  <>
                    <IconSymbol name="checkmark" size={16} color="#FFF" />
                    <Text style={styles.saveBtnText}>Save Zones</Text>
                  </>
                )}
              </TouchableOpacity>
            </View>
          </View>

          {/* Zone clean-up: the watcher on the PC applies these to every account */}
          <Text style={[styles.sectionHeader, { color: theme.colors.textSecondary }]}>Zone clean-up</Text>
          <View style={[styles.card, { backgroundColor: theme.colors.card }]}>
            <View style={[styles.toggleRow, { borderColor: theme.colors.border, borderTopWidth: 0, marginTop: 0, paddingTop: 2 }]}>
              <View style={styles.toggleTextCol}>
                <Text style={[styles.toggleTitle, { color: theme.colors.text }]}>Auto-approve zones</Text>
                <Text style={[styles.toggleSub, { color: theme.colors.textSecondary }]}>
                  {!zonePrefs.autoApprove
                    ? 'Switched off for every account'
                    : autoApproveOn
                      ? `This account: when a symbol has fewer than ${zonePrefs.maxPerSymbol} live zones, its waiting drafts go live automatically`
                      : 'This account: drafts wait for your review'}
                </Text>
              </View>
              <Switch
                value={autoApproveOn}
                onValueChange={saveAutoApprove}
                disabled={!zonePrefs.autoApprove || !selectedAccount}
                trackColor={{ false: theme.colors.border, true: theme.colors.primary }}
                thumbColor="#FFF"
                accessibilityLabel="Auto-approve zones for this account"
              />
            </View>

            <Text style={[styles.fieldLabel, { color: theme.colors.textSecondary, marginTop: 10 }]}>Max zones per symbol</Text>
            <View style={[styles.choiceRow, { backgroundColor: theme.colors.input }]}>
              {ZONE_LIMIT_OPTIONS.map((n) => {
                const on = zonePrefs.maxPerSymbol === n;
                return (
                  <TouchableOpacity
                    key={n}
                    style={[styles.choiceBtn, on && { backgroundColor: theme.colors.primary }]}
                    onPress={() => saveZonePref('maxPerSymbol', n)}
                    accessibilityRole="button"
                    accessibilityState={{ selected: on }}
                    accessibilityLabel={`Max zones per symbol ${n}`}
                  >
                    <Text style={[styles.choiceText, { color: on ? '#FFF' : theme.colors.textSecondary }]}>{n}</Text>
                  </TouchableOpacity>
                );
              })}
            </View>

            <Text style={[styles.fieldLabel, { color: theme.colors.textSecondary, marginTop: 14 }]}>Zones expire after</Text>
            <View style={[styles.choiceRow, { backgroundColor: theme.colors.input }]}>
              {ZONE_HOURS_OPTIONS.map((o) => {
                const on = zonePrefs.validityHours === o.hours;
                return (
                  <TouchableOpacity
                    key={o.label}
                    style={[styles.choiceBtn, on && { backgroundColor: theme.colors.primary }]}
                    onPress={() => saveZonePref('validityHours', o.hours)}
                    accessibilityRole="button"
                    accessibilityState={{ selected: on }}
                    accessibilityLabel={`Zones expire after ${o.label}`}
                  >
                    <Text style={[styles.choiceText, { color: on ? '#FFF' : theme.colors.textSecondary }]}>{o.label}</Text>
                  </TouchableOpacity>
                );
              })}
              {(() => {
                const isCustom = !ZONE_HOURS_OPTIONS.some((o) => o.hours === zonePrefs.validityHours);
                return (
                  <TouchableOpacity
                    style={[styles.choiceBtn, styles.choiceBtnWide, isCustom && { backgroundColor: theme.colors.primary }]}
                    onPress={() => setCustomHours(isCustom ? String(zonePrefs.validityHours) : '')}
                    accessibilityRole="button"
                    accessibilityState={{ selected: isCustom }}
                    accessibilityLabel="Zones expire after: custom hours"
                  >
                    <Text style={[styles.choiceText, { color: isCustom ? '#FFF' : theme.colors.textSecondary }]}>
                      {isCustom ? `${zonePrefs.validityHours} h` : 'Custom'}
                    </Text>
                  </TouchableOpacity>
                );
              })()}
            </View>

            {/* Custom hours: a small dialog near the top, clear of the keyboard (edge-to-edge
                Android doesn't move the screen up for it) */}
            <Modal transparent animationType="fade" visible={customHours !== null} onRequestClose={() => setCustomHours(null)}>
              <Pressable
                style={[StyleSheet.absoluteFill, { backgroundColor: theme.colors.overlay }]}
                onPress={() => setCustomHours(null)}
                accessibilityLabel="Cancel"
              />
              <View style={styles.dialogWrap} pointerEvents="box-none">
                <View style={[styles.dialog, { backgroundColor: theme.colors.card, borderColor: theme.colors.border }]}>
                  <Text style={[styles.dialogTitle, { color: theme.colors.text }]}>Zones expire after</Text>
                  <Text style={[styles.dialogSub, { color: theme.colors.textSecondary }]}>
                    Hours after a zone goes live, up to {MAX_CUSTOM_HOURS} (90 days).
                  </Text>
                  <View style={styles.dialogInputRow}>
                    <TextInput
                      value={customHours ?? ''}
                      onChangeText={(t) => setCustomHours(t.replace(/[^0-9.,]/g, ''))}
                      keyboardType="decimal-pad"
                      returnKeyType="done"
                      onSubmitEditing={saveCustomHours}
                      autoFocus
                      placeholder="e.g. 5"
                      placeholderTextColor={theme.colors.textTertiary}
                      style={[styles.dialogInput, { backgroundColor: theme.colors.input, color: theme.colors.text }]}
                      accessibilityLabel="Zone validity in hours"
                    />
                    <Text style={[styles.dialogUnit, { color: theme.colors.textSecondary }]}>h</Text>
                  </View>
                  <View style={styles.dialogBtns}>
                    <TouchableOpacity
                      style={[styles.dialogBtn, { backgroundColor: theme.colors.input }]}
                      onPress={() => setCustomHours(null)}
                      accessibilityRole="button"
                    >
                      <Text style={[styles.dialogBtnText, { color: theme.colors.text }]}>Cancel</Text>
                    </TouchableOpacity>
                    <TouchableOpacity
                      style={[styles.dialogBtn, { backgroundColor: theme.colors.primary }]}
                      onPress={saveCustomHours}
                      accessibilityRole="button"
                      accessibilityLabel="Save zone validity"
                    >
                      <Text style={[styles.dialogBtnText, { color: '#FFF' }]}>Save</Text>
                    </TouchableOpacity>
                  </View>
                </View>
              </View>
            </Modal>

            <Text style={[styles.mutedText, styles.cleanupNote, { color: theme.colors.textTertiary }]}>
              When approving a zone takes a symbol over {zonePrefs.maxPerSymbol}, the zone farthest from the current price
              is removed (never the one you just approved).{' '}
              {zonePrefs.validityHours > 0
                ? `Zones also leave ${validityText(zonePrefs.validityHours)} after they went live.`
                : 'Zones never expire by time.'}{' '}
              Applies to every account; your PC checks every 5 minutes and updates the EA and TradingView.
            </Text>
          </View>
        </ScrollView>
      </KeyboardAvoidingView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  reviewCard: {
    borderWidth: 1,
  },
  reviewTitle: {
    fontSize: 16,
    fontWeight: '800',
    marginBottom: 2,
  },
  container: {
    flex: 1,
  },
  listContent: {
    padding: 16,
  },
  sectionHeader: {
    fontSize: 13,
    fontWeight: '800',
    textTransform: 'uppercase',
    letterSpacing: 0.5,
    marginTop: 8,
    marginBottom: 8,
  },
  editorHeaderRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    marginTop: 4,
  },
  linkText: {
    fontSize: 13,
    fontWeight: '700',
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
  mutedText: {
    fontSize: 14,
  },
  chipWrap: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 8,
    marginBottom: 8,
  },
  symbolChip: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    paddingHorizontal: 12,
    paddingVertical: 8,
    borderRadius: 20,
    borderWidth: 1,
  },
  symbolChipText: {
    fontSize: 14,
    fontWeight: '600',
  },
  countBadge: {
    minWidth: 20,
    height: 20,
    borderRadius: 10,
    paddingHorizontal: 6,
    justifyContent: 'center',
    alignItems: 'center',
  },
  countText: {
    fontSize: 11,
    fontWeight: '700',
  },
  // Corner dot on a chip: amber = price near a zone, red = inside one. The
  // background-coloured ring cuts it out of the chip's border.
  alertDot: {
    position: 'absolute',
    top: -4,
    right: -4,
    width: 12,
    height: 12,
    borderRadius: 6,
    borderWidth: 2,
  },
  fieldLabel: {
    fontSize: 12,
    fontWeight: '700',
    marginBottom: 6,
  },
  textInput: {
    padding: 12,
    borderRadius: 12,
    fontSize: 16,
  },
  symbolFieldWrap: {
    position: 'relative',
  },
  suggestBox: {
    marginTop: 6,
    borderRadius: 12,
    borderWidth: 1,
    overflow: 'hidden',
  },
  suggestRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
    paddingHorizontal: 12,
    paddingVertical: 12,
    borderBottomWidth: 1,
  },
  suggestText: {
    flex: 1,
    fontSize: 15,
    fontWeight: '600',
  },
  zoneRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
    paddingVertical: 10,
    borderBottomWidth: 1,
  },
  zoneCol: {
    flex: 1,
  },
  zoneMain: {
    flex: 1,
  },
  zoneCols: {
    flexDirection: 'row',
    gap: 12,
  },
  zoneAge: {
    fontSize: 11,
    marginTop: 4,
  },
  choiceRow: {
    flexDirection: 'row',
    borderRadius: 10,
    padding: 3,
  },
  choiceBtn: {
    flex: 1,
    borderRadius: 8,
    paddingVertical: 8,
    alignItems: 'center',
  },
  choiceBtnWide: {
    flex: 1.4,
  },
  choiceText: {
    fontSize: 13,
    fontWeight: '700',
  },
  cleanupNote: {
    fontSize: 12,
    lineHeight: 17,
    marginTop: 12,
  },
  dialogWrap: {
    position: 'absolute',
    top: '14%',
    left: 0,
    right: 0,
    alignItems: 'center',
    paddingHorizontal: 24,
  },
  dialog: {
    width: '100%',
    maxWidth: 420,
    borderRadius: 18,
    borderWidth: StyleSheet.hairlineWidth,
    padding: 18,
  },
  dialogTitle: {
    fontSize: 17,
    fontWeight: '800',
  },
  dialogSub: {
    fontSize: 13,
    lineHeight: 18,
    marginTop: 4,
  },
  dialogInputRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    marginTop: 14,
  },
  dialogInput: {
    flex: 1,
    borderRadius: 10,
    paddingHorizontal: 12,
    paddingVertical: 10,
    fontSize: 18,
    fontWeight: '700',
  },
  dialogUnit: {
    fontSize: 18,
    fontWeight: '700',
  },
  dialogBtns: {
    flexDirection: 'row',
    gap: 10,
    marginTop: 16,
  },
  dialogBtn: {
    flex: 1,
    borderRadius: 12,
    paddingVertical: 12,
    alignItems: 'center',
  },
  dialogBtnText: {
    fontSize: 15,
    fontWeight: '700',
  },
  zoneColLabel: {
    fontSize: 10,
    fontWeight: '700',
    marginBottom: 2,
  },
  zoneColValue: {
    fontSize: 15,
    fontWeight: '700',
    fontFamily: 'monospace',
  },
  zoneDelete: {
    width: 32,
    height: 32,
    borderRadius: 8,
    justifyContent: 'center',
    alignItems: 'center',
  },
  addRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    marginTop: 12,
  },
  addInput: {
    flex: 1,
    padding: 12,
    borderRadius: 12,
    fontSize: 15,
  },
  addBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    paddingHorizontal: 16,
    paddingVertical: 12,
    borderRadius: 12,
  },
  addBtnText: {
    color: '#FFF',
    fontSize: 14,
    fontWeight: '700',
  },
  toggleRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingVertical: 14,
    borderTopWidth: 1,
    marginTop: 8,
  },
  toggleTextCol: {
    flex: 1,
    paddingRight: 12,
  },
  toggleTitle: {
    fontSize: 15,
    fontWeight: '600',
  },
  toggleSub: {
    fontSize: 12,
    marginTop: 2,
  },
  actionRow: {
    flexDirection: 'row',
    gap: 12,
    marginTop: 16,
  },
  deleteBtn: {
    flex: 1,
    flexDirection: 'row',
    gap: 8,
    paddingVertical: 14,
    borderRadius: 12,
    borderWidth: 1,
    alignItems: 'center',
    justifyContent: 'center',
  },
  deleteBtnText: {
    fontSize: 16,
    fontWeight: '600',
  },
  saveBtn: {
    flex: 2,
    flexDirection: 'row',
    gap: 8,
    paddingVertical: 14,
    borderRadius: 12,
    alignItems: 'center',
    justifyContent: 'center',
  },
  saveBtnText: {
    color: '#FFF',
    fontSize: 16,
    fontWeight: '700',
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
