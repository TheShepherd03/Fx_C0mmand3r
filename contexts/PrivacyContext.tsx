import React, { createContext, useContext, useEffect, useState, ReactNode } from 'react';
import AsyncStorage from '@react-native-async-storage/async-storage';

const STORAGE_KEY = 'fxc_hide_balances';
const STATUSBAR_KEY = 'fxc_show_statusbar';
const MASK = '••••••';

interface PrivacyContextType {
  hidden: boolean;
  toggle: () => void;
  /** Returns the mask when balances are hidden, otherwise the value as-is. */
  mask: (value: string | number) => string;
  /** Whether the always-visible P/L + Risk strip is shown (default on). */
  statusBarEnabled: boolean;
  toggleStatusBar: () => void;
}

const PrivacyContext = createContext<PrivacyContextType>({
  hidden: false,
  toggle: () => {},
  mask: (v) => String(v),
  statusBarEnabled: true,
  toggleStatusBar: () => {},
});

export function PrivacyProvider({ children }: { children: ReactNode }) {
  const [hidden, setHidden] = useState(false);
  const [statusBarEnabled, setStatusBarEnabled] = useState(true);

  // Restore saved preferences so they persist across launches.
  useEffect(() => {
    AsyncStorage.getItem(STORAGE_KEY)
      .then((v) => { if (v === '1') setHidden(true); })
      .catch(() => {});
    AsyncStorage.getItem(STATUSBAR_KEY)
      .then((v) => { if (v === '0') setStatusBarEnabled(false); })
      .catch(() => {});
  }, []);

  const toggle = () => {
    setHidden((prev) => {
      const next = !prev;
      AsyncStorage.setItem(STORAGE_KEY, next ? '1' : '0').catch(() => {});
      return next;
    });
  };

  const toggleStatusBar = () => {
    setStatusBarEnabled((prev) => {
      const next = !prev;
      AsyncStorage.setItem(STATUSBAR_KEY, next ? '1' : '0').catch(() => {});
      return next;
    });
  };

  const mask = (value: string | number) => (hidden ? MASK : String(value));

  return (
    <PrivacyContext.Provider value={{ hidden, toggle, mask, statusBarEnabled, toggleStatusBar }}>
      {children}
    </PrivacyContext.Provider>
  );
}

export const usePrivacy = () => useContext(PrivacyContext);
