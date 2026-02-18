import React from 'react';
import { StyleSheet, View, Text, ScrollView, Dimensions } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useAccountData } from '@/hooks/useAccountData';
import { useHistoryData } from '@/hooks/useHistoryData';
import { LineChart } from 'react-native-chart-kit';
import { AccountSelector } from '@/components/AccountSelector';
import { ThemeToggle } from '@/components/ThemeToggle';
import { useTheme } from '@/contexts/ThemeContext';

export default function DashboardScreen() {
  const { data, loading, error } = useAccountData();
  const { history, loading: historyLoading } = useHistoryData();
  const { theme } = useTheme();

  const formatCurrency = (val: number | undefined) => {
    return val !== undefined ? `$${val.toFixed(2)}` : '$0.00';
  };

  const isOnline = () => {
    if (!data) return false;
    const now = Math.floor(Date.now() / 1000);
    return (now - data.lastUpdated) < 60;
  };

  return (
    <SafeAreaView style={[styles.container, { backgroundColor: theme.colors.background }]}>
      <ScrollView contentContainerStyle={styles.scrollContent}>

        {/* Header */}
        <View style={styles.header}>
          <Text style={[styles.title, { color: theme.colors.text }]}>TradeCommand</Text>
          <View style={styles.headerRight}>
            <View style={styles.statusContainer}>
              <View style={[styles.statusDot, { backgroundColor: isOnline() ? '#4CAF50' : '#F44336' }]} />
              <Text style={[styles.statusText, { color: theme.colors.textSecondary }]}>{isOnline() ? 'ONLINE' : 'OFFLINE'}</Text>
            </View>
            <ThemeToggle />
          </View>
        </View>

        {/* Account Selector */}
        <AccountSelector />

        {loading ? (
          <Text style={[styles.loadingText, { color: theme.colors.textSecondary }]}>Connecting to HQ...</Text>
        ) : error ? (
          <Text style={[styles.errorText, { color: theme.colors.error }]}>Error: {error}</Text>
        ) : (
          <>
            {/* Account Overview Card */}
            <View style={[styles.card, { backgroundColor: theme.colors.card }]}>
              <Text style={[styles.cardTitle, { color: theme.colors.text }]}>Account Overview</Text>

              <View style={styles.row}>
                <View style={styles.metric}>
                  <Text style={[styles.metricLabel, { color: theme.colors.textSecondary }]}>Balance</Text>
                  <Text style={[styles.metricValue, { color: theme.colors.text }]}>{formatCurrency(data?.balance)}</Text>
                </View>
                <View style={styles.metric}>
                  <Text style={[styles.metricLabel, { color: theme.colors.textSecondary }]}>Equity</Text>
                  <Text style={[styles.metricValue, { color: theme.colors.text }]}>{formatCurrency(data?.equity)}</Text>
                </View>
              </View>

              <View style={styles.divider} />

              <View style={styles.row}>
                <View style={styles.metric}>
                  <Text style={[styles.metricLabel, { color: theme.colors.textSecondary }]}>Free Margin</Text>
                  <Text style={[styles.metricValue, { color: theme.colors.text }]}>{formatCurrency(data?.freeMargin)}</Text>
                </View>
                <View style={styles.metric}>
                  <Text style={[styles.metricLabel, { color: theme.colors.textSecondary }]}>Margin Level</Text>
                  <Text style={[styles.metricValue, { color: theme.colors.text }]}>{data?.marginLevel ? `${data.marginLevel.toFixed(1)}%` : '0%'}</Text>
                </View>
              </View>
            </View>

            {/* Equity Curve */}
            <View style={[styles.card, { backgroundColor: theme.colors.card }]}>
              <Text style={[styles.cardTitle, { color: theme.colors.text }]}>📈 Equity Curve</Text>
              {history && history.length > 0 ? (
                <LineChart
                  data={{
                    labels: history.slice(-10).map((_: any, i: number) => `${i + 1}`), // Last 10 points
                    datasets: [
                      {
                        data: history.map((h: any) => h.equity || 0),
                        color: (opacity = 1) => `rgba(76, 175, 80, ${opacity})`, // Green for Equity
                        strokeWidth: 2
                      },
                      {
                        data: history.map((h: any) => h.balance || 0),
                        color: (opacity = 1) => `rgba(33, 150, 243, ${opacity})`, // Blue for Balance
                        strokeWidth: 2
                      }
                    ],
                    legend: ["Equity", "Balance"]
                  }}
                  width={Dimensions.get("window").width - 64} // Card padding compensation
                  height={220}
                  yAxisLabel="$"
                  yAxisInterval={1}
                  chartConfig={{
                    backgroundColor: theme.colors.card,
                    decimalPlaces: 0,
                    color: (opacity = 1) => theme.isDark ? `rgba(255, 255, 255, ${opacity})` : `rgba(0, 0, 0, ${opacity})`,
                    labelColor: (opacity = 1) => theme.isDark ? `rgba(255, 255, 255, ${opacity})` : `rgba(0, 0, 0, ${opacity})`,
                    style: {
                      borderRadius: 16
                    },
                    propsForDots: {
                      r: "0", // Hide dots for cleaner look
                    }
                  }}
                  bezier
                  style={{
                    marginVertical: 8,
                    borderRadius: 16
                  }}
                />
              ) : (
                <View style={{ padding: 20, alignItems: 'center' }}>
                  <Text style={[{ textAlign: 'center', fontSize: 16 }, { color: theme.colors.textSecondary }]}>
                    📊 Chart will appear after account activity
                  </Text>
                </View>
              )}
            </View>

            {/* Performance / Profit (Simple Calc) */}
            <View style={[styles.card, { backgroundColor: theme.colors.card }]}>
              <Text style={[styles.cardTitle, { color: theme.colors.text }]}>Open P/L</Text>
              <Text style={[
                styles.pnlValue,
                { color: (data?.equity ?? 0) >= (data?.balance ?? 0) ? theme.colors.profit : theme.colors.loss }
              ]}>
                {formatCurrency((data?.equity ?? 0) - (data?.balance ?? 0))}
              </Text>
            </View>

            {/* Active Positions Summary */}
            <View style={[styles.card, { backgroundColor: theme.colors.card }]}>
              <Text style={[styles.cardTitle, { color: theme.colors.text }]}>Active Positions</Text>
              <Text style={[styles.bigNumber, { color: theme.colors.text }]}>{data?.positions ? data.positions.length : 0}</Text>
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
    backgroundColor: '#F5F5F5',
  },
  scrollContent: {
    padding: 16,
  },
  header: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    marginBottom: 24,
  },
  headerRight: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
  },
  title: {
    fontSize: 28,
    fontWeight: 'bold',
    color: '#333',
  },
  statusContainer: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: '#FFF',
    paddingHorizontal: 12,
    paddingVertical: 6,
    borderRadius: 20,
    elevation: 2,
  },
  statusDot: {
    width: 8,
    height: 8,
    borderRadius: 4,
    marginRight: 6,
  },
  statusText: {
    fontSize: 12,
    fontWeight: '600',
    color: '#666',
  },
  loadingText: {
    textAlign: 'center',
    marginTop: 20,
    color: '#666',
  },
  errorText: {
    textAlign: 'center',
    marginTop: 20,
    color: '#F44336',
  },
  card: {
    backgroundColor: '#FFF',
    borderRadius: 16,
    padding: 20,
    marginBottom: 16,
    elevation: 2,
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 2 },
    shadowOpacity: 0.1,
    shadowRadius: 4,
  },
  cardTitle: {
    fontSize: 16,
    fontWeight: '600',
    color: '#888',
    marginBottom: 16,
    textTransform: 'uppercase',
    letterSpacing: 1,
  },
  row: {
    flexDirection: 'row',
    justifyContent: 'space-between',
  },
  metric: {
    flex: 1,
  },
  metricLabel: {
    fontSize: 14,
    color: '#999',
    marginBottom: 4,
  },
  metricValue: {
    fontSize: 20,
    fontWeight: '700',
    color: '#333',
  },
  divider: {
    height: 1,
    backgroundColor: '#EEE',
    marginVertical: 16,
  },
  pnlValue: {
    fontSize: 36,
    fontWeight: 'bold',
    textAlign: 'center',
  },
  bigNumber: {
    fontSize: 48,
    fontWeight: 'bold',
    color: '#333',
    textAlign: 'center',
  },
});
