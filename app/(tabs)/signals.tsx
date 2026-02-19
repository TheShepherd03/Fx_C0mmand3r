import React, { useState, useEffect } from 'react';
import { StyleSheet, View, Text, FlatList, TouchableOpacity, Alert, ActivityIndicator, TextInput } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { database } from '@/firebaseConfig';
import { ref, query, orderByChild, limitToLast, onValue, set, update } from 'firebase/database';
import { AccountSelector } from '@/components/AccountSelector';
import { useAccount } from '@/contexts/AccountContext';
import { useTheme } from '@/contexts/ThemeContext';
import { Signal } from '@/constants/types';
import { IconSymbol } from '@/components/ui/icon-symbol';

const FILTERS = ['All Signals', 'Pending', 'Winning', 'VIP'];

export default function SignalsScreen() {
  const { selectedAccount } = useAccount();
  const { theme } = useTheme();
  const [signals, setSignals] = useState<Signal[]>([]);
  const [loading, setLoading] = useState(true);
  const [executingIds, setExecutingIds] = useState<Set<string>>(new Set());
  const [activeFilter, setActiveFilter] = useState('All Signals');
  const [searchQuery, setSearchQuery] = useState('');
  const [showSearch, setShowSearch] = useState(false);

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
            return item.symbol &&
              (item.action === 'BUY' || item.action === 'SELL') &&
              typeof item.price === 'number' && !isNaN(item.price);
          })
          .sort((a: Signal, b: Signal) => b.timestamp - a.timestamp);

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
      Alert.alert("Error", "No account selected.");
      return;
    }

    Alert.alert(
      "Execute Trade",
      `Open ${signal.symbol} ${signal.action}?`,
      [
        { text: "Cancel", style: "cancel" },
        {
          text: "Execute",
          onPress: async () => {
            setExecutingIds(prev => new Set([...prev, signal.id]));
            try {
              const commandRef = ref(database, `commands/${selectedAccount}/latest`);
              await set(commandRef, {
                action: 'OPEN_POSITION',
                symbol: signal.symbol,
                type: signal.action === 'BUY' ? 0 : 1,
                lots: signal.lots,
                sl: signal.sl,
                tp: signal.tp,
                status: 'PENDING',
                timestamp: Math.floor(Date.now() / 1000)
              });

              const signalRef = ref(database, `signals/${selectedAccount}/${signal.id}`);
              await update(signalRef, { status: 'executed' });
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

  const rejectSignal = async (signal: Signal) => {
    setExecutingIds(prev => new Set([...prev, signal.id]));
    try {
      const signalRef = ref(database, `signals/${selectedAccount}/${signal.id}`);
      await update(signalRef, { status: 'rejected' });
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
    if (!timestamp) return "";
    const now = Math.floor(Date.now() / 1000);
    const diff = now - timestamp;

    if (diff < 60) return `${diff}s ago`;
    if (diff < 3600) return `${Math.floor(diff / 60)}m ago`;
    if (diff < 86400) return `${Math.floor(diff / 3600)}h ago`;
    return new Date(timestamp * 1000).toLocaleDateString();
  };

  const getFilteredSignals = () => {
    let filtered = signals;

    // Search filter
    if (searchQuery) {
      const q = searchQuery.toLowerCase();
      filtered = filtered.filter(s =>
        s.symbol.toLowerCase().includes(q) ||
        (s.source && s.source.toLowerCase().includes(q))
      );
    }

    // Tab filter
    switch (activeFilter) {
      case 'Pending':
        return filtered.filter(s => s.status === 'pending');
      case 'Winning':
        return filtered.filter(s => s.status === 'executed'); // Simplified
      case 'VIP':
        return filtered.filter(s => s.source && s.source.toLowerCase().includes('vip'));
      default:
        return filtered;
    }
  };

  const renderItem = ({ item }: { item: Signal }) => {
    const isPending = item.status === 'pending';
    const isProcessing = executingIds.has(item.id);
    const isBuy = item.action === 'BUY';

    // Symbol Color (Simple hash)
    const getSymbolColor = (symbol: string) => {
      if (symbol.includes('XAU') || symbol.includes('Gold')) return '#F59E0B'; // Gold
      if (symbol.includes('EUR')) return '#3B82F6'; // Blue
      if (symbol.includes('GBP')) return '#8B5CF6'; // Indigo
      if (symbol.includes('JPY')) return '#EF4444'; // Red
      if (symbol.includes('USD')) return '#10B981'; // Green
      return theme.colors.textSecondary;
    };

    const symbolColor = getSymbolColor(item.symbol);

    return (
      <View style={[styles.card, { backgroundColor: theme.colors.card }]}>
        {/* Header */}
        <View style={styles.cardHeader}>
          <View style={styles.headerLeft}>
            <View style={[styles.symbolIcon, { backgroundColor: symbolColor }]}>
              <Text style={styles.symbolIconText}>{item.symbol.substring(0, 3)}</Text>
            </View>
            <View>
              <View style={styles.titleRow}>
                <Text style={[styles.symbolText, { color: theme.colors.text }]}>{item.symbol}</Text>
                <View style={[
                  styles.statusBadge,
                  { backgroundColor: isPending ? theme.colors.warning + '20' : (item.status === 'executed' ? theme.colors.success + '20' : theme.colors.error + '20') }
                ]}>
                  <Text style={[
                    styles.statusText,
                    { color: isPending ? theme.colors.warning : (item.status === 'executed' ? theme.colors.success : theme.colors.error) }
                  ]}>
                    {item.status.toUpperCase()}
                  </Text>
                </View>
              </View>
              <Text style={[styles.metaText, { color: theme.colors.textSecondary }]}>
                {item.source || 'Signal Feed'} • {formatTime(item.timestamp)}
              </Text>
            </View>
          </View>

          {/* Confidence Ring (Simulated) */}
          <View style={styles.confidenceWrapper}>
            <View style={[styles.confidenceRing, { borderColor: theme.colors.primary }]}>
              <Text style={[styles.confidenceValue, { color: theme.colors.text }]}>{item.confidence}%</Text>
            </View>
            <Text style={[styles.confidenceLabel, { color: theme.colors.textSecondary }]}>Confidence</Text>
          </View>
        </View>

        {/* Signal Details */}
        <View style={[styles.detailsContainer, { backgroundColor: theme.colors.input }]}>
          <View style={styles.typeRow}>
            <Text style={[
              styles.actionText,
              { color: isBuy ? theme.colors.buy : theme.colors.sell }
            ]}>
              {isBuy ? 'BUY MARKET' : 'SELL MARKET'}
            </Text>
            <Text style={[styles.lotText, { color: theme.colors.text }]}>Lot: {item.lots}</Text>
          </View>

          <View style={styles.grid}>
            <View style={styles.gridItem}>
              <Text style={[styles.gridLabel, { color: theme.colors.textSecondary }]}>ENTRY</Text>
              <Text style={[styles.gridValue, { color: theme.colors.text }]}>{item.price.toFixed(5)}</Text>
            </View>
            <View style={[styles.gridItem, styles.gridBorder, { borderColor: theme.colors.border }]}>
              <Text style={[styles.gridLabel, { color: theme.colors.textSecondary }]}>STOP LOSS</Text>
              <Text style={[styles.gridValue, { color: theme.colors.loss }]}>{item.sl > 0 ? item.sl.toFixed(5) : '-'}</Text>
            </View>
            <View style={styles.gridItem}>
              <Text style={[styles.gridLabel, { color: theme.colors.textSecondary }]}>TAKE PROFIT</Text>
              <Text style={[styles.gridValue, { color: theme.colors.profit }]}>{item.tp > 0 ? item.tp.toFixed(5) : '-'}</Text>
            </View>
          </View>
        </View>

        {/* Actions */}
        {isPending && (
          <View style={styles.actionRow}>
            <TouchableOpacity
              style={[styles.rejectBtn, { borderColor: theme.colors.border }]}
              onPress={() => rejectSignal(item)}
              disabled={isProcessing}
            >
              {isProcessing && executingIds.has(item.id) ? (
                <ActivityIndicator size="small" color={theme.colors.textSecondary} />
              ) : (
                <Text style={[styles.rejectText, { color: theme.colors.textSecondary }]}>Reject</Text>
              )}
            </TouchableOpacity>

            <TouchableOpacity
              style={[styles.executeBtn, { backgroundColor: theme.colors.primary }]}
              onPress={() => executeSignal(item)}
              disabled={isProcessing}
            >
              {isProcessing && executingIds.has(item.id) ? (
                <ActivityIndicator size="small" color="#FFF" />
              ) : (
                <>
                  <IconSymbol name="checkmark" size={16} color="#FFF" />
                  <Text style={styles.executeText}>Execute Trade</Text>
                </>
              )}
            </TouchableOpacity>
          </View>
        )}

        {item.status === 'executed' && (
          <TouchableOpacity style={[styles.detailsBtn, { borderColor: theme.colors.border }]}>
            <Text style={[styles.detailsBtnText, { color: theme.colors.textSecondary }]}>View Trade Details →</Text>
          </TouchableOpacity>
        )}
      </View>
    );
  };

  return (
    <SafeAreaView style={[styles.container, { backgroundColor: theme.colors.background }]}>
      {/* Header */}
      <View style={[styles.header, { backgroundColor: theme.colors.background }]}>
        <View style={styles.headerTop}>
          <Text style={[styles.headerTitle, { color: theme.colors.text }]}>Market Signals</Text>
          <View style={styles.headerIcons}>
            <TouchableOpacity onPress={() => setShowSearch(!showSearch)} style={[styles.iconBtn, { backgroundColor: theme.colors.card }]}>
              <IconSymbol name="magnifyingglass" size={20} color={theme.colors.text} />
            </TouchableOpacity>
            <TouchableOpacity style={[styles.iconBtn, { backgroundColor: theme.colors.card }]}>
              <IconSymbol name="slider.horizontal.3" size={20} color={theme.colors.text} />
            </TouchableOpacity>
          </View>
        </View>
        <Text style={[styles.headerSubtitle, { color: theme.colors.textSecondary }]}>Live Feed • FX Commander</Text>

        {showSearch && (
          <TextInput
            style={[styles.searchInput, { backgroundColor: theme.colors.card, color: theme.colors.text }]}
            placeholder="Search symbol or source..."
            placeholderTextColor={theme.colors.textSecondary}
            value={searchQuery}
            onChangeText={setSearchQuery}
          />
        )}
      </View>

      {/* Filters */}
      <View style={styles.filterContainer}>
        <FlatList
          data={FILTERS}
          horizontal
          showsHorizontalScrollIndicator={false}
          contentContainerStyle={styles.filterList}
          keyExtractor={item => item}
          renderItem={({ item }) => (
            <TouchableOpacity
              style={[
                styles.filterPill,
                { backgroundColor: activeFilter === item ? theme.colors.primary : theme.colors.card }
              ]}
              onPress={() => setActiveFilter(item)}
            >
              <Text style={[
                styles.filterText,
                { color: activeFilter === item ? '#FFF' : theme.colors.textSecondary }
              ]}>{item}</Text>
            </TouchableOpacity>
          )}
        />
      </View>

      <AccountSelector />

      {/* Signal List */}
      <FlatList
        data={getFilteredSignals()}
        renderItem={renderItem}
        keyExtractor={item => item.id}
        contentContainerStyle={styles.listContent}
        ListEmptyComponent={
          !loading ? (
            <View style={styles.emptyContainer}>
              <IconSymbol name="antenna.radiowaves.left.and.right.slash" size={48} color={theme.colors.textTertiary} />
              <Text style={[styles.emptyText, { color: theme.colors.textSecondary }]}>No signals found</Text>
            </View>
          ) : (
            <ActivityIndicator style={{ marginTop: 40 }} size="large" color={theme.colors.primary} />
          )
        }
      />
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
  },
  header: {
    padding: 16,
    paddingBottom: 8,
  },
  headerTop: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
  },
  headerTitle: {
    fontSize: 28,
    fontWeight: 'bold',
  },
  headerIcons: {
    flexDirection: 'row',
    gap: 12,
  },
  iconBtn: {
    width: 40,
    height: 40,
    borderRadius: 12,
    justifyContent: 'center',
    alignItems: 'center',
  },
  headerSubtitle: {
    fontSize: 14,
    marginTop: 4,
  },
  searchInput: {
    marginTop: 12,
    padding: 12,
    borderRadius: 12,
    fontSize: 16,
  },
  filterContainer: {
    marginBottom: 12,
  },
  filterList: {
    paddingHorizontal: 16,
    gap: 8,
  },
  filterPill: {
    paddingHorizontal: 16,
    paddingVertical: 8,
    borderRadius: 20,
  },
  filterText: {
    fontSize: 14,
    fontWeight: '600',
  },
  listContent: {
    padding: 16,
    paddingTop: 0,
  },
  card: {
    borderRadius: 16,
    padding: 16,
    marginBottom: 16,
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 2 },
    shadowOpacity: 0.05,
    shadowRadius: 8,
    elevation: 2,
  },
  cardHeader: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    marginBottom: 16,
  },
  headerLeft: {
    flexDirection: 'row',
    gap: 12,
    flex: 1,
  },
  symbolIcon: {
    width: 48,
    height: 48,
    borderRadius: 12,
    justifyContent: 'center',
    alignItems: 'center',
  },
  symbolIconText: {
    color: '#FFF',
    fontWeight: 'bold',
    fontSize: 12,
  },
  titleRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    marginBottom: 4,
  },
  symbolText: {
    fontSize: 18,
    fontWeight: 'bold',
  },
  statusBadge: {
    paddingHorizontal: 6,
    paddingVertical: 2,
    borderRadius: 4,
  },
  statusText: {
    fontSize: 10,
    fontWeight: '800',
  },
  metaText: {
    fontSize: 12,
  },
  confidenceWrapper: {
    alignItems: 'center',
  },
  confidenceRing: {
    width: 44,
    height: 44,
    borderRadius: 22,
    borderWidth: 3,
    justifyContent: 'center',
    alignItems: 'center',
    marginBottom: 4,
  },
  confidenceValue: {
    fontSize: 12,
    fontWeight: 'bold',
  },
  confidenceLabel: {
    fontSize: 10,
  },
  detailsContainer: {
    borderRadius: 12,
    padding: 16,
    marginBottom: 16,
  },
  typeRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    marginBottom: 12,
    paddingBottom: 12,
    borderBottomWidth: 1,
    borderBottomColor: 'rgba(150,150,150,0.1)',
  },
  actionText: {
    fontSize: 14,
    fontWeight: '800',
  },
  lotText: {
    fontSize: 14,
    fontWeight: '600',
  },
  grid: {
    flexDirection: 'row',
    justifyContent: 'space-between',
  },
  gridItem: {
    alignItems: 'center',
    flex: 1,
  },
  gridBorder: {
    borderLeftWidth: 1,
    borderRightWidth: 1,
  },
  gridLabel: {
    fontSize: 10,
    fontWeight: '700',
    marginBottom: 4,
  },
  gridValue: {
    fontSize: 15,
    fontWeight: '700',
  },
  actionRow: {
    flexDirection: 'row',
    gap: 12,
  },
  rejectBtn: {
    flex: 1,
    paddingVertical: 14,
    borderRadius: 12,
    borderWidth: 1,
    alignItems: 'center',
    justifyContent: 'center',
  },
  rejectText: {
    fontSize: 16,
    fontWeight: '600',
  },
  executeBtn: {
    flex: 2,
    paddingVertical: 14,
    borderRadius: 12,
    flexDirection: 'row',
    gap: 8,
    alignItems: 'center',
    justifyContent: 'center',
  },
  executeText: {
    color: '#FFF',
    fontSize: 16,
    fontWeight: '700',
  },
  detailsBtn: {
    paddingVertical: 12,
    borderRadius: 12,
    borderWidth: 1,
    alignItems: 'center',
  },
  detailsBtnText: {
    fontSize: 14,
    fontWeight: '600',
  },
  emptyContainer: {
    alignItems: 'center',
    marginTop: 40,
  },
  emptyText: {
    marginTop: 16,
    fontSize: 16,
  }
});
