import React, { useState, useEffect } from 'react';
import { StyleSheet, View, Text, TouchableOpacity, Alert, Switch, ScrollView, TextInput } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { database } from '@/firebaseConfig';
import { ref, set, get } from 'firebase/database';
import { AccountSelector } from '@/components/AccountSelector';
import { useAccount } from '@/contexts/AccountContext';
import { useAccountData } from '@/hooks/useAccountData';
import { useTheme } from '@/contexts/ThemeContext';
import { IconSymbol } from '@/components/ui/icon-symbol';

export default function CommandsScreen() {
  const { selectedAccount } = useAccount();
  const { data } = useAccountData();
  const { theme } = useTheme();

  // State
  const [autoTrading, setAutoTrading] = useState(true);
  const [hedgeMode, setHedgeMode] = useState(false);
  const [breakevenOffset, setBreakevenOffset] = useState(15);
  const [dailyTarget, setDailyTarget] = useState('2500');
  const [scheduleStatus] = useState('RUNNING');
  const [serverTime] = useState('15:42:05'); // Placeholder, would come from backend in real app

  // Load initial settings
  useEffect(() => {
    if (selectedAccount) {
      const loadSettings = async () => {
        try {
          const settingsRef = ref(database, `settings/${selectedAccount}`);
          const snapshot = await get(settingsRef);
          if (snapshot.exists()) {
            const data = snapshot.val();
            if (data.breakevenThresholdPips !== undefined) setBreakevenOffset(data.breakevenThresholdPips);
            // Add other settings mappings here
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
      // Send a command to update the EA params live
      await sendCommand('UPDATE_SETTINGS', {
        breakevenThresholdPips: breakevenOffset,
        dailyTarget: parseFloat(dailyTarget)
      });

      Alert.alert("Saved", "Configuration updated successfully.");
    } catch {
      Alert.alert("Error", "Failed to save configuration.");
    }
  };

  return (
    <SafeAreaView style={[styles.container, { backgroundColor: theme.colors.background }]}>
      <View style={[styles.header, { backgroundColor: theme.colors.background }]}>
        <TouchableOpacity style={styles.backButton}>
          <IconSymbol name="arrow.left" size={24} color={theme.colors.text} />
        </TouchableOpacity>
        <Text style={[styles.headerTitle, { color: theme.colors.text }]}>Trade Control</Text>
        <TouchableOpacity>
          <IconSymbol name="clock.arrow.circlepath" size={24} color={theme.colors.textSecondary} />
        </TouchableOpacity>
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
              <Text style={[styles.actionValue, { color: theme.colors.success }]}>+$1,240.50</Text>
            </TouchableOpacity>

            <TouchableOpacity
              style={[styles.actionCard, { backgroundColor: theme.colors.card }]}
              onPress={() => sendCommand('CLOSE_LOSING')}
            >
              <IconSymbol name="chart.line.downtrend.xyaxis" size={24} color={theme.colors.error} />
              <Text style={[styles.actionTitle, { color: theme.colors.text }]}>Close Losers</Text>
              <Text style={[styles.actionValue, { color: theme.colors.error }]}>-$320.10</Text>
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

        {/* EA Schedule */}
        <View style={[styles.scheduleCard, { backgroundColor: theme.colors.card }]}>
          <View style={styles.scheduleHeader}>
            <View style={styles.scheduleTitleRow}>
              <IconSymbol name="clock.fill" size={16} color={theme.colors.textSecondary} />
              <Text style={[styles.scheduleTitle, { color: theme.colors.textSecondary }]}>EA SCHEDULE</Text>
            </View>
            <View style={styles.scheduleControls}>
              <TouchableOpacity style={[styles.controlBtn, { backgroundColor: theme.colors.input }]}>
                <Text style={[styles.controlBtnText, { color: theme.colors.textSecondary }]}>Pause</Text>
              </TouchableOpacity>
              <TouchableOpacity style={[styles.controlBtn, { backgroundColor: theme.colors.primary }]}>
                <Text style={[styles.controlBtnText, { color: '#FFF' }]}>Resume</Text>
              </TouchableOpacity>
            </View>
          </View>

          <View style={styles.timelineLabels}>
            <Text style={styles.timelineTime}>00:00</Text>
            <Text style={styles.timelineTime}>06:00</Text>
            <Text style={styles.timelineTime}>12:00</Text>
            <Text style={styles.timelineTime}>18:00</Text>
            <Text style={styles.timelineTime}>24:00</Text>
          </View>

          <View style={[styles.timelineBar, { backgroundColor: theme.colors.input }]}>
            {/* Visual representation of schedule - simplified */}
            <View style={[styles.timelineActive, { left: '25%', width: '40%', backgroundColor: theme.colors.success }]} />
            <View style={[styles.timelineActive, { left: '70%', width: '20%', backgroundColor: theme.colors.success }]} />
            {/* Current time marker */}
            <View style={[styles.timeMarker, { left: '65%', borderColor: theme.colors.warning }]} />
          </View>

          <View style={styles.scheduleFooter}>
            <View style={styles.statusRow}>
              <Text style={[styles.statusLabel, { color: theme.colors.textSecondary }]}>Status: </Text>
              <Text style={[styles.statusValue, { color: theme.colors.success }]}>{scheduleStatus}</Text>
            </View>
            <Text style={[styles.serverTime, { color: theme.colors.textSecondary }]}>Server Time: {serverTime}</Text>
          </View>
        </View>

        {/* Risk Parameters */}
        <View style={styles.section}>
          <Text style={[styles.sectionLabel, { color: theme.colors.textSecondary }]}>RISK PARAMETERS</Text>

          <View style={[styles.paramCard, { backgroundColor: theme.colors.card }]}>
            <View style={styles.paramIcon}>
              <IconSymbol name="anchor" size={24} color={theme.colors.primary} />
            </View>
            <View style={styles.paramContent}>
              <Text style={[styles.paramTitle, { color: theme.colors.text }]}>Breakeven Offset</Text>
              <Text style={[styles.paramSubtitle, { color: theme.colors.textSecondary }]}>Pips after entry</Text>
            </View>
            <View style={[styles.stepper, { backgroundColor: theme.colors.input }]}>
              <TouchableOpacity onPress={() => setBreakevenOffset(Math.max(0, breakevenOffset - 1))} style={styles.stepBtn}>
                <Text style={[styles.stepText, { color: theme.colors.textSecondary }]}>−</Text>
              </TouchableOpacity>
              <Text style={[styles.stepValue, { color: theme.colors.text }]}>{breakevenOffset}</Text>
              <TouchableOpacity onPress={() => setBreakevenOffset(breakevenOffset + 1)} style={styles.stepBtn}>
                <Text style={[styles.stepText, { color: theme.colors.textSecondary }]}>+</Text>
              </TouchableOpacity>
            </View>
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
