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
  ActivityIndicator,
  Platform,
} from 'react-native';
import { Position } from '@/constants/types';
import { useTheme } from '@/contexts/ThemeContext';
import { useAccount } from '@/contexts/AccountContext';
import { database } from '@/firebaseConfig';
import { ref, set, onValue } from 'firebase/database';
import { IconSymbol } from '@/components/ui/icon-symbol';
import { currencySymbol } from '@/utils/currency';
import { showAlert } from '@/components/AppDialog';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

interface PositionManagementModalProps {
  visible: boolean;
  position: Position | null;
  onClose: () => void;
  onUpdate: () => void;
  currency?: string;
}

export function PositionManagementModal({
  visible,
  position,
  onClose,
  onUpdate,
  currency
}: PositionManagementModalProps) {
  const { theme } = useTheme();
  const insets = useSafeAreaInsets();
  const { selectedAccount } = useAccount();
  const [activeTab, setActiveTab] = useState<'breakeven' | 'trailing' | 'partial' | 'scale' | 'time'>('breakeven');
  const [isProcessing, setIsProcessing] = useState(false);

  // Break-even settings
  const [breakevenEnabled, setBreakevenEnabled] = useState(false);
  const [breakevenThreshold, setBreakevenThreshold] = useState('10');
  // pips / percent = automatic at a profit threshold; now = move the SL to entry immediately
  const [breakevenMode, setBreakevenMode] = useState<'pips' | 'percent' | 'now'>('pips');
  const [breakevenPercent, setBreakevenPercent] = useState('0.5');
  const [beNowBusy, setBeNowBusy] = useState(false);

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

  // Initialise the controls from the EA's CURRENT per-position state, but only when
  // the sheet opens (or the ticket changes) — not on every price tick, which would
  // otherwise clobber edits the user is making before they hit Save.
  useEffect(() => {
    if (visible && position) {
      setBreakevenEnabled(position.breakevenEnabled || false);
      setBreakevenMode(position.breakevenUsePercent ? 'percent' : 'pips');
      if (position.breakevenThreshold && position.breakevenThreshold > 0) setBreakevenThreshold(String(position.breakevenThreshold));
      if (position.breakevenPercent && position.breakevenPercent > 0) setBreakevenPercent(String(position.breakevenPercent));
      setTrailingEnabled(position.trailingEnabled || false);
      setTrailingPercentage(position.trailingPercentage || 20);
      setTimeLimit(position.timeLimit && position.timeLimit > 0 ? String(Math.round(position.timeLimit / 3600)) : '');
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [visible, position?.ticket]);

  const sendCommand = async (action: string, payload: any) => {
    if (!selectedAccount) {
      showAlert("Error", "No account selected");
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
      showAlert("Error", "Failed to send command");
      return false;
    } finally {
      setIsProcessing(false);
    }
  };

  const handleBreakevenSave = async () => {
    if (!position) return;

    const success = await sendCommand('SET_BREAKEVEN', {
      ticket: position.ticket,
      enabled: breakevenEnabled,
      usePercent: breakevenMode === 'percent',
      percent: breakevenMode === 'percent' ? parseFloat(breakevenPercent) || 0 : 0,
      threshold: breakevenMode === 'pips' ? parseInt(breakevenThreshold) || 0 : 0
    });

    if (success) {
      showAlert("Success", `Break-even ${breakevenEnabled ? 'enabled' : 'disabled'} for position ${position.ticket}`);
      onUpdate();
    }
  };

  // Break-even NOW: the Bridge EA moves the SL to entry immediately and answers on
  // the same command node (status EXECUTED / FAILED + a plain-English message).
  const handleBreakevenNow = async () => {
    if (!position) return;
    if (!selectedAccount) {
      showAlert("Error", "No account selected");
      return;
    }
    setBeNowBusy(true);
    const sentAt = Math.floor(Date.now() / 1000);
    const commandRef = ref(database, `commands/${selectedAccount}/latest`);
    try {
      await set(commandRef, { action: 'BREAKEVEN_NOW', ticket: position.ticket, status: 'PENDING', timestamp: sentAt });
    } catch {
      setBeNowBusy(false);
      showAlert("Error", "Failed to send the command. Check your connection.");
      return;
    }

    let done = false;
    let unsubscribe = () => {};
    let timer: ReturnType<typeof setTimeout> | undefined;
    const finish = (title: string, message: string, variant: 'success' | 'error' | 'info') => {
      if (done) return;
      done = true;
      unsubscribe();
      if (timer) clearTimeout(timer);
      setBeNowBusy(false);
      showAlert(title, message, undefined, { variant });
      if (variant === 'success') onUpdate();
    };
    unsubscribe = onValue(commandRef, (snap) => {
      const c = snap.val();
      if (!c || c.action !== 'BREAKEVEN_NOW' || c.timestamp !== sentAt) return;   // not our command (yet)
      if (c.status === 'EXECUTED') finish('Break-even set', c.message || 'Stop loss moved to entry.', 'success');
      else if (c.status === 'FAILED') finish("Couldn't move the stop", c.message || 'The EA could not apply break-even.', 'error');
    });
    timer = setTimeout(
      () => finish('Sent to the EA', "The EA hasn't confirmed yet (it may be offline). Check the position's stop loss in a moment.", 'info'),
      25000,
    );
  };

  // "Now" panel: where the trade stands against its entry, and one button to lock break-even.
  const renderBreakevenNow = () => {
    if (!position) return null;
    const isBuy = position.type === 0;
    const open = position.openPrice;
    const move = isBuy ? position.currentPrice - open : open - position.currentPrice;
    const movePct = open ? (move / open) * 100 : 0;
    const alreadyProtected = position.sl > 0 && (isBuy ? position.sl >= open : position.sl <= open);
    const inProfit = move > 0;
    const decimals = Math.min(5, (String(open).split('.')[1] || '').length);
    const fmt = (v: number) => v.toFixed(decimals);
    const state = alreadyProtected
      ? { text: 'Already protected: your stop loss is at or beyond entry.', color: theme.colors.profit }
      : inProfit
        ? { text: `In profit by ${movePct.toFixed(2)}%, ready to lock in break-even.`, color: theme.colors.profit }
        : { text: `Not in profit yet (${movePct.toFixed(2)}%). Break-even is possible once price moves past your entry.`, color: theme.colors.warning };
    const disabled = beNowBusy || alreadyProtected || !inProfit;

    return (
      <View>
        <Text style={[styles.description, { color: theme.colors.textSecondary }]}>
          Moves the stop loss to your entry price right away, with no profit target to wait for. The broker only
          accepts it while the trade is in profit by at least its minimum stop distance.
        </Text>
        <View style={[styles.nowStats, { backgroundColor: theme.colors.input }]}>
          {[
            ['Entry', fmt(open)],
            ['Price now', fmt(position.currentPrice)],
            ['Stop loss', position.sl > 0 ? fmt(position.sl) : 'None'],
          ].map(([label, value]) => (
            <View key={label} style={styles.nowStat}>
              <Text style={[styles.nowStatLabel, { color: theme.colors.textTertiary }]}>{label}</Text>
              <Text style={[styles.nowStatValue, { color: theme.colors.text }]}>{value}</Text>
            </View>
          ))}
        </View>
        <Text style={[styles.nowState, { color: state.color }]}>{state.text}</Text>
        <TouchableOpacity
          style={[styles.saveButton, { backgroundColor: theme.colors.primary, opacity: disabled ? 0.5 : 1 }]}
          onPress={handleBreakevenNow}
          disabled={disabled}
        >
          {beNowBusy ? (
            <ActivityIndicator color="#fff" />
          ) : (
            <Text style={styles.saveButtonText}>Move SL to Entry Now</Text>
          )}
        </TouchableOpacity>
      </View>
    );
  };

  const handleTrailingSave = async () => {
    if (!position) return;

    const success = await sendCommand('SET_TRAILING_STOP', {
      ticket: position.ticket,
      trailPercentage: trailingPercentage,
      enabled: trailingEnabled
    });

    if (success) {
      showAlert("Success", `Trailing stop ${trailingEnabled ? 'enabled' : 'disabled'} for position ${position.ticket}`);
      onUpdate();
    }
  };

  const handlePartialClose = async () => {
    if (!position) return;

    showAlert(
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
              showAlert("Success", `Partial close order sent for ${partialPercentage}%`);
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

    showAlert(
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
              showAlert("Success", `Scale-in order sent with ${scaleInMultiplier}x multiplier`);
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
      {/* Full-screen on Android (pageSheet is iOS-only), drawn edge to edge: keep the
          header below the status bar and the content above the navigation bar. */}
      <View
        style={[
          styles.container,
          { backgroundColor: theme.colors.background },
          Platform.OS === 'android' && { paddingTop: insets.top, paddingBottom: insets.bottom },
        ]}
      >
        {/* Header */}
        <View style={[styles.header, { borderBottomColor: theme.colors.border }]}>
          <View>
            <Text style={[styles.title, { color: theme.colors.text }]}>
              {position.symbol} #{position.ticket}
            </Text>
            <Text style={[styles.subtitle, { color: profitColor }]}>
              {position.type === 0 ? 'BUY' : 'SELL'} {position.lots} lots • {currencySymbol(currency)}{position.profit.toFixed(2)}
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
                {/* Mode: pips / percent (automatic, at a profit threshold) or now (immediately) */}
                <View style={styles.modeToggle}>
                  {(['pips', 'percent', 'now'] as const).map((mode) => (
                    <TouchableOpacity
                      key={mode}
                      style={[
                        styles.modeButton,
                        { borderColor: theme.colors.border },
                        breakevenMode === mode && { backgroundColor: theme.colors.primary, borderColor: theme.colors.primary }
                      ]}
                      onPress={() => setBreakevenMode(mode)}
                    >
                      <Text style={[
                        styles.modeButtonText,
                        { color: breakevenMode === mode ? '#fff' : theme.colors.text }
                      ]}>
                        {mode === 'pips' ? 'Pips' : mode === 'percent' ? 'Percent' : 'Now'}
                      </Text>
                    </TouchableOpacity>
                  ))}
                </View>

                {breakevenMode !== 'now' && (
                  <>
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
                      Move stop loss to entry price when the trade reaches the threshold below
                    </Text>
                  </>
                )}

                {breakevenMode === 'now' ? (
                  renderBreakevenNow()
                ) : breakevenMode === 'pips' ? (
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
                ) : (
                  <View style={styles.inputGroup}>
                    <Text style={[styles.inputLabel, { color: theme.colors.text }]}>
                      Price Move from Entry (%)
                    </Text>
                    <TextInput
                      style={[styles.input, {
                        backgroundColor: theme.colors.input,
                        color: theme.colors.text,
                        borderColor: theme.colors.border
                      }]}
                      value={breakevenPercent}
                      onChangeText={setBreakevenPercent}
                      placeholder="0.5"
                      keyboardType="numeric"
                      placeholderTextColor={theme.colors.textTertiary}
                    />
                    <Text style={[styles.description, { color: theme.colors.textTertiary, marginTop: 6, marginBottom: 0 }]}>
                      e.g. 0.5 = SL moves to entry once price has moved 0.5% in your favour from entry
                    </Text>
                  </View>
                )}

                {breakevenMode !== 'now' && (
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
                )}
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
                  Auto-close this position after it has been open for the set number of hours
                </Text>

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
                      showAlert("Success", `Time limit set to ${timeLimit} hours for position ${position.ticket}`);
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
  modeToggle: {
    flexDirection: 'row',
    gap: 8,
    marginBottom: 16,
  },
  modeButton: {
    flex: 1,
    paddingVertical: 10,
    borderWidth: 1,
    borderRadius: 8,
    alignItems: 'center',
  },
  modeButtonText: {
    fontSize: 14,
    fontWeight: '600',
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
  nowStats: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    borderRadius: 12,
    paddingVertical: 12,
    paddingHorizontal: 14,
    marginBottom: 12,
  },
  nowStat: {
    alignItems: 'flex-start',
  },
  nowStatLabel: {
    fontSize: 11,
    fontWeight: '700',
    letterSpacing: 0.4,
    marginBottom: 4,
  },
  nowStatValue: {
    fontSize: 15,
    fontWeight: '800',
    fontFamily: 'monospace',
  },
  nowState: {
    fontSize: 13,
    fontWeight: '600',
    marginBottom: 4,
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
