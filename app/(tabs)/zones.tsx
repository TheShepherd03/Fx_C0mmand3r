import React, { useState, useEffect, useMemo, useRef } from 'react';
import { StyleSheet, View, Text, FlatList, TouchableOpacity, Alert, ActivityIndicator, TextInput, Switch, ScrollView, KeyboardAvoidingView, Platform, Keyboard } from 'react-native';
import * as Haptics from 'expo-haptics';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useLocalSearchParams } from 'expo-router';
import { database, authReady } from '@/firebaseConfig';
import { ref, onValue, set, remove } from 'firebase/database';
import { AccountSelector } from '@/components/AccountSelector';
import { useAccount } from '@/contexts/AccountContext';
import { useTheme } from '@/contexts/ThemeContext';
import { IconSymbol } from '@/components/ui/icon-symbol';
import { parseZoneStatus, zoneAlertLevel } from '@/components/ZoneChart';
import { ZoneStatusPanel, zoneStateColor } from '@/components/ZoneStatusPanel';

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
      Alert.alert('Invalid zone', 'Enter numeric High and Low values.');
      return;
    }
    if (high === low) {
      Alert.alert('Invalid zone', 'High and Low cannot be equal.');
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
      Alert.alert('No account', 'Select an account first.');
      return;
    }
    const symbol = symbolInput.trim();
    if (!symbol) {
      Alert.alert('Missing symbol', 'Type a symbol (e.g. XAUUSDb).');
      return;
    }
    if (rows.length === 0) {
      Alert.alert('No zones', 'Add at least one High/Low zone.');
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
      Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success).catch(() => {});
      Alert.alert('Saved', `Zones for ${symbol} saved.`);
    } catch {
      Alert.alert('Error', 'Failed to save zones.');
    } finally {
      setSaving(false);
    }
  };

  const deleteSymbol = () => {
    if (!selectedAccount) return;
    const symbol = symbolInput.trim();
    if (!symbol) return;
    Alert.alert(
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
              Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success).catch(() => {});
              clearEditor();
            } catch {
              Alert.alert('Error', 'Failed to delete zones.');
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
        <AccountSelector />
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
              <ZoneStatusPanel symbol={editorSymbol} status={liveStatus} />
            </>
          )}

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
              rows.map((row, index) => (
                <View key={index} style={[styles.zoneRow, { borderColor: theme.colors.border }]}>
                  <View style={styles.zoneCol}>
                    <Text style={[styles.zoneColLabel, { color: theme.colors.textTertiary }]}>HIGH</Text>
                    <Text style={[styles.zoneColValue, { color: theme.colors.profit }]}>{row.high}</Text>
                  </View>
                  <View style={styles.zoneCol}>
                    <Text style={[styles.zoneColLabel, { color: theme.colors.textTertiary }]}>LOW</Text>
                    <Text style={[styles.zoneColValue, { color: theme.colors.loss }]}>{row.low}</Text>
                  </View>
                  <TouchableOpacity
                    style={[styles.zoneDelete, { backgroundColor: theme.colors.input }]}
                    onPress={() => deleteRow(index)}
                    hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
                  >
                    <IconSymbol name="xmark" size={16} color={theme.colors.error} />
                  </TouchableOpacity>
                </View>
              ))
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
        </ScrollView>
      </KeyboardAvoidingView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
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
