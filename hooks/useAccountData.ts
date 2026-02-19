import { useState, useEffect, useCallback } from 'react';
import { ref, onValue } from 'firebase/database';
import { database } from '../firebaseConfig'; // Adjust path as needed
import { AccountData } from '../constants/types';
import { useAccount } from '@/contexts/AccountContext';

export function useAccountData() {
  const { selectedAccount } = useAccount();
  const [data, setData] = useState<AccountData | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [refreshTrigger, setRefreshTrigger] = useState(0);

  const refresh = useCallback(() => {
    setRefreshTrigger(prev => prev + 1);
  }, []);

  useEffect(() => {
    if (!selectedAccount) {
      setData(null);
      setLoading(false);
      return;
    }

    setLoading(true);
    const accountRef = ref(database, `accounts/${selectedAccount}`);

    const unsubscribe = onValue(accountRef, (snapshot) => {
      const val = snapshot.val();
      if (val) {
        // Parse positions if they exist (MQL5 might send them as an object or array)
        // Our Bridge EA sends an array, but Firebase might convert arrays to objects with numeric keys if sparse
        let positions = [];
        if (val.positions) {
          if (Array.isArray(val.positions)) {
            positions = val.positions;
          } else {
            positions = Object.values(val.positions);
          }
        }

        let orders = [];
        if (val.orders) {
          if (Array.isArray(val.orders)) {
            orders = val.orders;
          } else {
            orders = Object.values(val.orders);
          }
        }

        setData({ ...val, positions, orders });
      } else {
        setData(null);
      }
      setLoading(false);
    }, (err) => {
      setError(err.message);
      setLoading(false);
    });

    return () => unsubscribe();
  }, [selectedAccount, refreshTrigger]);

  return { data, loading, error, refresh };
}
