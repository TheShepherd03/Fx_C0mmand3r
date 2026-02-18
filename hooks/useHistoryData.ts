import { useState, useEffect } from 'react';
import { ref, query, orderByChild, limitToLast, onValue } from 'firebase/database';
import { database } from '../firebaseConfig';
import { HistoryPoint } from '../constants/types';
import { useAccount } from '@/contexts/AccountContext';

export function useHistoryData() {
  const { selectedAccount } = useAccount();
  const [history, setHistory] = useState<HistoryPoint[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    if (!selectedAccount) {
      setHistory([]);
      setLoading(false);
      return;
    }

    const historyRef = query(
      ref(database, `history/${selectedAccount}`),
      orderByChild('timestamp'),
      limitToLast(50) // Last ~12 hours if 15min interval
    );

    const unsubscribe = onValue(historyRef, (snapshot) => {
      const val = snapshot.val();
      if (val) {
        const list = Object.keys(val).map(key => val[key])
          .sort((a, b) => a.timestamp - b.timestamp);
        setHistory(list);
      } else {
        setHistory([]);
      }
      setLoading(false);
    });

    return () => unsubscribe();
  }, [selectedAccount]);

  return { history, loading };
}
