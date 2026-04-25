import { useEffect } from 'react';

import { supabase } from '../services/supabaseClient';
import { useAppSettings } from './useAppSettings';

const SYSTEM_CONFIG_KEY = 'backend_url';
const PLACEHOLDER_URLS = new Set([
  'http://192.168.1.1:8000',
  'http://localhost:8000',
  'http://127.0.0.1:8000',
  '',
]);

function isPlaceholderUrl(url: string | undefined): boolean {
  return !url || PLACEHOLDER_URLS.has(url.trim());
}

async function fetchDiscoveredUrl(): Promise<string | null> {
  const { data, error } = await supabase
    .from('system_config')
    .select('value')
    .eq('key', SYSTEM_CONFIG_KEY)
    .maybeSingle();

  if (error) {
    return null;
  }

  return data?.value ?? null;
}

export function useServerDiscovery() {
  const { settings, updateSettings } = useAppSettings();

  useEffect(() => {
    let isMounted = true;
    const applyDiscoveredUrl = (url: string | null) => {
      if (!url || !isMounted) return;
      if (settings.serverBaseUrl === url) return;
      if (!isPlaceholderUrl(settings.serverBaseUrl)) return;
      updateSettings({ serverBaseUrl: url });
    };

    fetchDiscoveredUrl().then(applyDiscoveredUrl).catch(() => {});

    const channel = supabase
      .channel('system_config_backend_url')
      .on(
        'postgres_changes',
        {
          event : '*',
          schema: 'public',
          table : 'system_config',
          filter: 'key=eq.backend_url',
        },
        (payload) => {
          const rawPayload = payload as unknown as { new?: { value?: string }; record?: { value?: string } };
          const row = rawPayload.new ?? rawPayload.record;
          applyDiscoveredUrl(row?.value ?? null);
        },
      )
      .subscribe();

    return () => {
      isMounted = false;
      supabase.removeChannel(channel);
    };
  }, [settings.serverBaseUrl, updateSettings]);
}
