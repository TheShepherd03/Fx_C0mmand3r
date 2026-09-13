import React, { createContext, useContext, useEffect, useState, ReactNode } from 'react';
import AsyncStorage from '@react-native-async-storage/async-storage';

const STORAGE_KEY = 'fxc_hide_balances';
const MASK = '••••••';

interface PrivacyContextType {
  hidden: boolean;
  toggle: () => void;
  /** Returns the mask when balances are hidden, otherwise the value as-is. */
  mask: (value: string | number) => string;
}

const PrivacyContext = createContext<PrivacyContextType>({
  hidden: false,
  toggle: () => {},
  mask: (v) => String(v),
});

export function PrivacyProvider({ children }: { children: ReactNode }) {
  const [hidden, setHidden] = useState(false);

  // Restore the last choice so hidden balances stay hidden across launches.
  useEffect(() => {
    AsyncStorage.getItem(STORAGE_KEY)
      .then((v) => { if (v === '1') setHidden(true); })
      .catch(() => {});
  }, []);

  const toggle = () => {
    setHidden((prev) => {
      const next = !prev;
      AsyncStorage.setItem(STORAGE_KEY, next ? '1' : '0').catch(() => {});
      return next;
    });
  };

  const mask = (value: string | number) => (hidden ? MASK : String(value));

  return (
    <PrivacyContext.Provider value={{ hidden, toggle, mask }}>
      {children}
    </PrivacyContext.Provider>
  );
}

export const usePrivacy = () => useContext(PrivacyContext);
