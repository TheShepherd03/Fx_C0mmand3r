import React, { useState, useEffect } from 'react';
import { StyleSheet, View, Text, FlatList, TouchableOpacity, Alert, ActivityIndicator, ScrollView } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { database } from '@/firebaseConfig';
import { ref, query, orderByChild, limitToLast, onValue, set, update } from 'firebase/database';
import { AccountSelector } from '@/components/AccountSelector';
import { useAccount } from '@/contexts/AccountContext';
import { useTheme } from '@/contexts/ThemeContext';
import { Signal } from '@/constants/types';

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
        }))
          .filter((item: any) => {
            // Validate required fields to prevent crashes
            return item.symbol &&
              (item.action === 'BUY' || item.action === 'SELL') &&
              typeof item.price === 'number' && !isNaN(item.price) &&
              typeof item.lots === 'number' && !isNaN(item.lots) &&
              typeof item.timestamp === 'number' && !isNaN(item.timestamp);
          })
          .sort((a: Signal, b: Signal) => b.timestamp - a.timestamp); // Newest first

        setSignals(list);
      } else {
        setSignals([]);
      }
      setLoading(false);
    };

    const unsubscribe = onValue(signalsRef, onDataChange);

    return () => unsubscribe();
  }, [selectedAccount]);

  const executeSignal = async (signal: Signal) => {
    if (!selectedAccount) {
      Alert.alert("Error", "No account selected. Please select an account first.");
      return;
    }

    if (!signal || !signal.id) {
      Alert.alert("Error", "Invalid signal data.");
      return;
    }

    // Calculate risk/reward info
    const price = signal.price || 0;
    const sl = signal.sl || 0;
    const tp = signal.tp || 0;
    const lots = signal.lots || 0;

    const riskAmount = sl > 0 ? Math.abs(price - sl) * lots * 100000 : 0;
    const rewardAmount = tp > 0 ? Math.abs(tp - price) * lots * 100000 : 0;
    const rrRatio = riskAmount > 0 ? (rewardAmount / riskAmount).toFixed(2) : "N/A";

    // Show detailed confirmation dialog
    Alert.alert(
      "🎯 Execute Signal",
      `Execute ${signal.symbol} ${signal.action} signal?
      
📊 Signal Details:
• Source: ${signal.source || 'Unknown'}
• Entry: ${price.toFixed(5)}
• Stop Loss: ${sl > 0 ? sl.toFixed(5) : 'None'}
• Take Profit: ${tp > 0 ? tp.toFixed(5) : 'None'}
• Lot Size: ${lots}
• Risk/Reward: 1:${rrRatio}
• Confidence: ${signal.confidence || 0}%`,
      [
        { text: "❌ Cancel", style: "cancel" },
        {
          text: "✅ Execute",
          onPress: async () => {
            setExecutingIds(prev => new Set([...prev, signal.id]));

            try {
              const commandRef = ref(database, `commands/${selectedAccount}/latest`);
              const command = {
                action: 'OPEN_POSITION',
                symbol: signal.symbol,
                type: signal.action === 'BUY' ? 0 : 1,
                lots: lots,
                sl: sl,
                tp: tp,
                status: 'PENDING',
                timestamp: Math.floor(Date.now() / 1000)
              };

              await set(commandRef, command);

              // Update signal status to executed
              const signalRef = ref(database, `signals/${selectedAccount}/${signal.id}`);
              await update(signalRef, { status: 'executed' });

              Alert.alert("✅ Success", `Signal executed for ${signal.symbol} ${signal.action}`);
            } catch {
              Alert.alert("❌ Error", "Failed to execute signal.");
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

  const rejectSignal = async (signal: Signal) => {
    if (!signal || !signal.id) return;

    setExecutingIds(prev => new Set([...prev, signal.id]));

    try {
      const signalRef = ref(database, `signals/${selectedAccount}/${signal.id}`);
      await update(signalRef, { status: 'rejected' });
      Alert.alert("Signal Rejected", `${signal.symbol} ${signal.action} signal marked as rejected`);
    } catch {
      Alert.alert("Error", "Failed to reject signal");
    } finally {
      setExecutingIds(prev => {
        const newSet = new Set(prev);
        newSet.delete(signal.id);
        return newSet;
      });
    }
  };

  const formatTime = (timestamp: number) => {
    if (!timestamp || isNaN(timestamp)) return "Unknown Time";
    try {
      const date = new Date(timestamp * 1000);
      return date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
    } catch (e) {
      return "Invalid Time";
    }
  };

  const renderItem = ({ item }: { item: Signal }) => {
    if (!item) return null;

    const getStatusColor = () => {
      switch (item.status) {
        case 'executed': return theme.colors.profit;
        case 'rejected': return theme.colors.loss;
        case 'expired': return theme.colors.textSecondary;
        default: return theme.colors.warning;
      }
    };

    const getStatusIcon = () => {
      switch (item.status) {
        case 'executed': return '✅';
        case 'rejected': return '❌';
        case 'expired': return '⏰';
        default: return '⏳';
      }
    };

    const price = item.price || 0;
    const sl = item.sl || 0;
    const tp = item.tp || 0;
    const confidence = item.confidence || 0;
    const lots = item.lots || 0;
    const source = item.source || 'Unknown';
    const isProcessing = executingIds.has(item.id);

    return (
      <View style={[styles.card, { backgroundColor: theme.colors.card }]}>
        <View style={styles.cardHeader}>
          <View>
            <Text style={[styles.symbol, { color: theme.colors.text }]}>{item.symbol || 'Unknown'}</Text>
            <Text style={[styles.source, { color: theme.colors.textSecondary }]}>📡 {source}</Text>
          </View>
          <View style={styles.headerRight}>
            <Text style={[styles.type, { color: item.action === 'BUY' ? theme.colors.buy : theme.colors.sell }]}>
              {item.action || 'Unknown'}
            </Text>
            <View style={[styles.statusBadge, { backgroundColor: getStatusColor() }]}>
              <Text style={styles.statusText}>{getStatusIcon()} {(item.status || 'unknown').toUpperCase()}</Text>
            </View>
          </View>
        </View>

        <View style={styles.signalInfo}>
          <View style={styles.confidenceContainer}>
            <Text style={[styles.confidence, { color: theme.colors.text }]}>
              🎯 {confidence}% Confidence
            </Text>
            <Text style={[styles.lots, { color: theme.colors.textSecondary }]}>
              Size: {lots} lots
            </Text>
          </View>
          <Text style={[styles.time, { color: theme.colors.textTertiary }]}>{formatTime(item.timestamp)}</Text>
        </View>

        <View style={styles.priceInfo}>
          <View>
            <Text style={[styles.label, { color: theme.colors.textSecondary }]}>Entry</Text>
            <Text style={[styles.value, { color: theme.colors.text }]}>{price.toFixed(5)}</Text>
          </View>
          <View>
            <Text style={[styles.label, { color: theme.colors.textSecondary }]}>Stop Loss</Text>
            <Text style={[styles.value, { color: theme.colors.loss }]}>
              {sl > 0 ? sl.toFixed(5) : 'None'}
            </Text>
          </View>
          <View>
            <Text style={[styles.label, { color: theme.colors.textSecondary }]}>Take Profit</Text>
            <Text style={[styles.value, { color: theme.colors.profit }]}>
              {tp > 0 ? tp.toFixed(5) : 'None'}
            </Text>
          </View>
        </View>

        {item.status === 'pending' && (
          <View style={styles.actionButtons}>
            <TouchableOpacity
              style={[styles.rejectButton, { backgroundColor: theme.colors.error }]}
              onPress={() => rejectSignal(item)}
              disabled={isProcessing}
            >
              {isProcessing ? (
                <ActivityIndicator color="#fff" size="small" />
              ) : (
                <Text style={styles.rejectButtonText}>❌ Reject</Text>
              )}
            </TouchableOpacity>

            <TouchableOpacity
              style={[styles.executeButton, { backgroundColor: theme.colors.primary }]}
              onPress={() => executeSignal(item)}
              disabled={isProcessing}
            >
              {isProcessing ? (
                <ActivityIndicator color="#fff" size="small" />
              ) : (
                <Text style={styles.executeButtonText}>
                  ✅ Execute
                </Text>
              )}
            </TouchableOpacity>
          </View>
        )}
      </View>
    );
  };

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
  source: {
    fontSize: 12,
    color: '#666',
    marginTop: 2,
  },
  headerRight: {
    flexDirection: 'column',
    alignItems: 'flex-end',
    gap: 4,
  },
  statusBadge: {
    paddingHorizontal: 6,
    paddingVertical: 2,
    borderRadius: 4,
  },
  statusText: {
    color: '#FFF',
    fontSize: 10,
    fontWeight: 'bold',
  },
  signalInfo: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    marginVertical: 8,
  },
  confidenceContainer: {
    flexDirection: 'column',
    gap: 4,
  },
  confidence: {
    fontSize: 14,
    fontWeight: '600',
  },
  lots: {
    fontSize: 12,
  },
  actionButtons: {
    flexDirection: 'row',
    gap: 12,
    marginTop: 16,
  },
  rejectButton: {
    flex: 1,
    paddingVertical: 10,
    borderRadius: 8,
    alignItems: 'center',
  },
  rejectButtonText: {
    color: '#FFF',
    fontSize: 14,
    fontWeight: '600',
  },
  executeButton: {
    flex: 2,
    paddingVertical: 10,
    borderRadius: 8,
    alignItems: 'center',
  },
  executeButtonText: {
    color: '#FFF',
    fontSize: 14,
    fontWeight: '600',
  },
});
