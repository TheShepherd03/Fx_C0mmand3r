import React, { useState, useEffect } from 'react';
import {
  View,
  Text,
  Modal,
  StyleSheet,
  TouchableOpacity,
  ScrollView,
  Pressable,
  Alert,
  TextInput
} from 'react-native';
import { Position } from '@/constants/types';
import { useTheme } from '@/contexts/ThemeContext';
import { IconSymbol } from '@/components/ui/icon-symbol';

interface PositionDetailsModalProps {
  position: Position | null;
  visible: boolean;
  onClose: () => void;
  onScalePosition?: (scaleFactor: number) => void;
  onModifySLTP?: (ticket: number, sl: number, tp: number) => void;
  onHedge?: () => void;
}

export function PositionDetailsModal({ position, visible, onClose, onScalePosition, onModifySLTP, onHedge }: PositionDetailsModalProps) {
  const { theme } = useTheme();
  const [editableSL, setEditableSL] = useState('');
  const [editableTP, setEditableTP] = useState('');
  const [hasChanges, setHasChanges] = useState(false);

  // Initialize editable values when position changes
  useEffect(() => {
    if (position) {
      setEditableSL(position.sl > 0 ? position.sl.toString() : '');
      setEditableTP(position.tp > 0 ? position.tp.toString() : '');
      setHasChanges(false);
    }
  }, [position]);

  if (!position) return null;

  // Handle SL/TP input changes
  const handleSLChange = (value: string) => {
    setEditableSL(value);
    setHasChanges(true);
  };

  const handleTPChange = (value: string) => {
    setEditableTP(value);
    setHasChanges(true);
  };

  // Convert a price distance into account money for THIS position.
  // Prefers the EA-provided tick value/size (accurate for FX, metals, and
  // synthetic indices like Boom/Vol); falls back to the old contract-size
  // heuristic only if the EA hasn't sent tick specs yet.
  const moneyForPriceDiff = (priceDiff: number) => {
    if (position.tickValue && position.tickSize && position.tickSize > 0) {
      return (Math.abs(priceDiff) / position.tickSize) * position.tickValue * position.lots;
    }
    const { contractSize } = getContractSpecs(position.symbol);
    return Math.abs(priceDiff) * contractSize * position.lots;
  };

  // Calculate monetary value for SL change (negative = loss)
  const calculateSLValue = () => {
    const sl = parseFloat(editableSL);
    if (!sl || sl <= 0) return 0;
    return -moneyForPriceDiff(position.openPrice - sl);
  };

  // Calculate monetary value for TP change (positive = profit)
  const calculateTPValue = () => {
    const tp = parseFloat(editableTP);
    if (!tp || tp <= 0) return 0;
    return moneyForPriceDiff(tp - position.openPrice);
  };

  // Multiply the SL or TP *distance from entry* by a factor, then update the field.
  // e.g. x2 moves the level to twice its current distance from the entry price.
  const applyMultiplier = (field: 'sl' | 'tp', factor: number) => {
    if (!factor || factor <= 0) return;
    const current = parseFloat(field === 'sl' ? editableSL : editableTP);
    if (!current || current <= 0) {
      Alert.alert(
        'Set a value first',
        `Enter a ${field === 'sl' ? 'Stop Loss' : 'Take Profit'} price before multiplying its distance from entry.`
      );
      return;
    }
    const scaled = position.openPrice + (current - position.openPrice) * factor;
    const next = formatPrice(scaled);
    if (field === 'sl') setEditableSL(next);
    else setEditableTP(next);
    setHasChanges(true);
  };

  // Compact "multiply distance from entry" controls shown under each SL/TP input
  const renderMultiplierRow = (field: 'sl' | 'tp') => (
    <View style={styles.multiplierRow}>
      <Text style={[styles.multiplierLabel, { color: theme.colors.textTertiary }]}>× distance</Text>
      {[1.5, 2, 3].map((f) => (
        <TouchableOpacity
          key={f}
          style={[styles.multChip, { backgroundColor: theme.colors.input, borderColor: theme.colors.border }]}
          onPress={() => applyMultiplier(field, f)}
        >
          <Text style={[styles.multChipText, { color: theme.colors.primary }]}>×{f}</Text>
        </TouchableOpacity>
      ))}
      <TextInput
        style={[styles.multCustomInput, { backgroundColor: theme.colors.input, color: theme.colors.text, borderColor: theme.colors.border }]}
        placeholder="×?"
        placeholderTextColor={theme.colors.textTertiary}
        keyboardType="numeric"
        returnKeyType="done"
        onSubmitEditing={(e) => applyMultiplier(field, parseFloat(e.nativeEvent.text))}
      />
    </View>
  );

  // Save SL/TP changes
  const handleSaveChanges = () => {
    if (!onModifySLTP) {
      Alert.alert("Error", "SL/TP modification not available");
      return;
    }

    const sl = parseFloat(editableSL) || 0;
    const tp = parseFloat(editableTP) || 0;

    Alert.alert(
      "Modify Position",
      `Update Stop Loss to ${sl > 0 ? formatPrice(sl) : 'None'} and Take Profit to ${tp > 0 ? formatPrice(tp) : 'None'}?`,
      [
        { text: "Cancel", style: "cancel" },
        {
          text: "Update",
          onPress: () => {
            onModifySLTP(position.ticket, sl, tp);
            setHasChanges(false);
          }
        }
      ]
    );
  };

  // Get contract specifications
  const getContractSpecs = (symbol: string) => {
    if (symbol.includes('XAU') || symbol.includes('Gold')) {
      return { contractSize: 100 }; // Gold: 100 oz per lot
    } else if (symbol.includes('JPY')) {
      return { contractSize: 100000 }; // JPY pairs: 100k units per lot
    } else {
      return { contractSize: 100000 }; // Major pairs: 100k units per lot
    }
  };

  // Calculate position duration
  const getDuration = (openTime: number) => {
    const now = Math.floor(Date.now() / 1000);
    const duration = now - openTime;

    const days = Math.floor(duration / (24 * 3600));
    const hours = Math.floor((duration % (24 * 3600)) / 3600);
    const minutes = Math.floor((duration % 3600) / 60);

    if (days > 0) {
      return `${days}d ${hours}h ${minutes}m`;
    } else if (hours > 0) {
      return `${hours}h ${minutes}m`;
    } else {
      return `${minutes}m`;
    }
  };

  // Calculate position risk (distance from entry to SL)
  const calculateRisk = () => {
    if (position.sl === 0) return 0;
    return moneyForPriceDiff(position.openPrice - position.sl);
  };

  // Calculate potential profit (distance from entry to TP)
  const calculatePotentialProfit = () => {
    if (position.tp === 0) return 0;
    return moneyForPriceDiff(position.tp - position.openPrice);
  };

  // Format price display based on symbol
  const formatPrice = (price: number) => {
    const decimals = position.symbol.includes('JPY') ? 3 : 5;
    return price.toFixed(decimals);
  };

  const formatCurrency = (amount: number) => {
    return new Intl.NumberFormat('en-US', {
      style: 'currency',
      currency: 'USD',
      minimumFractionDigits: 2,
      maximumFractionDigits: 2,
    }).format(amount);
  };

  const riskAmount = calculateRisk();
  const potentialProfit = calculatePotentialProfit();
  const riskRewardRatio = riskAmount > 0 ? potentialProfit / riskAmount : 0;

  return (
    <Modal
      animationType="slide"
      transparent={true}
      visible={visible}
      onRequestClose={onClose}
    >
      <View style={[styles.overlay, { backgroundColor: theme.colors.overlay }]}>
        {/* Tap-outside-to-close sits BEHIND the sheet so it never intercepts scroll */}
        <Pressable style={StyleSheet.absoluteFill} onPress={onClose} />
        <View style={[styles.modalContainer, { backgroundColor: theme.colors.card }]}>
          <View style={styles.grabber}>
            <View style={[styles.grabberBar, { backgroundColor: theme.colors.border }]} />
          </View>
          <ScrollView
            style={styles.modalContent}
            contentContainerStyle={styles.modalScrollContent}
            showsVerticalScrollIndicator={true}
            indicatorStyle={theme.isDark ? "white" : "black"}
            persistentScrollbar={true}
            nestedScrollEnabled={true}
            keyboardShouldPersistTaps="handled"
            scrollEventThrottle={16}
            bounces={true}
          >
            {/* Header */}
            <View style={[styles.header, { borderBottomColor: theme.colors.border }]}>
              <View>
                <Text style={[styles.symbol, { color: theme.colors.text }]}>{position.symbol}</Text>
                <Text style={[styles.ticket, { color: theme.colors.textSecondary }]}>Ticket #{position.ticket}</Text>
              </View>
              <TouchableOpacity style={[styles.closeButton, { backgroundColor: theme.colors.input }]} onPress={onClose}>
                <IconSymbol name="xmark" size={16} color={theme.colors.textSecondary} />
              </TouchableOpacity>
            </View>

            {/* Position Type & Status */}
            <View style={styles.statusSection}>
              <View style={[
                styles.typeTag,
                { backgroundColor: position.type === 0 ? theme.colors.buyBackground : theme.colors.sellBackground }
              ]}>
                <Text style={[styles.typeText, { color: position.type === 0 ? theme.colors.buy : theme.colors.sell }]}>
                  {position.type === 0 ? 'BUY' : 'SELL'} {position.lots} LOT
                </Text>
              </View>
              <View style={styles.durationContainer}>
                <Text style={[styles.durationLabel, { color: theme.colors.textSecondary }]}>Duration</Text>
                <Text style={[styles.durationValue, { color: theme.colors.text }]}>{getDuration(position.openTime)}</Text>
              </View>
            </View>

            {/* Position Configuration */}
            <View style={[styles.section, { borderTopColor: theme.colors.border }]}>
              <Text style={[styles.sectionTitle, { color: theme.colors.text }]}>Position Configuration</Text>

              <View style={styles.priceRow}>
                <Text style={[styles.priceLabel, { color: theme.colors.textSecondary }]}>Entry Price</Text>
                <Text style={[styles.priceValue, { color: theme.colors.text }]}>{formatPrice(position.openPrice)}</Text>
              </View>

              {/* Configurable Stop Loss */}
              <View style={styles.configRow}>
                <Text style={[styles.configLabel, { color: theme.colors.textSecondary }]}>Stop Loss</Text>
                <View style={styles.configInput}>
                  <TextInput
                    style={[
                      styles.priceInput,
                      {
                        borderColor: theme.colors.border,
                        color: theme.colors.text,
                        backgroundColor: theme.colors.input
                      }
                    ]}
                    value={editableSL}
                    onChangeText={handleSLChange}
                    placeholder="0.00000"
                    placeholderTextColor={theme.colors.textTertiary}
                    keyboardType="numeric"
                  />
                  <View style={styles.monetaryValue}>
                    <Text style={[
                      styles.monetaryText,
                      { color: theme.colors.loss }
                    ]}>
                      {editableSL && parseFloat(editableSL) > 0 ? formatCurrency(calculateSLValue()) : '$0.00'}
                    </Text>
                  </View>
                </View>
                {renderMultiplierRow('sl')}
              </View>

              {/* Configurable Take Profit */}
              <View style={styles.configRow}>
                <Text style={[styles.configLabel, { color: theme.colors.textSecondary }]}>Take Profit</Text>
                <View style={styles.configInput}>
                  <TextInput
                    style={[
                      styles.priceInput,
                      {
                        borderColor: theme.colors.border,
                        color: theme.colors.text,
                        backgroundColor: theme.colors.input
                      }
                    ]}
                    value={editableTP}
                    onChangeText={handleTPChange}
                    placeholder="0.00000"
                    placeholderTextColor={theme.colors.textTertiary}
                    keyboardType="numeric"
                  />
                  <View style={styles.monetaryValue}>
                    <Text style={[
                      styles.monetaryText,
                      { color: theme.colors.profit }
                    ]}>
                      {editableTP && parseFloat(editableTP) > 0 ? formatCurrency(calculateTPValue()) : '$0.00'}
                    </Text>
                  </View>
                </View>
                {renderMultiplierRow('tp')}
              </View>

              {/* Save Changes Button */}
              {hasChanges && (
                <TouchableOpacity
                  style={[styles.saveButton, { backgroundColor: theme.colors.primary }]}
                  onPress={handleSaveChanges}
                >
                  <Text style={[styles.saveButtonText, { color: theme.colors.primaryText }]}>💾 Save Changes</Text>
                </TouchableOpacity>
              )}
            </View>

            {/* P&L Information */}
            <View style={[styles.section, { borderTopColor: theme.colors.border }]}>
              <Text style={[styles.sectionTitle, { color: theme.colors.text }]}>Profit & Loss</Text>

              <View style={styles.plRow}>
                <Text style={[styles.plLabel, { color: theme.colors.textSecondary }]}>Current P&L</Text>
                <Text style={[
                  styles.plValue,
                  { color: position.profit >= 0 ? theme.colors.profit : theme.colors.loss }
                ]}>
                  {formatCurrency(position.profit)}
                </Text>
              </View>

              <View style={styles.plRow}>
                <Text style={[styles.plLabel, { color: theme.colors.textSecondary }]}>Risk Amount</Text>
                <Text style={[styles.plValue, { color: theme.colors.loss }]}>
                  {position.sl > 0 ? formatCurrency(-riskAmount) : 'Unlimited'}
                </Text>
              </View>

              <View style={styles.plRow}>
                <Text style={[styles.plLabel, { color: theme.colors.textSecondary }]}>Potential Profit</Text>
                <Text style={[styles.plValue, { color: theme.colors.profit }]}>
                  {position.tp > 0 ? formatCurrency(potentialProfit) : 'Unlimited'}
                </Text>
              </View>

              {riskRewardRatio > 0 && (
                <View style={styles.plRow}>
                  <Text style={[styles.plLabel, { color: theme.colors.textSecondary }]}>Risk:Reward Ratio</Text>
                  <Text style={[styles.plValue, { color: theme.colors.text }]}>
                    1:{riskRewardRatio.toFixed(2)}
                  </Text>
                </View>
              )}
            </View>

            {/* Position Scaling */}
            {onScalePosition && (
              <View style={[styles.section, { borderTopColor: theme.colors.border }]}>
                <Text style={[styles.sectionTitle, { color: theme.colors.text }]}>Position Scaling</Text>
                <Text style={[styles.scalingDesc, { color: theme.colors.textSecondary }]}>
                  Open additional positions with scaled lot sizes at current market price
                </Text>

                <View style={styles.scalingButtons}>
                  {[2, 3, 4, 5, 10].map((factor) => {
                    const scaledLots = (position.lots * factor).toFixed(2);
                    return (
                      <TouchableOpacity
                        key={factor}
                        style={[styles.scaleButton, { backgroundColor: theme.colors.input, borderColor: theme.colors.border }]}
                        onPress={() => {
                          Alert.alert(
                            "Scale Position",
                            `Open ${scaledLots} lot ${position.symbol} ${position.type === 0 ? 'BUY' : 'SELL'} position (${factor}x scale)?`,
                            [
                              { text: "Cancel", style: "cancel" },
                              { text: "Confirm", onPress: () => onScalePosition(factor) }
                            ]
                          );
                        }}
                      >
                        <Text style={[styles.scaleButtonText, { color: theme.colors.primary }]}>
                          {factor}x
                        </Text>
                        <Text style={[styles.scaleButtonLots, { color: theme.colors.textSecondary }]}>
                          {scaledLots} lots
                        </Text>
                      </TouchableOpacity>
                    );
                  })}
                </View>
              </View>
            )}

            {/* Hedge */}
            {onHedge && (
              <View style={[styles.section, { borderTopColor: theme.colors.border }]}>
                <Text style={[styles.sectionTitle, { color: theme.colors.text }]}>Hedge</Text>
                <Text style={[styles.scalingDesc, { color: theme.colors.textSecondary }]}>
                  Open an opposite {position.type === 0 ? 'SELL' : 'BUY'} position of {position.lots} lot{position.lots === 1 ? '' : 's'} to hedge this trade
                </Text>
                <TouchableOpacity
                  style={[styles.hedgeButton, { backgroundColor: theme.colors.warning + '22', borderColor: theme.colors.warning }]}
                  onPress={() => {
                    Alert.alert(
                      'Hedge Position',
                      `Open an opposite ${position.type === 0 ? 'SELL' : 'BUY'} ${position.lots} lot ${position.symbol} position at market price?`,
                      [
                        { text: 'Cancel', style: 'cancel' },
                        { text: 'Hedge', onPress: onHedge },
                      ]
                    );
                  }}
                >
                  <IconSymbol name="arrow.triangle.2.circlepath" size={18} color={theme.colors.warning} />
                  <Text style={[styles.hedgeButtonText, { color: theme.colors.warning }]}>
                    Hedge with opposite {position.type === 0 ? 'SELL' : 'BUY'}
                  </Text>
                </TouchableOpacity>
              </View>
            )}

            {/* Technical Details */}
            <View style={[styles.section, { borderTopColor: theme.colors.border }]}>
              <Text style={[styles.sectionTitle, { color: theme.colors.text }]}>Technical Details</Text>

              <View style={styles.detailRow}>
                <Text style={[styles.detailLabel, { color: theme.colors.textSecondary }]}>Magic Number</Text>
                <Text style={[styles.detailValue, { color: theme.colors.text }]}>{position.magic}</Text>
              </View>

              <View style={styles.detailRow}>
                <Text style={[styles.detailLabel, { color: theme.colors.textSecondary }]}>Open Time</Text>
                <Text style={[styles.detailValue, { color: theme.colors.text }]}>
                  {new Date(position.openTime * 1000).toLocaleString()}
                </Text>
              </View>
            </View>

          </ScrollView>
        </View>
      </View>
    </Modal>
  );
}

