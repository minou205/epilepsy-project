import AsyncStorage from '@react-native-async-storage/async-storage';
import { createClient } from '@supabase/supabase-js';

// ── Configuration ─────────────────────────────────────────────────────────────
// Get these from: Supabase Dashboard -> Settings -> API
//   * Project URL  -> SUPABASE_URL
//   * anon public  -> SUPABASE_ANON_KEY
export const SUPABASE_URL      = 'https://lgxybjdacsjzbmdsgoxo.supabase.co';
export const SUPABASE_ANON_KEY = 'sb_publishable_To2cxx8axCm8sluVV8g6lA_XefKPJlx';

// Dev-time guard: warn loudly if credentials are still placeholders.
if (__DEV__ && (
  SUPABASE_URL.includes('YOUR_PROJECT_ID') ||
  SUPABASE_ANON_KEY.includes('YOUR_ANON_PUBLIC_KEY')
)) {
  console.error(
    '\n\n  SUPABASE NOT CONFIGURED\n' +
    '   Open src/services/supabaseClient.ts and replace:\n' +
    '     SUPABASE_URL      -> your Project URL  (Settings -> API -> Project URL)\n' +
    '     SUPABASE_ANON_KEY -> your anon key     (Settings -> API -> anon public)\n\n',
  );
}

// ── Client ────────────────────────────────────────────────────────────────────
export const supabase = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
  auth: {
    storage           : AsyncStorage,
    autoRefreshToken  : true,
    persistSession    : true,
    detectSessionInUrl: false,
  },
});

// ── Profile type (mirrors the `profiles` table) ──────────────────────────────
export type UserRole = 'patient' | 'helper' | 'doctor' | 'supporter';

export interface UserProfile {
  id                          : string;   // UUID - FK -> auth.users.id
  patient_name                : string;   // legacy, kept for compat
  full_name                   : string;
  username                    : string;
  birthday                    : string | null;
  bio                         : string;
  role                        : UserRole;
  avatar_url                  : string | null;
  background_url              : string | null;
  server_ip                   : string;
  consent_given               : boolean;
  consent_to_train            : boolean;
  doctor_verified             : boolean;
  show_name_in_posts          : boolean;
  data_usage_consent          : boolean;
  normal_alarm_time           : string | null;   // "HH:MM"
  last_normal_collection      : string | null;   // ISO date
  general_model_config        : string;          // 'both' | 'prediction_only' | 'detection_only' | 'none'
  tracker_notifications_enabled: boolean;
  alarm_sound_enabled         : boolean;
  created_at                  : string;
}
