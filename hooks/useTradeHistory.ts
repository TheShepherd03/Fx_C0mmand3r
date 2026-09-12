import { useState, useEffect } from 'react';
import { ref, onValue } from 'firebase/database';
import { database, authReady } from '../firebaseConfig';
import { ClosedTrade } from '../constants/types';
import { useAccount } from '@/contexts/AccountContext';

// Reads the last 30 days of closed trades the EA syncs to tradeHistory/{account}.
export function useTradeHistory() {
  const { selectedAccount } = useAccount();
  const [trades, setTrades] = useState<ClosedTrade[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    if (!selectedAccount) {
      setTrades([]);
      setLoading(false);
      return;
    }

    setLoading(true);
    let cancelled = false;
    let unsubscribe = () => {};

    // Wait for anonymous sign-in before reading (auth != null rules).
    authReady.then(() => {
      if (cancelled) return;
      const tradesRef = ref(database, `tradeHistory/${selectedAccount}`);
      unsubscribe = onValue(tradesRef, (snapshot) => {
        const val = snapshot.val();
        if (val) {
          const list = Object.values(val) as ClosedTrade[];
          // Newest first
          list.sort((a, b) => b.closeTime - a.closeTime);
          setTrades(list);
        } else {
          setTrades([]);
        }
        setLoading(false);
      }, (error) => {
        console.error('Failed to read trade history:', error);
        setLoading(false);
      });
    });

    return () => {
      cancelled = true;
      unsubscribe();
    };
  }, [selectedAccount]);

  return { trades, loading };
}