const styles = StyleSheet.create({
  overlay: {
    flex: 1,
    backgroundColor: 'rgba(0, 0, 0, 0.5)',
    justifyContent: 'flex-end',
  },
  modalContainer: {
    backgroundColor: '#FFF',
    borderTopLeftRadius: 20,
    borderTopRightRadius: 20,
    maxHeight: '85%',
    minHeight: '60%',
  },
  modalContent: {
    flex: 1,
    paddingHorizontal: 16,
  },
  modalScrollContent: {
    paddingBottom: 40,
  },
  grabber: {
    alignItems: 'center',
    paddingTop: 10,
    paddingBottom: 4,
  },
  grabberBar: {
    width: 44,
    height: 5,
    borderRadius: 3,
    opacity: 0.6,
  },
  multiplierRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    marginTop: 10,
  },
  multiplierLabel: {
    fontSize: 12,
    fontWeight: '600',
  },
  multChip: {
    paddingHorizontal: 12,
    paddingVertical: 6,
    borderRadius: 8,
    borderWidth: 1,
  },
  multChipText: {
    fontSize: 13,
    fontWeight: '700',
  },
  multCustomInput: {
    width: 56,
    borderWidth: 1,
    borderRadius: 8,
    paddingHorizontal: 8,
    paddingVertical: 6,
    fontSize: 13,
    textAlign: 'center',
  },
  content: {
    flex: 1,
  },
  header: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'flex-start',
    padding: 20,
    paddingBottom: 10,
    borderBottomWidth: 1,
    borderBottomColor: '#F0F0F0',
  },
  symbol: {
    fontSize: 24,
    fontWeight: 'bold',
    color: '#333',
  },
  ticket: {
    fontSize: 14,
    color: '#666',
    marginTop: 2,
  },
  closeButton: {
    width: 30,
    height: 30,
    borderRadius: 15,
    backgroundColor: '#F5F5F5',
    justifyContent: 'center',
    alignItems: 'center',
  },
  closeButtonText: {
    fontSize: 16,
    color: '#666',
    fontWeight: 'bold',
  },
  statusSection: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    padding: 20,
    paddingTop: 15,
    paddingBottom: 15,
  },
  typeTag: {
    paddingHorizontal: 12,
    paddingVertical: 6,
    borderRadius: 20,
  },
  typeText: {
    color: '#FFF',
    fontWeight: 'bold',
    fontSize: 14,
  },
  durationContainer: {
    alignItems: 'flex-end',
  },
  durationLabel: {
    fontSize: 12,
    color: '#666',
  },
  durationValue: {
    fontSize: 16,
    fontWeight: '600',
    color: '#333',
    marginTop: 2,
  },
  section: {
    padding: 20,
    paddingTop: 10,
    borderTopWidth: 1,
    borderTopColor: '#F5F5F5',
  },
  sectionTitle: {
    fontSize: 18,
    fontWeight: 'bold',
    color: '#333',
    marginBottom: 15,
  },
  priceRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    marginBottom: 12,
  },
  priceLabel: {
    fontSize: 16,
    color: '#666',
  },
  priceValue: {
    fontSize: 16,
    fontWeight: '600',
    color: '#333',
    fontFamily: 'monospace',
  },
  plRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    marginBottom: 12,
  },
  plLabel: {
    fontSize: 16,
    color: '#666',
  },
  plValue: {
    fontSize: 18,
    fontWeight: 'bold',
    fontFamily: 'monospace',
  },
  detailRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    marginBottom: 12,
  },
  detailLabel: {
    fontSize: 16,
    color: '#666',
  },
  detailValue: {
    fontSize: 16,
    color: '#333',
    fontWeight: '600',
  },
  configRow: {
    marginBottom: 16,
  },
  configLabel: {
    fontSize: 14,
    fontWeight: '600',
    marginBottom: 8,
  },
  configInput: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
  },
  priceInput: {
    flex: 1,
    borderWidth: 1,
    borderRadius: 8,
    paddingHorizontal: 12,
    paddingVertical: 10,
    fontSize: 16,
    fontFamily: 'monospace',
  },
  monetaryValue: {
    minWidth: 100,
    alignItems: 'flex-end',
  },
  monetaryText: {
    fontSize: 14,
    fontWeight: '600',
    fontFamily: 'monospace',
  },
  saveButton: {
    marginTop: 16,
    paddingVertical: 12,
    paddingHorizontal: 20,
    borderRadius: 8,
    alignItems: 'center',
  },
  saveButtonText: {
    color: '#fff',
    fontSize: 16,
    fontWeight: 'bold',
  },
  scalingDesc: {
    fontSize: 14,
    color: '#666',
    marginBottom: 15,
    textAlign: 'center',
  },
  scalingButtons: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    justifyContent: 'space-between',
    gap: 10,
  },
  scaleButton: {
    backgroundColor: '#2196F3',
    borderRadius: 8,
    paddingVertical: 12,
    paddingHorizontal: 16,
    alignItems: 'center',
    minWidth: '18%',
    borderWidth: 1,
    borderColor: '#1976D2',
    elevation: 2,
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 2 },
    shadowOpacity: 0.1,
    shadowRadius: 4,
  },
  scaleButtonText: {
    fontSize: 16,
    fontWeight: 'bold',
    color: '#FFFFFF',
  },
  scaleButtonLots: {
    fontSize: 12,
    color: '#E3F2FD',
    marginTop: 2,
  },
  hedgeButton: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 8,
    paddingVertical: 12,
    paddingHorizontal: 16,
    borderRadius: 10,
    borderWidth: 1,
  },
  hedgeButtonText: {
    fontSize: 15,
    fontWeight: '700',
  },
});
