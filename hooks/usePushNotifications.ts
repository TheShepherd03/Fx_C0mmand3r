import { useEffect, useState } from 'react';
import { Platform } from 'react-native';
import * as Notifications from 'expo-notifications';
import * as Device from 'expo-device';
import Constants from 'expo-constants';
import { router } from 'expo-router';
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

/**
 * Registers this device for push, writes its Expo push token under the selected
 * account (pushTokens/{account}/{sanitizedToken}) so the EA can send a push when
 * a new signal is published, and opens the Signals screen when a push is tapped.
 */
export function usePushNotifications() {
  const { selectedAccount } = useAccount();
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
  // remove it when OFF — the EA sends to whatever tokens are present, so removing
  // it cleanly stops pushes without any EA change.
  useEffect(() => {
    if (!user || !selectedAccount || !pushToken) return;
    const key = pushToken.replace(/[.#$/\[\]]/g, '_');
    const tokenRef = ref(database, `pushTokens/${selectedAccount}/${key}`);
    if (notificationsEnabled) {
      set(tokenRef, pushToken).catch(() => {});
    } else {
      remove(tokenRef).catch(() => {});
    }
  }, [user, selectedAccount, pushToken, notificationsEnabled]);

  // Tapping a signal notification opens the Signals tab.
  useEffect(() => {
    const sub = Notifications.addNotificationResponseReceivedListener(() => {
      try { router.push('/(tabs)/signals'); } catch {}
    });
    return () => sub.remove();
  }, []);
}
