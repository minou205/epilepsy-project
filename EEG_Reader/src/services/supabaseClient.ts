import AsyncStorage from '@react-native-async-storage/async-storage';
import { createClient } from '@supabase/supabase-js';

export const SUPABASE_URL      = 'https://lgxybjdacsjzbmdsgoxo.supabase.co';
export const SUPABASE_ANON_KEY = 'sb_publishable_To2cxx8axCm8sluVV8g6lA_XefKPJlx';

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

export const supabase = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
  auth: {
    storage           : AsyncStorage,
    autoRefreshToken  : true,
    persistSession    : true,
    detectSessionInUrl: false,
  },
});

export type UserRole = 'patient' | 'helper' | 'doctor' | 'supporter';

export interface UserProfile {
  id                          : string;
  patient_name                : string;
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
  normal_alarm_time           : string | null;
  last_normal_collection      : string | null;
  general_model_config        : string;
  tracker_notifications_enabled: boolean;
  alarm_sound_enabled         : boolean;
  expo_push_token             : string | null;
  train_next_version          : boolean;
  created_at                  : string;
}
