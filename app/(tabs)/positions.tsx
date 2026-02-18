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
        action: 'OPEN_POSITION', // Changed from SCALE_POSITION to standard command
        symbol: selectedPosition.symbol,
        type: selectedPosition.type,
        lots: scaledLots,
        sl: selectedPosition.sl,
        tp: selectedPosition.tp,
        scaleFactor: scaleFactor,
        originalTicket: selectedPosition.ticket,
        status: 'PENDING',
        timestamp: Math.floor(Date.now() / 1000)
      };

      console.log('Sending scale command:', JSON.stringify(command, null, 2));
      console.log('Firebase path:', `commands/${selectedAccount}/latest`);

      const commandRef = ref(database, `commands/${selectedAccount}/latest`);
      await set(commandRef, command);

      Alert.alert("Debug", `Scaling command sent to Firebase.\nPath: commands/${selectedAccount}/latest\nAction: OPEN_POSITION\nLots: ${scaledLots}`);
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

  const renderItem = ({ item }: { item: Position }) => (
    <TouchableOpacity style={[styles.card, { backgroundColor: theme.colors.card }]} onPress={() => handlePositionTap(item)} activeOpacity={0.8}>
      <View style={styles.cardHeader}>
        <View>
          <Text style={[styles.symbol, { color: theme.colors.text }]}>{item.symbol}</Text>
          <Text style={[styles.ticket, { color: theme.colors.textSecondary }]}>#{item.ticket}</Text>
        </View>
        <Text style={[styles.type, { color: item.type === 0 ? theme.colors.buy : theme.colors.sell }]}>
          {item.type === 0 ? 'BUY' : 'SELL'}
        </Text>
      </View>

      <View style={styles.row}>
        <Text style={[styles.label, { color: theme.colors.textSecondary }]}>Lots: {item.lots}</Text>
        <Text style={[styles.label, { color: theme.colors.textSecondary }]}>Open: {item.openPrice}</Text>
      </View>

      <View style={styles.row}>
        <Text style={[styles.profit, { color: item.profit >= 0 ? theme.colors.profit : theme.colors.loss }]}>
          {item.profit >= 0 ? '+' : ''}{item.profit.toFixed(2)}
        </Text>

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
            <Text style={styles.closeButtonText}>Close</Text>
          )}
        </TouchableOpacity>
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
});
