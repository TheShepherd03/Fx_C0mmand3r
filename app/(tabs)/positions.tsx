import React, { useState, useEffect } from 'react';
import {
  View,
  Text,
  FlatList,
  StyleSheet,
  SafeAreaView,
  TouchableOpacity,
  ActivityIndicator,
  Alert
} from 'react-native';
import { Position } from '@/constants/types';
import { useAccount } from '@/contexts/AccountContext';
import { PositionDetailsModal } from '@/components/PositionDetailsModal';
import { PositionManagementModal } from '@/components/PositionManagementModal';
import { useTheme } from '@/contexts/ThemeContext';
import { database } from '@/firebaseConfig';
import { ref, set, onValue, off } from 'firebase/database';

interface AccountData {
  balance?: number;
  equity?: number;
  freeMargin?: number;
  marginLevel?: number;
  positions?: Position[];
}

export default function PositionsScreen() {
  const { selectedAccount } = useAccount();
  const { theme } = useTheme();
  const [data, setData] = useState<AccountData | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [closingIds, setClosingIds] = useState<Set<number>>(new Set());
  const [selectedPosition, setSelectedPosition] = useState<Position | null>(null);
  const [modalVisible, setModalVisible] = useState(false);
  const [managementModalVisible, setManagementModalVisible] = useState(false);
  const [managementPosition, setManagementPosition] = useState<Position | null>(null);

  // Data fetching logic
  useEffect(() => {
    if (!selectedAccount) {
      setData(null);
      setLoading(false);
      return;
    }

    setLoading(true);
    setError(null);

    const accountRef = ref(database, `accounts/${selectedAccount}`);

    const handleData = (snapshot: any) => {
      const val = snapshot.val();
      if (val) {
        setData(val);
        setError(null);
      } else {
        setData(null);
        setError('No data available');
      }
      setLoading(false);
    };

    const handleError = (error: any) => {
      console.error('Firebase error:', error);
      setError('Connection error');
      setLoading(false);
    };

    onValue(accountRef, handleData, handleError);

    return () => {
      off(accountRef, 'value', handleData);
    };
  }, [selectedAccount]);

  const handleClosePosition = async (ticket: number) => {
    Alert.alert(
      "Confirm Close",
      `Are you sure you want to close ticket #${ticket}?`,
      [
        { text: "Cancel", style: "cancel" },
        {
          text: "Close",
          style: "destructive",
          onPress: async () => {
            setClosingIds(prev => new Set(prev).add(ticket));
            try {
              if (!selectedAccount) {
                Alert.alert("Error", "No account selected");
                return;
              }
              // Set 'latest' command
              const commandRef = ref(database, `commands/${selectedAccount}/latest`);
              await set(commandRef, {
                action: 'CLOSE_TICKET',
                ticket: ticket,
                status: 'PENDING',
                timestamp: Math.floor(Date.now() / 1000)
              });
            } catch {
              Alert.alert("Error", "Failed to send close command");
              setClosingIds(prev => {
                const next = new Set(prev);
                next.delete(ticket);
                return next;
              });
            }
          }
        }
      ]
    );
  };

  const handlePositionTap = (position: Position) => {
    setSelectedPosition(position);
    setModalVisible(true);
  };

  const handleScalePosition = async (scaleFactor: number) => {
    if (!selectedAccount || !selectedPosition) return;

    try {
      const scaledLots = selectedPosition.lots * scaleFactor;
      const command = {
        action: 'OPEN_POSITION',
        symbol: selectedPosition.symbol,
        type: selectedPosition.type,
        lots: scaledLots,
        sl: selectedPosition.sl,
        tp: selectedPosition.tp,
        status: 'PENDING',
        timestamp: Math.floor(Date.now() / 1000)
      };

      console.log('Sending scale command:', JSON.stringify(command, null, 2));
      console.log('Firebase path:', `commands/${selectedAccount}/latest`);

      const commandRef = ref(database, `commands/${selectedAccount}/latest`);
      await set(commandRef, command);

      Alert.alert("Success", `Position scaling command sent for ${selectedPosition.symbol}.\nNew lot size: ${scaledLots}`);
      setModalVisible(false);
    } catch (error) {
      console.error('Scale command error:', error);
      Alert.alert("Error", `Failed to send scale command: ${error}`);
    }
  };

  const handleCloseAll = () => {
    Alert.alert(
      "Close All Positions",
      "Are you sure you want to close all open positions?",
      [
        { text: "Cancel", style: "cancel" },
        {
          text: "Close All",
          style: "destructive",
          onPress: async () => {
            if (!selectedAccount || !data?.positions) return;

            try {
              const commandRef = ref(database, `commands/${selectedAccount}/latest`);
              await set(commandRef, {
                action: 'CLOSE_ALL',
                status: 'PENDING',
                timestamp: Math.floor(Date.now() / 1000)
              });
              Alert.alert("Success", "Close all command sent.");
            } catch {
              Alert.alert("Error", "Failed to send close all command.");
            }
          }
        }
      ]
    );
  };

  const handlePartialClose = async (position: Position, percentage: number) => {
    if (!selectedAccount) {
      Alert.alert("Error", "No account selected");
      return;
    }

    Alert.alert(
      "Confirm Partial Close",
      `Close ${percentage}% of ${position.symbol} position?`,
      [
        { text: "Cancel", style: "cancel" },
        {
          text: "Close",
          style: "destructive",
          onPress: async () => {
            try {
              const commandRef = ref(database, `commands/${selectedAccount}/latest`);
              await set(commandRef, {
                action: "PARTIAL_CLOSE",
                ticket: position.ticket,
                percentage: percentage,
                status: 'PENDING',
                timestamp: Math.floor(Date.now() / 1000)
              });
              Alert.alert("Success", `Partial close order sent for ${percentage}%`);
            } catch {
              Alert.alert("Error", "Failed to send partial close command");
            }
          }
        }
      ]
    );
  };

  const handleManagePosition = (position: Position) => {
    setManagementPosition(position);
    setManagementModalVisible(true);
  };

  const handleManagementUpdate = () => {
    // Refresh position data after management changes
    // This will be handled by the existing data fetching
  };

  const handleModifySLTP = async (ticket: number, sl: number, tp: number) => {
    if (!selectedAccount) {
      Alert.alert("Error", "No account selected");
      return;
    }

    try {
      const commandRef = ref(database, `commands/${selectedAccount}/latest`);
      await set(commandRef, {
        action: "MODIFY_SLTP",
        ticket: ticket,
        sl: sl,
        tp: tp,
        status: 'PENDING',
        timestamp: Math.floor(Date.now() / 1000)
      });
      Alert.alert("Success", "SL/TP modification sent to EA");
    } catch (error) {
      Alert.alert("Error", "Failed to send SL/TP modification command");
    }
  };

  const renderItem = ({ item }: { item: Position }) => (
    <TouchableOpacity style={[styles.card, { backgroundColor: theme.colors.card }]} onPress={() => handlePositionTap(item)} activeOpacity={0.8}>
      <View style={styles.cardHeader}>
        <View>
          <Text style={[styles.symbol, { color: theme.colors.text }]}>{item.symbol}</Text>
          <Text style={[styles.ticket, { color: theme.colors.textSecondary }]}>#{item.ticket}</Text>
        </View>
        <View style={styles.headerRight}>
          <Text style={[styles.type, { color: item.type === 0 ? theme.colors.buy : theme.colors.sell }]}>
            {item.type === 0 ? 'BUY' : 'SELL'}
          </Text>
          {/* Management Status Indicators */}
          <View style={styles.statusIndicators}>
            {item.breakevenEnabled && (
              <View style={[styles.statusBadge, { backgroundColor: item.breakevenTriggered ? theme.colors.success : theme.colors.warning }]}>
                <Text style={styles.statusBadgeText}>BE</Text>
              </View>
            )}
            {item.trailingEnabled && (
              <View style={[styles.statusBadge, { backgroundColor: theme.colors.primary }]}>
                <Text style={styles.statusBadgeText}>{item.trailingPercentage}%</Text>
              </View>
            )}
          </View>
        </View>
      </View>

      <View style={styles.row}>
        <Text style={[styles.label, { color: theme.colors.textSecondary }]}>Lots: {item.lots}</Text>
        <Text style={[styles.label, { color: theme.colors.textSecondary }]}>Open: {item.openPrice}</Text>
      </View>

      <View style={styles.row}>
        <Text style={[styles.profit, { color: item.profit >= 0 ? theme.colors.profit : theme.colors.loss }]}>
          {item.profit >= 0 ? '+' : ''}{item.profit.toFixed(2)}
        </Text>

        <View style={styles.actionButtons}>
          {/* Quick Action Buttons */}
          <TouchableOpacity
            style={[styles.quickButton, { backgroundColor: theme.colors.primary }]}
            onPress={(e) => {
              e.stopPropagation();
              handlePartialClose(item, 25);
            }}
          >
            <Text style={styles.quickButtonText}>25%</Text>
          </TouchableOpacity>

          <TouchableOpacity
            style={[styles.quickButton, { backgroundColor: theme.colors.primary }]}
            onPress={(e) => {
              e.stopPropagation();
              handlePartialClose(item, 50);
            }}
          >
            <Text style={styles.quickButtonText}>50%</Text>
          </TouchableOpacity>

          <TouchableOpacity
            style={[styles.manageButton, { backgroundColor: theme.colors.border }]}
            onPress={(e) => {
              e.stopPropagation();
              handleManagePosition(item);
            }}
          >
            <Text style={styles.manageButtonText}>⚙️</Text>
          </TouchableOpacity>

          <TouchableOpacity
            style={[styles.closeButton, closingIds.has(item.ticket) && styles.disabledButton]}
            onPress={(e) => {
              e.stopPropagation();
              handleClosePosition(item.ticket);
            }}
            disabled={closingIds.has(item.ticket)}
          >
            {closingIds.has(item.ticket) ? (
              <ActivityIndicator color="#FFF" size="small" />
            ) : (
              <Text style={styles.closeButtonText}>✕</Text>
            )}
          </TouchableOpacity>
        </View>
      </View>
    </TouchableOpacity>
  );

  return (
    <SafeAreaView style={[styles.container, { backgroundColor: theme.colors.background }]}>
      <View style={[styles.header, { backgroundColor: theme.colors.surface, borderBottomColor: theme.colors.border }]}>
        <Text style={[styles.title, { color: theme.colors.text }]}>📊 Portfolio</Text>
        {data?.positions && data.positions.length > 0 && (
          <TouchableOpacity style={[styles.closeAllButton, { backgroundColor: theme.colors.error }]} onPress={handleCloseAll}>
            <Text style={styles.closeAllText}>Close All</Text>
          </TouchableOpacity>
        )}
      </View>

      {loading ? (
        <Text style={[styles.centerText, { color: theme.colors.textSecondary }]}>Loading positions...</Text>
      ) : error ? (
        <Text style={[styles.centerText, { color: theme.colors.error }]}>Error loading data</Text>
      ) : !data?.positions || data.positions.length === 0 ? (
        <Text style={[styles.centerText, { color: theme.colors.textSecondary }]}>No open positions</Text>
      ) : (
        <FlatList
          data={data.positions}
          renderItem={renderItem}
          keyExtractor={item => item.ticket.toString()}
          contentContainerStyle={styles.listContent}
        />
      )}

      {/* Position Details Modal */}
      <PositionDetailsModal
        position={selectedPosition}
        visible={modalVisible}
        onClose={() => setModalVisible(false)}
        onScalePosition={handleScalePosition}
        onModifySLTP={handleModifySLTP}
      />

      {/* Position Management Modal */}
      <PositionManagementModal
        position={managementPosition}
        visible={managementModalVisible}
        onClose={() => setManagementModalVisible(false)}
        onUpdate={handleManagementUpdate}
      />
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: '#F5F5F5',
  },
  header: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    padding: 16,
    backgroundColor: '#FFF',
    borderBottomWidth: 1,
    borderBottomColor: '#EEE',
  },
  title: {
    fontSize: 24,
    fontWeight: 'bold',
    color: '#333',
  },
  closeAllButton: {
    backgroundColor: '#F44336',
    paddingHorizontal: 12,
    paddingVertical: 8,
    borderRadius: 8,
  },
  closeAllText: {
    color: '#FFF',
    fontWeight: 'bold',
    fontSize: 14,
  },
  listContent: {
    padding: 16,
  },
  card: {
    backgroundColor: '#FFF',
    borderRadius: 12,
    padding: 16,
    marginBottom: 12,
    elevation: 2,
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 1 },
    shadowOpacity: 0.1,
    shadowRadius: 2,
  },
  cardHeader: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'flex-start',
    marginBottom: 12,
  },
  symbol: {
    fontSize: 18,
    fontWeight: 'bold',
    color: '#333',
  },
  ticket: {
    fontSize: 12,
    color: '#999',
  },
  type: {
    fontSize: 16,
    fontWeight: '700',
  },
  row: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    marginTop: 4,
  },
  label: {
    fontSize: 14,
    color: '#666',
  },
  profit: {
    fontSize: 20,
    fontWeight: 'bold',
  },
  closeButton: {
    backgroundColor: '#FF9800',
    paddingHorizontal: 16,
    paddingVertical: 8,
    borderRadius: 20,
    minWidth: 80,
    alignItems: 'center',
  },
  disabledButton: {
    backgroundColor: '#CCC',
  },
  closeButtonText: {
    color: '#FFF',
    fontWeight: '600',
  },
  centerText: {
    textAlign: 'center',
    marginTop: 40,
    color: '#999',
    fontSize: 16,
  },
  headerRight: {
    alignItems: 'flex-end',
  },
  statusIndicators: {
    flexDirection: 'row',
    gap: 4,
    marginTop: 4,
  },
  statusBadge: {
    paddingHorizontal: 6,
    paddingVertical: 2,
    borderRadius: 10,
    minWidth: 24,
    alignItems: 'center',
  },
  statusBadgeText: {
    color: '#FFF',
    fontSize: 10,
    fontWeight: 'bold',
  },
  actionButtons: {
    flexDirection: 'row',
    gap: 8,
    alignItems: 'center',
  },
  quickButton: {
    backgroundColor: '#007AFF',
    paddingHorizontal: 8,
    paddingVertical: 6,
    borderRadius: 6,
    minWidth: 40,
    alignItems: 'center',
  },
  quickButtonText: {
    color: '#FFF',
    fontSize: 12,
    fontWeight: 'bold',
  },
  manageButton: {
    backgroundColor: '#666',
    paddingHorizontal: 8,
    paddingVertical: 6,
    borderRadius: 6,
    minWidth: 32,
    alignItems: 'center',
  },
  manageButtonText: {
    color: '#FFF',
    fontSize: 14,
  },
});
