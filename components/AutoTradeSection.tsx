import React, { useState } from 'react';
import { Modal, Pressable, StyleSheet, Switch, Text, TextInput, TouchableOpacity, View } from 'react-native';
import * as Haptics from 'expo-haptics';

import { useTheme, type Theme } from '@/contexts/ThemeContext';
import { IconSymbol } from '@/components/ui/icon-symbol';
import { showAlert } from '@/components/AppDialog';
import { terminalLabel } from '@/components/TerminalStatus';
import { formatMoney } from '@/utils/currency';
import { AutoTradeSymbolsSheet } from '@/components/AutoTradeSymbolsSheet';
import {
  BE_R_OPTIONS,
  CAP_OPTIONS,
  OPEN_RISK_OPTIONS,
  RISK_OPTIONS,
  saveAutoTradeLevel,
  saveAutoTradeSource,
  saveAutoTradeSymbols,
  useAutoTradeLog,
  useAutoTradeSettings,
  type AutoTradeLevel,
  type AutoTradeLogEntry,
} from '@/hooks/useAutoTrade';

/** Same key rule as prefs/signals and the EAs: each of space . $ # [ ] / becomes '_'. */
const keyFor = (name: string) => name.replace(/[ .$#[\]/]/g, '_');

const pct = (v: number) => `${parseFloat(v.toFixed(2))}%`;

/** Sources that no longer publish (they still show in the Scorecard): no auto-trade switch. */
const RETIRED_SOURCES = new Set(['Zones_CHoCH']); // merged into "Zones" on 2026-10-05

const beLabel = (r: number) => (r > 0 ? `+${parseFloat(r.toFixed(2))}R` : 'Off');

function ago(at: number): string {
  const s = Math.max(0, Math.floor(Date.now() / 1000) - at);
  if (s < 60) return 'just now';
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  return `${Math.floor(s / 86400)}d ago`;
}

const MAX_PCT = 100;

/**
 * Preset % chips plus "Custom": a small dialog near the top of the screen (clear of the
 * keyboard, which the settings sheet doesn't avoid) taking any value up to 100%, saved on
 * Save / Done rather than per keystroke.
 */
export function LevelPicker({
  options,
  value,
  minEnabled,
  onPick,
  label,
  hint,
  example = 'e.g. 8',
  theme,
}: {
  options: number[];
  value: number;
  minEnabled?: number;
  onPick: (v: number) => void;
  label: string;
  /** Custom dialog subtitle (default: the per-trade wording). */
  hint?: string;
  /** Placeholder for the custom value. */
  example?: string;
  theme: Theme;
}) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState('');
  const [problem, setProblem] = useState('');
  const isPreset = options.some((o) => Math.abs(value - o) < 1e-9);
  const floor = minEnabled ?? 0;

  const open = () => {
    setDraft(isPreset ? '' : String(value));
    setProblem('');
    setEditing(true);
  };

  const commit = () => {
    const v = parseFloat(draft.replace(',', '.'));
    if (!Number.isFinite(v) || v <= 0 || v > MAX_PCT) {
      setProblem(`Enter a percentage above 0 and up to ${MAX_PCT}.`);
      return;
    }
    if (v < floor) {
      setProblem(`This can't be below your risk per trade (${pct(floor)}).`);
      return;
    }
    onPick(Math.round(v * 100) / 100);
    setEditing(false);
  };

  return (
    <>
      <View style={[styles.segment, { backgroundColor: theme.colors.input }]}>
        {options.map((o) => {
          const active = Math.abs(value - o) < 1e-9;
          const disabled = o < floor;
          return (
            <TouchableOpacity
              key={o}
              disabled={disabled}
              style={[styles.segmentBtn, active && { backgroundColor: theme.colors.primary }, disabled && { opacity: 0.35 }]}
              onPress={() => onPick(o)}
              accessibilityRole="button"
              accessibilityState={{ selected: active, disabled }}
              accessibilityLabel={`${label} ${pct(o)}`}>
              <Text style={[styles.segmentText, { color: active ? '#FFF' : theme.colors.textSecondary }]}>{pct(o)}</Text>
            </TouchableOpacity>
          );
        })}
        <TouchableOpacity
          style={[styles.segmentBtn, styles.customBtn, !isPreset && { backgroundColor: theme.colors.primary }]}
          onPress={open}
          accessibilityRole="button"
          accessibilityState={{ selected: !isPreset }}
          accessibilityLabel={`${label}: custom value`}>
          <Text style={[styles.segmentText, { color: !isPreset ? '#FFF' : theme.colors.textSecondary }]}>
            {isPreset ? 'Custom' : pct(value)}
          </Text>
        </TouchableOpacity>
      </View>

      <Modal transparent animationType="fade" visible={editing} onRequestClose={() => setEditing(false)}>
        <Pressable
          style={[StyleSheet.absoluteFill, { backgroundColor: theme.colors.overlay }]}
          onPress={() => setEditing(false)}
          accessibilityLabel="Cancel"
        />
        <View style={styles.dialogWrap} pointerEvents="box-none">
          <View style={[styles.dialog, { backgroundColor: theme.colors.card, borderColor: theme.colors.border }]}>
            <Text style={[styles.dialogTitle, { color: theme.colors.text }]}>{label}</Text>
            <Text style={[styles.dialogSub, { color: theme.colors.textSecondary }]}>
              {hint ??
                (floor > 0
                  ? `At least your risk per trade (${pct(floor)}), up to ${MAX_PCT}% of the balance.`
                  : `Any value above 0, up to ${MAX_PCT}% of the balance per trade.`)}
            </Text>
            <View style={styles.customRow}>
              <TextInput
                value={draft}
                onChangeText={(t) => {
                  setDraft(t.replace(/[^0-9.,]/g, ''));
                  setProblem('');
                }}
                keyboardType="decimal-pad"
                returnKeyType="done"
                onSubmitEditing={commit}
                autoFocus
                placeholder={floor > 0 ? `${parseFloat(floor.toFixed(2))} or more` : example}
                placeholderTextColor={theme.colors.textTertiary}
                style={[styles.customInput, { backgroundColor: theme.colors.input, color: theme.colors.text }]}
                accessibilityLabel={`${label} in percent`}
              />
              <Text style={[styles.customUnit, { color: theme.colors.textSecondary }]}>%</Text>
            </View>
            {!!problem && <Text style={[styles.dialogProblem, { color: theme.colors.error }]}>{problem}</Text>}
            <View style={styles.dialogBtns}>
              <TouchableOpacity
                style={[styles.dialogBtn, { backgroundColor: theme.colors.input }]}
                onPress={() => setEditing(false)}
                accessibilityRole="button">
                <Text style={[styles.dialogBtnText, { color: theme.colors.text }]}>Cancel</Text>
              </TouchableOpacity>
              <TouchableOpacity
                style={[styles.dialogBtn, { backgroundColor: theme.colors.primary }]}
                onPress={commit}
                accessibilityRole="button"
                accessibilityLabel={`Save ${label}`}>
                <Text style={[styles.dialogBtnText, { color: '#FFF' }]}>Save</Text>
              </TouchableOpacity>
            </View>
          </View>
        </View>
      </Modal>
    </>
  );
}

function LogRow({ e, theme }: { e: AutoTradeLogEntry; theme: Theme }) {
  const color =
    e.result === 'opened' ? theme.colors.success : e.result === 'failed' ? theme.colors.error : theme.colors.textTertiary;
  const icon = e.result === 'opened' ? 'checkmark' : e.result === 'failed' ? 'exclamationmark.triangle.fill' : 'info.circle';
  const lots = parseFloat(e.lots.toFixed(3));
  const title =
    e.result === 'opened'
      ? `${e.action} ${e.symbol} · ${lots} lot · risk ${formatMoney(e.risk, e.currency)} (${pct(e.riskPct)})`
      : `${e.result === 'failed' ? 'Failed' : 'Skipped'}: ${e.action} ${e.symbol}`;
  return (
    <View style={styles.logRow}>
      <IconSymbol name={icon} size={14} color={color} />
      <View style={styles.logText}>
        <Text style={[styles.logTitle, { color: theme.colors.text }]} numberOfLines={2}>
          {title}
        </Text>
        <Text style={[styles.logSub, { color: theme.colors.textSecondary }]} numberOfLines={3}>
          {e.source}
          {e.reason ? ` — ${e.reason}` : ''}
          {e.why ? ` — ${e.why}` : ''} · {ago(e.at)}
        </Text>
      </View>
    </View>
  );
}

/**
 * Per-account auto trading for the signal EAs (Signal settings sheet): which sources the
 * Bridge EA opens by itself, the risk per trade, the minimum-lot cap, the open-risk limit,
 * and what it did lately.
 */
export function AutoTradeSection({ account, sources }: { account: string | null; sources: string[] }) {
  const { theme } = useTheme();
  const settings = useAutoTradeSettings(account);
  const log = useAutoTradeLog(account, 10);
  const [symbolsFor, setSymbolsFor] = useState<string | null>(null);

  if (!account) {
    return (
      <Text style={[styles.note, { color: theme.colors.textTertiary }]}>Select an account to set up auto trading.</Text>
    );
  }

  const label = terminalLabel(account);
  const cap = Math.max(settings.capPct, settings.riskPct);
  const divider = { borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: theme.colors.border };
  const switchTrack = { false: theme.colors.border, true: theme.colors.primary };
  const failed = () => showAlert('Error', 'Could not save that setting. Check your connection.');

  const toggle = (source: string, on: boolean) => {
    Haptics.selectionAsync().catch(() => {});
    const save = () => saveAutoTradeSource(account, keyFor(source), on).catch(failed);
    if (!on) {
      save();
      return;
    }
    showAlert(
      `Auto trade ${source}?`,
      `The Bridge EA will open new ${source} signals on ${label} by itself: ${pct(settings.riskPct)} risk per trade, ` +
        `the minimum lot allowed up to ${pct(cap)}, nothing new while your open trades risk more than ` +
        `${pct(settings.maxOpenRiskPct)}, break-even ${settings.beR > 0 ? `at ${beLabel(settings.beR)}` : 'off'}. ` +
        `Only signals from now on, always with their stop loss.`,
      [
        { text: 'Cancel', style: 'cancel' },
        { text: 'Turn on', onPress: save },
      ],
    );
  };

  const pick = (field: AutoTradeLevel) => (v: number) => {
    Haptics.selectionAsync().catch(() => {});
    saveAutoTradeLevel(account, field, v).catch(failed);
  };

  return (
    <View style={[styles.group, { borderColor: theme.colors.border }]}>
      <Text style={[styles.intro, { color: theme.colors.textSecondary }]}>
        The Bridge EA opens new signals from the sources you switch on, on {label} only, sized by your risk.
        Always with the signal&apos;s stop loss; only signals that arrive after you switch a source on; zone signals
        follow the zone grades below. Nothing opens while Auto-Trading is off in Trade Control.
      </Text>

      {sources
        .filter((s) => !RETIRED_SOURCES.has(keyFor(s)))
        .map((s) => {
          const src = settings.sources[keyFor(s)];
          const on = src?.on === true;
          const list = src?.symbols ?? null;
          return (
            <View key={s} style={divider}>
              <View style={styles.sourceRow}>
                <Text style={[styles.sourceName, { color: theme.colors.text }]} numberOfLines={1}>
                  {s}
                </Text>
                <Switch
                  value={on}
                  onValueChange={(v) => toggle(s, v)}
                  trackColor={switchTrack}
                  thumbColor="#FFF"
                  accessibilityLabel={`Auto trade ${s}`}
                />
              </View>
              {on && (
                <TouchableOpacity
                  style={styles.symbolsRow}
                  onPress={() => setSymbolsFor(s)}
                  accessibilityRole="button"
                  accessibilityLabel={`${s} symbols: ${list ? `${list.length} chosen` : 'every symbol'}. Change`}>
                  <Text style={[styles.symbolsText, { color: theme.colors.textSecondary }]} numberOfLines={1}>
                    {list
                      ? `Only ${list.length} symbol${list.length === 1 ? '' : 's'}: ${list.map((k) => k.replace(/_/g, ' ')).join(', ')}`
                      : 'Every symbol'}
                  </Text>
                  <IconSymbol name="chevron.right" size={16} color={theme.colors.textTertiary} />
                </TouchableOpacity>
              )}
            </View>
          );
        })}

      {symbolsFor && (
        <AutoTradeSymbolsSheet
          visible
          onClose={() => setSymbolsFor(null)}
          account={account}
          source={symbolsFor}
          current={settings.sources[keyFor(symbolsFor)]?.symbols ?? null}
          onSave={(keys) => saveAutoTradeSymbols(account, keyFor(symbolsFor), keys)}
        />
      )}

      <View style={[styles.block, divider]}>
        <Text style={[styles.blockTitle, { color: theme.colors.text }]}>Risk per trade</Text>
        <LevelPicker
          options={RISK_OPTIONS}
          value={settings.riskPct}
          onPick={pick('riskPct')}
          label="Risk per trade"
          theme={theme}
        />
        <Text style={[styles.blockTitle, { color: theme.colors.text, marginTop: 14 }]}>Minimum-lot cap</Text>
        <LevelPicker
          options={CAP_OPTIONS}
          value={cap}
          minEnabled={settings.riskPct}
          onPick={pick('capPct')}
          label="Minimum-lot cap"
          theme={theme}
        />
        <Text style={[styles.note, { color: theme.colors.textTertiary }]}>
          Lots come from the signal&apos;s stop and your balance. If {pct(settings.riskPct)} buys less than the
          broker&apos;s minimum lot, the minimum lot is used only if it risks {pct(cap)} or less; otherwise the signal is
          skipped.
        </Text>
      </View>

      <View style={[styles.block, divider]}>
        <Text style={[styles.blockTitle, { color: theme.colors.text }]}>Open-risk limit</Text>
        <LevelPicker
          options={OPEN_RISK_OPTIONS}
          value={settings.maxOpenRiskPct}
          onPick={pick('maxOpenRiskPct')}
          label="Open-risk limit"
          hint={`Any value above 0, up to ${MAX_PCT}% of the balance at risk across your open trades.`}
          example="e.g. 40"
          theme={theme}
        />
        <Text style={[styles.note, { color: theme.colors.textTertiary }]}>
          No new auto trades while your open trades already risk more than {pct(settings.maxOpenRiskPct)} of the
          balance (the Total risk on the dashboard: every open trade&apos;s entry to its stop loss; trades without a stop
          loss don&apos;t count).
        </Text>
      </View>

      <View style={[styles.block, divider]}>
        <Text style={[styles.blockTitle, { color: theme.colors.text }]}>Break-even</Text>
        <View style={[styles.segment, { backgroundColor: theme.colors.input }]}>
          {BE_R_OPTIONS.map((o) => {
            const active = Math.abs(settings.beR - o) < 1e-9;
            return (
              <TouchableOpacity
                key={o}
                style={[styles.segmentBtn, active && { backgroundColor: theme.colors.primary }]}
                onPress={() => pick('beR')(o)}
                accessibilityRole="button"
                accessibilityState={{ selected: active }}
                accessibilityLabel={`Auto-trade break-even ${o > 0 ? `at plus ${o} R` : 'off'}`}>
                <Text style={[styles.segmentText, { color: active ? '#FFF' : theme.colors.textSecondary }]}>{beLabel(o)}</Text>
              </TouchableOpacity>
            );
          })}
        </View>
        <Text style={[styles.note, { color: theme.colors.textTertiary }]}>
          {settings.beR > 0
            ? `Moves an auto trade's stop to its entry once price is ${beLabel(settings.beR)} in profit (R = entry to stop). `
            : 'Auto trades keep their stop loss until TP or SL. '}
          Auto trades ignore the Trade Control break-even (a % of price, which on these stops fired almost at entry).
          Applies to trades opened after a change.
        </Text>
      </View>

      <View style={[styles.block, divider]}>
        <Text style={[styles.blockTitle, { color: theme.colors.text }]}>Recent</Text>
        {log.length === 0 ? (
          <Text style={[styles.note, { color: theme.colors.textTertiary }]}>No auto trades yet.</Text>
        ) : (
          log.slice(0, 5).map((e) => <LogRow key={e.id} e={e} theme={theme} />)
        )}
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  group: {
    borderWidth: StyleSheet.hairlineWidth,
    borderRadius: 14,
    overflow: 'hidden',
  },
  intro: {
    fontSize: 12,
    lineHeight: 16,
    padding: 12,
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
  symbolsRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    paddingHorizontal: 12,
    paddingBottom: 10,
    marginTop: -2,
  },
  symbolsText: {
    flex: 1,
    fontSize: 12,
    fontWeight: '600',
  },
  block: {
    padding: 12,
  },
  blockTitle: {
    fontSize: 15,
    fontWeight: '600',
  },
  segment: {
    flexDirection: 'row',
    borderRadius: 10,
    padding: 3,
    marginTop: 8,
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
  customBtn: {
    flex: 1.4,
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
  customRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    marginTop: 14,
  },
  customInput: {
    flex: 1,
    borderRadius: 10,
    paddingHorizontal: 12,
    paddingVertical: 10,
    fontSize: 18,
    fontWeight: '700',
  },
  customUnit: {
    fontSize: 18,
    fontWeight: '700',
  },
  dialogProblem: {
    fontSize: 13,
    marginTop: 8,
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
  note: {
    fontSize: 12,
    lineHeight: 16,
    marginTop: 8,
  },
  logRow: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    gap: 8,
    marginTop: 10,
  },
  logText: {
    flex: 1,
  },
  logTitle: {
    fontSize: 13,
    fontWeight: '600',
  },
  logSub: {
    fontSize: 12,
    lineHeight: 16,
    marginTop: 2,
  },
});
