import {
  createElement,
  createContext,
  useCallback,
  useContext,
  useEffect,
  useState,
  type ReactNode,
} from 'react';
import AsyncStorage from '@react-native-async-storage/async-storage';
import Constants from 'expo-constants';
import type { UserRole } from '../services/supabaseClient';

const STORAGE_KEY = 'app_settings_v2';

const STALE_PLACEHOLDER = 'http://192.168.1.1:8000';

function autoDetectBackendUrl(): string {
  try {
    const hostUri: string | undefined =
      (Constants.expoConfig as any)?.hostUri ??
      (Constants.manifest  as any)?.debuggerHost ??
      (Constants.manifest2 as any)?.extra?.expoGo?.debuggerHost;

    if (hostUri) {
      const host = hostUri.split(':')[0];
      if (host && host !== 'localhost' && host !== '127.0.0.1') {
        return `http://${host}:8000`;
      }
    }
  } catch { /* ignore */ }
  return STALE_PLACEHOLDER;
}

export interface AppSettings {
  patientId            : string;
  patientName          : string;
  consentGiven         : boolean;
  consentDate          : string | null;
  serverBaseUrl        : string;
  inferenceIntervalMs  : number;
  helperPushToken      : string | null;
  // New fields synced from profile
  role                 : UserRole;
  consentToTrain       : boolean;
  generalModelConfig   : string;        // 'both' | 'prediction_only' | 'detection_only' | 'none'
  normalAlarmTime      : string | null;  // "HH:MM"
  alarmSoundEnabled    : boolean;
}

const DEFAULTS: AppSettings = {
  patientId            : '',
  patientName          : '',
  consentGiven         : false,
  consentDate          : null,
  serverBaseUrl        : autoDetectBackendUrl(),
  inferenceIntervalMs  : 4000,
  helperPushToken      : null,
  role                 : 'patient',
  consentToTrain       : true,
  generalModelConfig   : 'both',
  normalAlarmTime      : null,
  alarmSoundEnabled    : true,
};

// ── Context ────────────────────────────────────────────────────────────────────

interface AppSettingsContextValue {
  settings      : AppSettings;
  updateSettings: (partial: Partial<AppSettings>) => Promise<void>;
  loaded        : boolean;
}

const AppSettingsContext = createContext<AppSettingsContextValue | null>(null);

// ── Provider ───────────────────────────────────────────────────────────────────

export function AppSettingsProvider({ children }: { children: ReactNode }) {
  const [settings, setSettings] = useState<AppSettings>(DEFAULTS);
  const [loaded,   setLoaded  ] = useState(false);

  useEffect(() => {
    AsyncStorage.getItem(STORAGE_KEY).then(raw => {
      if (raw) {
        try {
          const saved = JSON.parse(raw) as Partial<AppSettings>;
          if (!saved.serverBaseUrl || saved.serverBaseUrl === STALE_PLACEHOLDER) {
            saved.serverBaseUrl = autoDetectBackendUrl();
          }
          setSettings({ ...DEFAULTS, ...saved });
        } catch {
          // corrupted - use defaults
        }
      }
      setLoaded(true);
    });
  }, []);

  const updateSettings = useCallback(async (partial: Partial<AppSettings>) => {
    setSettings(prev => {
      const next = { ...prev, ...partial };
      AsyncStorage.setItem(STORAGE_KEY, JSON.stringify(next));
      return next;
    });
  }, []);

  return createElement(
    AppSettingsContext.Provider,
    { value: { settings, updateSettings, loaded } },
    children,
  );
}

// ── Hook ───────────────────────────────────────────────────────────────────────

export function useAppSettings() {
  const ctx = useContext(AppSettingsContext);
  if (!ctx) throw new Error('useAppSettings must be used inside <AppSettingsProvider>');
  return ctx;
}
