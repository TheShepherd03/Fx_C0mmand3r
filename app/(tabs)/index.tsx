import React from 'react';
import { StyleSheet, View, Text, ScrollView, Dimensions, RefreshControl } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useAccountData } from '@/hooks/useAccountData';
import { useHistoryData } from '@/hooks/useHistoryData';
import { LineChart } from 'react-native-chart-kit';
import { AccountSelector } from '@/components/AccountSelector';
import { ThemeToggle } from '@/components/ThemeToggle';
import { useTheme } from '@/contexts/ThemeContext';
import { IconSymbol } from '@/components/ui/icon-symbol';

export default function DashboardScreen() {
  const { data, loading, error, refresh } = useAccountData();
  const { history } = useHistoryData();
  const { theme } = useTheme();

  const formatCurrency = (val: number | undefined) => {
    return val !== undefined ? `$${val.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}` : '$0.00';
  };

  const isOnline = () => {
    if (!data) return false;
    const now = Math.floor(Date.now() / 1000);
    return (now - data.lastUpdated) < 60;
  };

  const calculatePL = () => {
    if (!data) return 0;
    return (data.equity || 0) - (data.balance || 0);
  };

  const calculatePLPercent = () => {
    if (!data || !data.balance || data.balance === 0) return 0;
    const pl = calculatePL();
    return (pl / data.balance) * 100;
  };

  const totalPL = calculatePL();
  const plPercent = calculatePLPercent();
  const isProfit = totalPL >= 0;

  return (
    <SafeAreaView style={[styles.container, { backgroundColor: theme.colors.background }]}>
      <ScrollView
        contentContainerStyle={styles.scrollContent}
        refreshControl={
          <RefreshControl refreshing={loading} onRefresh={refresh} tintColor={theme.colors.primary} />
        }
      >

        {/* Header */}
        <View style={styles.header}>
          <View>
            <Text style={[styles.appName, { color: theme.colors.text }]}>FX Commander</Text>
          </View>

          <View style={[styles.statusPill, { backgroundColor: isOnline() ? 'rgba(16, 185, 129, 0.2)' : 'rgba(239, 68, 68, 0.2)' }]}>
            <View style={[styles.statusDot, { backgroundColor: isOnline() ? theme.colors.success : theme.colors.error }]} />
            <Text style={[styles.statusText, { color: isOnline() ? theme.colors.success : theme.colors.error }]}>
              {isOnline() ? 'ONLINE' : 'OFFLINE'}
            </Text>
          </View>

          <ThemeToggle />
        </View>

        {/* Account Selector */}
        <AccountSelector />

        {error ? (
          <View style={[styles.errorCard, { backgroundColor: theme.colors.error + '20' }]}>
            <Text style={[styles.errorText, { color: theme.colors.error }]}>Connection Error: {error}</Text>
          </View>
        ) : (
          <>
            {/* Main P/L Card */}
            <View style={[styles.mainCard, { backgroundColor: theme.colors.card }]}>
              <Text style={[styles.mainCardTitle, { color: theme.colors.textSecondary }]}>TOTAL FLOATING P/L</Text>
              <Text style={[styles.mainCardValue, { color: isProfit ? theme.colors.profit : theme.colors.loss }]}>
                {totalPL >= 0 ? '+' : ''}{formatCurrency(totalPL)}
              </Text>
              <View style={[styles.percentBadge, { backgroundColor: isProfit ? theme.colors.buyBackground : theme.colors.sellBackground }]}>
                <Text style={[styles.percentText, { color: isProfit ? theme.colors.profit : theme.colors.loss }]}>
                  {totalPL >= 0 ? '+' : ''}{plPercent.toFixed(2)}% Today
                </Text>
              </View>
            </View>

            {/* Metrics Grid */}
            <View style={styles.metricsGrid}>
              <View style={[styles.metricCard, { backgroundColor: theme.colors.card }]}>
                <View style={styles.metricHeader}>
                  <IconSymbol name="building.columns.fill" size={16} color={theme.colors.primary} />
                  <Text style={[styles.metricLabel, { color: theme.colors.textSecondary }]}>BALANCE</Text>
                </View>
                <Text style={[styles.metricValue, { color: theme.colors.text }]}>{formatCurrency(data?.balance)}</Text>
              </View>

              <View style={[styles.metricCard, { backgroundColor: theme.colors.card }]}>
                <View style={styles.metricHeader}>
                  <IconSymbol name="chart.line.uptrend.xyaxis" size={16} color={theme.colors.success} />
                  <Text style={[styles.metricLabel, { color: theme.colors.textSecondary }]}>EQUITY</Text>
                </View>
                <Text style={[styles.metricValue, { color: theme.colors.text }]}>{formatCurrency(data?.equity)}</Text>
              </View>

              <View style={[styles.metricCard, { backgroundColor: theme.colors.card }]}>
                <View style={styles.metricHeader}>
                  <IconSymbol name="lock.open.fill" size={16} color={theme.colors.textSecondary} />
                  <Text style={[styles.metricLabel, { color: theme.colors.textSecondary }]}>FREE MARGIN</Text>
                </View>
                <Text style={[styles.metricValue, { color: theme.colors.text }]}>{formatCurrency(data?.freeMargin)}</Text>
              </View>

              <View style={[styles.metricCard, { backgroundColor: theme.colors.card }]}>
                <View style={styles.metricHeader}>
                  <IconSymbol name="percent" size={16} color={theme.colors.warning} />
                  <Text style={[styles.metricLabel, { color: theme.colors.textSecondary }]}>MARGIN LVL</Text>
                </View>
                <Text style={[styles.metricValue, { color: theme.colors.text }]}>
                  {data?.marginLevel ? `${Math.round(data.marginLevel).toLocaleString()}%` : '0%'}
                </Text>
              </View>
            </View>

            {/* Performance Curve */}
            <View style={[styles.chartCard, { backgroundColor: theme.colors.card }]}>
              <View style={styles.chartHeader}>
                <Text style={[styles.chartTitle, { color: theme.colors.text }]}>Performance Curve</Text>
                <View style={styles.legendContainer}>
                  <View style={styles.legendItem}>
                    <View style={[styles.legendDot, { backgroundColor: theme.colors.textSecondary }]} />
                    <Text style={[styles.legendText, { color: theme.colors.textSecondary }]}>Balance</Text>
                  </View>
                  <View style={styles.legendItem}>
                    <View style={[styles.legendDot, { backgroundColor: theme.colors.success }]} />
                    <Text style={[styles.legendText, { color: theme.colors.textSecondary }]}>Equity</Text>
                  </View>
                </View>
              </View>

              {history && history.length > 0 ? (
                <LineChart
                  data={{
                    labels: history.slice(-10).map((h, i) => {
                      // Show label for every other point to avoid crowding
                      if (i % 2 !== 0) return '';
                      const date = new Date(h.timestamp * 1000);
                      return `${date.getHours()}:${date.getMinutes().toString().padStart(2, '0')}`;
                    }),
                    datasets: [
                      {
                        data: history.slice(-10).map((h: any) => h.equity || 0),
                        color: (opacity = 1) => theme.colors.success,
                        strokeWidth: 2
                      },
                      {
                        data: history.slice(-10).map((h: any) => h.balance || 0),
                        color: (opacity = 1) => theme.colors.textSecondary,
                        strokeWidth: 2,
                        withDots: false
                      }
                    ]
                  }}
                  width={Dimensions.get("window").width - 48}
                  height={220}
                  yAxisLabel="$"
                  yAxisInterval={1}
                  formatYLabel={(y) => {
                    const val = parseFloat(y);
                    if (val >= 1000) return `${(val / 1000).toFixed(1)}k`;
                    return val.toFixed(0);
                  }}
                  chartConfig={{
                    backgroundColor: theme.colors.card,
                    backgroundGradientFrom: theme.colors.card,
                    backgroundGradientTo: theme.colors.card,
                    decimalPlaces: 0,
                    color: (opacity = 1) => theme.colors.textSecondary,
                    labelColor: (opacity = 1) => theme.colors.textSecondary,
                    propsForDots: { r: "4", strokeWidth: "2", stroke: theme.colors.card },
                    propsForBackgroundLines: { strokeDasharray: "", stroke: theme.colors.border }
                  }}
                  bezier
                  style={styles.chart}
                  withInnerLines={false}
                  withOuterLines={false}
                />
              ) : (
                <View style={styles.emptyChart}>
                  <Text style={{ color: theme.colors.textSecondary }}>Waiting for data history...</Text>
                </View>
              )}
            </View>
          </>
        )}
      </ScrollView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
  },
  scrollContent: {
    padding: 16,
    paddingBottom: 32,
  },
  header: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    marginBottom: 20,
  },
  appName: {
    fontSize: 22,
    fontWeight: '800',
    letterSpacing: 0.5,
  },
  statusPill: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 12,
    paddingVertical: 6,
    borderRadius: 20,
  },
  statusDot: {
    width: 8,
    height: 8,
    borderRadius: 4,
    marginRight: 6,
  },
  statusText: {
    fontSize: 12,
    fontWeight: '700',
    letterSpacing: 0.5,
  },
  mainCard: {
    borderRadius: 20,
    padding: 24,
    alignItems: 'center',
    marginBottom: 16,
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 4 },
    shadowOpacity: 0.1,
    shadowRadius: 12,
    elevation: 5,
  },
  mainCardTitle: {
    fontSize: 13,
    fontWeight: '600',
    letterSpacing: 1,
    marginBottom: 8,
  },
  mainCardValue: {
    fontSize: 42,
    fontWeight: '800',
    marginBottom: 12,
  },
  percentBadge: {
    paddingHorizontal: 12,
    paddingVertical: 4,
    borderRadius: 12,
  },
  percentText: {
    fontSize: 14,
    fontWeight: '600',
  },
  metricsGrid: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 12,
    marginBottom: 16,
  },
  metricCard: {
    flex: 1, // Distribute space equally
    minWidth: '48%', // Ensure 2 columns
    padding: 16,
    borderRadius: 16,
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 2 },
    shadowOpacity: 0.05,
    shadowRadius: 8,
    elevation: 2,
  },
  metricHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    marginBottom: 8,
    gap: 8,
  },
  metricLabel: {
    fontSize: 11,
    fontWeight: '700',
    letterSpacing: 0.5,
  },
  metricValue: {
    fontSize: 18,
    fontWeight: '700',
  },
  chartCard: {
    padding: 16,
    borderRadius: 20,
    marginBottom: 16,
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 4 },
    shadowOpacity: 0.1,
    shadowRadius: 12,
    elevation: 5,
  },
  chartHeader: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    marginBottom: 16,
    paddingHorizontal: 8,
  },
  chartTitle: {
    fontSize: 16,
    fontWeight: '700',
  },
  legendContainer: {
    flexDirection: 'row',
    gap: 12,
  },
  legendItem: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
  },
  legendDot: {
    width: 8,
    height: 8,
    borderRadius: 4,
  },
  legendText: {
    fontSize: 12,
  },
  chart: {
    borderRadius: 16,
    paddingRight: 0,
    paddingBottom: 0,
    marginLeft: -20, // Adjust for chart padding
  },
  emptyChart: {
    height: 220,
    justifyContent: 'center',
    alignItems: 'center',
  },
  errorCard: {
    padding: 16,
    borderRadius: 12,
    marginBottom: 16,
    alignItems: 'center',
  },
  errorText: {
    fontWeight: '600',
  },
  loadingText: {
    textAlign: 'center',
    marginTop: 20,
  }
});
