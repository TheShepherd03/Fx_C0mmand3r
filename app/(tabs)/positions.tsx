import React, { useState, useEffect } from 'react';
import {
  View,
  Text,
  FlatList,
  StyleSheet,
  SafeAreaView,
  TouchableOpacity,
  ActivityIndicator,
  Alert,
  RefreshControl
} from 'react-native';
import { Position } from '@/constants/types';
import { useAccount } from '@/contexts/AccountContext';
import { PositionDetailsModal } from '@/components/PositionDetailsModal';
import { PositionManagementModal } from '@/components/PositionManagementModal';
import { useTheme } from '@/contexts/ThemeContext';
import { database } from '@/firebaseConfig';
import { ref, set, onValue, off } from 'firebase/database';
import { IconSymbol } from '@/components/ui/icon-symbol';

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
  const [refreshing, setRefreshing] = useState(false);

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
        // Handle positions array/object
        let positions: Position[] = [];
        if (val.positions) {
          if (Array.isArray(val.positions)) {
            positions = val.positions;
          } else {
            positions = Object.values(val.positions);
          }
        }
        setData({ ...val, positions });
        setError(null);
      } else {
        setData(null);
        setError('No data available');
      }
      setLoading(false);
      setRefreshing(false);
    };

    const handleError = (error: any) => {
      console.error('Firebase error:', error);
      setError('Connection error');
      setLoading(false);
      setRefreshing(false);
    };

    onValue(accountRef, handleData, handleError);

    return () => {
      off(accountRef, 'value', handleData);
    };
  }, [selectedAccount]);

  const onRefresh = () => {
    setRefreshing(true);
    // Real-time listener will update automatically, but we simulate a refresh state
    setTimeout(() => setRefreshing(false), 1000);
  };

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
    // Refresh handled by real-time listener
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
    } catch {
      Alert.alert("Error", "Failed to send SL/TP modification command");
    }
  };

  const formatCurrency = (val: number) => {
    return `$${val.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
  };

  const renderItem = ({ item }: { item: Position }) => (
    <TouchableOpacity
      style={[styles.positionCard, { backgroundColor: theme.colors.card }]}
      onPress={() => handlePositionTap(item)}
      activeOpacity={0.9}
    >
      {/* Card Header: Symbol, Type, P/L */}
      <View style={styles.cardHeader}>
        <View style={styles.symbolContainer}>
          <View style={[styles.iconPlaceholder, { backgroundColor: theme.colors.input }]}>
            <Text style={[styles.iconText, { color: theme.colors.textSecondary }]}>
              {item.symbol.substring(0, 2)}
            </Text>
          </View>
          <View>
            <View style={styles.symbolRow}>
              <Text style={[styles.symbolText, { color: theme.colors.text }]}>{item.symbol}</Text>
              <View style={[
                styles.typeBadge,
                { backgroundColor: item.type === 0 ? theme.colors.buyBackground : theme.colors.sellBackground }
              ]}>
                <Text style={[
                  styles.typeText,
                  { color: item.type === 0 ? theme.colors.buy : theme.colors.sell }
                ]}>
                  {item.type === 0 ? 'BUY' : 'SELL'}
                </Text>
              </View>
            </View>
            <Text style={[styles.lotText, { color: theme.colors.textSecondary }]}>
              {item.lots} Lots @ {item.openPrice}
            </Text>
          </View>
        </View>

        <View style={styles.plContainer}>
          <Text style={[styles.plText, { color: item.profit >= 0 ? theme.colors.profit : theme.colors.loss }]}>
            {item.profit >= 0 ? '+' : ''}{formatCurrency(item.profit)}
          </Text>
          <View style={styles.badgesRow}>
            {item.breakevenEnabled && (
              <View style={[styles.miniBadge, { backgroundColor: theme.colors.input }]}>
                <Text style={[styles.miniBadgeText, { color: theme.colors.textSecondary }]}>BE Active</Text>
              </View>
            )}
            {item.tp > 0 && (
              <View style={[styles.miniBadge, { backgroundColor: theme.colors.input }]}>
                <Text style={[styles.miniBadgeText, { color: theme.colors.info }]}>TP Set</Text>
              </View>
            )}
          </View>
        </View>
      </View>

      {/* Price Grid */}
      <View style={[styles.priceGrid, { borderTopColor: theme.colors.border, borderBottomColor: theme.colors.border }]}>
        <View style={styles.priceItem}>
          <Text style={[styles.priceLabel, { color: theme.colors.textSecondary }]}>Entry</Text>
          <Text style={[styles.priceValue, { color: theme.colors.text }]}>{item.openPrice}</Text>
        </View>
        <View style={[styles.priceItem, { alignItems: 'flex-end' }]}>
          <Text style={[styles.priceLabel, { color: theme.colors.textSecondary }]}>Current</Text>
          <Text style={[styles.priceValue, { color: theme.colors.text }]}>{item.currentPrice}</Text>
        </View>
      </View>

      {/* Action Buttons */}
      <View style={styles.actionRow}>
        <TouchableOpacity
          style={[styles.actionBtn, { backgroundColor: theme.colors.info + '20' }]}
          onPress={(e) => {
            e.stopPropagation();
            handlePartialClose(item, 25);
          }}
        >
          <Text style={[styles.actionBtnText, { color: theme.colors.info }]}>[25%]</Text>
        </TouchableOpacity>

        <TouchableOpacity
          style={[styles.actionBtn, { backgroundColor: theme.colors.info + '20' }]}
          onPress={(e) => {
            e.stopPropagation();
            handlePartialClose(item, 50);
          }}
        >
          <Text style={[styles.actionBtnText, { color: theme.colors.info }]}>[50%]</Text>
        </TouchableOpacity>

        <TouchableOpacity
          style={[styles.iconBtn, { backgroundColor: theme.colors.input }]}
          onPress={(e) => {
            e.stopPropagation();
            handleManagePosition(item);
          }}
        >
          <IconSymbol name="gear" size={20} color={theme.colors.textSecondary} />
        </TouchableOpacity>

        <TouchableOpacity
          style={[styles.iconBtn, { backgroundColor: theme.colors.error + '20' }]}
          onPress={(e) => {
            e.stopPropagation();
            handleClosePosition(item.ticket);
          }}
          disabled={closingIds.has(item.ticket)}
        >
          {closingIds.has(item.ticket) ? (
            <ActivityIndicator color={theme.colors.error} size="small" />
          ) : (
            <IconSymbol name="xmark" size={20} color={theme.colors.error} />
          )}
        </TouchableOpacity>
      </View>
    </TouchableOpacity>
  );

  const calculateTotalPL = () => {
    if (!data?.balance || !data?.equity) return 0;
    return data.equity - data.balance;
  };

  const calculatePLPercent = () => {
    if (!data?.balance || data.balance === 0) return 0;
    const pl = calculateTotalPL();
    return (pl / data.balance) * 100;
  };

  const totalPL = calculateTotalPL();
  const plPercent = calculatePLPercent();

  return (
    <SafeAreaView style={[styles.container, { backgroundColor: theme.colors.background }]}>
      {/* Header */}
      <View style={styles.header}>
        <Text style={[styles.headerTitle, { color: theme.colors.text }]}>Portfolio</Text>
        {data?.positions && data.positions.length > 0 && (
          <TouchableOpacity
            style={[styles.closeAllBtn, { backgroundColor: theme.colors.error + '20', borderColor: theme.colors.error }]}
            onPress={handleCloseAll}
          >
            <IconSymbol name="exclamationmark.triangle.fill" size={14} color={theme.colors.error} />
            <Text style={[styles.closeAllText, { color: theme.colors.error }]}>Close All</Text>
          </TouchableOpacity>
        )}
      </View>

      {/* Summary Cards */}
      <View style={styles.summaryContainer}>
        <View style={[styles.summaryCard, { backgroundColor: theme.colors.card }]}>
          <Text style={[styles.summaryLabel, { color: theme.colors.textSecondary }]}>TOTAL P/L</Text>
          <View style={styles.valueRow}>
            <Text style={[styles.summaryValue, { color: totalPL >= 0 ? theme.colors.profit : theme.colors.loss }]}>
              {totalPL >= 0 ? '+' : ''}{formatCurrency(totalPL)}
            </Text>
            <View style={[styles.percentTag, { backgroundColor: totalPL >= 0 ? theme.colors.buyBackground : theme.colors.sellBackground }]}>
              <Text style={[styles.percentText, { color: totalPL >= 0 ? theme.colors.profit : theme.colors.loss }]}>
                {totalPL >= 0 ? '+' : ''}{plPercent.toFixed(1)}%
              </Text>
            </View>
          </View>
        </View>

        <View style={[styles.summaryCard, { backgroundColor: theme.colors.card }]}>
          <Text style={[styles.summaryLabel, { color: theme.colors.textSecondary }]}>MARGIN LEVEL</Text>
          <View style={styles.valueRow}>
            <Text style={[styles.summaryValue, { color: theme.colors.text }]}>
              {data?.marginLevel ? Math.round(data.marginLevel).toLocaleString() : '0'}%
            </Text>
            <IconSymbol name="info.circle" size={14} color={theme.colors.textSecondary} />
          </View>
        </View>
      </View>

      {/* Active Positions Header */}
      <View style={styles.sectionHeader}>
        <Text style={[styles.sectionTitle, { color: theme.colors.textSecondary }]}>
          ACTIVE POSITIONS ({data?.positions ? data.positions.length : 0})
        </Text>
        <View style={styles.filterContainer}>
          <TouchableOpacity style={[styles.filterBtn, { backgroundColor: theme.colors.input }]}>
            <Text style={[styles.filterText, { color: theme.colors.primary }]}>Filter</Text>
          </TouchableOpacity>
          <TouchableOpacity style={[styles.filterBtn, { backgroundColor: theme.colors.input }]}>
            <Text style={[styles.filterText, { color: theme.colors.primary }]}>Sort</Text>
          </TouchableOpacity>
        </View>
      </View>

      {loading && !refreshing ? (
        <View style={styles.loadingContainer}>
          <ActivityIndicator size="large" color={theme.colors.primary} />
          <Text style={[styles.loadingText, { color: theme.colors.textSecondary }]}>Syncing positions...</Text>
        </View>
      ) : error ? (
        <View style={styles.centerContainer}>
          <Text style={[styles.errorText, { color: theme.colors.error }]}>{error}</Text>
        </View>
      ) : !data?.positions || data.positions.length === 0 ? (
        <View style={styles.centerContainer}>
          <IconSymbol name="tray" size={48} color={theme.colors.textTertiary} />
          <Text style={[styles.emptyText, { color: theme.colors.textSecondary }]}>No active positions</Text>
        </View>
      ) : (
        <FlatList
          data={data.positions}
          renderItem={renderItem}
          keyExtractor={item => item.ticket.toString()}
          contentContainerStyle={styles.listContent}
          refreshControl={
            <RefreshControl refreshing={refreshing} onRefresh={onRefresh} tintColor={theme.colors.primary} />
          }
        />
      )}

      {/* Modals */}
      <PositionDetailsModal
        position={selectedPosition}
        visible={modalVisible}
        onClose={() => setModalVisible(false)}
        onScalePosition={handleScalePosition}
        onModifySLTP={handleModifySLTP}
      />

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
  },
  header: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    paddingHorizontal: 16,
    paddingVertical: 12,
  },
  headerTitle: {
    fontSize: 28,
    fontWeight: 'bold',
  },
  closeAllBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 12,
    paddingVertical: 8,
    borderRadius: 8,
    borderWidth: 1,
    gap: 6,
  },
  closeAllText: {
    fontWeight: 'bold',
    fontSize: 14,
  },
  summaryContainer: {
    flexDirection: 'row',
    paddingHorizontal: 16,
    gap: 12,
    marginBottom: 20,
  },
  summaryCard: {
    flex: 1,
    padding: 16,
    borderRadius: 12,
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 2 },
    shadowOpacity: 0.05,
    shadowRadius: 4,
    elevation: 2,
  },
  summaryLabel: {
    fontSize: 11,
    fontWeight: '700',
    marginBottom: 8,
    letterSpacing: 0.5,
  },
  valueRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    flexWrap: 'wrap',
    gap: 4,
  },
  summaryValue: {
    fontSize: 18,
    fontWeight: '800',
  },
  percentTag: {
    paddingHorizontal: 6,
    paddingVertical: 2,
    borderRadius: 4,
  },
  percentText: {
    fontSize: 11,
    fontWeight: '700',
  },
  sectionHeader: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    paddingHorizontal: 16,
    marginBottom: 12,
  },
  sectionTitle: {
    fontSize: 13,
    fontWeight: '600',
    letterSpacing: 0.5,
  },
  filterContainer: {
    flexDirection: 'row',
    gap: 8,
  },
  filterBtn: {
    paddingHorizontal: 10,
    paddingVertical: 4,
    borderRadius: 6,
  },
  filterText: {
    fontSize: 12,
    fontWeight: '600',
  },
  listContent: {
    padding: 16,
    paddingTop: 0,
  },
  positionCard: {
    borderRadius: 16,
    padding: 16,
    marginBottom: 12,
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 2 },
    shadowOpacity: 0.05,
    shadowRadius: 6,
    elevation: 2,
  },
  cardHeader: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    marginBottom: 12,
  },
  symbolContainer: {
    flexDirection: 'row',
    gap: 12,
  },
  iconPlaceholder: {
    width: 40,
    height: 40,
    borderRadius: 20,
    justifyContent: 'center',
    alignItems: 'center',
  },
  iconText: {
    fontWeight: 'bold',
    fontSize: 14,
  },
  symbolRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    marginBottom: 4,
  },
  symbolText: {
    fontSize: 16,
    fontWeight: 'bold',
  },
  typeBadge: {
    paddingHorizontal: 6,
    paddingVertical: 2,
    borderRadius: 4,
  },
  typeText: {
    fontSize: 10,
    fontWeight: '800',
  },
  lotText: {
    fontSize: 12,
  },
  plContainer: {
    alignItems: 'flex-end',
  },
  plText: {
    fontSize: 18,
    fontWeight: '800',
    marginBottom: 4,
  },
  badgesRow: {
    flexDirection: 'row',
    gap: 4,
  },
  miniBadge: {
    paddingHorizontal: 6,
    paddingVertical: 2,
    borderRadius: 4,
  },
  miniBadgeText: {
    fontSize: 10,
    fontWeight: '600',
  },
  priceGrid: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    paddingVertical: 12,
    borderTopWidth: 1,
    borderBottomWidth: 1,
    marginBottom: 12,
  },
  priceItem: {
    flex: 1,
  },
  priceLabel: {
    fontSize: 11,
    marginBottom: 2,
  },
  priceValue: {
    fontSize: 14,
    fontWeight: '600',
    fontFamily: 'monospace', // Ensure numbers align nicely
  },
  actionRow: {
    flexDirection: 'row',
    gap: 8,
  },
  actionBtn: {
    flex: 2,
    paddingVertical: 8,
    borderRadius: 8,
    alignItems: 'center',
    justifyContent: 'center',
  },
  actionBtnText: {
    fontSize: 12,
    fontWeight: '700',
  },
  iconBtn: {
    flex: 1,
    paddingVertical: 8,
    borderRadius: 8,
    alignItems: 'center',
    justifyContent: 'center',
  },
  centerContainer: {
    flex: 1,
    justifyContent: 'center',
    alignItems: 'center',
    padding: 20,
  },
  loadingContainer: {
    flex: 1,
    justifyContent: 'center',
    alignItems: 'center',
  },
  loadingText: {
    marginTop: 12,
    fontSize: 14,
  },
  emptyText: {
    marginTop: 12,
    fontSize: 16,
    fontWeight: '500',
  },
  errorText: {
    fontSize: 16,
    textAlign: 'center',
  },
});
