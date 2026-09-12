import { initializeApp } from 'firebase/app';
import { getDatabase } from 'firebase/database';
import {
  getAuth,
  initializeAuth,
  getReactNativePersistence,
  signInAnonymously,
  onAuthStateChanged,
} from 'firebase/auth';
import ReactNativeAsyncStorage from '@react-native-async-storage/async-storage';
import { Platform } from 'react-native';

// Replace with your Firebase project configuration
// See FIREBASE_SETUP.md for how to get these values
const firebaseConfig = {
  apiKey: "AIzaSyCA3LUdogLeo7wdHEfxfPQtG4EG2SqEFtg",
  authDomain: "c0mmand3r.firebaseapp.com",
  databaseURL: "https://c0mmand3r-default-rtdb.firebaseio.com",
  projectId: "c0mmand3r",
  storageBucket: "c0mmand3r.firebasestorage.app",
  messagingSenderId: "936874561230",
  appId: "1:936874561230:web:d36271190258360e1d0a9f"
};

// Initialize Firebase
const app = initializeApp(firebaseConfig);

// Initialize Realtime Database and get a reference to the service
const database = getDatabase(app);

// --- Authentication --------------------------------------------------------
// The Realtime Database security rules require an authenticated user
// (auth != null). We sign in anonymously so the app can read account data and
// send commands, while the database stays closed to unauthenticated callers.
let auth;
if (Platform.OS === 'web') {
  auth = getAuth(app);
} else {
  try {
    // Persist the anonymous session across app restarts (avoids creating a new
    // anonymous user every launch).
    auth = initializeAuth(app, {
      persistence: getReactNativePersistence(ReactNativeAsyncStorage),
    });
  } catch {
    // initializeAuth throws if it was already initialized (e.g. Fast Refresh).
    auth = getAuth(app);
  }
}

// Resolves once we have an authenticated (anonymous) user. Data listeners await
// this before attaching so their first read isn't rejected as "permission
// denied" during the brief window before sign-in completes.
const authReady = new Promise((resolve) => {
  const unsubscribe = onAuthStateChanged(auth, (user) => {
    if (user) {
      unsubscribe();
      resolve(user);
    }
  });
});

// Kick off sign-in. If a persisted session exists, onAuthStateChanged fires with
// that user and this is effectively a no-op.
signInAnonymously(auth).catch((error) => {
  console.error('Firebase anonymous sign-in failed:', error);
});

export { app, database, auth, authReady };
