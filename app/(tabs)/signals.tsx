import React, { useState, useEffect } from 'react';
import { StyleSheet, View, Text, FlatList, TouchableOpacity, Alert, ActivityIndicator } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { database } from '@/firebaseConfig';
import { ref, query, orderByChild, limitToLast, onValue, set } from 'firebase/database';
import { AccountSelector } from '@/components/AccountSelector';
import { useAccount } from '@/contexts/AccountContext';
import { useTheme } from '@/contexts/ThemeContext';

interface Signal {
  id: string;
  symbol: string;
  type: string; // 'BUY' | 'SELL'
  price: number;
  sl?: number;
  tp?: number;
  timestamp: number;
  strategy: string;
}

export default function SignalsScreen() {
  const { selectedAccount } = useAccount();
  const { theme } = useTheme();
  const [signals, setSignals] = useState<Signal[]>([]);
  const [loading, setLoading] = useState(true);
  const [executingIds, setExecutingIds] = useState<Set<string>>(new Set());

  useEffect(() => {
    if (!selectedAccount) {
      setSignals([]);
      setLoading(false);
      return;
    }

    const signalsRef = query(
      ref(database, `signals/${selectedAccount}`),
      orderByChild('timestamp'),
      limitToLast(50)
    );

    const onDataChange = (snapshot: any) => {
      const val = snapshot.val();
      if (val) {
        const list = Object.keys(val).map(key => ({
          id: key,
          ...val[key]
        })).sort((a: Signal, b: Signal) => b.timestamp - a.timestamp); // Newest first

        setSignals(list);

        // Check for new signals to notify
        const newest = list[0];
        if (newest) {
          scheduleNotification(newest);
        }
      } else {
        setSignals([]);
      }
      setLoading(false);
    };

    const unsubscribe = onValue(signalsRef, onDataChange);

    return () => unsubscribe();
  }, [selectedAccount]);

  async function scheduleNotification(signal: Signal) {
    // Notifications disabled for Expo Go compatibility
    console.log(`Signal: ${signal.type} ${signal.symbol} @ ${signal.price} | ${signal.strategy}`);
  }

  const executeSignal = async (signal: Signal) => {
    if (!selectedAccount) {
      Alert.alert("Error", "No account selected. Please select an account first.");
      return;
    }

    // Show confirmation dialog
    Alert.alert(
      "Execute Signal",
      `Execute ${signal.symbol} ${signal.type} signal with minimum lot size (0.01)?`,
      [
        { text: "Cancel", style: "cancel" },
        {
          text: "Execute",
          onPress: async () => {
            setExecutingIds(prev => new Set([...prev, signal.id]));

            try {
              const commandRef = ref(database, `commands/${selectedAccount}/latest`);
              const command = {
                action: 'OPEN_POSITION',
                symbol: signal.symbol,
                type: signal.type === 'BUY' ? 0 : 1, // Convert string to number
                lots: 0.01, // Minimum lot size as requested
                sl: signal.sl || 0,
                tp: signal.tp || 0,
                status: 'PENDING',
                timestamp: Math.floor(Date.now() / 1000)
              };

              console.log('Sending signal execution command:', JSON.stringify(command, null, 2));
              console.log('Firebase path:', `commands/${selectedAccount}/latest`);

              await set(commandRef, command);
              Alert.alert("Success", `Signal execution command sent for ${signal.symbol}.`);
            } catch {
              Alert.alert("Error", "Failed to execute signal.");
            } finally {
              setExecutingIds(prev => {
                const newSet = new Set(prev);
                newSet.delete(signal.id);
                return newSet;
              });
            }
          }
        }
      ]
    );
  };

  const formatTime = (timestamp: number) => {
    const date = new Date(timestamp * 1000);
    return date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  };

  const renderItem = ({ item }: { item: Signal }) => (
    <View style={[styles.card, { backgroundColor: theme.colors.card }]}>
      <View style={styles.cardHeader}>
        <Text style={[styles.symbol, { color: theme.colors.text }]}>{item.symbol}</Text>
        <Text style={[styles.type, { color: item.type === 'BUY' ? theme.colors.buy : theme.colors.sell }]}>
          {item.type}
        </Text>
      </View>

      <Text style={[styles.strategy, { color: theme.colors.textSecondary }]}>Strategy: {item.strategy}</Text>
      <Text style={[styles.time, { color: theme.colors.textTertiary }]}>{formatTime(item.timestamp)}</Text>

      <View style={styles.priceInfo}>
        <View>
          <Text style={[styles.label, { color: theme.colors.textSecondary }]}>Price</Text>
          <Text style={[styles.value, { color: theme.colors.text }]}>{item.price}</Text>
        </View>
        <View>
          <Text style={[styles.label, { color: theme.colors.textSecondary }]}>Stop Loss</Text>
          <Text style={[styles.value, { color: theme.colors.text }]}>{item.sl || '-'}</Text>
        </View>
        <View>
          <Text style={[styles.label, { color: theme.colors.textSecondary }]}>Take Profit</Text>
          <Text style={[styles.value, { color: theme.colors.text }]}>{item.tp || '-'}</Text>
        </View>
      </View>

      <TouchableOpacity
        style={[styles.executeButton, { backgroundColor: theme.colors.buttonBackground }]}
        onPress={() => executeSignal(item)}
        disabled={executingIds.has(item.id)}
      >
        {executingIds.has(item.id) ? (
          <ActivityIndicator color={theme.colors.text} size="small" />
        ) : (
          <Text style={[styles.executeButtonText, { color: theme.colors.text }]}>
            Execute Signal
          </Text>
        )}
      </TouchableOpacity>
    </View>
  );

  return (
    <SafeAreaView style={[styles.container, { backgroundColor: theme.colors.background }]}>
      <View style={[styles.header, { backgroundColor: theme.colors.surface, borderBottomColor: theme.colors.border }]}>
        <Text style={[styles.title, { color: theme.colors.text }]}>📡 Market Signals</Text>
      </View>

      <AccountSelector />

      <FlatList
        data={signals}
        renderItem={renderItem}
        keyExtractor={item => item.id}
        contentContainerStyle={styles.listContent}
        ListEmptyComponent={
          !loading ? <Text style={[styles.emptyText, { color: theme.colors.textSecondary }]}>No signals yet</Text> : null
        }
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
    alignItems: 'center',
    marginBottom: 8,
  },
  badgeContainer: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
  },
  badge: {
    paddingHorizontal: 8,
    paddingVertical: 4,
    borderRadius: 4,
  },
  badgeText: {
    color: '#FFF',
    fontWeight: 'bold',
    fontSize: 12,
  },
  symbol: {
    fontSize: 18,
    fontWeight: 'bold',
    color: '#333',
  },
  type: {
    fontSize: 16,
    fontWeight: 'bold',
    paddingHorizontal: 8,
    paddingVertical: 4,
    borderRadius: 4,
  },
  time: {
    fontSize: 12,
    color: '#999',
  },
  priceInfo: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    marginTop: 8,
    paddingTop: 8,
    borderTopWidth: 1,
    borderTopColor: '#F0F0F0',
  },
  strategy: {
    fontSize: 14,
    color: '#666',
    marginBottom: 12,
    fontStyle: 'italic',
  },
  detailsRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    backgroundColor: '#F9F9F9',
    padding: 12,
    borderRadius: 8,
  },
  label: {
    fontSize: 12,
    color: '#999',
    marginBottom: 4,
  },
  value: {
    fontSize: 16,
    fontWeight: '600',
    color: '#333',
  },
  emptyText: {
    textAlign: 'center',
    marginTop: 40,
    color: '#999',
  },
  executeButton: {
    backgroundColor: '#2196F3',
    paddingHorizontal: 16,
    paddingVertical: 10,
    borderRadius: 8,
    marginTop: 12,
    alignItems: 'center',
    justifyContent: 'center',
    minHeight: 40,
  },
  executeButtonText: {
    color: '#FFF',
    fontSize: 14,
    fontWeight: '600',
  },
});
