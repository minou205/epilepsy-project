import { useCallback, useEffect, useRef, useState } from 'react';
import { EEGSession } from './useEEGSession';

const RETRY_DELAY_MS    = 12_000;
const MAX_RETRIES       = 20;
const MANUAL_GUARD_MS   = 8_000;


export interface AutoConnectState {
  reconnecting    : boolean;
  retryCount      : number;
  lastError       : string | null;
  markManualConnect: () => void;
}

export function useAutoConnect(
  session : EEGSession,
  serverIp: string | null,
): AutoConnectState {

  const [reconnecting, setReconnecting] = useState(false);
  const [retryCount,   setRetryCount  ] = useState(0);
  const [lastError,    setLastError   ] = useState<string | null>(null);

  const serverIpRef        = useRef<string | null>(null);
  const retryCountRef      = useRef(0);
  const retryTimerRef      = useRef<ReturnType<typeof setTimeout> | null>(null);
  const manualGuardRef     = useRef(false);
  const manualGuardTimer   = useRef<ReturnType<typeof setTimeout> | null>(null);

  const markManualConnect = useCallback(() => {
    if (manualGuardTimer.current !== null) clearTimeout(manualGuardTimer.current);
    manualGuardRef.current = true;
    manualGuardTimer.current = setTimeout(() => {
      manualGuardRef.current = false;
      manualGuardTimer.current = null;
    }, MANUAL_GUARD_MS);
  }, []);

  const clearRetry = useCallback(() => {
    if (retryTimerRef.current !== null) {
      clearTimeout(retryTimerRef.current);
      retryTimerRef.current = null;
    }
  }, []);

  const attempt = useCallback(() => {
    const ip = serverIpRef.current;
    if (!ip) return;
    session.connect(ip);
  }, [session]);

  const scheduleRetry = useCallback(() => {
    clearRetry();
    retryCountRef.current += 1;
    if (retryCountRef.current > MAX_RETRIES) {
      setReconnecting(false);
      return;
    }
    setRetryCount(retryCountRef.current);
    retryTimerRef.current = setTimeout(attempt, RETRY_DELAY_MS);
  }, [attempt, clearRetry]);

  useEffect(() => {
    if (session.status === 'connected') {
      clearRetry();
      setReconnecting(false);
      setRetryCount(0);
      retryCountRef.current = 0;
      setLastError(null);
      manualGuardRef.current = false;
      if (manualGuardTimer.current !== null) {
        clearTimeout(manualGuardTimer.current);
        manualGuardTimer.current = null;
      }
      return;
    }

    if (
      session.status === 'error' &&
      serverIpRef.current         &&
      !manualGuardRef.current
    ) {
      setLastError(session.statusMessage);
      setReconnecting(true);
      scheduleRetry();
    }
  }, [session.status, session.statusMessage, scheduleRetry, clearRetry]);

  useEffect(() => {
    serverIpRef.current = serverIp;

    clearRetry();
    retryCountRef.current = 0;
    setRetryCount(0);
    setLastError(null);

    if (!serverIp) {
      setReconnecting(false);
      manualGuardRef.current = false;
      return;
    }

    if (session.status === 'connected' || session.status === 'connecting') return;

    if (manualGuardRef.current) return;

    setReconnecting(true);
    attempt();
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [serverIp]);

  useEffect(() => () => {
    clearRetry();
    if (manualGuardTimer.current !== null) clearTimeout(manualGuardTimer.current);
  }, [clearRetry]);

  return { reconnecting, retryCount, lastError, markManualConnect };
}
