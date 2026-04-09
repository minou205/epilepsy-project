import { useCallback, useEffect, useRef, useState } from 'react';
import { EEGSession } from './useEEGSession';

// ── Tuning constants ──────────────────────────────────────────────────────────
const RETRY_DELAY_MS    = 12_000;  // 12 s between reconnect attempts
const MAX_RETRIES       = 20;      // give up after 20 × 12 s ≈ 4 min
// How long to suppress auto-connect after a manual/QR connect fires.
// This covers the window between "QR scanned → session.connect()" and
// "updateProfile() resolves → serverIp changes → auto-connect effect fires".
const MANUAL_GUARD_MS   = 8_000;

// ── Public API ────────────────────────────────────────────────────────────────

export interface AutoConnectState {
  /** True while the hook is actively trying to (re)connect. */
  reconnecting    : boolean;
  /** Number of failed attempts since the last clean connect. */
  retryCount      : number;
  /** Status message from the last failed attempt, or null. */
  lastError       : string | null;
  /**
   * Call this BEFORE session.connect() from handleQRScanned or any manual
   * connect button.  It suppresses the auto-connect retry logic for
   * MANUAL_GUARD_MS so the two don't race each other.
   */
  markManualConnect: () => void;
}

/**
 * Zero-touch auto-connect.
 *
 * When a `serverIp` is available from the Supabase profile this hook
 * immediately calls `session.connect(serverIp)`.  If the simulator is
 * offline it silently retries every RETRY_DELAY_MS milliseconds and
 * exposes a `reconnecting` flag so the UI can show a subtle banner.
 *
 * The retry loop stops when:
 *   • The session becomes 'connected'.
 *   • `serverIp` changes to null (user signed out).
 *   • MAX_RETRIES is exceeded.
 */
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
  // FIX: Guard flag — set by markManualConnect(), cleared after MANUAL_GUARD_MS
  // or when the session reaches 'connected'. Prevents the auto-connect
  // effect from firing (and overriding) a manual/QR-triggered connection.
  const manualGuardRef     = useRef(false);
  const manualGuardTimer   = useRef<ReturnType<typeof setTimeout> | null>(null);

  // ── markManualConnect ──────────────────────────────────────────────────────

  const markManualConnect = useCallback(() => {
    // Clear any running guard timer and set a fresh one.
    if (manualGuardTimer.current !== null) clearTimeout(manualGuardTimer.current);
    manualGuardRef.current = true;
    manualGuardTimer.current = setTimeout(() => {
      manualGuardRef.current = false;
      manualGuardTimer.current = null;
    }, MANUAL_GUARD_MS);
  }, []);

  // ── Helpers ────────────────────────────────────────────────────────────────

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

  // ── React to session.status ────────────────────────────────────────────────

  useEffect(() => {
    if (session.status === 'connected') {
      clearRetry();
      setReconnecting(false);
      setRetryCount(0);
      retryCountRef.current = 0;
      setLastError(null);
      // Connected — the manual guard is no longer needed.
      manualGuardRef.current = false;
      if (manualGuardTimer.current !== null) {
        clearTimeout(manualGuardTimer.current);
        manualGuardTimer.current = null;
      }
      return;
    }

    // Only schedule a retry on 'error' when we have an IP to try AND
    // we are not in the middle of a manual/QR connect attempt.
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

  // ── React to serverIp changes (new login / QR scan / profile update) ──────

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

    // Don't disrupt an already-live connection.
    if (session.status === 'connected' || session.status === 'connecting') return;

    // FIX: Don't fire an auto-connect attempt if a manual/QR connect was
    // just triggered — it is still in flight and we must not clobber it
    // by calling session.connect() with a bare IP (missing ws:// and port).
    if (manualGuardRef.current) return;

    setReconnecting(true);
    attempt();
  // session.status intentionally excluded — only re-fire on IP change.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [serverIp]);

  // ── Cleanup ────────────────────────────────────────────────────────────────

  useEffect(() => () => {
    clearRetry();
    if (manualGuardTimer.current !== null) clearTimeout(manualGuardTimer.current);
  }, [clearRetry]);

  return { reconnecting, retryCount, lastError, markManualConnect };
}