import React, {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useState,
} from 'react';
import { AuthError, Session, User } from '@supabase/supabase-js';
import { supabase, UserProfile, UserRole } from './supabaseClient';
import { getExpoPushToken, scheduleNormalDataReminder } from './NotificationService';

export interface SignUpPayload {
  email   : string;
  password: string;
  fullName: string;
  username: string;
  birthday: string | null;
  bio     : string;
  role    : UserRole;
  consent : boolean;
}

interface AuthContextValue {
  session  : Session     | null;
  user     : User        | null;
  profile  : UserProfile | null;
  isLoading: boolean;

  signIn(email: string, password: string): Promise<AuthError | null>;
  signUp(payload: SignUpPayload): Promise<AuthError | null>;
  signOut(): Promise<void>;
  updateProfile(partial: Partial<UserProfile>): Promise<void>;
  fetchProfile(uid: string): Promise<void>;
}

const AuthContext = createContext<AuthContextValue | null>(null);

export function AuthProvider({ children }: { children: React.ReactNode }) {
  const [session,   setSession  ] = useState<Session     | null>(null);
  const [user,      setUser     ] = useState<User        | null>(null);
  const [profile,   setProfile  ] = useState<UserProfile | null>(null);
  const [isLoading, setIsLoading] = useState(true);

  const syncPushToken = useCallback(async (uid: string, existing: string | null) => {
    const token = await getExpoPushToken();
    if (!token || token === existing) return;
    const { error } = await supabase
      .from('profiles')
      .update({ expo_push_token: token })
      .eq('id', uid);
    if (error) {
      console.warn('[Auth] Failed to sync push token:', error.message);
    }
  }, []);

  const fetchProfile = useCallback(async (uid: string) => {
    const { data, error } = await supabase
      .from('profiles')
      .select('*')
      .eq('id', uid)
      .single();
    if (!error && data) {
      const prof = data as UserProfile;
      setProfile(prof);
      syncPushToken(uid, prof.expo_push_token ?? null).catch(() => {});
      scheduleNormalDataReminder(prof.normal_alarm_time).catch(() => {});
    } else {
      const authUser = (await supabase.auth.getUser()).data.user;
      const email = authUser?.email ?? '';
      const fallbackName = email.split('@')[0] || 'User';
      const { data: created, error: createErr } = await supabase
        .from('profiles')
        .insert({
          id                  : uid,
          patient_name        : fallbackName,
          full_name           : fallbackName,
          username            : fallbackName.toLowerCase().replace(/[^a-z0-9]/g, '') + '_' + uid.slice(0, 4),
          server_ip           : '',
          consent_given       : false,
          consent_to_train    : true,
          general_model_config: 'both',
          role                : 'patient',
          bio                 : '',
        })
        .select()
        .single();
      if (!createErr && created) {
        console.log('[Auth] Auto-created missing profile for', uid);
        setProfile(created as UserProfile);
        syncPushToken(uid, null).catch(() => {});
      } else {
        console.warn('[Auth] Failed to auto-create profile:', createErr?.message);
        setProfile(null);
      }
    }
  }, [syncPushToken]);

  useEffect(() => {
    supabase.auth.getSession().then(({ data: { session: s } }) => {
      setSession(s);
      setUser(s?.user ?? null);
      const uid = s?.user?.id;
      if (uid) {
        fetchProfile(uid).finally(() => setIsLoading(false));
      } else {
        setIsLoading(false);
      }
    });

    const { data: { subscription } } = supabase.auth.onAuthStateChange(
      (_event, s) => {
        setSession(s);
        setUser(s?.user ?? null);
        if (s?.user) {
          fetchProfile(s.user.id);
        } else {
          setProfile(null);
        }
      },
    );

    return () => subscription.unsubscribe();
  }, [fetchProfile]);

  const signIn = useCallback(async (
    email   : string,
    password: string,
  ): Promise<AuthError | null> => {
    const { error } = await supabase.auth.signInWithPassword({ email, password });
    return error;
  }, []);

  const signUp = useCallback(async (
    payload: SignUpPayload,
  ): Promise<AuthError | null> => {
    const { data, error } = await supabase.auth.signUp({
      email   : payload.email,
      password: payload.password,
    });
    if (error || !data.user) return error;

    const { error: insertError } = await supabase.from('profiles').insert({
      id                  : data.user.id,
      patient_name        : payload.fullName.trim(),
      full_name           : payload.fullName.trim(),
      username            : payload.username.trim().toLowerCase(),
      birthday            : payload.birthday,
      bio                 : payload.bio.trim(),
      role                : payload.role,
      server_ip           : '',
      consent_given       : payload.consent,
      consent_to_train    : payload.consent,
      data_usage_consent  : payload.consent,
      general_model_config: 'both',
    });

    if (insertError) {
      console.warn('[Auth] Profile insert failed:', insertError.message);
    }

    return null;
  }, []);

  const signOut = useCallback(async () => {
    await supabase.auth.signOut();
  }, []);

  const updateProfile = useCallback(async (
    partial: Partial<UserProfile>,
  ) => {
    if (!user) return;
    const { data, error } = await supabase
      .from('profiles')
      .update(partial)
      .eq('id', user.id)
      .select()
      .single();
    if (!error && data) {
      setProfile(data as UserProfile);
    }
  }, [user]);

  return (
    <AuthContext.Provider value={{
      session, user, profile, isLoading,
      signIn, signUp, signOut, updateProfile, fetchProfile,
    }}>
      {children}
    </AuthContext.Provider>
  );
}

export function useAuth(): AuthContextValue {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error('useAuth must be used inside <AuthProvider>');
  return ctx;
}
