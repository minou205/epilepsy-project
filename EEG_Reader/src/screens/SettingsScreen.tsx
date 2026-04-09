import React, { useState, useEffect } from 'react';
import {
  View,
  Text,
  StyleSheet,
  TouchableOpacity,
  ScrollView,
  Platform,
  TextInput,
  Alert,
  Switch,
  Image,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { StatusBar as ExpoStatusBar } from 'expo-status-bar';
import * as ImagePicker from 'expo-image-picker';

import { useAuth }        from '../services/AuthContext';
import { useAppSettings } from '../hooks/useAppSettings';
import { EEGSession }     from '../hooks/useEEGSession';
import { CHANNEL_COLORS } from '../hooks/useEEGSession';
import { uploadImageToStorage } from '../services/CommunityService';
import { BackendClient }  from '../services/BackendClient';
import {
  HeadsetInfo,
  fetchHeadset,
  resetHeadset,
  renameHeadset,
} from '../services/HeadsetClient';
import BottomTabBar        from '../components/BottomTabBar';
import RoleBadge           from '../components/RoleBadge';

const MONO = Platform.select({ ios: 'Menlo', android: 'monospace', default: 'monospace' });

function shortUuid(id: string): string {
  if (id.length <= 13) return id;
  return `${id.slice(0, 6)}...${id.slice(-4)}`;
}

const MODEL_CONFIG_OPTIONS = [
  { value: 'both',            label: 'Both (Prediction + Detection)' },
  { value: 'prediction_only', label: 'Prediction Only' },
  { value: 'detection_only',  label: 'Detection Only' },
  { value: 'none',            label: 'None' },
] as const;

interface SettingsScreenProps {
  session: EEGSession;
}

export default function SettingsScreen({ session }: SettingsScreenProps) {
  const { user, profile, signOut, updateProfile } = useAuth();
  const { settings, updateSettings } = useAppSettings();

  // Profile editing
  const [editingName,     setEditingName    ] = useState(profile?.full_name ?? '');
  const [editingUsername, setEditingUsername ] = useState(profile?.username ?? '');
  const [editingBio,      setEditingBio     ] = useState(profile?.bio ?? '');
  const [profileDirty,    setProfileDirty   ] = useState(false);

  // Normal alarm time editing
  const [alarmHour,   setAlarmHour  ] = useState(0);
  const [alarmMinute, setAlarmMinute] = useState(0);
  const [alarmDirty,  setAlarmDirty ] = useState(false);

  // Headset state
  const [headset,        setHeadset       ] = useState<HeadsetInfo | null>(null);
  const [headsetLoaded,  setHeadsetLoaded ] = useState(false);
  const [headsetNameDraft, setHeadsetNameDraft] = useState('');
  const [headsetNameDirty, setHeadsetNameDirty] = useState(false);

  const role = profile?.role ?? 'patient';

  useEffect(() => {
    setEditingName(profile?.full_name ?? '');
    setEditingUsername(profile?.username ?? '');
    setEditingBio(profile?.bio ?? '');
    setProfileDirty(false);
  }, [profile?.full_name, profile?.username, profile?.bio]);

  useEffect(() => {
    if (profile?.normal_alarm_time) {
      const [h, m] = profile.normal_alarm_time.split(':').map(Number);
      setAlarmHour(h || 0);
      setAlarmMinute(m || 0);
    }
    setAlarmDirty(false);
  }, [profile?.normal_alarm_time]);

  // Fetch the locked headset whenever patient/server settings change.
  useEffect(() => {
    if (role !== 'patient') return;
    if (!settings.patientId || !settings.serverBaseUrl) return;

    let cancelled = false;
    setHeadsetLoaded(false);
    fetchHeadset(settings.serverBaseUrl, settings.patientId)
      .then(info => {
        if (cancelled) return;
        setHeadset(info);
        setHeadsetNameDraft(info?.headsetName ?? '');
        setHeadsetNameDirty(false);
        setHeadsetLoaded(true);
      })
      .catch(err => {
        console.warn('[Settings] fetchHeadset failed:', err?.message ?? err);
        if (!cancelled) setHeadsetLoaded(true);
      });
    return () => { cancelled = true; };
  }, [role, settings.patientId, settings.serverBaseUrl]);

  async function handleSaveHeadsetName() {
    if (!settings.patientId || !settings.serverBaseUrl || !headset) return;
    try {
      await renameHeadset(
        settings.serverBaseUrl,
        settings.patientId,
        headsetNameDraft.trim(),
      );
      const refreshed = await fetchHeadset(settings.serverBaseUrl, settings.patientId);
      setHeadset(refreshed);
      setHeadsetNameDraft(refreshed?.headsetName ?? '');
      setHeadsetNameDirty(false);
      Alert.alert('Saved', 'Headset name updated.');
    } catch (err: any) {
      Alert.alert('Error', err?.message ?? 'Failed to rename headset');
    }
  }

  function handleResetHeadset() {
    Alert.alert(
      'Reset Headset',
      'This will permanently delete ALL collected EEG data for this patient and unlock the headset registration. The next recording will register a new headset.\n\nAre you sure?',
      [
        { text: 'Cancel', style: 'cancel' },
        {
          text: 'Reset & Wipe Data',
          style: 'destructive',
          onPress: async () => {
            if (!settings.patientId || !settings.serverBaseUrl) return;
            try {
              await resetHeadset(settings.serverBaseUrl, settings.patientId);
              setHeadset(null);
              setHeadsetNameDraft('');
              setHeadsetNameDirty(false);
              Alert.alert(
                'Done',
                'Headset reset. Old EEG data has been deleted.',
              );
            } catch (err: any) {
              Alert.alert('Error', err?.message ?? 'Failed to reset headset');
            }
          },
        },
      ],
    );
  }

  // ── Save handlers ──

  async function handleSaveProfile() {
    if (!profileDirty) return;
    try {
      await updateProfile({
        full_name   : editingName.trim(),
        patient_name: editingName.trim(),
        username    : editingUsername.trim().toLowerCase(),
        bio         : editingBio.trim(),
      });
      setProfileDirty(false);
      Alert.alert('Saved', 'Profile updated.');
    } catch (err: any) {
      Alert.alert('Error', err?.message ?? 'Failed to save profile');
    }
  }

  async function handleSaveAlarmTime() {
    const pad = (n: number) => n.toString().padStart(2, '0');
    const timeStr = `${pad(alarmHour)}:${pad(alarmMinute)}`;
    await updateProfile({ normal_alarm_time: timeStr });
    setAlarmDirty(false);
    Alert.alert('Saved', `Normal data alarm set to ${timeStr}`);
  }

  // ── Image pickers ──

  async function handlePickAvatar() {
    const result = await ImagePicker.launchImageLibraryAsync({
      mediaTypes: ['images'],
      allowsEditing: true,
      aspect: [1, 1],
      quality: 0.7,
    });
    if (result.canceled || !result.assets[0]) return;
    try {
      const uri = result.assets[0].uri;
      const path = `avatars/${user?.id}_${Date.now()}.jpg`;
      const publicUrl = await uploadImageToStorage(uri, 'avatars', path);
      await updateProfile({ avatar_url: publicUrl });
      Alert.alert('Saved', 'Avatar updated.');
    } catch (err: any) {
      Alert.alert('Error', err?.message ?? 'Failed to upload avatar');
    }
  }

  async function handlePickBackground() {
    const result = await ImagePicker.launchImageLibraryAsync({
      mediaTypes: ['images'],
      allowsEditing: true,
      aspect: [16, 9],
      quality: 0.7,
    });
    if (result.canceled || !result.assets[0]) return;
    try {
      const uri = result.assets[0].uri;
      const path = `backgrounds/${user?.id}_${Date.now()}.jpg`;
      const publicUrl = await uploadImageToStorage(uri, 'backgrounds', path);
      await updateProfile({ background_url: publicUrl });
      Alert.alert('Saved', 'Background updated.');
    } catch (err: any) {
      Alert.alert('Error', err?.message ?? 'Failed to upload background');
    }
  }

  // ── Toggle handlers ──

  async function handleToggleConsentToTrain(value: boolean) {
    await updateProfile({ consent_to_train: value });
    updateSettings({ consentToTrain: value });
  }

  async function handleToggleAlarmSound(value: boolean) {
    await updateProfile({ alarm_sound_enabled: value });
    updateSettings({ alarmSoundEnabled: value });
  }

  async function handleToggleShowName(value: boolean) {
    await updateProfile({ show_name_in_posts: value });
  }

  async function handleToggleDataConsent(value: boolean) {
    await updateProfile({ data_usage_consent: value });
  }

  async function handleModelConfigSelect(config: string) {
    await updateProfile({ general_model_config: config } as any);
    updateSettings({ generalModelConfig: config });
  }

  async function handleDeleteModels() {
    Alert.alert(
      'Delete Models',
      'This will delete your personal models and retrain from scratch. Are you sure?',
      [
        { text: 'Cancel', style: 'cancel' },
        {
          text: 'Delete',
          style: 'destructive',
          onPress: async () => {
            try {
              const client = new BackendClient(settings.serverBaseUrl);
              await client.deleteModels(settings.patientId);
              Alert.alert('Done', 'Models deleted. A new training cycle will begin.');
            } catch (err: any) {
              Alert.alert('Error', err?.message ?? 'Failed to delete models');
            }
          },
        },
      ],
    );
  }

  function handleSignOut() {
    Alert.alert('Sign Out', 'You will need to sign in again.', [
      { text: 'Cancel', style: 'cancel' },
      { text: 'Sign Out', style: 'destructive', onPress: () => signOut() },
    ]);
  }

  const pad = (n: number) => n.toString().padStart(2, '0');

  return (
    <SafeAreaView style={styles.root} edges={['top', 'left', 'right']}>
      <ExpoStatusBar style="light" />

      <View style={styles.header}>
        <Text style={styles.headerTitle}>Settings</Text>
      </View>

      <ScrollView
        style={styles.scroll}
        contentContainerStyle={styles.scrollContent}
        showsVerticalScrollIndicator={false}
      >
        {/* ── Edit Profile ── */}
        {!!profile && (
          <>
            <Text style={styles.sectionTitle}>PROFILE</Text>
            <View style={styles.card}>
              {/* Avatar + Background */}
              <View style={styles.avatarSection}>
                <TouchableOpacity onPress={handlePickAvatar} activeOpacity={0.7}>
                  {profile.avatar_url ? (
                    <Image source={{ uri: profile.avatar_url }} style={styles.avatarImg} />
                  ) : (
                    <View style={styles.avatarPlaceholder}>
                      <Text style={styles.avatarPlaceholderText}>
                        {(profile.full_name || '?')[0].toUpperCase()}
                      </Text>
                    </View>
                  )}
                  <Text style={styles.changePhotoText}>Change Avatar</Text>
                </TouchableOpacity>
                <TouchableOpacity onPress={handlePickBackground} activeOpacity={0.7}>
                  <Text style={styles.changeBgText}>Change Background</Text>
                </TouchableOpacity>
              </View>

              {/* Name */}
              <View style={styles.inputGroup}>
                <Text style={styles.inputLabel}>Full Name</Text>
                <TextInput
                  style={[styles.input, profileDirty && styles.inputDirty]}
                  value={editingName}
                  onChangeText={v => { setEditingName(v); setProfileDirty(true); }}
                  placeholder="Your name"
                  placeholderTextColor="#334455"
                  autoCapitalize="words"
                />
              </View>

              {/* Username */}
              <View style={styles.inputGroup}>
                <Text style={styles.inputLabel}>Username</Text>
                <TextInput
                  style={[styles.input, profileDirty && styles.inputDirty]}
                  value={editingUsername}
                  onChangeText={v => { setEditingUsername(v); setProfileDirty(true); }}
                  placeholder="username"
                  placeholderTextColor="#334455"
                  autoCapitalize="none"
                  autoCorrect={false}
                />
              </View>

              {/* Bio */}
              <View style={styles.inputGroup}>
                <Text style={styles.inputLabel}>Bio</Text>
                <TextInput
                  style={[styles.input, styles.inputBio, profileDirty && styles.inputDirty]}
                  value={editingBio}
                  onChangeText={v => { setEditingBio(v); setProfileDirty(true); }}
                  placeholder="Tell us about yourself..."
                  placeholderTextColor="#334455"
                  multiline
                  textAlignVertical="top"
                />
              </View>

              {/* Role (read-only) */}
              <View style={styles.row}>
                <Text style={styles.label}>Role</Text>
                <RoleBadge role={role} size="medium" />
              </View>

              <View style={styles.row}>
                <Text style={styles.label}>Patient ID</Text>
                <View style={styles.uuidChip}>
                  <Text style={styles.uuidText}>{shortUuid(profile.id)}</Text>
                </View>
              </View>

              {profileDirty && (
                <TouchableOpacity style={styles.actionBtn} onPress={handleSaveProfile} activeOpacity={0.8}>
                  <Text style={styles.actionBtnText}>Save Profile</Text>
                </TouchableOpacity>
              )}
            </View>
          </>
        )}

        {/* ── Training & Model Config (patient only) ── */}
        {role === 'patient' && (
          <>
            <Text style={styles.sectionTitle}>TRAINING & MODELS</Text>
            <View style={styles.card}>
              <View style={styles.toggleRow}>
                <View style={{ flex: 1 }}>
                  <Text style={styles.toggleLabel}>Allow Data Collection & Training</Text>
                  <Text style={styles.toggleHint}>
                    When off, seizure reports and normal data collection are disabled
                  </Text>
                </View>
                <Switch
                  value={profile?.consent_to_train ?? true}
                  onValueChange={handleToggleConsentToTrain}
                  thumbColor={profile?.consent_to_train ? '#00FF88' : '#556677'}
                  trackColor={{ false: '#1A2030', true: '#00FF8840' }}
                />
              </View>

              {/* General model config selector */}
              <View style={styles.inputGroup}>
                <Text style={styles.inputLabel}>General Model Configuration</Text>
                <Text style={styles.toggleHint}>
                  Choose which general models to use (only applies before personal models)
                </Text>
                {MODEL_CONFIG_OPTIONS.map(opt => {
                  const selected = (profile?.general_model_config ?? 'both') === opt.value;
                  return (
                    <TouchableOpacity
                      key={opt.value}
                      style={[styles.radioRow, selected && styles.radioRowSelected]}
                      onPress={() => handleModelConfigSelect(opt.value)}
                      activeOpacity={0.7}
                    >
                      <View style={[styles.radioDot, selected && styles.radioDotSelected]} />
                      <Text style={[styles.radioLabel, selected && styles.radioLabelSelected]}>
                        {opt.label}
                      </Text>
                    </TouchableOpacity>
                  );
                })}
              </View>

              {/* Delete models */}
              <TouchableOpacity
                style={styles.dangerBtn}
                onPress={handleDeleteModels}
                activeOpacity={0.7}
              >
                <Text style={styles.dangerBtnText}>Delete Personal Models</Text>
              </TouchableOpacity>
            </View>
          </>
        )}

        {/* ── Headset (patient only, after first registration) ── */}
        {role === 'patient' && headsetLoaded && headset && (
          <>
            <Text style={styles.sectionTitle}>HEADSET</Text>
            <View style={styles.card}>
              <View style={styles.row}>
                <Text style={styles.label}>Channels</Text>
                <Text style={styles.value}>{headset.nChannels}</Text>
              </View>
              <View style={styles.row}>
                <Text style={styles.label}>Sampling Rate</Text>
                <Text style={styles.value}>{headset.samplingRate} Hz</Text>
              </View>

              <View style={styles.inputGroup}>
                <Text style={styles.inputLabel}>Channel Names</Text>
                <Text style={styles.headsetChannelList} numberOfLines={4}>
                  {headset.channelNames.join(', ')}
                </Text>
              </View>

              <View style={styles.inputGroup}>
                <Text style={styles.inputLabel}>Headset Name (optional)</Text>
                <TextInput
                  style={[styles.input, headsetNameDirty && styles.inputDirty]}
                  value={headsetNameDraft}
                  onChangeText={v => { setHeadsetNameDraft(v); setHeadsetNameDirty(true); }}
                  placeholder={profile?.id ?? 'Headset name'}
                  placeholderTextColor="#334455"
                  autoCapitalize="words"
                />
                <Text style={styles.toggleHint}>
                  Leave empty to use your patient ID as the headset name.
                </Text>
              </View>

              {headsetNameDirty && (
                <TouchableOpacity
                  style={styles.actionBtn}
                  onPress={handleSaveHeadsetName}
                  activeOpacity={0.8}
                >
                  <Text style={styles.actionBtnText}>Save Headset Name</Text>
                </TouchableOpacity>
              )}

              <TouchableOpacity
                style={styles.dangerBtn}
                onPress={handleResetHeadset}
                activeOpacity={0.7}
              >
                <Text style={styles.dangerBtnText}>Reset Headset (wipes data)</Text>
              </TouchableOpacity>
            </View>
          </>
        )}

        {/* ── Normal Alarm Time (patient only) ── */}
        {role === 'patient' && (
          <>
            <Text style={styles.sectionTitle}>NORMAL DATA ALARM</Text>
            <View style={styles.card}>
              <View style={styles.alarmTimeRow}>
                <TouchableOpacity
                  style={styles.timeArrow}
                  onPress={() => { setAlarmHour(h => (h + 1) % 24); setAlarmDirty(true); }}
                >
                  <Text style={styles.arrowText}>^</Text>
                </TouchableOpacity>
                <View style={styles.timeBox}>
                  <Text style={styles.timeText}>{pad(alarmHour)}</Text>
                </View>
                <TouchableOpacity
                  style={styles.timeArrow}
                  onPress={() => { setAlarmHour(h => (h - 1 + 24) % 24); setAlarmDirty(true); }}
                >
                  <Text style={styles.arrowText}>v</Text>
                </TouchableOpacity>

                <Text style={styles.colonText}>:</Text>

                <TouchableOpacity
                  style={styles.timeArrow}
                  onPress={() => { setAlarmMinute(m => (m + 5) % 60); setAlarmDirty(true); }}
                >
                  <Text style={styles.arrowText}>^</Text>
                </TouchableOpacity>
                <View style={styles.timeBox}>
                  <Text style={styles.timeText}>{pad(alarmMinute)}</Text>
                </View>
                <TouchableOpacity
                  style={styles.timeArrow}
                  onPress={() => { setAlarmMinute(m => (m - 5 + 60) % 60); setAlarmDirty(true); }}
                >
                  <Text style={styles.arrowText}>v</Text>
                </TouchableOpacity>
              </View>

              {alarmDirty && (
                <TouchableOpacity style={styles.actionBtn} onPress={handleSaveAlarmTime} activeOpacity={0.8}>
                  <Text style={styles.actionBtnText}>Save Alarm Time</Text>
                </TouchableOpacity>
              )}

              {profile?.normal_alarm_time && !alarmDirty && (
                <Text style={styles.alarmInfo}>
                  Current alarm: {profile.normal_alarm_time}
                </Text>
              )}
            </View>
          </>
        )}

        {/* ── Privacy ── */}
        <Text style={styles.sectionTitle}>PRIVACY</Text>
        <View style={styles.card}>
          <View style={styles.toggleRow}>
            <View style={{ flex: 1 }}>
              <Text style={styles.toggleLabel}>Show Name in Posts</Text>
              <Text style={styles.toggleHint}>
                Your role badge always shows. Toggle to hide your name and username.
              </Text>
            </View>
            <Switch
              value={profile?.show_name_in_posts ?? true}
              onValueChange={handleToggleShowName}
              thumbColor={profile?.show_name_in_posts ? '#00FF88' : '#556677'}
              trackColor={{ false: '#1A2030', true: '#00FF8840' }}
            />
          </View>
          <View style={[styles.toggleRow, { borderTopWidth: 1, borderTopColor: '#141828' }]}>
            <View style={{ flex: 1 }}>
              <Text style={styles.toggleLabel}>Data Usage Consent</Text>
              <Text style={styles.toggleHint}>
                Allow us to use anonymized data for improving the experience
              </Text>
            </View>
            <Switch
              value={profile?.data_usage_consent ?? true}
              onValueChange={handleToggleDataConsent}
              thumbColor={profile?.data_usage_consent ? '#00FF88' : '#556677'}
              trackColor={{ false: '#1A2030', true: '#00FF8840' }}
            />
          </View>
        </View>

        {/* ── Channels ── */}
        <Text style={styles.sectionTitle}>CHANNELS ({session.selectedChannels.length}/{session.config?.channels.length ?? 0})</Text>
        <View style={styles.card}>
          <View style={styles.bulkRow}>
            <TouchableOpacity style={styles.bulkBtn} onPress={session.selectAll}>
              <Text style={styles.bulkBtnTextGreen}>All</Text>
            </TouchableOpacity>
            <TouchableOpacity style={styles.bulkBtn} onPress={session.clearAll}>
              <Text style={styles.bulkBtnTextRed}>Clear</Text>
            </TouchableOpacity>
          </View>
          {(session.config?.channels ?? []).map((ch, idx) => {
            const sel = session.selectedChannels.includes(ch);
            const color = CHANNEL_COLORS[idx % CHANNEL_COLORS.length];
            return (
              <TouchableOpacity
                key={ch}
                style={[styles.chRow, sel && styles.chRowSel]}
                onPress={() => session.toggleChannel(ch)}
                activeOpacity={0.7}
              >
                <View style={[styles.colorDot, { backgroundColor: color }]} />
                <Text style={[styles.chName, sel && { color: '#E8F0FF' }]}>{ch}</Text>
                {sel && <Text style={[styles.chCheck, { color }]}>v</Text>}
              </TouchableOpacity>
            );
          })}
        </View>

        {/* ── Notifications ── */}
        <Text style={styles.sectionTitle}>NOTIFICATIONS</Text>
        <View style={styles.card}>
          <View style={styles.toggleRow}>
            <Text style={styles.toggleLabel}>Alarm Sound</Text>
            <Switch
              value={profile?.alarm_sound_enabled ?? true}
              onValueChange={handleToggleAlarmSound}
              thumbColor={profile?.alarm_sound_enabled ? '#00FF88' : '#556677'}
              trackColor={{ false: '#1A2030', true: '#00FF8840' }}
            />
          </View>
        </View>

        {/* ── Actions ── */}
        <View style={styles.footerActions}>
          <TouchableOpacity
            style={styles.disconnectBtn}
            onPress={() => session.disconnect()}
            activeOpacity={0.7}
          >
            <Text style={styles.disconnectText}>Disconnect EEG</Text>
          </TouchableOpacity>

          <TouchableOpacity
            style={styles.signOutBtn}
            onPress={handleSignOut}
            activeOpacity={0.7}
          >
            <Text style={styles.signOutText}>Sign Out</Text>
          </TouchableOpacity>
        </View>

      </ScrollView>

      <BottomTabBar activeTab="settings" role={role} />
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: '#090915' },
  header: {
    paddingHorizontal: 16, paddingVertical: 14,
    borderBottomWidth: 1, borderBottomColor: '#0D1828',
  },
  headerTitle: { color: '#E8F0FF', fontSize: 20, fontWeight: '700', fontFamily: MONO },
  scroll: { flex: 1 },
  scrollContent: { paddingHorizontal: 16, paddingBottom: 20 },
  sectionTitle: {
    color: '#334455', fontSize: 10, fontWeight: '700', letterSpacing: 1.4,
    fontFamily: MONO, marginTop: 20, marginBottom: 8,
  },
  card: {
    backgroundColor: '#0D1220', borderRadius: 12, borderWidth: 1,
    borderColor: '#1E2E44', overflow: 'hidden',
  },
  row: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between',
    paddingVertical: 12, paddingHorizontal: 14,
    borderBottomWidth: 1, borderBottomColor: '#141828',
  },
  label: { color: '#556677', fontSize: 12, fontFamily: MONO },
  value: { color: '#AAB8CC', fontSize: 13, fontFamily: MONO, fontWeight: '600', maxWidth: 160, textAlign: 'right' },
  uuidChip: {
    backgroundColor: '#0A1428', borderRadius: 6, paddingHorizontal: 8, paddingVertical: 3,
    borderWidth: 1, borderColor: '#1E3060',
  },
  uuidText: { color: '#4499FF', fontSize: 11, fontFamily: MONO, fontWeight: '600' },

  // Avatar section
  avatarSection: {
    alignItems: 'center', paddingVertical: 16, gap: 8,
    borderBottomWidth: 1, borderBottomColor: '#141828',
  },
  avatarImg: { width: 72, height: 72, borderRadius: 36 },
  avatarPlaceholder: {
    width: 72, height: 72, borderRadius: 36, backgroundColor: '#1A2840',
    alignItems: 'center', justifyContent: 'center',
  },
  avatarPlaceholderText: { color: '#4499FF', fontSize: 28, fontWeight: '700' },
  changePhotoText: { color: '#4499FF', fontSize: 12, fontWeight: '600', marginTop: 4 },
  changeBgText: { color: '#556677', fontSize: 11 },

  // Toggles
  toggleRow: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between',
    paddingVertical: 12, paddingHorizontal: 14,
  },
  toggleLabel: { color: '#CCDDEE', fontSize: 13, fontWeight: '600', fontFamily: MONO },
  toggleHint: { color: '#445566', fontSize: 10, fontFamily: MONO, marginTop: 2 },

  // Inputs
  inputGroup: { padding: 14, gap: 6 },
  inputLabel: { color: '#556677', fontSize: 12, fontFamily: MONO },
  input: {
    backgroundColor: '#080D18', borderWidth: 1, borderColor: '#1E2E44', borderRadius: 8,
    paddingVertical: 10, paddingHorizontal: 12, color: '#AAB8CC', fontSize: 13, fontFamily: MONO,
  },
  inputBio: { minHeight: 60, textAlignVertical: 'top' },
  inputDirty: { borderColor: '#4499FF55' },
  inputHint: { color: '#334455', fontSize: 10, fontFamily: MONO, display: 'none' },
  headsetChannelList: {
    backgroundColor: '#080D18', borderWidth: 1, borderColor: '#1E2E44',
    borderRadius: 8, paddingVertical: 10, paddingHorizontal: 12,
    color: '#AABBCC', fontSize: 11, fontFamily: MONO, lineHeight: 16,
  },

  // Action buttons
  actionBtn: {
    marginHorizontal: 14, marginBottom: 10, paddingVertical: 10, alignItems: 'center',
    borderRadius: 8, borderWidth: 1, borderColor: '#4499FF55', backgroundColor: '#4499FF12',
  },
  actionBtnText: { color: '#4499FF', fontSize: 12, fontWeight: '600' },

  // Radio
  radioRow: {
    flexDirection: 'row', alignItems: 'center', gap: 10,
    paddingVertical: 10, paddingHorizontal: 4,
  },
  radioRowSelected: {},
  radioDot: {
    width: 16, height: 16, borderRadius: 8, borderWidth: 2,
    borderColor: '#334455', backgroundColor: 'transparent',
  },
  radioDotSelected: { borderColor: '#4499FF', backgroundColor: '#4499FF' },
  radioLabel: { color: '#556677', fontSize: 12, fontFamily: MONO },
  radioLabelSelected: { color: '#CCDDEE' },

  // Danger
  dangerBtn: {
    marginHorizontal: 14, marginVertical: 10, paddingVertical: 10, alignItems: 'center',
    borderRadius: 8, borderWidth: 1, borderColor: '#FF664444', backgroundColor: '#FF664410',
  },
  dangerBtnText: { color: '#FF6644', fontSize: 12, fontWeight: '600' },

  // Alarm time
  alarmTimeRow: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'center',
    paddingVertical: 16, gap: 6,
  },
  timeArrow: {
    width: 36, height: 28, alignItems: 'center', justifyContent: 'center',
    backgroundColor: '#0D1828', borderRadius: 6, borderWidth: 1, borderColor: '#1E2E44',
  },
  arrowText: { color: '#4499FF', fontSize: 14, fontWeight: '700' },
  timeBox: {
    width: 50, height: 44, alignItems: 'center', justifyContent: 'center',
    backgroundColor: '#0D1220', borderRadius: 8, borderWidth: 1, borderColor: '#4499FF33',
  },
  timeText: { color: '#E8F0FF', fontSize: 20, fontWeight: '700', fontFamily: MONO },
  colonText: { color: '#4499FF', fontSize: 20, fontWeight: '700', fontFamily: MONO, marginHorizontal: 4 },
  alarmInfo: { color: '#445566', fontSize: 11, fontFamily: MONO, textAlign: 'center', paddingBottom: 10 },

  // Channels
  bulkRow: { flexDirection: 'row', gap: 8, padding: 14 },
  bulkBtn: { paddingVertical: 5, paddingHorizontal: 14, borderRadius: 8, borderWidth: 1, borderColor: '#1E2E44' },
  bulkBtnTextGreen: { color: '#00FF88', fontSize: 12, fontWeight: '600' },
  bulkBtnTextRed: { color: '#FF6644', fontSize: 12, fontWeight: '600' },
  chRow: {
    flexDirection: 'row', alignItems: 'center', paddingVertical: 10, paddingHorizontal: 14,
    borderBottomWidth: 1, borderBottomColor: '#0D1020', gap: 10,
  },
  chRowSel: { backgroundColor: 'rgba(255,255,255,0.04)' },
  colorDot: { width: 9, height: 9, borderRadius: 5 },
  chName: { flex: 1, color: '#445566', fontSize: 13, fontFamily: MONO, fontWeight: '500' },
  chCheck: { fontSize: 13, fontWeight: '700' },

  // Footer
  footerActions: { marginTop: 24, gap: 10, marginBottom: 30 },
  disconnectBtn: {
    paddingVertical: 12, alignItems: 'center', borderRadius: 10,
    borderWidth: 1, borderColor: '#FF664444', backgroundColor: '#FF664410',
  },
  disconnectText: { color: '#FF6644', fontSize: 14, fontWeight: '600' },
  signOutBtn: {
    paddingVertical: 12, alignItems: 'center', borderRadius: 10,
    borderWidth: 1, borderColor: '#33333355', backgroundColor: '#1A1A1A',
  },
  signOutText: { color: '#556677', fontSize: 14, fontWeight: '600' },
});
