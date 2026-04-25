import React, { useState, useCallback } from 'react';
import {
  View,
  Text,
  Image,
  TextInput,
  TouchableOpacity,
  StyleSheet,
  KeyboardAvoidingView,
  Platform,
  ActivityIndicator,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { StatusBar as ExpoStatusBar } from 'expo-status-bar';
import { EEGSession } from '../hooks/useEEGSession';
import { useNavigation } from '../navigation/NavigationContext';
import { useAuth } from '../services/AuthContext';

const MONO = Platform.select({ ios: 'Menlo', android: 'monospace', default: 'monospace' });

interface ConnectScreenProps {
  session      : EEGSession;
  reconnecting ?: boolean;
  retryCount   ?: number;
  serverIp     ?: string | null;
}

export default function ConnectScreen({
  session,
  reconnecting = false,
  retryCount   = 0,
  serverIp     = null,
}: ConnectScreenProps) {
  const { navigate }          = useNavigation();
  const { profile }           = useAuth();
  const [ipInput, setIpInput] = useState('');

  const isAutoConnecting = reconnecting && session.status !== 'error';

  const handleConnect = useCallback(() => {
    const target = ipInput.trim();
    if (target) session.connect(target);
  }, [ipInput, session]);

  return (
    <SafeAreaView style={styles.root} edges={['top', 'bottom', 'left', 'right']}>
      <ExpoStatusBar style="light" />

      <KeyboardAvoidingView
        style={styles.container}
        behavior={Platform.OS === 'ios' ? 'padding' : 'height'}
      >

        <View style={styles.titleBlock}>
          <Image
            source={require('../../assets/logo.png')}
            style={styles.logoImage}
            resizeMode="contain"
          />
          {profile ? (
            <>
              <Text style={styles.greeting}>Welcome back,</Text>
              <Text style={styles.patientName}>{profile.patient_name}</Text>
            </>
          ) : (
            <>
              <Text style={styles.appTitle}>EEG Reader</Text>
              <Text style={styles.appSubtitle}>Connect to EEG Simulator over WiFi</Text>
            </>
          )}
        </View>

        {isAutoConnecting && (
          <View style={styles.reconnectBanner}>
            <ActivityIndicator size="small" color="#4499FF" style={{ marginRight: 10 }} />
            <Text style={styles.reconnectText}>
              {retryCount === 0
                ? `Connecting to ${serverIp ?? 'simulator'}…`
                : `Reconnecting… (attempt ${retryCount})`}
            </Text>
          </View>
        )}

        {session.status === 'error' && (
          <View style={styles.errorPill}>
            <Text style={styles.errorPillText}>{session.statusMessage}</Text>
            {reconnecting && (
              <Text style={styles.retryHint}>
                Auto-retry in 12 s  ·  or connect manually below
              </Text>
            )}
          </View>
        )}

        <View style={styles.manualSection}>
          <Text style={styles.manualLabel}>
            {serverIp ? 'Connect to a different device' : 'EEG Simulator IP Address'}
          </Text>
          <View style={styles.inputRow}>
            <TextInput
              style={styles.ipInput}
              placeholder={serverIp ?? '192.168.1.x  or  ws://…'}
              placeholderTextColor="#334455"
              value={ipInput}
              onChangeText={setIpInput}
              keyboardType="url"
              autoCapitalize="none"
              autoCorrect={false}
              returnKeyType="go"
              onSubmitEditing={handleConnect}
            />
          </View>

          <TouchableOpacity
            style={[styles.primaryBtn, !ipInput.trim() && styles.btnDisabled]}
            onPress={handleConnect}
            disabled={!ipInput.trim()}
            activeOpacity={0.8}
          >
            <Text style={styles.primaryBtnText}>Connect</Text>
          </TouchableOpacity>

          <TouchableOpacity
            style={styles.qrBtn}
            onPress={() => navigate('qr')}
            activeOpacity={0.8}
          >
            <Text style={styles.qrBtnText}>⬡  Scan QR Code</Text>
          </TouchableOpacity>
        </View>

        <Text style={styles.hint}>
          Run EEG Simulator on PC and scan the QR code{'\n'}
          or enter the IP address shown on screen.
        </Text>

      </KeyboardAvoidingView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  root: {
    flex           : 1,
    backgroundColor: '#090915',
  },
  container: {
    flex             : 1,
    justifyContent   : 'center',
    paddingHorizontal: 28,
    gap              : 14,
  },

  titleBlock: {
    alignItems  : 'center',
    marginBottom: 4,
    gap         : 4,
  },
  logoImage: {
    width       : 64,
    height      : 64,
    marginBottom: 10,
  },
  appTitle: {
    color        : '#E8F0FF',
    fontSize     : 26,
    fontWeight   : '700',
    letterSpacing: 0.5,
  },
  appSubtitle: {
    color    : '#445566',
    fontSize : 13,
    textAlign: 'center',
  },
  greeting: {
    color    : '#445566',
    fontSize : 14,
    textAlign: 'center',
  },
  patientName: {
    color        : '#E8F0FF',
    fontSize     : 22,
    fontWeight   : '700',
    textAlign    : 'center',
    letterSpacing: 0.3,
  },

  reconnectBanner: {
    flexDirection  : 'row',
    alignItems     : 'center',
    backgroundColor: '#0A1428',
    borderWidth    : 1,
    borderColor    : '#1E3060',
    borderRadius   : 10,
    paddingVertical: 10,
    paddingHorizontal: 14,
  },
  reconnectText: {
    color     : '#4499FF',
    fontSize  : 13,
    fontFamily: MONO,
    flex      : 1,
  },

  errorPill: {
    backgroundColor: '#FF664422',
    borderWidth    : 1,
    borderColor    : '#FF664444',
    borderRadius   : 10,
    padding        : 12,
    gap            : 4,
  },
  errorPillText: {
    color    : '#FF8866',
    fontSize : 13,
    textAlign: 'center',
  },
  retryHint: {
    color    : '#556677',
    fontSize : 11,
    textAlign: 'center',
    fontFamily: MONO,
  },

  manualSection: {
    gap: 10,
  },
  manualLabel: {
    color     : '#334455',
    fontSize  : 11,
    fontFamily: MONO,
    letterSpacing: 0.8,
    textTransform: 'uppercase',
    textAlign : 'center',
  },
  inputRow: {},
  ipInput: {
    backgroundColor  : '#0D1424',
    borderWidth      : 1,
    borderColor      : '#1E2E44',
    borderRadius     : 12,
    paddingVertical  : 14,
    paddingHorizontal: 16,
    color            : '#E8F0FF',
    fontSize         : 15,
    fontFamily       : MONO,
  },
  primaryBtn: {
    backgroundColor: '#00FF88',
    borderRadius   : 12,
    paddingVertical: 15,
    alignItems     : 'center',
  },
  primaryBtnText: {
    color     : '#090915',
    fontSize  : 16,
    fontWeight: '700',
  },
  qrBtn: {
    borderWidth    : 1,
    borderColor    : '#1E2E44',
    borderRadius   : 12,
    paddingVertical: 14,
    alignItems     : 'center',
  },
  qrBtnText: {
    color     : '#AAB8CC',
    fontSize  : 15,
    fontWeight: '600',
  },
  btnDisabled: {
    opacity: 0.35,
  },

  hint: {
    color     : '#334455',
    fontSize  : 12,
    textAlign : 'center',
    lineHeight: 18,
    marginTop : 4,
  },
});
