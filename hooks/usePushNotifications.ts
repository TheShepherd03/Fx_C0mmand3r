import { useEffect, useState } from 'react';
import { Platform } from 'react-native';
import * as Notifications from 'expo-notifications';
import * as Device from 'expo-device';
import Constants from 'expo-constants';
import { router, type Href } from 'expo-router';
import { ref, set, remove } from 'firebase/database';
import { database } from '@/firebaseConfig';
import { useAccount } from '@/contexts/AccountContext';
import { useAuth } from '@/contexts/AuthContext';
import { usePrivacy } from '@/contexts/PrivacyContext';

// Show the banner + play sound even when the app is foregrounded.
Notifications.setNotificationHandler({
  handleNotification: async () => ({
    shouldShowBanner: true,
    shouldShowList: true,
    shouldPlaySound: true,
    shouldSetBadge: false,
  }),
});

const PROJECT_ID =
  (Constants?.expoConfig as any)?.extra?.eas?.projectId ||
  '5b59d77a-c7fd-417b-b414-e6f41d3a60ac';

async function registerForPush(): Promise<string | null> {
  // Push tokens only work on physical devices.
  if (!Device.isDevice) return null;

  if (Platform.OS === 'android') {
    await Notifications.setNotificationChannelAsync('signals', {
      name: 'Signals',
      importance: Notifications.AndroidImportance.HIGH,
      vibrationPattern: [0, 250, 250, 250],
      lightColor: '#2196F3',
    });
  }

  const existing = await Notifications.getPermissionsAsync();
  let granted = existing.granted;
  if (!granted) {
    const req = await Notifications.requestPermissionsAsync();
    granted = req.granted;
  }
  if (!granted) return null;

  const tokenData = await Notifications.getExpoPushTokenAsync({ projectId: PROJECT_ID });
  return tokenData.data; // "ExponentPushToken[...]"
}

// ---- Notification tap -> screen ---------------------------------------------
// EAs name the target screen in the push `data`:
//   { screen: 'zones', symbol: 'Volatility 10 Index' } -> Zones tab, that symbol preselected
//   { screen: 'signals' }                              -> Signals tab
//   { screen: 'positions' } (Bridge auto trade)        -> Portfolio
//   { screen: 'home' }  (cloud terminal watchdog)      -> Dashboard
//   anything else / no data                            -> just open the app (no navigation)

function pushData(response: Notifications.NotificationResponse): Record<string, unknown> {
  const raw: unknown = response.notification.request.content.data;
  if (typeof raw === 'string') {
    try {
      const parsed: unknown = JSON.parse(raw);
      return parsed && typeof parsed === 'object' ? (parsed as Record<string, unknown>) : {};
    } catch {
      return {};
    }
  }
  return raw && typeof raw === 'object' ? (raw as Record<string, unknown>) : {};
}

function hrefForPush(data: Record<string, unknown>): Href | null {
  const screen = typeof data.screen === 'string' ? data.screen.trim().toLowerCase() : '';
  switch (screen) {
    case 'zones': {
      // The broker's resolved symbol name; Zones matches it case-insensitively.
      const symbol = typeof data.symbol === 'string' ? data.symbol.trim() : '';
      // `ts` makes every tap a distinct route, so Zones re-selects the symbol
      // even if an earlier alert for it was already opened.
      return symbol
        ? { pathname: '/(tabs)/zones', params: { symbol, ts: String(Date.now()) } }
        : '/(tabs)/zones';
    }
    case 'signals':
      return '/(tabs)/signals';
    case 'positions':
      return '/(tabs)/positions';
    case 'home':
      return '/(tabs)';
    default:
      return null;
  }
}

// On a cold start (app launched by the tap) the root navigator mounts just after
// this hook's first effect, and router.push throws until it has — retry briefly
// rather than drop the tap.
function navigateWhenReady(href: Href, attempt = 0) {
  try {
    router.push(href);
  } catch {
    if (attempt < 20) setTimeout(() => navigateWhenReady(href, attempt + 1), 100);
  }
}

// Last tap routed. Module scope so it survives TabLayout remounts (sign-out/in);
// the cold-start check and the live listener may both report the same tap.
let lastHandledTap = '';

// Pushes name the account they came from (`data.account`); the tapped screen must
// show THAT account (a Deriv zone alert is useless on the HFM zones list). Held
// until the account list has loaded, which on a cold start is after the tap.
let pendingAccount = '';
let applyPendingAccount: (() => void) | null = null;

function openFromNotification(response: Notifications.NotificationResponse | null) {
  if (!response?.notification) return;
  const { request, date } = response.notification;
  const tapId = `${request?.identifier ?? ''}|${date ?? ''}|${response.actionIdentifier ?? ''}`;
  if (tapId === lastHandledTap) return;
  lastHandledTap = tapId;
  // Consume it natively too, so a later JS restart doesn't replay this tap.
  try { Notifications.clearLastNotificationResponse(); } catch {}
  const data = pushData(response);
  if (typeof data.account === 'string' && data.account) {
    pendingAccount = data.account;
    applyPendingAccount?.();
  }
  const href = hrefForPush(data);
  if (href) navigateWhenReady(href);
}

/**
 * Registers this device for push, writes its Expo push token under the selected
 * account (pushTokens/{account}/{sanitizedToken}) so the EA can send a push when
 * a new signal is published, and opens the screen named in a push's data when
 * it is tapped (zones -> Zones with the symbol preselected, signals -> Signals,
 * home -> Dashboard; anything else just opens the app).
 */
export function usePushNotifications() {
  const { selectedAccount, availableAccounts, setSelectedAccount } = useAccount();
  const { user } = useAuth();
  const { notificationsEnabled } = usePrivacy();
  const [pushToken, setPushToken] = useState<string | null>(null);

  // Fetch the token once the user is signed in.
  useEffect(() => {
    if (!user) return;
    let mounted = true;
    registerForPush()
      .then((t) => { if (mounted && t) setPushToken(t); })
      .catch(() => {});
    return () => { mounted = false; };
  }, [user]);

  // Register the token under the selected account when notifications are ON, and
  // remove it when OFF. The EAs and the cloud watchdog send to every token under
  // pushTokens (all accounts, de-duplicated), so OFF removes it from EVERY account.
  useEffect(() => {
    if (!user || !selectedAccount || !pushToken) return;
    const key = pushToken.replace(/[.#$/\[\]]/g, '_');
    if (notificationsEnabled) {
      set(ref(database, `pushTokens/${selectedAccount}/${key}`), pushToken).catch(() => {});
    } else {
      for (const acct of new Set([selectedAccount, ...availableAccounts])) {
        remove(ref(database, `pushTokens/${acct}/${key}`)).catch(() => {});
      }
    }
  }, [user, selectedAccount, availableAccounts, pushToken, notificationsEnabled]);

  // Switch to the account a tapped push came from, once the account list has it.
  useEffect(() => {
    applyPendingAccount = () => {
      if (!pendingAccount || !availableAccounts.includes(pendingAccount)) return;
      if (pendingAccount !== selectedAccount) setSelectedAccount(pendingAccount);
      pendingAccount = '';
    };
    applyPendingAccount();
    return () => { applyPendingAccount = null; };
  }, [availableAccounts, selectedAccount, setSelectedAccount]);

  // Tapping a notification opens the screen named in its data.
  useEffect(() => {
    // Cold start: the tap that launched the app fired before this listener existed.
    try {
      openFromNotification(Notifications.getLastNotificationResponse());
    } catch {}
    const sub = Notifications.addNotificationResponseReceivedListener(openFromNotification);
    return () => sub.remove();
  }, []);
}
