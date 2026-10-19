import React, { useEffect, useState } from 'react';
import {
  AppState,
  Modal,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TouchableOpacity,
  View,
  type StyleProp,
  type ViewStyle,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import * as Haptics from 'expo-haptics';
import { ref, onValue } from 'firebase/database';
import { database, authReady } from '@/firebaseConfig';
import { useAccount } from '@/contexts/AccountContext';
import { useTheme, type Theme } from '@/contexts/ThemeContext';
import { showAlert } from '@/components/AppDialog';
import { IconSymbol } from '@/components/ui/icon-symbol';
import { healthColor, healthText, terminalHealth, terminalLabel, toEpochSeconds } from '@/components/TerminalStatus';

// What the selector shows about each account, from accounts/{id} (the Bridge EA writes it).
interface AccountMeta {
  lastUpdated: number; // epoch seconds, 0 = never
  currency: string;
  paused: boolean;
}

const TICK_MS = 15000;

/** Live heartbeat / currency / pause flag per account. Only these leaves are read. */
function useAccountMeta() {
  const [meta, setMeta] = useState<Record<string, AccountMeta>>({});
  const [, setTick] = useState(0);

  useEffect(() => {
    let cancelled = false;
    let unsubscribe = () => {};
    authReady.then(() => {
      if (cancelled) return;
      unsubscribe = onValue(
        ref(database, 'accounts'),
        (snapshot) => {
          const out: Record<string, AccountMeta> = {};
          snapshot.forEach((child) => {
            if (!child.key) return;
            const cur = child.child('currency').val();
            out[child.key] = {
              lastUpdated: toEpochSeconds(child.child('lastUpdated').val()),
              currency: typeof cur === 'string' ? cur : '',
              paused: child.child('isPaused').val() === true,
            };
          });
          setMeta(out);
        },
        (error) => console.error('Failed to read account status:', error)
      );
    });
    return () => {
      cancelled = true;
      unsubscribe();
    };
  }, []);

  // Ages tick without new data, and refresh when the app comes back to the foreground.
  useEffect(() => {
    const bump = () => setTick((t) => t + 1);
    const id = setInterval(bump, TICK_MS);
    const sub = AppState.addEventListener('change', (s) => s === 'active' && bump());
    return () => {
      clearInterval(id);
      sub.remove();
    };
  }, []);

  return meta;
}

// "Deriv · 140421845" -> monogram "D"; "HFM · 55029630" -> "HFM".
function brokerMono(accountId: string) {
  const broker = terminalLabel(accountId).split(' · ')[0];
  return broker.length <= 3 ? broker : broker.charAt(0).toUpperCase();
}

function statusOf(m: AccountMeta | undefined, theme: Theme) {
  if (!m || !m.lastUpdated) return { color: theme.colors.textTertiary, text: 'no data yet' };
  const age = Math.max(0, Math.floor(Date.now() / 1000) - m.lastUpdated);
  const h = terminalHealth(age);
  return h === 'retired'
    ? { color: theme.colors.textTertiary, text: 'inactive' }
    : { color: healthColor(h, theme), text: healthText(h, age) };
}

function Monogram({ accountId, theme, size = 38 }: { accountId: string; theme: Theme; size?: number }) {
  const mono = brokerMono(accountId);
  return (
    <View
      style={[
        styles.mono,
        { width: size, height: size, borderRadius: size / 2, backgroundColor: theme.colors.primary + '1F' },
      ]}>
      <Text style={[styles.monoText, { color: theme.colors.primary, fontSize: mono.length > 1 ? 11 : 15 }]}>{mono}</Text>
    </View>
  );
}

function MetaLine({ m, theme }: { m: AccountMeta | undefined; theme: Theme }) {
  const s = statusOf(m, theme);
  return (
    <View style={styles.metaLine}>
      <View style={[styles.dot, { backgroundColor: s.color }]} />
      <Text style={[styles.metaStatus, { color: s.color }]} numberOfLines={1}>
        {s.text}
      </Text>
      {!!m?.currency && (
        <Text style={[styles.metaText, { color: theme.colors.textTertiary }]} numberOfLines={1}>
          · {m.currency}
        </Text>
      )}
      {m?.paused && (
        <Text style={[styles.metaText, { color: theme.colors.warning }]} numberOfLines={1}>
          · EA paused
        </Text>
      )}
    </View>
  );
}

/**
 * The account the screens show: a card with the account's short name and live status;
 * tapping it opens a sheet listing every account (switch, or remove one).
 */
export function AccountSelector({ style }: { style?: StyleProp<ViewStyle> }) {
  const { selectedAccount, availableAccounts, setSelectedAccount, removeAccount, loading } = useAccount();
  const { theme } = useTheme();
  const insets = useSafeAreaInsets();
  const meta = useAccountMeta();
  const [open, setOpen] = useState(false);

  const cardStyle = [
    styles.card,
    { backgroundColor: theme.colors.card },
    theme.isDark && { borderWidth: StyleSheet.hairlineWidth, borderColor: theme.colors.border },
    style,
  ];

  if (loading) {
    return (
      <View style={cardStyle}>
        <Text style={[styles.placeholder, { color: theme.colors.textSecondary }]}>Loading accounts…</Text>
      </View>
    );
  }

  if (availableAccounts.length === 0) {
    return (
      <View style={cardStyle}>
        <Text style={[styles.placeholderTitle, { color: theme.colors.text }]}>No EA connections found</Text>
        <Text style={[styles.placeholder, { color: theme.colors.textSecondary }]}>
          Start the Bridge EA on an MT5 terminal to see its account here.
        </Text>
      </View>
    );
  }

  const choose = (id: string) => {
    Haptics.selectionAsync().catch(() => {});
    setSelectedAccount(id);
    setOpen(false);
  };

  const confirmRemove = (id: string) => {
    showAlert(
      'Remove account?',
      `"${terminalLabel(id)}" and all its data in the app will be deleted. This can't be undone. ` +
        'If its Bridge EA is still running, the account comes back on its next update.',
      [
        { text: 'Cancel', style: 'cancel' },
        {
          text: 'Remove',
          style: 'destructive',
          onPress: async () => {
            try {
              await removeAccount(id);
            } catch {
              showAlert('Error', 'Could not remove the account. Check your connection and try again.');
            }
          },
        },
      ]
    );
  };

  const current = selectedAccount ?? availableAccounts[0];

  return (
    <>
      <TouchableOpacity
        style={[cardStyle, styles.trigger]}
        onPress={() => setOpen(true)}
        activeOpacity={0.7}
        accessibilityRole="button"
        accessibilityLabel={`Account ${terminalLabel(current)}, ${statusOf(meta[current], theme).text}. Change account`}>
        <Monogram accountId={current} theme={theme} />
        <View style={styles.rowText}>
          <Text style={[styles.name, { color: theme.colors.text }]} numberOfLines={1}>
            {terminalLabel(current)}
          </Text>
          <MetaLine m={meta[current]} theme={theme} />
        </View>
        {availableAccounts.length > 1 && (
          <View style={[styles.countBadge, { backgroundColor: theme.colors.input }]}>
            <Text style={[styles.countText, { color: theme.colors.textSecondary }]}>{availableAccounts.length}</Text>
          </View>
        )}
        <IconSymbol name="chevron.down" size={22} color={theme.colors.textSecondary} />
      </TouchableOpacity>

      <Modal animationType="slide" transparent visible={open} onRequestClose={() => setOpen(false)}>
        <View style={[styles.overlay, { backgroundColor: theme.colors.overlay }]}>
          <Pressable style={StyleSheet.absoluteFill} onPress={() => setOpen(false)} accessibilityLabel="Close accounts" />
          <View
            style={[
              styles.sheet,
              { backgroundColor: theme.colors.card, paddingBottom: Math.max(insets.bottom, 12) + 12 },
              // No shadow on black — a hairline keeps the sheet's edge visible in dark mode.
              theme.isDark && { borderWidth: StyleSheet.hairlineWidth, borderBottomWidth: 0, borderColor: theme.colors.border },
            ]}>
            <View style={styles.grabber}>
              <View style={[styles.grabberBar, { backgroundColor: theme.colors.border }]} />
            </View>
            <Text style={[styles.title, { color: theme.colors.text }]}>Accounts</Text>
            <Text style={[styles.subtitle, { color: theme.colors.textSecondary }]}>
              {availableAccounts.length} terminal{availableAccounts.length === 1 ? '' : 's'} · tap one to switch
            </Text>

            <ScrollView style={styles.listScroll} contentContainerStyle={styles.list} bounces={false}>
              {availableAccounts.map((id) => {
                const selected = id === current;
                return (
                  <TouchableOpacity
                    key={id}
                    style={[
                      styles.row,
                      { borderColor: selected ? theme.colors.primary : theme.colors.border },
                      selected && { backgroundColor: theme.colors.primary + '14' },
                    ]}
                    onPress={() => choose(id)}
                    accessibilityRole="button"
                    accessibilityState={{ selected }}
                    accessibilityLabel={`${terminalLabel(id)}, ${statusOf(meta[id], theme).text}`}>
                    <Monogram accountId={id} theme={theme} />
                    <View style={styles.rowText}>
                      <Text style={[styles.name, { color: theme.colors.text }]} numberOfLines={1}>
                        {terminalLabel(id)}
                      </Text>
                      <MetaLine m={meta[id]} theme={theme} />
                    </View>
                    {selected && <IconSymbol name="checkmark" size={20} color={theme.colors.primary} />}
                    <TouchableOpacity
                      style={[styles.removeBtn, { backgroundColor: theme.colors.input }]}
                      onPress={() => confirmRemove(id)}
                      hitSlop={{ top: 6, bottom: 6, left: 6, right: 6 }}
                      accessibilityRole="button"
                      accessibilityLabel={`Remove ${terminalLabel(id)}`}>
                      <IconSymbol name="trash" size={16} color={theme.colors.textTertiary} />
                    </TouchableOpacity>
                  </TouchableOpacity>
                );
              })}
            </ScrollView>

            <TouchableOpacity
              style={[styles.cancel, { backgroundColor: theme.colors.input }]}
              onPress={() => setOpen(false)}
              accessibilityRole="button">
              <Text style={[styles.cancelText, { color: theme.colors.text }]}>Close</Text>
            </TouchableOpacity>
          </View>
        </View>
      </Modal>
    </>
  );
}

const styles = StyleSheet.create({
  card: {
    marginBottom: 16,
    borderRadius: 16,
    padding: 12,
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 2 },
    shadowOpacity: 0.05,
    shadowRadius: 8,
    elevation: 2,
  },
  trigger: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
  },
  placeholderTitle: {
    fontSize: 15,
    fontWeight: '700',
    textAlign: 'center',
  },
  placeholder: {
    fontSize: 13,
    textAlign: 'center',
    marginTop: 4,
  },
  mono: {
    justifyContent: 'center',
    alignItems: 'center',
  },
  monoText: {
    fontWeight: '800',
    letterSpacing: 0.3,
  },
  rowText: {
    flex: 1,
  },
  name: {
    fontSize: 16,
    fontWeight: '700',
  },
  metaLine: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 5,
    marginTop: 3,
  },
  dot: {
    width: 7,
    height: 7,
    borderRadius: 3.5,
  },
  metaStatus: {
    fontSize: 12,
    fontWeight: '800',
    letterSpacing: 0.3,
  },
  metaText: {
    fontSize: 12,
    fontWeight: '600',
  },
  countBadge: {
    minWidth: 24,
    height: 24,
    borderRadius: 12,
    paddingHorizontal: 7,
    justifyContent: 'center',
    alignItems: 'center',
  },
  countText: {
    fontSize: 12,
    fontWeight: '700',
  },
  overlay: {
    flex: 1,
    justifyContent: 'flex-end',
  },
  sheet: {
    borderTopLeftRadius: 20,
    borderTopRightRadius: 20,
    paddingHorizontal: 16,
    maxHeight: '80%',
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
    fontWeight: '600',
    marginTop: 2,
  },
  listScroll: {
    marginTop: 14,
    flexGrow: 0,
  },
  list: {
    gap: 8,
  },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
    paddingHorizontal: 12,
    paddingVertical: 10,
    borderRadius: 14,
    borderWidth: 1,
  },
  removeBtn: {
    width: 32,
    height: 32,
    borderRadius: 10,
    justifyContent: 'center',
    alignItems: 'center',
  },
  cancel: {
    marginTop: 12,
    borderRadius: 14,
    paddingVertical: 14,
    alignItems: 'center',
  },
  cancelText: {
    fontSize: 15,
    fontWeight: '700',
  },
});
