import React, { useState, useEffect } from 'react';
import {
  Modal,
  View,
  Text,
  TouchableOpacity,
  TextInput,
  Switch,
  ScrollView,
  StyleSheet,
  Alert,
  ActivityIndicator,
} from 'react-native';
import { Position } from '@/constants/types';
import { useTheme } from '@/contexts/ThemeContext';
import { useAccount } from '@/contexts/AccountContext';
import { database } from '@/firebaseConfig';
import { ref, set } from 'firebase/database';
import { IconSymbol } from '@/components/ui/icon-symbol';

interface PositionManagementModalProps {
  visible: boolean;
  position: Position | null;
  onClose: () => void;
  onUpdate: () => void;
}

export function PositionManagementModal({
  visible,
  position,
  onClose,
  onUpdate
}: PositionManagementModalProps) {
  const { theme } = useTheme();
  const { selectedAccount } = useAccount();
  const [activeTab, setActiveTab] = useState<'breakeven' | 'trailing' | 'partial' | 'scale' | 'time'>('breakeven');
  const [isProcessing, setIsProcessing] = useState(false);

  // Break-even settings
  const [breakevenEnabled, setBreakevenEnabled] = useState(false);
  const [breakevenThreshold, setBreakevenThreshold] = useState('10');

  // Trailing stop settings
  const [trailingEnabled, setTrailingEnabled] = useState(false);
  const [trailingPercentage, setTrailingPercentage] = useState(20);

  // Partial close settings
  const [partialPercentage, setPartialPercentage] = useState(50);

  // Scale-in settings
  const [scaleInMultiplier, setScaleInMultiplier] = useState('1.5');
  const [scaleInThreshold, setScaleInThreshold] = useState('20');

  // Time management settings
  const [timeLimit, setTimeLimit] = useState('');
  const [weekendClose, setWeekendClose] = useState(true);

  useEffect(() => {
    if (position) {
      setBreakevenEnabled(position.breakevenEnabled || false);
      setTrailingEnabled(position.trailingEnabled || false);
      setTrailingPercentage(position.trailingPercentage || 20);
    }
  }, [position]);

  const sendCommand = async (action: string, payload: any) => {
    if (!selectedAccount) {
      Alert.alert("Error", "No account selected");
      return;
    }

    setIsProcessing(true);
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
    } finally {
      setIsProcessing(false);
    }
  };

  const handleBreakevenSave = async () => {
    if (!position) return;

    const success = await sendCommand('SET_BREAKEVEN', {
      ticket: position.ticket,
      threshold: parseInt(breakevenThreshold),
      enabled: breakevenEnabled
    });

    if (success) {
      Alert.alert("Success", `Break-even ${breakevenEnabled ? 'enabled' : 'disabled'} for position ${position.ticket}`);
      onUpdate();
    }
  };

  const handleTrailingSave = async () => {
    if (!position) return;

    const success = await sendCommand('SET_TRAILING_STOP', {
      ticket: position.ticket,
      trailPercentage: trailingPercentage,
      enabled: trailingEnabled
    });

    if (success) {
      Alert.alert("Success", `Trailing stop ${trailingEnabled ? 'enabled' : 'disabled'} for position ${position.ticket}`);
      onUpdate();
    }
  };

  const handlePartialClose = async () => {
    if (!position) return;

    Alert.alert(
      "Confirm Partial Close",
      `Close ${partialPercentage}% of position ${position.ticket}?`,
      [
        { text: "Cancel", style: "cancel" },
        {
          text: "Close",
          style: "destructive",
          onPress: async () => {
            const success = await sendCommand('PARTIAL_CLOSE', {
              ticket: position.ticket,
              percentage: partialPercentage
            });

            if (success) {
              Alert.alert("Success", `Partial close order sent for ${partialPercentage}%`);
              onUpdate();
              onClose();
            }
          }
        }
      ]
    );
  };

  const handleScaleIn = async () => {
    if (!position) return;

    Alert.alert(
      "Confirm Scale-In",
      `Add ${scaleInMultiplier}x lots to position ${position.ticket}?`,
      [
        { text: "Cancel", style: "cancel" },
        {
          text: "Scale In",
          onPress: async () => {
            const success = await sendCommand('SCALE_IN', {
              ticket: position.ticket,
              lotMultiplier: parseFloat(scaleInMultiplier),
              profitThreshold: parseInt(scaleInThreshold)
            });

            if (success) {
              Alert.alert("Success", `Scale-in order sent with ${scaleInMultiplier}x multiplier`);
              onUpdate();
              onClose();
            }
          }
        }
      ]
    );
  };

  if (!position) return null;

  const profitColor = position.profit >= 0 ? theme.colors.success : theme.colors.error;

  return (
    <Modal
      visible={visible}
      animationType="slide"
      presentationStyle="pageSheet"
      onRequestClose={onClose}
    >
      <View style={[styles.container, { backgroundColor: theme.colors.background }]}>
        {/* Header */}
        <View style={[styles.header, { borderBottomColor: theme.colors.border }]}>
          <View>
            <Text style={[styles.title, { color: theme.colors.text }]}>
              {position.symbol} #{position.ticket}
            </Text>
            <Text style={[styles.subtitle, { color: profitColor }]}>
              {position.type === 0 ? 'BUY' : 'SELL'} {position.lots} lots • ${position.profit.toFixed(2)}
            </Text>
          </View>
          <TouchableOpacity
            style={[styles.closeButton, { backgroundColor: theme.colors.input }]}
            onPress={onClose}
          >
            <IconSymbol name="xmark" size={16} color={theme.colors.textSecondary} />
          </TouchableOpacity>
        </View>

        {/* Tabs */}
        <View style={styles.tabWrapper}>
          <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.tabContainer}>
            {[
              { key: 'breakeven', label: 'Break-Even', icon: 'scalemass' },
              { key: 'trailing', label: 'Trailing', icon: 'chart.line.uptrend.xyaxis' },
              { key: 'partial', label: 'Partial', icon: 'scissors' },
              { key: 'scale', label: 'Scale-In', icon: 'chart.bar.fill' },
              { key: 'time', label: 'Time', icon: 'clock' },
            ].map((tab) => (
              <TouchableOpacity
                key={tab.key}
                style={[
                  styles.tab,
                  activeTab === tab.key && [styles.activeTab, { backgroundColor: theme.colors.primary }]
                ]}
                onPress={() => setActiveTab(tab.key as any)}
              >
                <IconSymbol
                  name={tab.icon as any}
                  size={16}
                  color={activeTab === tab.key ? '#fff' : theme.colors.textSecondary}
                  style={{ marginRight: 6 }}
                />
                <Text style={[
                  styles.tabText,
                  { color: activeTab === tab.key ? '#fff' : theme.colors.textSecondary }
                ]}>
                  {tab.label}
                </Text>
              </TouchableOpacity>
            ))}
          </ScrollView>
        </View>

        {/* Content */}
        <ScrollView style={styles.content}>
          {activeTab === 'breakeven' && (
            <View style={styles.tabContent}>
              <View style={[styles.card, { backgroundColor: theme.colors.card }]}>
                <View style={styles.settingRow}>
                  <Text style={[styles.settingLabel, { color: theme.colors.text }]}>
                    Enable Break-Even
                  </Text>
                  <Switch
                    value={breakevenEnabled}
                    onValueChange={setBreakevenEnabled}
                    trackColor={{ false: theme.colors.input, true: theme.colors.primary }}
                    thumbColor="#FFF"
                  />
                </View>

                <Text style={[styles.description, { color: theme.colors.textSecondary }]}>
                  Move stop loss to entry price when profit reaches threshold
                </Text>

                <View style={styles.inputGroup}>
                  <Text style={[styles.inputLabel, { color: theme.colors.text }]}>
                    Profit Threshold (pips)
                  </Text>
                  <TextInput
                    style={[styles.input, {
                      backgroundColor: theme.colors.input,
                      color: theme.colors.text,
                      borderColor: theme.colors.border
                    }]}
                    value={breakevenThreshold}
                    onChangeText={setBreakevenThreshold}
                    placeholder="10"
                    keyboardType="numeric"
                    placeholderTextColor={theme.colors.textTertiary}
                  />
                </View>

                <TouchableOpacity
                  style={[styles.saveButton, { backgroundColor: theme.colors.primary, opacity: isProcessing ? 0.7 : 1 }]}
                  onPress={handleBreakevenSave}
                  disabled={isProcessing}
                >
                  {isProcessing ? (
                    <ActivityIndicator color="#fff" />
                  ) : (
                    <Text style={styles.saveButtonText}>Save Break-Even Settings</Text>
                  )}
                </TouchableOpacity>
              </View>
            </View>
          )}

          {activeTab === 'trailing' && (
            <View style={styles.tabContent}>
              <View style={[styles.card, { backgroundColor: theme.colors.card }]}>
                <View style={styles.settingRow}>
                  <Text style={[styles.settingLabel, { color: theme.colors.text }]}>
                    Enable Trailing Stop
                  </Text>
                  <Switch
                    value={trailingEnabled}
                    onValueChange={setTrailingEnabled}
                    trackColor={{ false: theme.colors.input, true: theme.colors.primary }}
                    thumbColor="#FFF"
                  />
                </View>

                <Text style={[styles.description, { color: theme.colors.textSecondary }]}>
                  Trail stop loss when profit reaches percentage of distance to TP
                </Text>

                <Text style={[styles.inputLabel, { color: theme.colors.text }]}>
                  Trail Percentage
                </Text>
                <View style={styles.percentageButtons}>
                  {[12, 20, 50, 100].map((percent) => (
                    <TouchableOpacity
                      key={percent}
                      style={[
                        styles.percentageButton,
                        { borderColor: theme.colors.border },
                        trailingPercentage === percent && {
                          backgroundColor: theme.colors.primary,
                          borderColor: theme.colors.primary
                        }
                      ]}
                      onPress={() => setTrailingPercentage(percent)}
                    >
                      <Text style={[
                        styles.percentageButtonText,
                        { color: trailingPercentage === percent ? '#fff' : theme.colors.text }
                      ]}>
                        {percent}%
                      </Text>
                    </TouchableOpacity>
                  ))}
                </View>

                <TouchableOpacity
                  style={[styles.saveButton, { backgroundColor: theme.colors.primary, opacity: isProcessing ? 0.7 : 1 }]}
                  onPress={handleTrailingSave}
                  disabled={isProcessing}
                >
                  {isProcessing ? (
                    <ActivityIndicator color="#fff" />
                  ) : (
                    <Text style={styles.saveButtonText}>Save Trailing Settings</Text>
                  )}
                </TouchableOpacity>
              </View>
            </View>
          )}

          {activeTab === 'partial' && (
            <View style={styles.tabContent}>
              <View style={[styles.card, { backgroundColor: theme.colors.card }]}>
                <Text style={[styles.cardTitle, { color: theme.colors.text }]}>
                  Partial Close Position
                </Text>
                <Text style={[styles.description, { color: theme.colors.textSecondary }]}>
                  Close percentage of current position to lock in profits
                </Text>

                <Text style={[styles.inputLabel, { color: theme.colors.text }]}>
                  Close Percentage
                </Text>
                <View style={styles.percentageButtons}>
                  {[25, 50, 75].map((percent) => (
                    <TouchableOpacity
                      key={percent}
                      style={[
                        styles.percentageButton,
                        { borderColor: theme.colors.border },
                        partialPercentage === percent && {
                          backgroundColor: theme.colors.primary,
                          borderColor: theme.colors.primary
                        }
                      ]}
                      onPress={() => setPartialPercentage(percent)}
                    >
                      <Text style={[
                        styles.percentageButtonText,
                        { color: partialPercentage === percent ? '#fff' : theme.colors.text }
                      ]}>
                        {percent}%
                      </Text>
                    </TouchableOpacity>
                  ))}
                </View>

                <TouchableOpacity
                  style={[styles.actionButton, { backgroundColor: theme.colors.error, opacity: isProcessing ? 0.7 : 1 }]}
                  onPress={handlePartialClose}
                  disabled={isProcessing}
                >
                  {isProcessing ? (
                    <ActivityIndicator color="#fff" />
                  ) : (
                    <Text style={styles.actionButtonText}>
                      Close {partialPercentage}% of Position
                    </Text>
                  )}
                </TouchableOpacity>
              </View>
            </View>
          )}

          {activeTab === 'scale' && (
            <View style={styles.tabContent}>
              <View style={[styles.card, { backgroundColor: theme.colors.card }]}>
                <Text style={[styles.cardTitle, { color: theme.colors.text }]}>
                  Scale Into Position
                </Text>
                <Text style={[styles.description, { color: theme.colors.textSecondary }]}>
                  Add to winning position when profit threshold is reached
                </Text>

                <View style={styles.inputGroup}>
                  <Text style={[styles.inputLabel, { color: theme.colors.text }]}>
                    Lot Multiplier
                  </Text>
                  <TextInput
                    style={[styles.input, {
                      backgroundColor: theme.colors.input,
                      color: theme.colors.text,
                      borderColor: theme.colors.border
                    }]}
                    value={scaleInMultiplier}
                    onChangeText={setScaleInMultiplier}
                    placeholder="1.5"
                    keyboardType="numeric"
                    placeholderTextColor={theme.colors.textTertiary}
                  />
                </View>

                <View style={styles.inputGroup}>
                  <Text style={[styles.inputLabel, { color: theme.colors.text }]}>
                    Profit Threshold (pips)
                  </Text>
                  <TextInput
                    style={[styles.input, {
                      backgroundColor: theme.colors.input,
                      color: theme.colors.text,
                      borderColor: theme.colors.border
                    }]}
                    value={scaleInThreshold}
                    onChangeText={setScaleInThreshold}
                    placeholder="20"
                    keyboardType="numeric"
                    placeholderTextColor={theme.colors.textTertiary}
                  />
                </View>

                <TouchableOpacity
                  style={[styles.actionButton, { backgroundColor: theme.colors.success, opacity: isProcessing ? 0.7 : 1 }]}
                  onPress={handleScaleIn}
                  disabled={isProcessing}
                >
                  {isProcessing ? (
                    <ActivityIndicator color="#fff" />
                  ) : (
                    <Text style={styles.actionButtonText}>
                      Scale In {scaleInMultiplier}x
                    </Text>
                  )}
                </TouchableOpacity>
              </View>
            </View>
          )}

          {activeTab === 'time' && (
            <View style={styles.tabContent}>
              <View style={[styles.card, { backgroundColor: theme.colors.card }]}>
                <Text style={[styles.cardTitle, { color: theme.colors.text }]}>
                  Time Management
                </Text>
                <Text style={[styles.description, { color: theme.colors.textSecondary }]}>
                  Automatic position management based on time
                </Text>

                <View style={styles.settingRow}>
                  <Text style={[styles.settingLabel, { color: theme.colors.text }]}>
                    Weekend Close
                  </Text>
                  <Switch
                    value={weekendClose}
                    onValueChange={setWeekendClose}
                    trackColor={{ false: theme.colors.input, true: theme.colors.primary }}
                    thumbColor="#FFF"
                  />
                </View>

                <View style={styles.inputGroup}>
                  <Text style={[styles.inputLabel, { color: theme.colors.text }]}>
                    Max Duration (hours)
                  </Text>
                  <TextInput
                    style={[styles.input, {
                      backgroundColor: theme.colors.input,
                      color: theme.colors.text,
                      borderColor: theme.colors.border
                    }]}
                    value={timeLimit}
                    onChangeText={setTimeLimit}
                    placeholder="24"
                    keyboardType="numeric"
                    placeholderTextColor={theme.colors.textTertiary}
                  />
                </View>

                <TouchableOpacity
                  style={[styles.saveButton, { backgroundColor: theme.colors.primary, opacity: isProcessing ? 0.7 : 1 }]}
                  disabled={isProcessing}
                  onPress={async () => {
                    if (!position) return;

                    const success = await sendCommand('SET_POSITION_TIME_LIMIT', {
                      ticket: position.ticket,
                      timeLimit: parseInt(timeLimit) * 3600 // Convert hours to seconds
                    });

                    if (success) {
                      Alert.alert("Success", `Time limit set to ${timeLimit} hours for position ${position.ticket}`);
                      onUpdate();
                    }
                  }}
                >
                  {isProcessing ? (
                    <ActivityIndicator color="#fff" />
                  ) : (
                    <Text style={styles.saveButtonText}>Save Time Settings</Text>
                  )}
                </TouchableOpacity>
              </View>
            </View>
          )}
        </ScrollView>
      </View>
    </Modal>
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
    padding: 20,
    borderBottomWidth: 1,
  },
  title: {
    fontSize: 20,
    fontWeight: 'bold',
  },
  subtitle: {
    fontSize: 14,
    marginTop: 2,
  },
  closeButton: {
    width: 32,
    height: 32,
    borderRadius: 16,
    justifyContent: 'center',
    alignItems: 'center',
  },
  closeButtonText: {
    fontSize: 16,
    fontWeight: 'bold',
  },
  tabWrapper: {
    maxHeight: 60,
  },
  tabContainer: {
    paddingHorizontal: 16,
    paddingVertical: 8,
  },
  tab: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 16,
    paddingVertical: 8,
    marginRight: 8,
    borderRadius: 20,
    backgroundColor: 'transparent',
  },
  activeTab: {
    backgroundColor: '#007AFF',
  },
  tabText: {
    fontSize: 14,
    fontWeight: '500',
  },
  content: {
    flex: 1,
    padding: 16,
  },
  tabContent: {
    flex: 1,
  },
  card: {
    padding: 20,
    borderRadius: 16,
    marginBottom: 16,
  },
  cardTitle: {
    fontSize: 18,
    fontWeight: 'bold',
    marginBottom: 8,
  },
  description: {
    fontSize: 14,
    marginBottom: 20,
    lineHeight: 20,
  },
  settingRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    marginBottom: 16,
  },
  settingLabel: {
    fontSize: 16,
    fontWeight: '500',
  },
  inputGroup: {
    marginBottom: 20,
  },
  inputLabel: {
    fontSize: 14,
    fontWeight: '500',
    marginBottom: 8,
  },
  input: {
    borderWidth: 1,
    borderRadius: 8,
    paddingHorizontal: 12,
    paddingVertical: 10,
    fontSize: 16,
  },
  percentageButtons: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 8,
    marginBottom: 20,
  },
  percentageButton: {
    flex: 1,
    minWidth: 70,
    paddingVertical: 12,
    borderWidth: 1,
    borderRadius: 8,
    alignItems: 'center',
  },
  percentageButtonText: {
    fontSize: 16,
    fontWeight: '500',
  },
  saveButton: {
    paddingVertical: 14,
    borderRadius: 12,
    alignItems: 'center',
    marginTop: 10,
  },
  saveButtonText: {
    color: '#fff',
    fontSize: 16,
    fontWeight: 'bold',
  },
  actionButton: {
    paddingVertical: 14,
    borderRadius: 12,
    alignItems: 'center',
    marginTop: 10,
  },
  actionButtonText: {
    color: '#fff',
    fontSize: 16,
    fontWeight: 'bold',
  },
});
