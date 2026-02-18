import { initializeApp } from 'firebase/app';
import { getDatabase } from 'firebase/database';

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

export { app, database };
