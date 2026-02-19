import React, { useState, useEffect } from 'react';
import {
  View,
  Text,
  TouchableOpacity,
  StyleSheet,
  Alert,
  ScrollView,
  Switch,
  TextInput,
} from 'react-native';
import { useTheme } from '@/contexts/ThemeContext';
import { useAccount } from '@/contexts/AccountContext';
import { database } from '@/firebaseConfig';
import { ref, set, get } from 'firebase/database';

interface EASettings {
  // Position Management
  enableBreakeven: boolean;
  breakevenThresholdPips: number;
  enableTrailing: boolean;
  enableTimeManagement: boolean;
  weekendClose: boolean;
  dailyTargetPercent: number;

  // EA Schedule
  enableSchedule: boolean;
  pauseStartTime: string;
  pauseEndTime: string;
  pauseMode: number;
}

const defaultSettings: EASettings = {
  enableBreakeven: true,
  breakevenThresholdPips: 10,
  enableTrailing: true,
  enableTimeManagement: true,
  weekendClose: true,
  dailyTargetPercent: 5.0,
  enableSchedule: true,
  pauseStartTime: "13:00",
  pauseEndTime: "14:00",
  pauseMode: 0,
};

interface EASettingsManagerProps {
  onUpdate: () => void;
}

export function EASettingsManager({ onUpdate }: EASettingsManagerProps) {
  const { theme } = useTheme();
  const { selectedAccount } = useAccount();
  const [settings, setSettings] = useState<EASettings>(defaultSettings);
  const [loading, setLoading] = useState(false);
  const [hasChanges, setHasChanges] = useState(false);

  // Load settings on mount
  const loadSettings = React.useCallback(async () => {
    if (!selectedAccount) return;

    try {
      setLoading(true);
      const settingsRef = ref(database, `settings/${selectedAccount}`);
      const snapshot = await get(settingsRef);

      if (snapshot.exists()) {
        const loadedSettings = snapshot.val();
        setSettings({ ...defaultSettings, ...loadedSettings });
      } else {
        setSettings(defaultSettings);
      }
    } catch {
      Alert.alert("Error", "Failed to load EA settings");
    } finally {
      setLoading(false);
    }
  }, [selectedAccount]);

  useEffect(() => {
    loadSettings();
  }, [loadSettings]);

  const saveSettings = async () => {
    if (!selectedAccount) {
      Alert.alert("Error", "No account selected");
      return;
    }

    try {
      setLoading(true);
      const settingsRef = ref(database, `settings/${selectedAccount}`);
      await set(settingsRef, {
        ...settings,
        lastUpdated: Math.floor(Date.now() / 1000)
      });

      setHasChanges(false);
      Alert.alert("Success", "EA settings saved successfully. The EA will load these settings within 10 seconds.");
      onUpdate();
    } catch {
      Alert.alert("Error", "Failed to save EA settings");
    } finally {
      setLoading(false);
    }
  };

  const updateSetting = <K extends keyof EASettings>(key: K, value: EASettings[K]) => {
    setSettings(prev => ({ ...prev, [key]: value }));
    setHasChanges(true);
  };

  const resetToDefaults = () => {
    Alert.alert(
      "Reset Settings",
      "Reset all EA settings to defaults?",
      [
        { text: "Cancel", style: "cancel" },
        {
          text: "Reset",
          style: "destructive",
          onPress: () => {
            setSettings(defaultSettings);
            setHasChanges(true);
          }
        }
      ]
    );
  };

  const timeButtons = [
    { hour: 9, label: '09:00' },
    { hour: 10, label: '10:00' },
    { hour: 11, label: '11:00' },
    { hour: 12, label: '12:00' },
    { hour: 13, label: '13:00' },
    { hour: 14, label: '14:00' },
    { hour: 15, label: '15:00' },
    { hour: 16, label: '16:00' },
    { hour: 17, label: '17:00' },
  ];

  const pauseModeLabels = ['No New Trades', 'Close All', 'Maintain Only'];

  return (
    <ScrollView style={styles.container}>
      {/* Header */}
      <View style={[styles.header, { backgroundColor: theme.colors.card }]}>
        <View>
          <Text style={[styles.title, { color: theme.colors.text }]}>
            ⚙️ EA Settings
          </Text>
          <Text style={[styles.subtitle, { color: theme.colors.textSecondary }]}>
            Configure trade management parameters
          </Text>
        </View>
        {hasChanges && (
          <View style={[styles.badge, { backgroundColor: theme.colors.warning }]}>
            <Text style={styles.badgeText}>●</Text>
          </View>
        )}
      </View>

      {/* Position Management Settings */}
      <View style={[styles.card, { backgroundColor: theme.colors.card }]}>
        <Text style={[styles.sectionTitle, { color: theme.colors.text }]}>
          📈 Position Management
        </Text>

        <View style={styles.settingRow}>
          <Text style={[styles.settingLabel, { color: theme.colors.text }]}>Break-Even</Text>
          <Switch
            value={settings.enableBreakeven}
            onValueChange={(value) => updateSetting('enableBreakeven', value)}
            trackColor={{ false: theme.colors.input, true: theme.colors.primary }}
            thumbColor="#FFF"
          />
        </View>

        {settings.enableBreakeven && (
          <View style={styles.inputRow}>
            <Text style={[styles.inputLabel, { color: theme.colors.textSecondary }]}>
              Threshold (Pips)
            </Text>
            <TextInput
              style={[styles.input, {
                borderColor: theme.colors.border,
                color: theme.colors.text,
                backgroundColor: theme.colors.input
              }]}
              value={settings.breakevenThresholdPips.toString()}
              onChangeText={(text) => {
                const value = parseInt(text) || 0;
                updateSetting('breakevenThresholdPips', Math.max(0, Math.min(100, value)));
              }}
              keyboardType="numeric"
              maxLength={3}
            />
          </View>
        )}

        <View style={styles.settingRow}>
          <Text style={[styles.settingLabel, { color: theme.colors.text }]}>Trailing Stops</Text>
          <Switch
            value={settings.enableTrailing}
            onValueChange={(value) => updateSetting('enableTrailing', value)}
            trackColor={{ false: theme.colors.input, true: theme.colors.primary }}
            thumbColor="#FFF"
          />
        </View>

        <View style={styles.settingRow}>
          <Text style={[styles.settingLabel, { color: theme.colors.text }]}>Time Management</Text>
          <Switch
            value={settings.enableTimeManagement}
            onValueChange={(value) => updateSetting('enableTimeManagement', value)}
            trackColor={{ false: theme.colors.input, true: theme.colors.primary }}
            thumbColor="#FFF"
          />
        </View>

        <View style={styles.settingRow}>
          <Text style={[styles.settingLabel, { color: theme.colors.text }]}>Weekend Close</Text>
          <Switch
            value={settings.weekendClose}
            onValueChange={(value) => updateSetting('weekendClose', value)}
            trackColor={{ false: theme.colors.input, true: theme.colors.primary }}
            thumbColor="#FFF"
          />
        </View>

        <View style={styles.inputRow}>
          <Text style={[styles.inputLabel, { color: theme.colors.textSecondary }]}>
            Daily Target (%)
          </Text>
          <TextInput
            style={[styles.input, {
              borderColor: theme.colors.border,
              color: theme.colors.text,
              backgroundColor: theme.colors.input
            }]}
            value={settings.dailyTargetPercent.toString()}
            onChangeText={(text) => {
              const value = parseFloat(text) || 0;
              updateSetting('dailyTargetPercent', Math.max(0, Math.min(50, value)));
            }}
            keyboardType="numeric"
            maxLength={4}
          />
        </View>
      </View>

      {/* EA Schedule Settings */}
      <View style={[styles.card, { backgroundColor: theme.colors.card }]}>
        <Text style={[styles.sectionTitle, { color: theme.colors.text }]}>
          ⏰ EA Schedule
        </Text>

        <View style={styles.settingRow}>
          <Text style={[styles.settingLabel, { color: theme.colors.text }]}>Enable Schedule</Text>
          <Switch
            value={settings.enableSchedule}
            onValueChange={(value) => updateSetting('enableSchedule', value)}
            trackColor={{ false: theme.colors.input, true: theme.colors.primary }}
            thumbColor="#FFF"
          />
        </View>

        {settings.enableSchedule && (
          <>
            <Text style={[styles.subLabel, { color: theme.colors.textSecondary }]}>
              Pause Start Time
            </Text>
            <View style={styles.timeButtons}>
              {timeButtons.map((time) => (
                <TouchableOpacity
                  key={`start-${time.hour}`}
                  style={[
                    styles.timeButton,
                    { borderColor: theme.colors.border, backgroundColor: theme.colors.input },
                    settings.pauseStartTime === time.label && {
                      backgroundColor: theme.colors.primary,
                      borderColor: theme.colors.primary
                    }
                  ]}
                  onPress={() => updateSetting('pauseStartTime', time.label)}
                >
                  <Text style={[
                    styles.timeButtonText,
                    { color: settings.pauseStartTime === time.label ? '#fff' : theme.colors.text }
                  ]}>
                    {time.label}
                  </Text>
                </TouchableOpacity>
              ))}
            </View>

            <Text style={[styles.subLabel, { color: theme.colors.textSecondary, marginTop: 16 }]}>
              Pause End Time
            </Text>
            <View style={styles.timeButtons}>
              {timeButtons.map((time) => (
                <TouchableOpacity
                  key={`end-${time.hour}`}
                  style={[
                    styles.timeButton,
                    { borderColor: theme.colors.border, backgroundColor: theme.colors.input },
                    settings.pauseEndTime === time.label && {
                      backgroundColor: theme.colors.primary,
                      borderColor: theme.colors.primary
                    }
                  ]}
                  onPress={() => updateSetting('pauseEndTime', time.label)}
                >
                  <Text style={[
                    styles.timeButtonText,
                    { color: settings.pauseEndTime === time.label ? '#fff' : theme.colors.text }
                  ]}>
                    {time.label}
                  </Text>
                </TouchableOpacity>
              ))}
            </View>

            <Text style={[styles.subLabel, { color: theme.colors.textSecondary, marginTop: 16 }]}>
              Pause Mode
            </Text>
            <View style={styles.modeButtons}>
              {pauseModeLabels.map((mode, index) => (
                <TouchableOpacity
                  key={index}
                  style={[
                    styles.modeButton,
                    { borderColor: theme.colors.border, backgroundColor: theme.colors.input },
                    settings.pauseMode === index && {
                      backgroundColor: theme.colors.primary,
                      borderColor: theme.colors.primary
                    }
                  ]}
                  onPress={() => updateSetting('pauseMode', index)}
                >
                  <Text style={[
                    styles.modeButtonText,
                    { color: settings.pauseMode === index ? '#fff' : theme.colors.text }
                  ]}>
                    {mode}
                  </Text>
                </TouchableOpacity>
              ))}
            </View>
          </>
        )}
      </View>

      {/* Action Buttons */}
      <View style={styles.actionButtons}>
        <TouchableOpacity
          style={[styles.resetButton, { backgroundColor: theme.colors.error }]}
          onPress={resetToDefaults}
          disabled={loading}
        >
          <Text style={styles.resetButtonText}>Reset Defaults</Text>
        </TouchableOpacity>

        <TouchableOpacity
          style={[
            styles.saveButton,
            { backgroundColor: hasChanges ? theme.colors.primary : theme.colors.input }
          ]}
          onPress={saveSettings}
          disabled={!hasChanges || loading}
        >
          <Text style={[
            styles.saveButtonText,
            { color: hasChanges ? '#fff' : theme.colors.textSecondary }
          ]}>
            {loading ? 'Saving...' : 'Save Settings'}
          </Text>
        </TouchableOpacity>
      </View>

      {/* Info */}
      <View style={[styles.infoCard, { backgroundColor: theme.colors.card }]}>
        <Text style={[styles.infoText, { color: theme.colors.textSecondary }]}>
          💡 These settings control EA behavior. The EA loads them automatically every 10 seconds.
          Changes apply to all new positions and position management operations.
        </Text>
      </View>
    </ScrollView>
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
    padding: 16,
    borderRadius: 12,
    marginBottom: 16,
  },
  title: {
    fontSize: 20,
    fontWeight: 'bold',
  },
  subtitle: {
    fontSize: 14,
    marginTop: 2,
  },
  badge: {
    width: 12,
    height: 12,
    borderRadius: 6,
    alignItems: 'center',
    justifyContent: 'center',
  },
  badgeText: {
    color: '#fff',
    fontSize: 8,
    fontWeight: 'bold',
  },
  card: {
    padding: 20,
    borderRadius: 12,
    marginBottom: 16,
  },
  sectionTitle: {
    fontSize: 18,
    fontWeight: 'bold',
    marginBottom: 16,
  },
  settingRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    paddingVertical: 12,
  },
  settingLabel: {
    fontSize: 16,
    fontWeight: '500',
  },
  inputRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    marginBottom: 16,
  },
  inputLabel: {
    fontSize: 14,
    fontWeight: '500',
  },
  input: {
    borderWidth: 1,
    borderRadius: 8,
    paddingHorizontal: 12,
    paddingVertical: 8,
    fontSize: 16,
    minWidth: 80,
    textAlign: 'center',
  },
  subLabel: {
    fontSize: 14,
    fontWeight: '600',
    marginBottom: 12,
  },
  timeButtons: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 8,
  },
  timeButton: {
    paddingHorizontal: 16,
    paddingVertical: 10,
    borderWidth: 1,
    borderRadius: 8,
    minWidth: 70,
    alignItems: 'center',
  },
  timeButtonText: {
    fontSize: 14,
    fontWeight: '500',
  },
  modeButtons: {
    gap: 8,
  },
  modeButton: {
    paddingHorizontal: 16,
    paddingVertical: 12,
    borderWidth: 1,
    borderRadius: 8,
    alignItems: 'center',
  },
  modeButtonText: {
    fontSize: 14,
    fontWeight: '500',
  },
  actionButtons: {
    flexDirection: 'row',
    gap: 12,
    marginBottom: 16,
  },
  resetButton: {
    flex: 1,
    paddingVertical: 14,
    borderRadius: 8,
    alignItems: 'center',
  },
  resetButtonText: {
    color: '#fff',
    fontSize: 16,
    fontWeight: 'bold',
  },
  saveButton: {
    flex: 2,
    paddingVertical: 14,
    borderRadius: 8,
    alignItems: 'center',
  },
  saveButtonText: {
    fontSize: 16,
    fontWeight: 'bold',
  },
  infoCard: {
    padding: 16,
    borderRadius: 12,
    marginBottom: 20,
  },
  infoText: {
    fontSize: 14,
    lineHeight: 20,
    textAlign: 'center',
  },
});
