import { initializeApp } from 'firebase/app';
import { getDatabase } from 'firebase/database';
import {
  getAuth,
  initializeAuth,
  getReactNativePersistence,
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
// The app signs in with a dedicated email/password account (entered on the
// login screen and persisted). DB rules are locked to that user's UID, so the
// public API key alone cannot read or write. See AuthContext for sign-in.
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

// Resolves once a user is authenticated (after login, or restored from a
// persisted session). Data listeners await this before attaching so their first
// read isn't rejected as "permission denied".
const authReady = new Promise((resolve) => {
  const unsubscribe = onAuthStateChanged(auth, (user) => {
    if (user) {
      unsubscribe();
      resolve(user);
    }
  });
});

export { app, database, auth, authReady };
