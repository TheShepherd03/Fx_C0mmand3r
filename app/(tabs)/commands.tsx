import React, { useState } from 'react';
import { StyleSheet, View, Text, TouchableOpacity, Alert, Switch, ScrollView } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { database } from '@/firebaseConfig';
import { ref, set } from 'firebase/database';
import { AccountSelector } from '@/components/AccountSelector';
import { useAccount } from '@/contexts/AccountContext';
import { useTheme } from '@/contexts/ThemeContext';

export default function CommandsScreen() {
  const { selectedAccount } = useAccount();
  const { theme } = useTheme();
  const [allowTrading, setAllowTrading] = useState(true);

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

  const handleTestNotification = async () => {
    // Notifications not available in Expo Go
    Alert.alert("Info", "Notifications are only available in production builds, not in Expo Go.");
  };

  const handleKillSwitch = () => {
    Alert.alert(
      "KILL SWITCH ACTIVATED",
      "This will immediately CLOSE ALL positions and PAUSE the EA. Are you sure?",
      [
        { text: "Cancel", style: "cancel" },
        {
          text: "EXECUTE",
          style: "destructive",
          onPress: () => {
            sendCommand('KILL_SWITCH');
            setAllowTrading(false);
          }
        }
      ]
    );
  };

  return (
    <SafeAreaView style={[styles.container, { backgroundColor: theme.colors.background }]}>
      <ScrollView contentContainerStyle={styles.scrollContent}>
        <Text style={[styles.title, { color: theme.colors.text }]}>⚡ Trade Control</Text>

        <AccountSelector />

        {/* Emergency Section */}
        <View style={[styles.card, styles.dangerCard, { backgroundColor: theme.colors.card }]}>
          <Text style={[styles.dangerTitle, { color: theme.colors.text }]}>⚠️ EMERGENCY ZONE</Text>
          <Text style={[styles.cardDesc, { color: theme.colors.textSecondary }]}>
            Use these controls only in critical situations.
          </Text>

          <TouchableOpacity style={[styles.killButton, { backgroundColor: theme.colors.error }]} onPress={handleKillSwitch}>
            <Text style={styles.killButtonText}>KILL SWITCH (CLOSE ALL)</Text>
          </TouchableOpacity>
        </View>

        {/* Configuration Section */}
        <View style={[styles.card, { backgroundColor: theme.colors.card }]}>
          <Text style={[styles.cardTitle, { color: theme.colors.text }]}>Global Settings</Text>

          <View style={styles.settingRow}>
            <Text style={[styles.settingLabel, { color: theme.colors.text }]}>Trading Enabled</Text>
            <Switch
              value={allowTrading}
              onValueChange={(val) => {
                setAllowTrading(val);
                sendCommand('UPDATE_CONFIG', { tradingEnabled: val });
              }}
            />
          </View>

          <View style={[styles.divider, { backgroundColor: theme.colors.divider }]} />

          <TouchableOpacity style={[styles.testButton, { backgroundColor: theme.colors.buttonBackground }]} onPress={handleTestNotification}>
            <Text style={styles.testButtonText}>Test Notification</Text>
          </TouchableOpacity>
        </View>

        {/* Risk Management */}
        <View style={[styles.card, { backgroundColor: theme.colors.card }]}>
          <Text style={[styles.cardTitle, { color: theme.colors.text }]}>Quick Actions</Text>
          <View style={styles.actionGrid}>
            <TouchableOpacity
              style={styles.actionButton}
              onPress={() => sendCommand('CLOSE_PROFITABLE')}
            >
              <Text style={styles.actionText}>Close Winners</Text>
            </TouchableOpacity>

            <TouchableOpacity
              style={styles.actionButton}
              onPress={() => sendCommand('CLOSE_LOSING')}
            >
              <Text style={styles.actionText}>Close Losers</Text>
            </TouchableOpacity>
          </View>
        </View>

      </ScrollView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: '#F5F5F5',
  },
  scrollContent: {
    padding: 16,
  },
  title: {
    fontSize: 28,
    fontWeight: 'bold',
    color: '#333',
    marginBottom: 24,
  },
  card: {
    backgroundColor: '#FFF',
    borderRadius: 16,
    padding: 20,
    marginBottom: 16,
    elevation: 2,
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 1 },
    shadowOpacity: 0.1,
    shadowRadius: 2,
  },
  dangerCard: {
    backgroundColor: '#FFEBEE',
    borderWidth: 1,
    borderColor: '#FFCDD2',
  },
  dangerTitle: {
    color: '#D32F2F',
    fontWeight: '900',
    fontSize: 16,
    marginBottom: 8,
    textTransform: 'uppercase',
  },
  cardTitle: {
    fontSize: 18,
    fontWeight: '700',
    color: '#333',
    marginBottom: 16,
  },
  cardDesc: {
    color: '#666',
    marginBottom: 16,
  },
  killButton: {
    backgroundColor: '#D32F2F',
    paddingVertical: 16,
    borderRadius: 12,
    alignItems: 'center',
    shadowColor: '#D32F2F',
    shadowOffset: { width: 0, height: 4 },
    shadowOpacity: 0.3,
    shadowRadius: 6,
    elevation: 5,
  },
  killButtonText: {
    color: '#FFF',
    fontWeight: '900',
    fontSize: 18,
    letterSpacing: 1,
  },
  divider: {
    height: 1,
    backgroundColor: '#EEE',
    marginVertical: 12,
  },
  testButton: {
    paddingVertical: 12,
    alignItems: 'center',
  },
  testButtonText: {
    color: '#2196F3',
    fontWeight: '600',
    fontSize: 16,
  },
  settingRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    paddingVertical: 8,
  },
  settingLabel: {
    fontSize: 16,
    color: '#333',
  },
  actionGrid: {
    flexDirection: 'row',
    gap: 12,
  },
  actionButton: {
    flex: 1,
    backgroundColor: '#E0E0E0',
    padding: 16,
    borderRadius: 12,
    alignItems: 'center',
  },
  actionText: {
    fontWeight: '600',
    color: '#333',
  },
});
