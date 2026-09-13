import React, { useState, useEffect } from 'react';
import { StyleSheet, View, Text, TouchableOpacity, Alert, Switch, ScrollView, TextInput } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { database } from '@/firebaseConfig';
import { ref, set, get, update } from 'firebase/database';
import { AccountSelector } from '@/components/AccountSelector';
import { useAccount } from '@/contexts/AccountContext';
import { useAccountData } from '@/hooks/useAccountData';
import { useTheme } from '@/contexts/ThemeContext';
import { usePrivacy } from '@/contexts/PrivacyContext';
import { IconSymbol } from '@/components/ui/icon-symbol';

export default function CommandsScreen() {
  const { selectedAccount } = useAccount();
  const { data } = useAccountData();
  const { theme } = useTheme();
  const { statusBarEnabled, toggleStatusBar } = usePrivacy();

  // State
  const [autoTrading, setAutoTrading] = useState(true);
  const [hedgeMode, setHedgeMode] = useState(false);
  // Global break-even applied to trades opened while enabled (price move % from entry)
  const [globalBreakevenEnabled, setGlobalBreakevenEnabled] = useState(false);
  const [globalBreakevenPercent, setGlobalBreakevenPercent] = useState('0.5');
  const [dailyTarget, setDailyTarget] = useState('2500');
  // Live values derived from the selected account's real-time data
  const isPaused = data?.isPaused ?? false;
  const positions = data?.positions ?? [];
  const winnersTotal = positions
    .filter((p) => p.profit > 0)
    .reduce((sum, p) => sum + p.profit, 0);
  const losersTotal = positions
    .filter((p) => p.profit < 0)
    .reduce((sum, p) => sum + p.profit, 0);
  const formatSigned = (n: number) => `${n >= 0 ? '+' : '-'}$${Math.abs(n).toFixed(2)}`;
  // lastUpdated is the broker server-time epoch; rendered as HH:MM:SS (UTC == server clock)
  const serverTime = data?.lastUpdated
    ? new Date(data.lastUpdated * 1000).toISOString().substring(11, 19)
    : '--:--:--';

  // Load initial settings
  useEffect(() => {
    if (selectedAccount) {
      const loadSettings = async () => {
        try {
          const settingsRef = ref(database, `settings/${selectedAccount}`);
          const snapshot = await get(settingsRef);
          if (snapshot.exists()) {
            const s = snapshot.val();
            if (s.enableBreakeven !== undefined) setGlobalBreakevenEnabled(!!s.enableBreakeven);
            if (s.breakevenPercent !== undefined) setGlobalBreakevenPercent(String(s.breakevenPercent));
            if (s.dailyTargetPercent !== undefined) setDailyTarget(String(s.dailyTargetPercent));
          }
        } catch {
          console.error();
        }
      };
      loadSettings();
    }
  }, [selectedAccount]);

  const sendCommand = async (action: string, payload: any = {}) => {
    if (!selectedAccount) {
      Alert.alert("Error", "No account selected. Please select an account first.");
      return;
    }

    try {
      const commandRef = ref(database, `commands/${selectedAccount}/latest`);
      await set(commandRef, {
        action,
        ...payload,
        status: 'PENDING',
        timestamp: Math.floor(Date.now() / 1000)
      });
      Alert.alert("Success", `Command ${action} sent.`);
    } catch {
      Alert.alert("Error", "Failed to send command.");
    }
  };

  const handlePause = () => {
    Alert.alert(
      "Pause EA",
      "Pause the EA? It will stop managing trades (breakeven, trailing, etc.) until you resume.",
      [
        { text: "Cancel", style: "cancel" },
        {
          text: "Pause",
          style: "destructive",
          onPress: () => sendCommand('SET_EA_PAUSE', { immediate: true, pauseDuration: 86400, pauseMode: 0 })
        }
      ]
    );
  };

  const handleResume = () => {
    sendCommand('SET_EA_PAUSE', { immediate: false });
  };

  const handleKillSwitch = () => {
    Alert.alert(
      "⚠️ KILL SWITCH ACTIVATED",
      "This will immediately CLOSE ALL positions and PAUSE the EA. Are you sure?",
      [
        { text: "Cancel", style: "cancel" },
        {
          text: "EXECUTE",
          style: "destructive",
          onPress: () => {
            sendCommand('KILL_SWITCH');
            setAutoTrading(false);
          }
        }
      ]
    );
  };

  const saveConfiguration = async () => {
    if (!selectedAccount) return;

    try {
      // Write to the settings node the EA polls (LoadEASettings), so it applies live
      const settingsRef = ref(database, `settings/${selectedAccount}`);
      await update(settingsRef, {
        enableBreakeven: globalBreakevenEnabled,
        breakevenUsePercent: true,
        breakevenPercent: parseFloat(globalBreakevenPercent) || 0,
        dailyTargetPercent: parseFloat(dailyTarget) || 0,
        lastUpdated: Math.floor(Date.now() / 1000)
      });

      Alert.alert("Saved", "Configuration updated. The EA applies it within ~10s and it takes effect on trades opened from now on.");
    } catch {
      Alert.alert("Error", "Failed to save configuration.");
    }
  };

  return (
    <SafeAreaView style={[styles.container, { backgroundColor: theme.colors.background }]}>
      <View style={[styles.header, { backgroundColor: theme.colors.background }]}>
        <Text style={[styles.headerTitle, { color: theme.colors.text }]}>Trade Control</Text>
      </View>

      <ScrollView contentContainerStyle={styles.scrollContent}>
        <AccountSelector />

        {/* Emergency Zone */}
        <View style={styles.section}>
          <View style={styles.sectionHeader}>
            <IconSymbol name="exclamationmark.shield.fill" size={16} color={theme.colors.error} />
            <Text style={[styles.sectionTitle, { color: theme.colors.error }]}>EMERGENCY ZONE</Text>
            <Text style={[styles.sectionAction, { color: theme.colors.textTertiary }]}>CONFIRM ACTION</Text>
          </View>

          <TouchableOpacity
            style={[styles.killSwitch, { backgroundColor: theme.colors.error }]}
            onPress={handleKillSwitch}
            activeOpacity={0.9}
          >
            <View style={styles.killIconBg}>
              <IconSymbol name="xmark" size={24} color={theme.colors.error} />
            </View>
            <View>
              <Text style={styles.killTitle}>KILL SWITCH</Text>
              <Text style={styles.killSubtitle}>CLOSE ALL POSITIONS IMMEDIATELY</Text>
            </View>
          </TouchableOpacity>
        </View>

        {/* Toggles */}
        <View style={styles.grid}>
          <View style={[styles.toggleCard, { backgroundColor: theme.colors.card }]}>
            <View style={styles.toggleHeader}>
              <View style={[styles.iconBox, { backgroundColor: theme.colors.primary }]}>
                <IconSymbol name="cpu" size={20} color="#FFF" />
              </View>
              <Switch
                value={autoTrading}
                onValueChange={setAutoTrading}
                trackColor={{ false: theme.colors.input, true: theme.colors.primary }}
                thumbColor="#FFF"
              />
            </View>
            <Text style={[styles.toggleTitle, { color: theme.colors.text }]}>Auto-Trading</Text>
            <Text style={[styles.toggleDesc, { color: theme.colors.textSecondary }]}>Allow EA to open trades</Text>
          </View>

          <View style={[styles.toggleCard, { backgroundColor: theme.colors.card }]}>
            <View style={styles.toggleHeader}>
              <View style={[styles.iconBox, { backgroundColor: theme.colors.input }]}>
                <IconSymbol name="arrow.triangle.2.circlepath" size={20} color={theme.colors.textSecondary} />
              </View>
              <Switch
                value={hedgeMode}
                onValueChange={setHedgeMode}
                trackColor={{ false: theme.colors.input, true: theme.colors.primary }}
                thumbColor="#FFF"
              />
            </View>
            <Text style={[styles.toggleTitle, { color: theme.colors.text }]}>Hedge Mode</Text>
            <Text style={[styles.toggleDesc, { color: theme.colors.textSecondary }]}>Simultaneous positions</Text>
          </View>
        </View>

        {/* Display preferences */}
        <View style={styles.section}>
          <Text style={[styles.sectionLabel, { color: theme.colors.textSecondary }]}>DISPLAY</Text>
          <View style={[styles.settingRow, { backgroundColor: theme.colors.card }]}>
            <View style={{ flex: 1, paddingRight: 12 }}>
              <Text style={[styles.settingTitle, { color: theme.colors.text }]}>Live P/L + Risk bar</Text>
              <Text style={[styles.settingDesc, { color: theme.colors.textSecondary }]}>Always-on strip above the tabs</Text>
            </View>
            <Switch
              value={statusBarEnabled}
              onValueChange={toggleStatusBar}
              trackColor={{ false: theme.colors.input, true: theme.colors.primary }}
              thumbColor="#FFF"
            />
          </View>
        </View>

        {/* Quick Actions */}
        <View style={styles.section}>
          <Text style={[styles.sectionLabel, { color: theme.colors.textSecondary }]}>QUICK ACTIONS</Text>
          <View style={styles.grid}>
            <TouchableOpacity
              style={[styles.actionCard, { backgroundColor: theme.colors.card }]}
              onPress={() => sendCommand('CLOSE_PROFITABLE')}
            >
              <IconSymbol name="chart.line.uptrend.xyaxis" size={24} color={theme.colors.success} />
              <Text style={[styles.actionTitle, { color: theme.colors.text }]}>Close Winners</Text>
              <Text style={[styles.actionValue, { color: theme.colors.success }]}>{formatSigned(winnersTotal)}</Text>
            </TouchableOpacity>

            <TouchableOpacity
              style={[styles.actionCard, { backgroundColor: theme.colors.card }]}
              onPress={() => sendCommand('CLOSE_LOSING')}
            >
              <IconSymbol name="chart.line.downtrend.xyaxis" size={24} color={theme.colors.error} />
              <Text style={[styles.actionTitle, { color: theme.colors.text }]}>Close Losers</Text>
              <Text style={[styles.actionValue, { color: theme.colors.error }]}>{formatSigned(losersTotal)}</Text>
            </TouchableOpacity>
          </View>

          <TouchableOpacity
            style={[styles.listItem, { backgroundColor: theme.colors.card }]}
            onPress={() => sendCommand('DELETE_PENDING')}
          >
            <View style={styles.listItemLeft}>
              <IconSymbol name="clock.badge.exclamationmark" size={24} color={theme.colors.warning} />
              <View>
                <Text style={[styles.listItemTitle, { color: theme.colors.text }]}>Delete Pending Orders</Text>
                <Text style={[styles.listItemSubtitle, { color: theme.colors.textSecondary }]}>
                  {data?.orders ? data.orders.length : 0} orders active
                </Text>
              </View>
            </View>
            <IconSymbol name="chevron.right" size={16} color={theme.colors.textTertiary} />
          </TouchableOpacity>
        </View>

        {/* EA Control */}
        <View style={[styles.scheduleCard, { backgroundColor: theme.colors.card }]}>
          <View style={styles.scheduleHeader}>
            <View style={styles.scheduleTitleRow}>
              <IconSymbol name="clock.fill" size={16} color={theme.colors.textSecondary} />
              <Text style={[styles.scheduleTitle, { color: theme.colors.textSecondary }]}>EA CONTROL</Text>
            </View>
            <View style={styles.scheduleControls}>
              <TouchableOpacity
                style={[styles.controlBtn, { backgroundColor: isPaused ? theme.colors.input : theme.colors.error + '22' }]}
                onPress={handlePause}
                disabled={isPaused}
              >
                <Text style={[styles.controlBtnText, { color: isPaused ? theme.colors.textTertiary : theme.colors.error }]}>Pause</Text>
              </TouchableOpacity>
              <TouchableOpacity
                style={[styles.controlBtn, { backgroundColor: isPaused ? theme.colors.primary : theme.colors.input }]}
                onPress={handleResume}
                disabled={!isPaused}
              >
                <Text style={[styles.controlBtnText, { color: isPaused ? '#FFF' : theme.colors.textTertiary }]}>Resume</Text>
              </TouchableOpacity>
            </View>
          </View>

          <View style={styles.scheduleFooter}>
            <View style={styles.statusRow}>
              <Text style={[styles.statusLabel, { color: theme.colors.textSecondary }]}>Status: </Text>
              <Text style={[styles.statusValue, { color: isPaused ? theme.colors.warning : theme.colors.success }]}>
                {isPaused ? 'PAUSED' : 'RUNNING'}
              </Text>
            </View>
            <Text style={[styles.serverTime, { color: theme.colors.textSecondary }]}>Server Time: {serverTime}</Text>
          </View>
        </View>

        {/* Risk Parameters */}
        <View style={styles.section}>
          <Text style={[styles.sectionLabel, { color: theme.colors.textSecondary }]}>RISK PARAMETERS</Text>

          <View style={[styles.paramCard, { backgroundColor: theme.colors.card, flexDirection: 'column', alignItems: 'stretch' }]}>
            <View style={{ flexDirection: 'row', alignItems: 'center' }}>
              <View style={styles.paramIcon}>
                <IconSymbol name="anchor" size={24} color={theme.colors.primary} />
              </View>
              <View style={styles.paramContent}>
                <Text style={[styles.paramTitle, { color: theme.colors.text }]}>Global Break-Even</Text>
                <Text style={[styles.paramSubtitle, { color: theme.colors.textSecondary }]}>Applies to trades opened while on</Text>
              </View>
              <Switch
                value={globalBreakevenEnabled}
                onValueChange={setGlobalBreakevenEnabled}
                trackColor={{ false: theme.colors.input, true: theme.colors.primary }}
                thumbColor="#FFF"
              />
            </View>
            {globalBreakevenEnabled && (
              <View style={{ marginTop: 14 }}>
                <Text style={[styles.paramSubtitle, { color: theme.colors.text, marginBottom: 8 }]}>Price move from entry (%)</Text>
                <View style={[styles.inputWrapper, { backgroundColor: theme.colors.input, alignSelf: 'flex-start', minWidth: 120 }]}>
                  <TextInput
                    style={[styles.paramInput, { color: theme.colors.text }]}
                    value={globalBreakevenPercent}
                    onChangeText={setGlobalBreakevenPercent}
                    keyboardType="numeric"
                    placeholder="0.5"
                    placeholderTextColor={theme.colors.textTertiary}
                  />
                  <Text style={[styles.currencySymbol, { color: theme.colors.textSecondary, marginLeft: 4, marginRight: 0 }]}>%</Text>
                </View>
              </View>
            )}
          </View>

          <View style={[styles.paramCard, { backgroundColor: theme.colors.card }]}>
            <View style={[styles.paramIcon, { backgroundColor: theme.colors.success + '20' }]}>
              <IconSymbol name="banknote" size={24} color={theme.colors.success} />
            </View>
            <View style={styles.paramContent}>
              <Text style={[styles.paramTitle, { color: theme.colors.text }]}>Daily Target</Text>
              <Text style={[styles.paramSubtitle, { color: theme.colors.textSecondary }]}>Auto-close at profit</Text>
            </View>
            <View style={[styles.inputWrapper, { backgroundColor: theme.colors.input }]}>
              <Text style={[styles.currencySymbol, { color: theme.colors.textSecondary }]}>$</Text>
              <TextInput
                style={[styles.paramInput, { color: theme.colors.text }]}
                value={dailyTarget}
                onChangeText={setDailyTarget}
                keyboardType="numeric"
              />
            </View>
          </View>
        </View>

        <TouchableOpacity
          style={[styles.saveButton, { backgroundColor: theme.colors.input }]}
          onPress={saveConfiguration}
        >
          <Text style={[styles.saveText, { color: theme.colors.text }]}>Save Configuration</Text>
        </TouchableOpacity>

        <View style={{ height: 40 }} />
      </ScrollView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
  },
  header: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    paddingHorizontal: 16,
    paddingVertical: 12,
  },
  headerTitle: {
    fontSize: 20,
    fontWeight: 'bold',
  },
  backButton: {
    padding: 4,
  },
  scrollContent: {
    padding: 16,
  },
  section: {
    marginBottom: 24,
  },
  sectionHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    marginBottom: 12,
    gap: 8,
  },
  sectionTitle: {
    fontSize: 12,
    fontWeight: '800',
    letterSpacing: 0.5,
    flex: 1,
  },
  sectionAction: {
    fontSize: 10,
    fontWeight: '700',
    letterSpacing: 0.5,
  },
  sectionLabel: {
    fontSize: 12,
    fontWeight: '700',
    marginBottom: 12,
    letterSpacing: 0.5,
    textTransform: 'uppercase',
  },
  settingRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    borderRadius: 12,
    paddingHorizontal: 16,
    paddingVertical: 14,
  },
  settingTitle: {
    fontSize: 15,
    fontWeight: '600',
  },
  settingDesc: {
    fontSize: 12,
    marginTop: 2,
  },
  killSwitch: {
    flexDirection: 'row',
    alignItems: 'center',
    padding: 16,
    borderRadius: 16,
    shadowColor: '#F44336',
    shadowOffset: { width: 0, height: 4 },
    shadowOpacity: 0.3,
    shadowRadius: 8,
    elevation: 5,
  },
  killIconBg: {
    width: 40,
    height: 40,
    borderRadius: 20,
    backgroundColor: 'rgba(255,255,255,0.9)',
    justifyContent: 'center',
    alignItems: 'center',
    marginRight: 16,
  },
  killTitle: {
    color: '#FFF',
    fontSize: 18,
    fontWeight: '900',
    letterSpacing: 0.5,
  },
  killSubtitle: {
    color: 'rgba(255,255,255,0.8)',
    fontSize: 10,
    fontWeight: '700',
    marginTop: 2,
  },
  grid: {
    flexDirection: 'row',
    gap: 12,
    marginBottom: 24,
  },
  toggleCard: {
    flex: 1,
    padding: 16,
    borderRadius: 16,
  },
  toggleHeader: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    marginBottom: 12,
  },
  iconBox: {
    width: 32,
    height: 32,
    borderRadius: 8,
    justifyContent: 'center',
    alignItems: 'center',
  },
  toggleTitle: {
    fontSize: 14,
    fontWeight: '700',
    marginBottom: 4,
  },
  toggleDesc: {
    fontSize: 11,
  },
  actionCard: {
    flex: 1,
    padding: 16,
    borderRadius: 16,
    alignItems: 'center',
    justifyContent: 'center',
  },
  actionTitle: {
    fontSize: 14,
    fontWeight: '700',
    marginTop: 8,
    marginBottom: 4,
  },
  actionValue: {
    fontSize: 12,
    fontWeight: '700',
  },
  listItem: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    padding: 16,
    borderRadius: 16,
    marginTop: 12,
  },
  listItemLeft: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
  },
  listItemTitle: {
    fontSize: 14,
    fontWeight: '700',
  },
  listItemSubtitle: {
    fontSize: 12,
  },
  scheduleCard: {
    padding: 16,
    borderRadius: 16,
    marginBottom: 24,
  },
  scheduleHeader: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    marginBottom: 16,
  },
  scheduleTitleRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
  },
  scheduleTitle: {
    fontSize: 12,
    fontWeight: '700',
    letterSpacing: 0.5,
  },
  scheduleControls: {
    flexDirection: 'row',
    gap: 8,
  },
  controlBtn: {
    paddingHorizontal: 12,
    paddingVertical: 6,
    borderRadius: 8,
  },
  controlBtnText: {
    fontSize: 12,
    fontWeight: '600',
  },
  timelineLabels: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    marginBottom: 8,
  },
  timelineTime: {
    fontSize: 10,
    color: '#666',
  },
  timelineBar: {
    height: 8,
    borderRadius: 4,
    marginBottom: 16,
    position: 'relative',
    overflow: 'hidden',
  },
  timelineActive: {
    position: 'absolute',
    top: 0,
    bottom: 0,
  },
  timeMarker: {
    position: 'absolute',
    top: -2,
    bottom: -2,
    width: 2,
    borderWidth: 1,
    backgroundColor: '#FFF',
    zIndex: 10,
  },
  scheduleFooter: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
  },
  statusRow: {
    flexDirection: 'row',
  },
  statusLabel: {
    fontSize: 12,
    fontWeight: '600',
  },
  statusValue: {
    fontSize: 12,
    fontWeight: '700',
  },
  serverTime: {
    fontSize: 12,
  },
  paramCard: {
    flexDirection: 'row',
    alignItems: 'center',
    padding: 16,
    borderRadius: 16,
    marginBottom: 12,
  },
  paramIcon: {
    width: 40,
    height: 40,
    borderRadius: 12,
    backgroundColor: 'rgba(59, 130, 246, 0.1)',
    justifyContent: 'center',
    alignItems: 'center',
    marginRight: 12,
  },
  paramContent: {
    flex: 1,
  },
  paramTitle: {
    fontSize: 14,
    fontWeight: '700',
  },
  paramSubtitle: {
    fontSize: 12,
  },
  stepper: {
    flexDirection: 'row',
    alignItems: 'center',
    borderRadius: 8,
    padding: 4,
  },
  stepBtn: {
    width: 32,
    height: 32,
    justifyContent: 'center',
    alignItems: 'center',
  },
  stepText: {
    fontSize: 18,
    fontWeight: '600',
  },
  stepValue: {
    fontSize: 16,
    fontWeight: '700',
    minWidth: 30,
    textAlign: 'center',
  },
  inputWrapper: {
    flexDirection: 'row',
    alignItems: 'center',
    borderRadius: 8,
    paddingHorizontal: 12,
    height: 40,
    minWidth: 100,
  },
  currencySymbol: {
    fontSize: 16,
    fontWeight: '600',
    marginRight: 4,
  },
  paramInput: {
    fontSize: 16,
    fontWeight: '700',
    minWidth: 60,
  },
  saveButton: {
    padding: 16,
    borderRadius: 16,
    alignItems: 'center',
    marginBottom: 20,
  },
  saveText: {
    fontSize: 16,
    fontWeight: '700',
  },
});
