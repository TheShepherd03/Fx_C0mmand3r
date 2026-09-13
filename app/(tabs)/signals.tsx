import React, { useState, useEffect } from 'react';
import { StyleSheet, View, Text, FlatList, TouchableOpacity, Alert, ActivityIndicator, TextInput } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { database } from '@/firebaseConfig';
import { ref, query, orderByChild, limitToLast, onValue, set } from 'firebase/database';
import { AccountSelector } from '@/components/AccountSelector';
import { useAccount } from '@/contexts/AccountContext';
import { useTheme } from '@/contexts/ThemeContext';
import { Signal } from '@/constants/types';
import { IconSymbol } from '@/components/ui/icon-symbol';
import { ExecuteSignalModal } from '@/components/ExecuteSignalModal';
import { useAccountData } from '@/hooks/useAccountData';

const FILTERS = ['All Signals', 'Pending', 'Winning'];

export default function SignalsScreen() {
  const { selectedAccount } = useAccount();
  const { theme } = useTheme();
  const [signals, setSignals] = useState<Signal[]>([]);
  const [loading, setLoading] = useState(true);
  const [executingIds, setExecutingIds] = useState<Set<string>>(new Set());
  const [activeFilter, setActiveFilter] = useState('All Signals');
  const [activeSource, setActiveSource] = useState('All');
  const [searchQuery, setSearchQuery] = useState('');
  const [showSearch, setShowSearch] = useState(false);
  const [execSignal, setExecSignal] = useState<Signal | null>(null);
  const [execVisible, setExecVisible] = useState(false);
  // Raw text the user has dialled in per signal (via -/+ or manual typing).
  const [lotOverrides, setLotOverrides] = useState<Record<string, string>>({});
  // Signals executed/rejected this session — filtered locally, NOT written to the
  // shared node, because the EA owns each signal's status (winning/pending) and
  // would overwrite an 'executed'/'rejected' flag, making the signal reappear.
  const [actedIds, setActedIds] = useState<Set<string>>(new Set());
  const { data: acctData } = useAccountData();

  const LOT_STEP = 0.01;
  const LOT_MIN = 0.01;
  // Numeric lot for a signal: parsed override if valid, else the signal's own lot, else default.
  const lotFor = (item: Signal) => {
    const raw = lotOverrides[item.id];
    const parsed = raw !== undefined ? parseFloat(raw) : NaN;
    if (!isNaN(parsed) && parsed > 0) return parsed;
    return item.lots > 0 ? item.lots : 0.05;
  };
  // Text shown in the editable field (raw override if present, else the default).
  const lotText = (item: Signal) =>
    lotOverrides[item.id] ?? (item.lots > 0 ? item.lots : 0.05).toFixed(2);
  // Manual edit: keep only digits + a single decimal point so the field stays valid.
  const setLotText = (item: Signal, text: string) => {
    const clean = text.replace(/[^0-9.]/g, '').replace(/(\..*)\./g, '$1');
    setLotOverrides(prev => ({ ...prev, [item.id]: clean }));
  };
  const adjustLot = (item: Signal, delta: number) => {
    const next = Math.max(LOT_MIN, Math.round((lotFor(item) + delta) * 100) / 100);
    setLotOverrides(prev => ({ ...prev, [item.id]: next.toFixed(2) }));
  };
  // On blur, normalise an empty/invalid field back to a clean value.
  const normalizeLot = (item: Signal) => {
    setLotOverrides(prev => ({ ...prev, [item.id]: lotFor(item).toFixed(2) }));
  };

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

  const executeSignal = (signal: Signal) => {
    if (!selectedAccount) {
      Alert.alert("Error", "No account selected.");
      return;
    }
    setExecSignal(signal);
    setExecVisible(true);
  };

  // Called from the confirm sheet with the chosen lots/SL/TP
  const doExecute = async (lots: number, sl: number, tp: number) => {
    if (!selectedAccount || !execSignal) return;
    const signal = execSignal;
    setExecutingIds(prev => new Set([...prev, signal.id]));
    try {
      const commandRef = ref(database, `commands/${selectedAccount}/latest`);
      await set(commandRef, {
        action: 'OPEN_POSITION',
        symbol: signal.symbol,
        type: signal.action === 'BUY' ? 0 : 1,
        lots,
        sl,
        tp,
        status: 'PENDING',
        timestamp: Math.floor(Date.now() / 1000)
      });
      setActedIds(prev => new Set(prev).add(signal.id));   // hide locally; EA owns the node
      setExecVisible(false);
      setExecSignal(null);
    } catch {
      Alert.alert("Error", "Failed to execute signal.");
    } finally {
      setExecutingIds(prev => {
        const newSet = new Set(prev);
        newSet.delete(signal.id);
        return newSet;
      });
    }
  };

  const rejectSignal = (signal: Signal) => {
    // Hide locally for this session; the EA owns the node and prunes it on
    // SL/TP hit or expiry. (No shared-node write — see actedIds.)
    setActedIds(prev => new Set(prev).add(signal.id));
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

  const sources = Array.from(new Set(signals.map(s => s.source).filter(Boolean))).sort();

  const getFilteredSignals = () => {
    const now = Math.floor(Date.now() / 1000);
    // Show only valid, actionable signals: drop expired, ones acted on this session,
    // and any legacy executed/rejected. (SL/TP-hit signals are pruned by the EA.)
    let filtered = signals.filter(s =>
      !(s.expiresAt && s.expiresAt < now) &&
      !actedIds.has(s.id) &&
      s.status !== 'executed' &&
      s.status !== 'rejected'
    );

    // Source filter
    if (activeSource !== 'All') {
      filtered = filtered.filter(s => (s.source || '') === activeSource);
    }

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
        return filtered.filter(s => s.status === 'winning');
      default:
        return filtered;
    }
  };

  const renderItem = ({ item }: { item: Signal }) => {
    const isPending = item.status === 'pending';
    const isWinning = item.status === 'winning';
    const isProcessing = executingIds.has(item.id);
    const isBuy = item.action === 'BUY';
    const statusColor = isPending ? theme.colors.warning
                      : (isWinning || item.status === 'executed') ? theme.colors.success
                      : theme.colors.error;

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
                <View style={[styles.statusBadge, { backgroundColor: statusColor + '20' }]}>
                  <Text style={[styles.statusText, { color: statusColor }]}>
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
            {(isPending || isWinning) ? (
              <View style={styles.lotStepper}>
                <Text style={[styles.lotStepLabel, { color: theme.colors.textSecondary }]}>Lot</Text>
                <TouchableOpacity
                  style={[styles.lotStepBtn, { borderColor: theme.colors.border }]}
                  onPress={() => adjustLot(item, -LOT_STEP)}
                  disabled={isProcessing}
                  hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
                >
                  <Text style={[styles.lotStepSign, { color: theme.colors.text }]}>−</Text>
                </TouchableOpacity>
                <TextInput
                  style={[styles.lotStepValue, styles.lotStepInput, { color: theme.colors.text, borderColor: theme.colors.border }]}
                  value={lotText(item)}
                  onChangeText={(t) => setLotText(item, t)}
                  onBlur={() => normalizeLot(item)}
                  keyboardType="numeric"
                  selectTextOnFocus
                  editable={!isProcessing}
                  placeholder="0.00"
                  placeholderTextColor={theme.colors.textTertiary}
                />
                <TouchableOpacity
                  style={[styles.lotStepBtn, { borderColor: theme.colors.border }]}
                  onPress={() => adjustLot(item, LOT_STEP)}
                  disabled={isProcessing}
                  hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
                >
                  <Text style={[styles.lotStepSign, { color: theme.colors.text }]}>+</Text>
                </TouchableOpacity>
              </View>
            ) : (
              <Text style={[styles.lotText, { color: theme.colors.text }]}>Lot: {item.lots}</Text>
            )}
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

        {/* Actions (live signals are actionable whether pending or already winning) */}
        {(isPending || isWinning) && (
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
      {/* Header — title/subtitle removed (bottom nav shows the screen); keep search */}
      <View style={[styles.header, { backgroundColor: theme.colors.background }]}>
        <View style={[styles.headerTop, { justifyContent: 'flex-end' }]}>
          <View style={styles.headerIcons}>
            <TouchableOpacity onPress={() => setShowSearch(!showSearch)} style={[styles.iconBtn, { backgroundColor: theme.colors.card }]}>
              <IconSymbol name="magnifyingglass" size={20} color={theme.colors.text} />
            </TouchableOpacity>
          </View>
        </View>

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

      {/* Source filter (by signal strategy) */}
      {sources.length > 0 && (
        <View style={styles.filterContainer}>
          <FlatList
            data={['All', ...sources]}
            horizontal
            showsHorizontalScrollIndicator={false}
            contentContainerStyle={styles.filterList}
            keyExtractor={item => 'src-' + item}
            renderItem={({ item }) => (
              <TouchableOpacity
                style={[
                  styles.sourcePill,
                  { borderColor: theme.colors.border },
                  activeSource === item && { backgroundColor: theme.colors.info + '22', borderColor: theme.colors.info }
                ]}
                onPress={() => setActiveSource(item)}
              >
                <Text style={[styles.sourceText, { color: activeSource === item ? theme.colors.info : theme.colors.textSecondary }]}>
                  {item === 'All' ? 'All sources' : item}
                </Text>
              </TouchableOpacity>
            )}
          />
        </View>
      )}

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

      <ExecuteSignalModal
        signal={execSignal}
        balance={acctData?.balance}
        initialLots={execSignal ? lotFor(execSignal) : undefined}
        visible={execVisible}
        busy={execSignal ? executingIds.has(execSignal.id) : false}
        onClose={() => setExecVisible(false)}
        onConfirm={doExecute}
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
  sourcePill: {
    paddingHorizontal: 14,
    paddingVertical: 6,
    borderRadius: 16,
    borderWidth: 1,
  },
  sourceText: {
    fontSize: 13,
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
  lotStepper: {
    flexDirection: 'row',
    alignItems: 'center',
  },
  lotStepLabel: {
    fontSize: 13,
    fontWeight: '600',
    marginRight: 8,
  },
  lotStepBtn: {
    width: 30,
    height: 30,
    borderRadius: 8,
    borderWidth: 1,
    justifyContent: 'center',
    alignItems: 'center',
  },
  lotStepSign: {
    fontSize: 20,
    fontWeight: '700',
    lineHeight: 22,
  },
  lotStepValue: {
    fontSize: 15,
    fontWeight: '700',
    minWidth: 46,
    textAlign: 'center',
    fontFamily: 'monospace',
  },
  lotStepInput: {
    borderWidth: 1,
    borderRadius: 6,
    paddingVertical: 4,
    paddingHorizontal: 6,
    marginHorizontal: 2,
    minWidth: 64,
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
