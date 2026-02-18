import React, { createContext, useContext, useState, useEffect, ReactNode } from 'react';
import { database } from '@/firebaseConfig';
import { ref, onValue, off, remove } from 'firebase/database';

interface AccountContextType {
  selectedAccount: string | null;
  availableAccounts: string[];
  setSelectedAccount: (accountId: string) => void;
  removeAccount: (accountId: string) => Promise<void>;
  loading: boolean;
}

const AccountContext = createContext<AccountContextType | undefined>(undefined);

interface AccountProviderProps {
  children: ReactNode;
}

export function AccountProvider({ children }: AccountProviderProps) {
  const [selectedAccount, setSelectedAccount] = useState<string | null>(null);
  const [availableAccounts, setAvailableAccounts] = useState<string[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    // Listen to accounts node to discover available accounts
    const accountsRef = ref(database, 'accounts');

    const onDataChange = (snapshot: any) => {
      const val = snapshot.val();
      if (val) {
        const accounts = Object.keys(val);
        setAvailableAccounts(accounts);

        // Auto-select first account if none selected
        if (!selectedAccount && accounts.length > 0) {
          setSelectedAccount(accounts[0]);
        }
      } else {
        setAvailableAccounts([]);
      }
      setLoading(false);
    };

    onValue(accountsRef, onDataChange);

    // Cleanup
    return () => {
      off(accountsRef, 'value', onDataChange);
    };
  }, [selectedAccount]);

  const removeAccount = async (accountId: string) => {
    try {
      // Remove all data for this account
      await Promise.all([
        remove(ref(database, `accounts/${accountId}`)),
        remove(ref(database, `history/${accountId}`)),
        remove(ref(database, `signals/${accountId}`)),
        remove(ref(database, `commands/${accountId}`))
      ]);

      // If this was the selected account, select another one
      if (selectedAccount === accountId) {
        const remaining = availableAccounts.filter(acc => acc !== accountId);
        setSelectedAccount(remaining.length > 0 ? remaining[0] : null);
      }
    } catch (error) {
      console.error('Error removing account:', error);
      throw error;
    }
  };

  return (
    <AccountContext.Provider
      value={{
        selectedAccount,
        availableAccounts,
        setSelectedAccount,
        removeAccount,
        loading
      }}
    >
      {children}
    </AccountContext.Provider>
  );
}

export function useAccount() {
  const context = useContext(AccountContext);
  if (context === undefined) {
    throw new Error('useAccount must be used within an AccountProvider');
  }
  return context;
}
