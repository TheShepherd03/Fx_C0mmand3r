import React, { useState } from 'react';
import {
  View,
  Text,
  TouchableOpacity,
  StyleSheet,
  Alert,
  ScrollView,
} from 'react-native';
import { EAScheduleSettings } from '@/constants/types';
import { useTheme } from '@/contexts/ThemeContext';
import { useAccount } from '@/contexts/AccountContext';
import { database } from '@/firebaseConfig';
import { ref, set } from 'firebase/database';

interface EAScheduleManagerProps {
  currentSchedule?: EAScheduleSettings;
  onUpdate: () => void;
}

export function EAScheduleManager({ currentSchedule, onUpdate }: EAScheduleManagerProps) {
  const { theme } = useTheme();
  const { selectedAccount } = useAccount();
  const [schedule, setSchedule] = useState<EAScheduleSettings>(
    currentSchedule || {
      enabled: true,
      pauseStartTime: '13:00',
      pauseEndTime: '14:00',
      pauseMode: 0,
    }
  );

  const sendCommand = async (action: string, payload: any) => {
    if (!selectedAccount) {
      Alert.alert("Error", "No account selected");
      return false;
    }

    try {
      const commandRef = ref(database, `commands/${selectedAccount}/latest`);
      await set(commandRef, {
        action,
        ...payload,
        status: 'PENDING',
        timestamp: Math.floor(Date.now() / 1000)
      });
      return true;
    } catch {
      Alert.alert("Error", "Failed to send command");
      return false;
    }
  };

  const handleScheduleUpdate = async () => {
    const success = await sendCommand('SET_EA_SCHEDULE', schedule);
    
    if (success) {
      Alert.alert("Success", "EA Schedule updated successfully");
      onUpdate();
    }
  };

  const handleQuickPause = async (duration: number, label: string) => {
    Alert.alert(
      "Confirm EA Pause",
      `Pause EA for ${label}? This will stop new trades.`,
      [
        { text: "Cancel", style: "cancel" },
        {
          text: "Pause",
          style: "destructive",
          onPress: async () => {
            const success = await sendCommand('SET_EA_PAUSE', {
              pauseDuration: duration,
              pauseMode: 0, // No new trades
              immediate: true
            });
            
            if (success) {
              Alert.alert("Success", `EA paused for ${label}`);
              onUpdate();
            }
          }
        }
      ]
    );
  };

  const handleResumeEA = async () => {
    const success = await sendCommand('SET_EA_PAUSE', {
      immediate: false // Resume EA
    });
    
    if (success) {
      Alert.alert("Success", "EA resumed successfully");
      onUpdate();
    }
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
      {/* EA Status Indicator */}
      <View style={[styles.statusCard, { backgroundColor: theme.colors.card }]}>
        <View style={styles.statusHeader}>
          <View style={styles.statusIndicator}>
            <View style={[styles.statusDot, { backgroundColor: theme.colors.success }]} />
            <Text style={[styles.statusText, { color: theme.colors.text }]}>
              EA Active
            </Text>
          </View>
          <Text style={[styles.nextAction, { color: theme.colors.textSecondary }]}>
            Next: Pause at {schedule.pauseStartTime}
          </Text>
        </View>
      </View>

      {/* Schedule Visualization */}
      <View style={[styles.card, { backgroundColor: theme.colors.card }]}>
        <Text style={[styles.cardTitle, { color: theme.colors.text }]}>
          📅 Daily Schedule
        </Text>
        
        <View style={styles.timelineContainer}>
          <Text style={[styles.timelineLabel, { color: theme.colors.textSecondary }]}>
            09:00 ████████████████░░░░ 17:00
          </Text>
          <View style={styles.timelineDetails}>
            <Text style={[styles.timelineText, { color: theme.colors.text }]}>
              Active
            </Text>
            <View style={[styles.pauseWindow, { backgroundColor: theme.colors.error }]}>
              <Text style={styles.pauseWindowText}>
                {schedule.pauseStartTime}-{schedule.pauseEndTime}
              </Text>
            </View>
            <Text style={[styles.timelineText, { color: theme.colors.text }]}>
              Active
            </Text>
          </View>
        </View>
      </View>

      {/* Schedule Settings */}
      <View style={[styles.card, { backgroundColor: theme.colors.card }]}>
        <Text style={[styles.cardTitle, { color: theme.colors.text }]}>
          ⚙️ Schedule Settings
        </Text>
        
        {/* Pause Start Time */}
        <View style={styles.settingSection}>
          <Text style={[styles.settingLabel, { color: theme.colors.text }]}>
            Pause Start Time
          </Text>
          <View style={styles.timeButtons}>
            {timeButtons.map((time) => (
              <TouchableOpacity
                key={time.hour}
                style={[
                  styles.timeButton,
                  { borderColor: theme.colors.border },
                  schedule.pauseStartTime === time.label && { 
                    backgroundColor: theme.colors.primary,
                    borderColor: theme.colors.primary 
                  }
                ]}
                onPress={() => setSchedule({
                  ...schedule,
                  pauseStartTime: time.label
                })}
              >
                <Text style={[
                  styles.timeButtonText,
                  { color: schedule.pauseStartTime === time.label ? '#fff' : theme.colors.text }
                ]}>
                  {time.label}
                </Text>
              </TouchableOpacity>
            ))}
          </View>
        </View>

        {/* Pause End Time */}
        <View style={styles.settingSection}>
          <Text style={[styles.settingLabel, { color: theme.colors.text }]}>
            Pause End Time
          </Text>
          <View style={styles.timeButtons}>
            {timeButtons.map((time) => (
              <TouchableOpacity
                key={time.hour}
                style={[
                  styles.timeButton,
                  { borderColor: theme.colors.border },
                  schedule.pauseEndTime === time.label && { 
                    backgroundColor: theme.colors.primary,
                    borderColor: theme.colors.primary 
                  }
                ]}
                onPress={() => setSchedule({
                  ...schedule,
                  pauseEndTime: time.label
                })}
              >
                <Text style={[
                  styles.timeButtonText,
                  { color: schedule.pauseEndTime === time.label ? '#fff' : theme.colors.text }
                ]}>
                  {time.label}
                </Text>
              </TouchableOpacity>
            ))}
          </View>
        </View>

        {/* Pause Mode */}
        <View style={styles.settingSection}>
          <Text style={[styles.settingLabel, { color: theme.colors.text }]}>
            Pause Mode
          </Text>
          <View style={styles.modeButtons}>
            {pauseModeLabels.map((mode, index) => (
              <TouchableOpacity
                key={index}
                style={[
                  styles.modeButton,
                  { borderColor: theme.colors.border },
                  schedule.pauseMode === index && { 
                    backgroundColor: theme.colors.primary,
                    borderColor: theme.colors.primary 
                  }
                ]}
                onPress={() => setSchedule({
                  ...schedule,
                  pauseMode: index
                })}
              >
                <Text style={[
                  styles.modeButtonText,
                  { color: schedule.pauseMode === index ? '#fff' : theme.colors.text }
                ]}>
                  {mode}
                </Text>
              </TouchableOpacity>
            ))}
          </View>
        </View>

        <TouchableOpacity
          style={[styles.saveButton, { backgroundColor: theme.colors.primary }]}
          onPress={handleScheduleUpdate}
        >
          <Text style={styles.saveButtonText}>Save Schedule</Text>
        </TouchableOpacity>
      </View>

      {/* Quick Pause Actions */}
      <View style={[styles.card, { backgroundColor: theme.colors.card }]}>
        <Text style={[styles.cardTitle, { color: theme.colors.text }]}>
          ⏸️ Quick Pause
        </Text>
        <Text style={[styles.description, { color: theme.colors.textSecondary }]}>
          Temporarily pause EA operations
        </Text>
        
        <View style={styles.quickPauseButtons}>
          {[
            { duration: 900, label: '15min' },
            { duration: 1800, label: '30min' },
            { duration: 3600, label: '1hr' },
            { duration: 7200, label: '2hr' },
          ].map((pause) => (
            <TouchableOpacity
              key={pause.duration}
              style={[styles.quickPauseButton, { backgroundColor: theme.colors.warning }]}
              onPress={() => handleQuickPause(pause.duration, pause.label)}
            >
              <Text style={styles.quickPauseButtonText}>{pause.label}</Text>
            </TouchableOpacity>
          ))}
        </View>

        <TouchableOpacity
          style={[styles.resumeButton, { backgroundColor: theme.colors.success }]}
          onPress={handleResumeEA}
        >
          <Text style={styles.resumeButtonText}>▶️ Resume EA</Text>
        </TouchableOpacity>
      </View>
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
  },
  statusCard: {
    padding: 16,
    borderRadius: 12,
    marginBottom: 16,
  },
  statusHeader: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
  },
  statusIndicator: {
    flexDirection: 'row',
    alignItems: 'center',
  },
  statusDot: {
    width: 8,
    height: 8,
    borderRadius: 4,
    marginRight: 8,
  },
  statusText: {
    fontSize: 16,
    fontWeight: '600',
  },
  nextAction: {
    fontSize: 14,
  },
  card: {
    padding: 20,
    borderRadius: 12,
    marginBottom: 16,
  },
  cardTitle: {
    fontSize: 18,
    fontWeight: 'bold',
    marginBottom: 16,
  },
  description: {
    fontSize: 14,
    marginBottom: 16,
    lineHeight: 20,
  },
  timelineContainer: {
    marginVertical: 10,
  },
  timelineLabel: {
    fontSize: 14,
    fontFamily: 'monospace',
    textAlign: 'center',
    marginBottom: 8,
  },
  timelineDetails: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
  },
  timelineText: {
    fontSize: 12,
    flex: 1,
    textAlign: 'center',
  },
  pauseWindow: {
    paddingHorizontal: 8,
    paddingVertical: 4,
    borderRadius: 4,
    flex: 1,
    alignItems: 'center',
  },
  pauseWindowText: {
    color: '#fff',
    fontSize: 10,
    fontWeight: 'bold',
  },
  settingSection: {
    marginBottom: 20,
  },
  settingLabel: {
    fontSize: 16,
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
  saveButton: {
    paddingVertical: 12,
    borderRadius: 8,
    alignItems: 'center',
    marginTop: 10,
  },
  saveButtonText: {
    color: '#fff',
    fontSize: 16,
    fontWeight: 'bold',
  },
  quickPauseButtons: {
    flexDirection: 'row',
    gap: 8,
    marginBottom: 16,
  },
  quickPauseButton: {
    flex: 1,
    paddingVertical: 12,
    borderRadius: 8,
    alignItems: 'center',
  },
  quickPauseButtonText: {
    color: '#fff',
    fontSize: 14,
    fontWeight: 'bold',
  },
  resumeButton: {
    paddingVertical: 12,
    borderRadius: 8,
    alignItems: 'center',
  },
  resumeButtonText: {
    color: '#fff',
    fontSize: 16,
    fontWeight: 'bold',
  },
});
