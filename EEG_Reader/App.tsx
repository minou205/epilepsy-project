import React, { useCallback, useEffect } from 'react';
import { ActivityIndicator, StyleSheet, Text, View } from 'react-native';
import { SafeAreaProvider } from 'react-native-safe-area-context';
import { setupNotifications } from './src/services/NotificationService';

import { AuthProvider, useAuth }            from './src/services/AuthContext';
import { NavigationProvider, useNavigation } from './src/navigation/NavigationContext';
import { useEEGSession }                     from './src/hooks/useEEGSession';
import { AppSettingsProvider, useAppSettings } from './src/hooks/useAppSettings';
import { useAutoConnect }                    from './src/hooks/useAutoConnect';
import { useTrackerSession }                 from './src/hooks/useTrackerSession';
import { useServerDiscovery }                from './src/hooks/useServerDiscovery';

import LoginScreen            from './src/screens/LoginScreen';
import ConnectScreen          from './src/screens/ConnectScreen';
import TrackerScreen          from './src/screens/TrackerScreen';
import SettingsScreen         from './src/screens/SettingsScreen';
import CommunityScreen        from './src/screens/CommunityScreen';
import ArchiveScreen          from './src/screens/ArchiveScreen';
import ProfileScreen          from './src/screens/ProfileScreen';
import ChatListScreen         from './src/screens/ChatListScreen';
import ChatScreen             from './src/screens/ChatScreen';
import NormalAlarmSetupScreen from './src/screens/NormalAlarmSetupScreen';
import QRScannerScreen        from './src/components/QRScannerScreen';

// ── Router ────────────────────────────────────────────────────────────────────

