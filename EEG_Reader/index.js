/**
 * index.js — Expo entry point
 *
 * For Expo SDK 51+, the standard entry is "expo-router/entry" when using
 * file-based routing, OR this file when using a plain App.tsx.
 * We use the plain approach (no expo-router) for simplicity.
 *
 * NOTE: No global Buffer polyfill is needed here because we no longer
 * use react-native-ble-plx or binary BLE decoding.  The WebSocket API
 * in React Native delivers JSON strings directly — no Buffer required.
 */

// URL polyfill — must be the very first import.
// Required by @supabase/supabase-js in React Native.
import 'react-native-url-polyfill/auto';

import { registerRootComponent } from 'expo';
import App from './App';

// registerRootComponent calls AppRegistry.registerComponent('main', () => App)
// and also ensures that whether you load the app in Expo Go or in a native
// build, the environment is set up appropriately.
registerRootComponent(App);
