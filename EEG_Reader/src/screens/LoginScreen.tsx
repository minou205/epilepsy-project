import React, { useState, useCallback } from 'react';
import {
  View,
  Text,
  TextInput,
  TouchableOpacity,
  StyleSheet,
  KeyboardAvoidingView,
  Platform,
  ScrollView,
  ActivityIndicator,
  Image,
  Switch,
  Alert,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { StatusBar as ExpoStatusBar } from 'expo-status-bar';
import { useAuth } from '../services/AuthContext';
import type { UserRole } from '../services/supabaseClient';

const MONO = Platform.select({ ios: 'Menlo', android: 'monospace', default: 'monospace' });

/** Convert common birthday formats to ISO YYYY-MM-DD for Supabase. */
function normaliseBirthday(raw: string): string | null {
  if (!raw) return null;
  // Already ISO? (2005-03-14)
  if (/^\d{4}-\d{2}-\d{2}$/.test(raw)) return raw;
  // DDMMYYYY (14032005) or MMDDYYYY
  if (/^\d{8}$/.test(raw)) {
    const d = raw.slice(0, 2), m = raw.slice(2, 4), y = raw.slice(4);
    // If first two digits > 12, it's DD/MM/YYYY
    return Number(d) > 12
      ? `${y}-${m}-${d}`
      : `${y}-${d}-${m}`;
  }
  // DD/MM/YYYY or DD-MM-YYYY
  const parts = raw.split(/[/\-.]/).map(s => s.trim());
  if (parts.length === 3) {
    let [a, b, c] = parts;
    if (a.length === 4) return `${a}-${b.padStart(2, '0')}-${c.padStart(2, '0')}`;
    if (c.length === 4) {
      // a/b/c = DD/MM/YYYY or MM/DD/YYYY
      return Number(a) > 12
        ? `${c}-${b.padStart(2, '0')}-${a.padStart(2, '0')}`
        : `${c}-${a.padStart(2, '0')}-${b.padStart(2, '0')}`;
    }
  }
  return raw; // can't parse — pass through as-is
}

type Tab = 'login' | 'signup';

const ROLES: { value: UserRole; label: string; desc: string }[] = [
  { value: 'patient',   label: 'Patient',   desc: 'Track seizures and collect EEG data' },
  { value: 'helper',    label: 'Helper',     desc: 'Monitor a patient and receive alerts' },
  { value: 'doctor',    label: 'Doctor',     desc: 'Medical professional supporting patients' },
  { value: 'supporter', label: 'Supporter',  desc: 'Community member offering support' },
];

export default function LoginScreen() {
  const { signIn, signUp } = useAuth();

  const [tab,      setTab     ] = useState<Tab>('login');
  const [email,    setEmail   ] = useState('');
  const [password, setPassword] = useState('');
  const [name,     setName    ] = useState('');
  const [username, setUsername ] = useState('');
  const [birthday, setBirthday] = useState('');
  const [bio,      setBio     ] = useState('');
  const [role,     setRole    ] = useState<UserRole>('patient');
  const [consent,  setConsent ] = useState(false);
  const [loading,  setLoading ] = useState(false);
  const [error,    setError   ] = useState<string | null>(null);
  const [success,  setSuccess ] = useState<string | null>(null);

  const switchTab = useCallback((t: Tab) => {
    setTab(t);
    setError(null);
    setSuccess(null);
  }, []);

  const handleLogin = useCallback(async () => {
    if (!email.trim() || !password) {
      setError('Please enter your email and password.');
      return;
    }
    setLoading(true);
    setError(null);
    const err = await signIn(email.trim().toLowerCase(), password);
    if (err) setError(err.message);
    setLoading(false);
  }, [email, password, signIn]);

  const handleSignUp = useCallback(async () => {
    if (!email.trim() || !password || !name.trim() || !username.trim()) {
      setError('Please fill in all required fields.');
      return;
    }
    if (password.length < 6) {
      setError('Password must be at least 6 characters.');
      return;
    }
    if (!consent) {
      setError('Please accept the data consent to continue.');
      return;
    }
    setLoading(true);
    setError(null);
    const err = await signUp({
      email   : email.trim().toLowerCase(),
      password,
      fullName: name.trim(),
      username: username.trim(),
      birthday: normaliseBirthday(birthday.trim()) || null,
      bio     : bio.trim(),
      role,
      consent,
    });
    if (err) {
      setError(err.message);
    } else {
      setSuccess(
        'Account created! Check your email to confirm, then sign in.\n\n'
        + 'If email confirmation is disabled, you are already signed in.',
      );
      // One-time headset warning for new patients. Once they upload their
      // first recording the backend locks them to that exact channel set,
      // and switching headsets later means wiping all collected data.
      if (role === 'patient') {
        Alert.alert(
          'Important: One Headset Per Patient',
          "Please use only ONE EEG headset for all your recordings.\n\n"
          + "Your first recording locks the app to that headset's exact channel set. "
          + "If you switch headsets later, we will need to delete your old data and "
          + "start collecting from scratch.",
          [{ text: 'I understand' }],
        );
      }
    }
    setLoading(false);
  }, [email, password, name, username, birthday, bio, role, consent, signUp]);

  const handleSubmit = tab === 'login' ? handleLogin : handleSignUp;

  return (
    <SafeAreaView style={styles.root} edges={['top', 'bottom', 'left', 'right']}>
      <ExpoStatusBar style="light" />

      <KeyboardAvoidingView
        style={styles.flex}
        behavior={Platform.OS === 'ios' ? 'padding' : 'height'}
      >
        <ScrollView
          contentContainerStyle={styles.container}
          keyboardShouldPersistTaps="handled"
          showsVerticalScrollIndicator={false}
        >

          {/* Branding */}
          <View style={styles.header}>
            <Image
              source={require('../../assets/logo.png')}
              style={styles.logo}
              resizeMode="contain"
            />
            <Text style={styles.title}>EEG Reader</Text>
            <Text style={styles.subtitle}>Epilepsy monitoring & seizure detection</Text>
          </View>

          {/* Tab switcher */}
          <View style={styles.tabRow}>
            <TouchableOpacity
              style={[styles.tab, tab === 'login' && styles.tabActive]}
              onPress={() => switchTab('login')}
              activeOpacity={0.8}
            >
              <Text style={[styles.tabText, tab === 'login' && styles.tabTextActive]}>Sign In</Text>
            </TouchableOpacity>
            <TouchableOpacity
              style={[styles.tab, tab === 'signup' && styles.tabActive]}
              onPress={() => switchTab('signup')}
              activeOpacity={0.8}
            >
              <Text style={[styles.tabText, tab === 'signup' && styles.tabTextActive]}>New Account</Text>
            </TouchableOpacity>
          </View>

          {/* Form card */}
          <View style={styles.card}>

            {!!error && (
              <View style={styles.errorBox}>
                <Text style={styles.errorText}>{error}</Text>
              </View>
            )}
            {!!success && (
              <View style={styles.successBox}>
                <Text style={styles.successText}>{success}</Text>
              </View>
            )}

            {/* Email */}
            <View style={styles.inputGroup}>
              <Text style={styles.label}>Email</Text>
              <TextInput
                style={styles.input}
                value={email}
                onChangeText={v => { setEmail(v); setError(null); }}
                placeholder="patient@example.com"
                placeholderTextColor="#334455"
                keyboardType="email-address"
                autoCapitalize="none"
                autoCorrect={false}
                returnKeyType="next"
              />
            </View>

            {/* Password */}
            <View style={styles.inputGroup}>
              <Text style={styles.label}>Password</Text>
              <TextInput
                style={styles.input}
                value={password}
                onChangeText={v => { setPassword(v); setError(null); }}
                placeholder="At least 6 characters"
                placeholderTextColor="#334455"
                secureTextEntry
                returnKeyType={tab === 'login' ? 'go' : 'next'}
                onSubmitEditing={tab === 'login' ? handleLogin : undefined}
              />
            </View>

            {/* Sign-up-only fields */}
            {tab === 'signup' && (
              <>
                <View style={styles.inputGroup}>
                  <Text style={styles.label}>Full Name *</Text>
                  <TextInput
                    style={styles.input}
                    value={name}
                    onChangeText={v => { setName(v); setError(null); }}
                    placeholder="Full name"
                    placeholderTextColor="#334455"
                    autoCapitalize="words"
                    returnKeyType="next"
                  />
                </View>

                <View style={styles.inputGroup}>
                  <Text style={styles.label}>Username *</Text>
                  <TextInput
                    style={styles.input}
                    value={username}
                    onChangeText={v => { setUsername(v.toLowerCase()); setError(null); }}
                    placeholder="Choose a username"
                    placeholderTextColor="#334455"
                    autoCapitalize="none"
                    autoCorrect={false}
                    returnKeyType="next"
                  />
                </View>

                <View style={styles.inputGroup}>
                  <Text style={styles.label}>Birthday (optional)</Text>
                  <TextInput
                    style={styles.input}
                    value={birthday}
                    onChangeText={setBirthday}
                    placeholder="YYYY-MM-DD"
                    placeholderTextColor="#334455"
                    autoCapitalize="none"
                    returnKeyType="next"
                  />
                </View>

                <View style={styles.inputGroup}>
                  <Text style={styles.label}>Bio (optional)</Text>
                  <TextInput
                    style={[styles.input, { height: 60 }]}
                    value={bio}
                    onChangeText={setBio}
                    placeholder="Tell us about yourself"
                    placeholderTextColor="#334455"
                    multiline
                    textAlignVertical="top"
                  />
                </View>

                {/* Role selector */}
                <Text style={styles.label}>I am a...</Text>
                <View style={styles.roleList}>
                  {ROLES.map(r => (
                    <TouchableOpacity
                      key={r.value}
                      style={[styles.roleItem, role === r.value && styles.roleItemActive]}
                      onPress={() => setRole(r.value)}
                      activeOpacity={0.7}
                    >
                      <Text style={[styles.roleLabel, role === r.value && styles.roleLabelActive]}>
                        {r.label}
                      </Text>
                      <Text style={styles.roleDesc}>{r.desc}</Text>
                    </TouchableOpacity>
                  ))}
                </View>

                {/* Consent */}
                <View style={styles.consentCard}>
                  <View style={styles.consentRow}>
                    <Switch
                      value={consent}
                      onValueChange={v => { setConsent(v); setError(null); }}
                      thumbColor={consent ? '#00FF88' : '#556677'}
                      trackColor={{ false: '#1A2030', true: '#00FF8840' }}
                    />
                    <Text style={styles.consentTitle}>Share anonymised data for research</Text>
                  </View>
                  <Text style={styles.consentBody}>
                    Your EEG data (seizures + normal activity) will be used to improve seizure
                    detection AI. Data is stored securely, never sold, and linked only to your
                    anonymous patient ID. You can withdraw consent at any time in Settings.
                  </Text>
                </View>
              </>
            )}

            {/* Submit button */}
            <TouchableOpacity
              style={[styles.primaryBtn, loading && styles.btnDisabled]}
              onPress={handleSubmit}
              disabled={loading}
              activeOpacity={0.85}
            >
              {loading
                ? <ActivityIndicator size="small" color="#090915" />
                : <Text style={styles.primaryBtnText}>
                    {tab === 'login' ? 'Sign In' : 'Create Account'}
                  </Text>
              }
            </TouchableOpacity>

          </View>
        </ScrollView>
      </KeyboardAvoidingView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: '#090915' },
  flex: { flex: 1 },
  container: { flexGrow: 1, justifyContent: 'center', paddingHorizontal: 24, paddingVertical: 32, gap: 16 },
  header: { alignItems: 'center', gap: 8, marginBottom: 4 },
  logo: { width: 68, height: 68, marginBottom: 4 },
  title: { color: '#E8F0FF', fontSize: 26, fontWeight: '700', letterSpacing: 0.5 },
  subtitle: { color: '#334455', fontSize: 13, textAlign: 'center' },
  tabRow: { flexDirection: 'row', borderRadius: 12, borderWidth: 1, borderColor: '#1E2E44', overflow: 'hidden' },
  tab: { flex: 1, paddingVertical: 13, alignItems: 'center', backgroundColor: '#0D1220' },
  tabActive: { backgroundColor: '#0A1A30' },
  tabText: { color: '#445566', fontSize: 14, fontWeight: '600' },
  tabTextActive: { color: '#4499FF', fontWeight: '700' },
  card: { backgroundColor: '#0D1220', borderRadius: 16, borderWidth: 1, borderColor: '#1E2E44', padding: 20, gap: 14 },
  errorBox: { backgroundColor: '#FF664418', borderWidth: 1, borderColor: '#FF664450', borderRadius: 10, padding: 12 },
  errorText: { color: '#FF8866', fontSize: 13, textAlign: 'center', lineHeight: 18 },
  successBox: { backgroundColor: '#00FF8818', borderWidth: 1, borderColor: '#00FF8840', borderRadius: 10, padding: 12 },
  successText: { color: '#00FF88', fontSize: 13, textAlign: 'center', lineHeight: 18 },
  inputGroup: { gap: 5 },
  label: { color: '#556677', fontSize: 12, fontFamily: MONO },
  input: {
    backgroundColor: '#080D18', borderWidth: 1, borderColor: '#1E2E44', borderRadius: 10,
    paddingVertical: 13, paddingHorizontal: 14, color: '#E8F0FF', fontSize: 14, fontFamily: MONO,
  },
  roleList: { gap: 6 },
  roleItem: {
    borderWidth: 1, borderColor: '#1E2E44', borderRadius: 10,
    paddingVertical: 10, paddingHorizontal: 14, backgroundColor: '#080D18',
  },
  roleItemActive: { borderColor: '#4499FF55', backgroundColor: '#0A1A30' },
  roleLabel: { color: '#556677', fontSize: 14, fontWeight: '700' },
  roleLabelActive: { color: '#4499FF' },
  roleDesc: { color: '#334455', fontSize: 11, marginTop: 2 },
  consentCard: {
    backgroundColor: '#080D18', borderRadius: 10, borderWidth: 1,
    borderColor: '#1E2E44', padding: 14, gap: 10,
  },
  consentRow: { flexDirection: 'row', alignItems: 'center', gap: 12 },
  consentTitle: { color: '#AAB8CC', fontSize: 13, fontWeight: '600', flex: 1 },
  consentBody: { color: '#445566', fontSize: 12, lineHeight: 18 },
  primaryBtn: { backgroundColor: '#4499FF', borderRadius: 12, paddingVertical: 15, alignItems: 'center', marginTop: 2 },
  btnDisabled: { opacity: 0.5 },
  primaryBtnText: { color: '#090915', fontSize: 16, fontWeight: '700' },
});