function AppNavigator() {
  const { user, profile, isLoading, updateProfile }  = useAuth();
  const { settings, updateSettings }  = useAppSettings();
  const eegSession                    = useEEGSession();

  useServerDiscovery();
  const { screen, navigate }          = useNavigation();

  const autoDetectedHost = (() => {
    try {
      const url  = settings.serverBaseUrl;
      const host = url.replace(/^https?:\/\//, '').split(':')[0];
      return host && host !== '192.168.1.1' ? host : null;
    } catch { return null; }
  })();

  const serverIpToConnect = profile?.server_ip || autoDetectedHost;

  const { reconnecting, retryCount, markManualConnect } = useAutoConnect(
    eegSession,
    serverIpToConnect ?? null,
  );

  // ── Tracker session — lives here so it survives screen navigation ─────────
  const effectiveSettings = user
    ? {
        ...settings,
        patientId          : user.id,
        consentGiven       : profile?.data_usage_consent ?? true,
        consentToTrain     : profile?.consent_to_train ?? true,
        generalModelConfig : profile?.general_model_config ?? 'both',
      }
    : settings;

  const tracker = useTrackerSession(eegSession, effectiveSettings);

  // ── 0. Auto-derive backend URL from the EEG simulator connection ──────────
  // The simulator and backend run on the same PC, so the IP is identical.
  // This is more reliable than Expo's hostUri when the PC has multiple NICs.
  useEffect(() => {
    const host = eegSession.connectedHost;
    if (!host) return;
    const derivedUrl = `http://${host}:8000`;
    if (settings.serverBaseUrl !== derivedUrl) {
      updateSettings({ serverBaseUrl: derivedUrl });
      updateProfile?.({ server_ip: host });
    }
  }, [eegSession.connectedHost]);

  // ── 1. Sync Supabase profile -> appSettings ────────────────────────────────
  useEffect(() => {
    if (!user || !profile) return;
    updateSettings({
      patientId      : user.id,
      patientName    : profile.full_name || profile.patient_name,
      serverBaseUrl  : profile.server_ip
        ? `http://${profile.server_ip}:8000`
        : settings.serverBaseUrl,
      consentGiven   : profile.data_usage_consent,
      role           : profile.role,
      consentToTrain : profile.consent_to_train,
      generalModelConfig: profile.general_model_config,
      alarmSoundEnabled : profile.alarm_sound_enabled,
    });
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [user?.id, profile?.server_ip, profile?.patient_name, profile?.full_name,
      profile?.data_usage_consent, profile?.role, profile?.consent_to_train,
      profile?.general_model_config, profile?.alarm_sound_enabled]);

  // ── 2. Auth -> navigation gate ─────────────────────────────────────────────
  useEffect(() => {
    if (isLoading) return;
    if (!user && screen !== 'login') navigate('login');
    if (user && screen === 'login') {
      // If patient and no alarm time set yet, go to alarm setup first
      if (profile?.role === 'patient' && !profile?.normal_alarm_time) {
        navigate('normalAlarmSetup');
      } else {
        navigate('connect');
      }
    }
  }, [user, isLoading, screen, navigate, profile?.role, profile?.normal_alarm_time]);

  // ── 3. EEG connection -> navigation ────────────────────────────────────────
  const eegStatus   = eegSession.status;
  const isConnected = eegStatus === 'connected' || eegStatus === 'connecting';

  useEffect(() => {
    if (!user) return;
    // After EEG connects from connect screen, go to tracker
    if (isConnected && screen === 'connect') navigate('tracker');
    // Don't auto-navigate away from tracker on disconnect —
    // the tracker shows connection status and the user can reconnect
  }, [isConnected, eegStatus, screen, user, navigate]);

  // ── Callbacks ─────────────────────────────────────────────────────────────

  const handleQRScanned = useCallback((url: string) => {
    markManualConnect();
    try {
      const ip = url.replace(/^ws:\/\//, '').split(':')[0];
      if (ip) {
        const backendUrl = `http://${ip}:8000`;
        updateSettings({ serverBaseUrl: backendUrl });
        updateProfile?.({ server_ip: ip });
      }
    } catch { /* ignore */ }
    navigate('tracker');
    eegSession.connect(url);
  }, [eegSession, navigate, updateSettings, updateProfile, markManualConnect]);

  // ── Loading splash ─────────────────────────────────────────────────────────

  if (isLoading) {
    return (
      <View style={splash.root}>
        <ActivityIndicator size="large" color="#4499FF" />
        <Text style={splash.text}>Loading...</Text>
      </View>
    );
  }

  // ── Screen routing ─────────────────────────────────────────────────────────

  switch (screen) {
    case 'login':
      return <LoginScreen />;

    case 'normalAlarmSetup':
      return <NormalAlarmSetupScreen />;

    case 'qr':
      return (
        <QRScannerScreen
          onScanned={handleQRScanned}
          onCancel={() => navigate('connect')}
        />
      );

    case 'tracker':
      return <TrackerScreen session={eegSession} tracker={tracker} />;

    case 'settings':
      return <SettingsScreen session={eegSession} />;

    case 'community':
    case 'createPost':
      return <CommunityScreen />;

    case 'archive':
      return <ArchiveScreen />;

    case 'profile':
      return <ProfileScreen />;

    case 'chatList':
      return <ChatListScreen />;

    case 'chat':
      return <ChatScreen />;

    default:
      return (
        <ConnectScreen
          session={eegSession}
          reconnecting={reconnecting}
          retryCount={retryCount}
          serverIp={serverIpToConnect ?? null}
        />
      );
  }
}

// ── Loading splash styles ─────────────────────────────────────────────────────

const splash = StyleSheet.create({
  root: {
    flex           : 1,
    backgroundColor: '#090915',
    alignItems     : 'center',
    justifyContent : 'center',
    gap            : 16,
  },
  text: {
    color     : '#334455',
    fontSize  : 14,
    fontFamily: 'monospace',
  },
});

// ── Root ──────────────────────────────────────────────────────────────────────

export default function App() {
  useEffect(() => {
    setupNotifications().catch(() => {/* expo-notifications not installed in dev */});
  }, []);

  return (
    <SafeAreaProvider>
      <AppSettingsProvider>
        <AuthProvider>
          <NavigationProvider>
            <AppNavigator />
          </NavigationProvider>
        </AuthProvider>
      </AppSettingsProvider>
    </SafeAreaProvider>
  );
}
