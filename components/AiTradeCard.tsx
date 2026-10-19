import React, { useEffect, useState } from 'react';
import { StyleSheet, Switch, Text, TouchableOpacity, View } from 'react-native';
import * as Haptics from 'expo-haptics';

import { useTheme, type Theme } from '@/contexts/ThemeContext';
import { IconSymbol } from '@/components/ui/icon-symbol';
import { showAlert } from '@/components/AppDialog';
import { terminalLabel } from '@/components/TerminalStatus';
import { LevelPicker } from '@/components/AutoTradeSection';
import {
  AI_INTERVAL_OPTIONS,
  AI_LOSS_OPTIONS,
  AI_RISK_OPTIONS,
  saveAi,
  saveAiInterval,
  useAiInterval,
  useAiLog,
  useAiSettings,
  useAiStatus,
  type AiLogEntry,
  type AiMode,
} from '@/hooks/useAiTrade';

const pct = (v: number) => `${parseFloat(v.toFixed(2))}%`;
const n = (v: number) => `${parseFloat(v.toFixed(5))}`;

function ago(at: number, now: number): string {
  const s = Math.max(0, now - at);
  if (s < 60) return 'just now';
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  return `${Math.floor(s / 86400)}d ago`;
}

/** "BUY LIMIT XAUUSDb @ 4101.5 · SL 4092 · TP 4125", "Stop → 4101 · #555", ... */
export function aiActionTitle(e: AiLogEntry): string {
  if (e.op === 'open') {
    const kind = e.type && e.type !== 'market' ? ` ${e.type.toUpperCase()}` : '';
    return (
      `${e.side}${kind} ${e.symbol}` +
      (e.entry > 0 ? ` @ ${n(e.entry)}` : '') +
      (e.sl > 0 ? ` · SL ${n(e.sl)}` : '') +
      (e.tp > 0 ? ` · TP ${n(e.tp)}` : '')
    );
  }
  if (e.op === 'modify') return `Stop → ${n(e.sl)}${e.tp > 0 ? ` · TP ${n(e.tp)}` : ''} · #${e.ticket}`;
  if (e.op === 'close')
    return `Close ${e.fraction > 0 && e.fraction < 1 ? `${Math.round(e.fraction * 100)}% of ` : ''}#${e.ticket}${e.symbol ? ` ${e.symbol}` : ''}`;
  return `Cancel order #${e.ticket}${e.symbol ? ` ${e.symbol}` : ''}`;
}

function ActionRow({ e, now, theme }: { e: AiLogEntry; now: number; theme: Theme }) {
  const [open, setOpen] = useState(false);
  const look =
    e.result === 'done'
      ? { icon: 'checkmark' as const, color: theme.colors.profit }
      : e.result === 'failed'
        ? { icon: 'exclamationmark.triangle.fill' as const, color: theme.colors.error }
        : e.result === 'refused'
          ? { icon: 'info.circle' as const, color: theme.colors.warning }
          : { icon: 'clock' as const, color: theme.colors.textTertiary };
  return (
    <TouchableOpacity
      style={[styles.row, { borderTopColor: theme.colors.border }]}
      onPress={() => setOpen((o) => !o)}
      activeOpacity={0.7}
      accessibilityRole="button"
      accessibilityLabel={`${aiActionTitle(e)}. ${e.result || 'sent'}. Reason: ${e.reason}`}>
      <IconSymbol name={look.icon} size={15} color={look.color} />
      <View style={styles.rowText}>
        <Text style={[styles.rowTitle, { color: theme.colors.text }]} numberOfLines={2}>
          {aiActionTitle(e)}
        </Text>
        <Text style={[styles.rowWhy, { color: theme.colors.textSecondary }]} numberOfLines={open ? undefined : 2}>
          {e.reason}
        </Text>
        <Text style={[styles.rowMeta, { color: look.color }]} numberOfLines={open ? undefined : 1}>
          {(e.result ? e.result.toUpperCase() : 'SENT') + (e.message ? ` · ${e.message}` : '')}
          <Text style={{ color: theme.colors.textTertiary }}>{` · ${ago(e.at, now)}`}</Text>
        </Text>
      </View>
    </TouchableOpacity>
  );
}

