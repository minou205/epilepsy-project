import React, { useState } from 'react';
import {
  View,
  Text,
  StyleSheet,
  TouchableOpacity,
  Platform,
  Alert,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { StatusBar as ExpoStatusBar } from 'expo-status-bar';

import { useAuth }       from '../services/AuthContext';
import { useNavigation } from '../navigation/NavigationContext';

const MONO = Platform.select({ ios: 'Menlo', android: 'monospace', default: 'monospace' });

export default function NormalAlarmSetupScreen() {
  const { updateProfile } = useAuth();
  const { navigate }      = useNavigation();

  const [hour,   setHour  ] = useState(9);
  const [minute, setMinute] = useState(0);

  const pad = (n: number) => n.toString().padStart(2, '0');

  const handleSave = async () => {
    const timeStr = `${pad(hour)}:${pad(minute)}`;
    try {
      await updateProfile({ normal_alarm_time: timeStr });
      Alert.alert(
        'Alarm Set',
        `Daily normal data reminder set for ${timeStr}`,
        [{ text: 'OK', onPress: () => navigate('connect') }],
      );
    } catch (err: any) {
      Alert.alert('Error', err?.message ?? 'Failed to save alarm time');
    }
  };

  const handleSkip = () => {
    navigate('connect');
  };

  return (
    <SafeAreaView style={styles.root} edges={['top', 'left', 'right', 'bottom']}>
      <ExpoStatusBar style="light" />

      <View style={styles.content}>
        <Text style={styles.title}>Set Daily Reminder</Text>
        <Text style={styles.subtitle}>
          Choose a time for your daily normal data collection reminder.
          You can change this later in Settings.
        </Text>

        <View style={styles.timeRow}>
          <View style={styles.pickerCol}>
            <TouchableOpacity
              style={styles.arrowBtn}
              onPress={() => setHour(h => (h + 1) % 24)}
            >
              <Text style={styles.arrowText}>^</Text>
            </TouchableOpacity>
            <View style={styles.timeBox}>
              <Text style={styles.timeText}>{pad(hour)}</Text>
            </View>
            <TouchableOpacity
              style={styles.arrowBtn}
              onPress={() => setHour(h => (h - 1 + 24) % 24)}
            >
              <Text style={styles.arrowText}>v</Text>
            </TouchableOpacity>
            <Text style={styles.pickerLabel}>Hour</Text>
          </View>

          <Text style={styles.colonText}>:</Text>

          <View style={styles.pickerCol}>
            <TouchableOpacity
              style={styles.arrowBtn}
              onPress={() => setMinute(m => (m + 5) % 60)}
            >
              <Text style={styles.arrowText}>^</Text>
            </TouchableOpacity>
            <View style={styles.timeBox}>
              <Text style={styles.timeText}>{pad(minute)}</Text>
            </View>
            <TouchableOpacity
              style={styles.arrowBtn}
              onPress={() => setMinute(m => (m - 5 + 60) % 60)}
            >
              <Text style={styles.arrowText}>v</Text>
            </TouchableOpacity>
            <Text style={styles.pickerLabel}>Minute</Text>
          </View>
        </View>

        <TouchableOpacity style={styles.saveBtn} onPress={handleSave} activeOpacity={0.85}>
          <Text style={styles.saveBtnText}>Set Alarm</Text>
        </TouchableOpacity>

        <TouchableOpacity style={styles.skipBtn} onPress={handleSkip} activeOpacity={0.7}>
          <Text style={styles.skipBtnText}>Skip for now</Text>
        </TouchableOpacity>
      </View>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: '#090915' },
  content: {
    flex: 1, justifyContent: 'center', alignItems: 'center',
    paddingHorizontal: 30, gap: 20,
  },
  title: {
    color: '#E8F0FF', fontSize: 24, fontWeight: '700', fontFamily: MONO,
    textAlign: 'center',
  },
  subtitle: {
    color: '#556677', fontSize: 13, textAlign: 'center', lineHeight: 20,
    paddingHorizontal: 10,
  },
  timeRow: {
    flexDirection: 'row', alignItems: 'center', gap: 16, marginVertical: 20,
  },
  pickerCol: { alignItems: 'center', gap: 8 },
  arrowBtn: {
    width: 50, height: 36, alignItems: 'center', justifyContent: 'center',
    backgroundColor: '#0D1828', borderRadius: 8, borderWidth: 1, borderColor: '#1E2E44',
  },
  arrowText: { color: '#4499FF', fontSize: 18, fontWeight: '700' },
  timeBox: {
    width: 70, height: 60, alignItems: 'center', justifyContent: 'center',
    backgroundColor: '#0D1220', borderRadius: 12, borderWidth: 2, borderColor: '#4499FF55',
  },
  timeText: {
    color: '#E8F0FF', fontSize: 28, fontWeight: '700', fontFamily: MONO,
  },
  colonText: {
    color: '#4499FF', fontSize: 28, fontWeight: '700', fontFamily: MONO,
    marginBottom: 30,
  },
  pickerLabel: { color: '#445566', fontSize: 10, fontFamily: MONO },
  saveBtn: {
    backgroundColor: '#4499FF', borderRadius: 14, paddingVertical: 16,
    paddingHorizontal: 50, alignItems: 'center', marginTop: 10,
  },
  saveBtnText: { color: '#090915', fontSize: 16, fontWeight: '700' },
  skipBtn: { paddingVertical: 10 },
  skipBtnText: { color: '#445566', fontSize: 13 },
});