/**
 * AI auto trade for the selected account (Zones screen): on/off, how it may trade, its risk,
 * daily loss stop and run interval, the last run's summary and its recent actions - each with
 * the AI's own reason and what the Bridge did with it.
 */
export function AiTradeCard({ account }: { account: string | null }) {
  const { theme } = useTheme();
  const ai = useAiSettings(account);
  const interval = useAiInterval();
  const status = useAiStatus(account);
  const log = useAiLog(account, 20);
  const [showSettings, setShowSettings] = useState(false);
  const [showAll, setShowAll] = useState(false);
  const [now, setNow] = useState(() => Math.floor(Date.now() / 1000));
  useEffect(() => {
    const id = setInterval(() => setNow(Math.floor(Date.now() / 1000)), 30000);
    return () => clearInterval(id);
  }, []);

  if (!account) return null;
  const label = terminalLabel(account);
  const failed = () => showAlert('Error', 'Could not save that setting. Check your connection.');
  const save = (fields: Parameters<typeof saveAi>[1]) => {
    Haptics.selectionAsync().catch(() => {});
    saveAi(account, fields).catch(failed);
  };

  const toggle = (on: boolean) => {
    if (!on) {
      save({ on: false });
      return;
    }
    showAlert(
      'Start AI auto trade?',
      `Claude will trade ${label} LIVE from your zones${ai.mode === 'zones+between' ? ' and between them' : ''}, ` +
        `checking every ${interval} min: ${pct(ai.riskPct)} risk per trade, daily loss stop ${pct(ai.dailyLossPct)}. ` +
        'Every trade has a stop loss and a written reason; stops are never widened and it never adds to a losing trade. ' +
        'Switching it off stops new trades and management - open AI trades keep their stop and target.',
      [
        { text: 'Cancel', style: 'cancel' },
        { text: 'Start', onPress: () => save({ on: true, since: Math.floor(Date.now() / 1000) }) },
      ],
    );
  };

  // The routine wakes every 5 min; three missed intervals means the trading PC isn't running it.
  const last = status?.lastRunAt ?? 0;
  const stale = ai.on && now - Math.max(last, ai.since) > Math.max(3 * interval, 15) * 60;
  const dot = !ai.on ? theme.colors.textTertiary : stale ? theme.colors.warning : theme.colors.profit;
  const statusText = !ai.on
    ? 'Off'
    : stale
      ? `No AI run ${last ? `since ${ago(last, now)}` : 'yet'} - is the Claude app open on the trading PC?`
      : last >= ai.since && last
        ? `Running · last decision ${ago(last, now)} · every ${interval} min`
        : `Starting · the first run comes within ${interval} min`;
  const shown = showAll ? log : log.slice(0, 5);
  const divider = { borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: theme.colors.border };

  return (
    <View
      style={[
        styles.card,
        { backgroundColor: theme.colors.card },
        theme.isDark && { borderWidth: StyleSheet.hairlineWidth, borderColor: theme.colors.border },
      ]}>
      <View style={styles.head}>
        <View style={[styles.badge, { backgroundColor: theme.colors.primary + '1F' }]}>
          <IconSymbol name="cpu" size={18} color={theme.colors.primary} />
        </View>
        <View style={styles.headText}>
          <Text style={[styles.title, { color: theme.colors.text }]}>AI auto trade</Text>
          <View style={styles.statusLine}>
            <View style={[styles.dot, { backgroundColor: dot }]} />
            <Text style={[styles.status, { color: stale ? theme.colors.warning : theme.colors.textSecondary }]} numberOfLines={2}>
              {statusText}
            </Text>
          </View>
        </View>
        <Switch
          value={ai.on}
          onValueChange={toggle}
          trackColor={{ false: theme.colors.border, true: theme.colors.primary }}
          thumbColor="#FFF"
          accessibilityLabel={`AI auto trade on ${label}`}
        />
      </View>

      {!!status?.summary && ai.on && (
        <Text style={[styles.summary, { color: theme.colors.text }]}>“{status.summary}”</Text>
      )}

      <TouchableOpacity
        style={[styles.settingsToggle, divider]}
        onPress={() => setShowSettings((s) => !s)}
        accessibilityRole="button"
        accessibilityState={{ expanded: showSettings }}>
        <Text style={[styles.settingsSummary, { color: theme.colors.textSecondary }]} numberOfLines={1}>
          {ai.mode === 'zones' ? 'At zones' : 'Zones + between'} · {pct(ai.riskPct)} per trade · stop at −{pct(ai.dailyLossPct)}/day · every{' '}
          {interval} min
        </Text>
        <IconSymbol name={showSettings ? 'chevron.up' : 'chevron.down'} size={18} color={theme.colors.textTertiary} />
      </TouchableOpacity>

      {showSettings && (
        <View style={styles.settings}>
          <Text style={[styles.label, { color: theme.colors.text }]}>Where it may trade</Text>
          <View style={[styles.segment, { backgroundColor: theme.colors.input }]}>
            {(
              [
                ['zones', 'At zones'],
                ['zones+between', 'Zones + between'],
              ] as [AiMode, string][]
            ).map(([m, t]) => (
              <TouchableOpacity
                key={m}
                style={[styles.segBtn, ai.mode === m && { backgroundColor: theme.colors.primary }]}
                onPress={() => save({ mode: m })}
                accessibilityRole="button"
                accessibilityState={{ selected: ai.mode === m }}>
                <Text style={[styles.segText, { color: ai.mode === m ? '#FFF' : theme.colors.textSecondary }]}>{t}</Text>
              </TouchableOpacity>
            ))}
          </View>
          <Text style={[styles.note, { color: theme.colors.textTertiary }]}>
            {ai.mode === 'zones'
              ? 'Only when price is at a zone or a zone event just happened.'
              : 'Also clean setups between zones, using the zones for stops and targets.'}
          </Text>

          <Text style={[styles.label, { color: theme.colors.text, marginTop: 12 }]}>Risk per AI trade</Text>
          <LevelPicker
            options={AI_RISK_OPTIONS}
            value={ai.riskPct}
            onPick={(v) => save({ riskPct: v })}
            label="Risk per AI trade"
            theme={theme}
          />
          <Text style={[styles.label, { color: theme.colors.text, marginTop: 12 }]}>Daily loss stop</Text>
          <LevelPicker
            options={AI_LOSS_OPTIONS}
            value={ai.dailyLossPct}
            onPick={(v) => save({ dailyLossPct: v })}
            label="Daily loss stop"
            hint="No new AI trades once the AI's trades are down this % of the day's starting equity (open ones are still managed)."
            example="e.g. 5"
            theme={theme}
          />
          <Text style={[styles.label, { color: theme.colors.text, marginTop: 12 }]}>Runs every</Text>
          <View style={[styles.segment, { backgroundColor: theme.colors.input }]}>
            {AI_INTERVAL_OPTIONS.map((m) => (
              <TouchableOpacity
                key={m}
                style={[styles.segBtn, interval === m && { backgroundColor: theme.colors.primary }]}
                onPress={() => {
                  Haptics.selectionAsync().catch(() => {});
                  saveAiInterval(m).catch(failed);
                }}
                accessibilityRole="button"
                accessibilityState={{ selected: interval === m }}
                accessibilityLabel={`Run every ${m} minutes`}>
                <Text style={[styles.segText, { color: interval === m ? '#FFF' : theme.colors.textSecondary }]}>{m}m</Text>
              </TouchableOpacity>
            ))}
          </View>
          <Text style={[styles.note, { color: theme.colors.textTertiary }]}>
            Every account with AI on. Each run is a Claude session on your plan; quiet runs (nothing due) stop at once.
            The Bridge sizes every trade, keeps its stop and never lets one widen.
          </Text>
        </View>
      )}

      <View style={[styles.logHead, divider]}>
        <Text style={[styles.label, { color: theme.colors.text }]}>Recent AI actions</Text>
      </View>
      {log.length === 0 ? (
        <Text style={[styles.note, styles.pad, { color: theme.colors.textTertiary }]}>
          {ai.on ? 'Nothing yet - no-trade runs leave no actions, only the summary above.' : 'None yet.'}
        </Text>
      ) : (
        <>
          {shown.map((e) => (
            <ActionRow key={e.id} e={e} now={now} theme={theme} />
          ))}
          {log.length > 5 && (
            <TouchableOpacity style={styles.more} onPress={() => setShowAll((s) => !s)} accessibilityRole="button">
              <Text style={[styles.moreText, { color: theme.colors.primary }]}>
                {showAll ? 'Show fewer' : `Show all ${log.length}`}
              </Text>
            </TouchableOpacity>
          )}
        </>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  card: {
    borderRadius: 16,
    marginBottom: 16,
    overflow: 'hidden',
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 2 },
    shadowOpacity: 0.05,
    shadowRadius: 8,
    elevation: 2,
  },
  head: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
    padding: 12,
  },
  badge: {
    width: 38,
    height: 38,
    borderRadius: 19,
    justifyContent: 'center',
    alignItems: 'center',
  },
  headText: {
    flex: 1,
  },
  title: {
    fontSize: 16,
    fontWeight: '800',
  },
  statusLine: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    marginTop: 3,
  },
  dot: {
    width: 7,
    height: 7,
    borderRadius: 3.5,
  },
  status: {
    flex: 1,
    fontSize: 12,
    fontWeight: '600',
  },
  summary: {
    fontSize: 13,
    lineHeight: 18,
    fontStyle: 'italic',
    paddingHorizontal: 12,
    paddingBottom: 10,
  },
  settingsToggle: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    paddingHorizontal: 12,
    paddingVertical: 10,
  },
  settingsSummary: {
    flex: 1,
    fontSize: 12,
    fontWeight: '600',
  },
  settings: {
    paddingHorizontal: 12,
    paddingBottom: 12,
  },
  label: {
    fontSize: 14,
    fontWeight: '700',
  },
  segment: {
    flexDirection: 'row',
    borderRadius: 10,
    padding: 3,
    marginTop: 8,
  },
  segBtn: {
    flex: 1,
    borderRadius: 8,
    paddingVertical: 8,
    alignItems: 'center',
  },
  segText: {
    fontSize: 13,
    fontWeight: '700',
  },
  note: {
    fontSize: 12,
    lineHeight: 16,
    marginTop: 6,
  },
  pad: {
    paddingHorizontal: 12,
    paddingBottom: 12,
    marginTop: 0,
  },
  logHead: {
    paddingHorizontal: 12,
    paddingTop: 10,
    paddingBottom: 4,
  },
  row: {
    flexDirection: 'row',
    gap: 8,
    paddingHorizontal: 12,
    paddingVertical: 10,
    borderTopWidth: StyleSheet.hairlineWidth,
  },
  rowText: {
    flex: 1,
  },
  rowTitle: {
    fontSize: 13,
    fontWeight: '700',
  },
  rowWhy: {
    fontSize: 12,
    lineHeight: 17,
    marginTop: 2,
  },
  rowMeta: {
    fontSize: 11,
    fontWeight: '700',
    marginTop: 3,
  },
  more: {
    alignItems: 'center',
    paddingVertical: 10,
  },
  moreText: {
    fontSize: 13,
    fontWeight: '700',
  },
});
