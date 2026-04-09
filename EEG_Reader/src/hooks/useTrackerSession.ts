import { useState, useRef, useCallback, useEffect } from 'react';
import { Alert } from 'react-native';
import { EEGSession } from './useEEGSession';
import { AppSettings } from './useAppSettings';
import { TrackerStatus, AlarmEvent, ModelTier } from '../types/tracker';
import { SignalChecker } from '../services/SignalChecker';
import { requestInference, ServerInferenceResult } from '../services/InferenceClient';
import {
  collectSeizureData,
  collectNormalData as collectNormalDataPackage,
  collectFalsePositiveData,
} from '../services/DataCollector';
import { BackendClient, HeadsetMismatchError } from '../services/BackendClient';
import {
  HeadsetInfo,
  fetchHeadset,
  resetHeadset,
} from '../services/HeadsetClient';
import {
  scheduleSeizureButtonNotification,
  cancelSeizureButtonNotification,
  triggerAlarmNotification,
} from '../services/NotificationService';
import {
  saveAlarmToArchive,
  syncAlarmToBackend,
  ArchivedAlarm,
} from '../services/ArchiveStorage';

// ── Model channel contract ──────────────────────────────────────────────────
// Default 18-channel layout used when no patient headset has been registered.
// Once the patient registers a headset, that headset's exact channel list
// (any count between 9 and 18) becomes the source of truth.
const CHANNELS_18 = [
  // Left temporal chain
  'FP1-F7', 'F7-T7', 'T7-P7', 'P7-O1',
  // Right temporal chain
  'FP2-F8', 'F8-T8', 'T8-P8', 'P8-O2',
  // Left parasagittal chain
  'FP1-F3', 'F3-C3', 'C3-P3', 'P3-O1',
  // Right parasagittal chain
  'FP2-F4', 'F4-C4', 'C4-P4', 'P4-O2',
  // Midline
  'FZ-CZ',  'CZ-PZ',
] as const;

// Model input: [18, 1280] — 1280 samples = 5 seconds at 256 Hz
const DEFAULT_WINDOW_SECS = 5;

// ── Adapter: channel-agnostic → fixed 18-channel model input ───────────────
/**
 * Maps an arbitrary incoming stream (N channels, any labels) to the fixed
 * 18-channel layout the model expects. Returns number[][] for HTTP transport.
 *
 * - Channels present in the stream are looked up case-insensitively.
 * - Missing channels → zero-padding.
 */
function mapToModel(
  getLongBuffer  : (ch: string, secs: number) => Float32Array | null,
  incomingLabels : string[],
  targetLabels   : readonly string[],
  windowSecs     : number,
  samplingRate   : number,
): number[][] {
  const windowSamples = windowSecs * samplingRate;
  const out: number[][] = [];

  // Case-insensitive reverse lookup
  const upperMap = new Map(incomingLabels.map(l => [l.toUpperCase(), l]));

  for (let ti = 0; ti < targetLabels.length; ti++) {
    const row = new Array<number>(windowSamples).fill(0);
    const match = upperMap.get(targetLabels[ti].toUpperCase());

    if (match) {
      const snap = getLongBuffer(match, windowSecs);
      if (snap && snap.length > 0) {
        if (snap.length >= windowSamples) {
          // Full window: copy the most-recent windowSamples
          for (let i = 0; i < windowSamples; i++) {
            row[i] = snap[snap.length - windowSamples + i];
          }
        } else {
          // Partial data: right-align so the most-recent samples are at the end
          const offset = windowSamples - snap.length;
          for (let i = 0; i < snap.length; i++) {
            row[offset + i] = snap[i];
          }
        }
      }
    }

    out.push(row);
  }

  return out;
}

// ── Helpers ─────────────────────────────────────────────────────────────────

function generateId(): string {
  return `${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;
}

function buildAlarmMessage(
  type: 'prediction' | 'detection',
  tier: ModelTier,
): string {
  const weak =
    " (the general models are so weak, don't rely on them 100% but be careful)";
  if (type === 'prediction') {
    return tier === 'general'
      ? `We predicted a seizure in around 15 minutes${weak}`
      : 'We predicted a seizure in around 15 minutes';
  } else {
    return tier === 'general'
      ? `We detected a seizure happening RIGHT NOW${weak}`
      : 'We detected a seizure happening RIGHT NOW';
  }
}

// ── Public API type ──────────────────────────────────────────────────────────

export interface TrackerSessionAPI {
  status              : TrackerStatus;
  statusMessage       : string;
  currentTier         : ModelTier;
  currentModelVersion : string;
  activeAlarm         : AlarmEvent | null;
  alarmHistory        : AlarmEvent[];
  isSignalLost        : boolean;
  predictorHistory    : number[];
  detectorHistory     : number[];
  /** true when satisfaction modal should show */
  showSatisfaction    : boolean;
  satisfactionCount   : number;
  /** true while collecting 30-min normal data */
  collectingNormal    : boolean;
  /** Locked headset for this patient (null until first upload registers it). */
  headset             : HeadsetInfo | null;
  /** Set when an upload was rejected because channels don't match the locked headset. */
  headsetMismatch     : { expected: string[]; got: string[] } | null;

  start               : () => void;
  stop                : () => void;
  reportSeizure       : () => void;
  collectNormalData   : () => void;
  dismissAlarm        : () => void;
  confirmAlarm        : (alarmId: string, confirmed: boolean) => void;
  rateAlarm           : (alarmId: string, rating: number) => void;
  markFalseAlarm      : (alarmId: string) => Promise<void>;
  onSatisfactionAnswer: (satisfied: boolean) => void;
  /** Dismiss the mismatch banner without changing the registered headset. */
  clearHeadsetMismatch: () => void;
  /** User confirmed they swapped headsets — wipe data + lock so next upload re-registers. */
  confirmHeadsetReset : () => Promise<void>;
}

// ── Hook ─────────────────────────────────────────────────────────────────────

export function useTrackerSession(
  eegSession  : EEGSession,
  appSettings : AppSettings,
): TrackerSessionAPI {

  const [status,            setStatus           ] = useState<TrackerStatus>('idle');
  const [statusMessage,     setStatusMessage    ] = useState('Waiting for EEG connection...');
  const [currentTier,       setCurrentTier      ] = useState<ModelTier>('none');
  const [activeAlarm,       setActiveAlarm      ] = useState<AlarmEvent | null>(null);
  const [alarmHistory,      setAlarmHistory     ] = useState<AlarmEvent[]>([]);
  const [isSignalLost,      setIsSignalLost     ] = useState(false);
  const [predictorHistory,  setPredictorHistory ] = useState<number[]>([]);
  const [detectorHistory,   setDetectorHistory  ] = useState<number[]>([]);
  const [showSatisfaction,  setShowSatisfaction ] = useState(false);
  const [satisfactionCount, setSatisfactionCount] = useState(0);
  const [collectingNormal,  setCollectingNormal ] = useState(false);
  const [headset,           setHeadset          ] = useState<HeadsetInfo | null>(null);
  const [headsetMismatch,   setHeadsetMismatch  ] = useState<{ expected: string[]; got: string[] } | null>(null);

  const loopRef           = useRef<ReturnType<typeof setInterval> | null>(null);
  const tierRef           = useRef<ModelTier>('none');
  const checkerRef        = useRef<SignalChecker | null>(null);
  const isRunningRef      = useRef(false);
  const activeAlarmRef    = useRef<AlarmEvent | null>(null);
  const errorCountRef     = useRef(0);
  const userWantsRunning  = useRef(false); // true after user presses START
  const runInferenceRef   = useRef<() => void>(() => {});
  const settingsRef       = useRef(appSettings);
  settingsRef.current     = appSettings;
  const headsetRef        = useRef<HeadsetInfo | null>(null);
  headsetRef.current      = headset;
  const MAX_SILENT_ERRORS = 3; // show error after this many consecutive failures

  // Alarm recording: accumulates probability traces while an alarm is active
  const alarmRecordingRef = useRef<{
    alarmId        : string;
    alarmEvent     : AlarmEvent;          // snapshot — avoids stale closure in timers
    predictorProbs : number[];
    detectorProbs  : number[];
    timestamps     : number[];
    autoNoTimer    : ReturnType<typeof setTimeout> | null;
    confirmTimer   : ReturnType<typeof setTimeout> | null;
  } | null>(null);

  const MAX_HISTORY_POINTS = 60; // ~5 min at 5s intervals

  // ── Signal checker ─────────────────────────────────────────────────────────

  useEffect(() => {
    checkerRef.current = new SignalChecker(eegSession, (lost) => {
      setIsSignalLost(lost);
      if (lost && isRunningRef.current) {
        setStatus('signal_lost');
        setStatusMessage('Signal lost — please check your headset');
        stopLoop();
      } else if (!lost && status === 'signal_lost' && userWantsRunning.current) {
        setStatusMessage('Signal recovered — resuming tracking...');
        startLoop();
      } else if (!lost && status === 'signal_lost') {
        setStatus('ready');
        setStatusMessage('Signal recovered — press START to resume');
      }
    });
    return () => checkerRef.current?.destroy();
  }, [eegSession]);

  // ── Inference loop ─────────────────────────────────────────────────────────

  function stopLoop() {
    if (loopRef.current) { clearInterval(loopRef.current); loopRef.current = null; }
    isRunningRef.current = false;
  }

  const runInference = useCallback(async () => {
    if (!eegSession.config) return;

    const { patientId, serverBaseUrl } = appSettings;
    if (!patientId || !serverBaseUrl) return;

    const sr             = eegSession.config.samplingRate;
    const incomingLabels = eegSession.config.channels;

    // Use the patient's locked headset channel list if available; otherwise
    // fall back to the default 18-channel layout (for first-run / general model).
    const targetLabels: readonly string[] =
      headsetRef.current?.channelNames && headsetRef.current.channelNames.length > 0
        ? headsetRef.current.channelNames
        : CHANNELS_18;

    // Build [E][1280] from the long buffer
    const eegData = mapToModel(
      eegSession.getLongBufferSnapshot,
      incomingLabels,
      targetLabels,
      DEFAULT_WINDOW_SECS,
      sr,
    );

    try {
      const result: ServerInferenceResult = await requestInference(
        serverBaseUrl,
        patientId,
        eegData,
        appSettings.generalModelConfig ?? 'both',
      );

      // Reset error count on success
      errorCountRef.current = 0;

      const tier = result.tier as ModelTier;
      tierRef.current = tier;
      setCurrentTier(tier);

      // Append probabilities to history
      if (result.predictorProb !== null) {
        setPredictorHistory(prev => {
          const next = [...prev, result.predictorProb!];
          return next.length > MAX_HISTORY_POINTS ? next.slice(-MAX_HISTORY_POINTS) : next;
        });
      }
      if (result.detectorProb !== null) {
        setDetectorHistory(prev => {
          const next = [...prev, result.detectorProb!];
          return next.length > MAX_HISTORY_POINTS ? next.slice(-MAX_HISTORY_POINTS) : next;
        });
      }

      // Record to active alarm trace if one is recording
      if (alarmRecordingRef.current) {
        alarmRecordingRef.current.predictorProbs.push(result.predictorProb ?? 0);
        alarmRecordingRef.current.detectorProbs.push(result.detectorProb ?? 0);
        alarmRecordingRef.current.timestamps.push(Date.now());
      }

      // Check alarm thresholds (only fire if no active alarm)
      if (!activeAlarmRef.current) {
        // The backend has already performed sustained alarm detection!
        // Trust the labels it returns:
        // - predictorLabel='preictal' → backend determined DELTA0_S=30 seconds sustained
        // - detectorLabel='ictal' → backend determined DELTA0_S=3 seconds sustained
        // No need for client-side double-checking.
        
        if (result.predictorLabel === 'preictal') {
          fireAlarm('prediction', tier);
        } else if (result.detectorLabel === 'ictal') {
          fireAlarm('detection', tier);
        } else {
          // Build accurate status message based on what models are active
          const tierLabel = tier === 'general' ? 'General (weak)'
                         : tier === 'none'    ? 'No models'
                         : `Personal ${tier.toUpperCase()}`;
          let modelInfo = '';
          if (result.hasPredictor && result.hasDetector) {
            modelInfo = ' (prediction + detection)';
          } else if (result.hasPredictor) {
            modelInfo = ' (prediction only)';
          } else if (result.hasDetector) {
            modelInfo = ' (detection only)';
          }
          setStatus('running');
          setStatusMessage(`Tracking active — ${tierLabel}${modelInfo}`);
        }
      }
    } catch (err: any) {
      errorCountRef.current += 1;
      console.error(`[Tracker] Inference error (#${errorCountRef.current}):`, err?.message ?? err);

      if (errorCountRef.current >= MAX_SILENT_ERRORS) {
        // Show user-visible error after repeated failures
        const msg = err?.message?.includes('Network request failed')
          ? 'Backend unreachable — check server connection'
          : `Inference error — ${(err?.message ?? 'unknown error').slice(0, 60)}`;
        setStatusMessage(msg);
        setStatus('running'); // keep loop alive, just show error
      }
      // Keep the loop running — next cycle may succeed
    }
  }, [eegSession, appSettings]);

  // Keep ref current so setInterval always calls the latest version
  runInferenceRef.current = runInference;

  // ── Fire alarm ─────────────────────────────────────────────────────────────

  function fireAlarm(type: 'prediction' | 'detection', tier: ModelTier) {
    const deadline = type === 'prediction' ? 60 * 60 * 1000 : 60 * 1000; // 1h or 1m
    const confirmDelay = type === 'prediction' ? 15 * 60 * 1000 : 0;     // 15m or immediate

    const event: AlarmEvent = {
      id                  : generateId(),
      type,
      tier,
      message             : buildAlarmMessage(type, tier),
      timestamp           : Date.now(),
      confirmationDeadline: Date.now() + deadline,
      confirmed           : null,
      probabilityTrace    : { predictorProbs: [], detectorProbs: [], timestamps: [] },
      rating              : null,
    };

    activeAlarmRef.current = event;
    setActiveAlarm(event);
    setAlarmHistory(prev => [event, ...prev]);
    setStatus(type === 'prediction' ? 'alarm_predict' : 'alarm_detect');

    // Start recording probabilities for this alarm
    alarmRecordingRef.current = {
      alarmId       : event.id,
      alarmEvent    : event,
      predictorProbs: [],
      detectorProbs : [],
      timestamps    : [],
      autoNoTimer   : setTimeout(() => autoRespondNo(event.id), deadline),
      confirmTimer  : confirmDelay > 0
        ? setTimeout(() => sendConfirmNotification(event.id, type), confirmDelay)
        : null,
    };

    // Immediate notification for detection, delayed for prediction
    if (type === 'detection') {
      sendConfirmNotification(event.id, type);
    }

    // Only play alarm sound if the user hasn't disabled it in settings
    if (settingsRef.current.alarmSoundEnabled !== false) {
      triggerAlarmNotification(type, event.message).catch(() => {/* ignore */});
    }

    // Notify helpers (only for personal models)
    if (tier !== 'general' && tier !== 'none') {
      const { patientId, serverBaseUrl } = appSettings;
      if (patientId && serverBaseUrl) {
        new BackendClient(serverBaseUrl)
          .sendHelperAlarm(patientId, type)
          .catch(err => console.error('[Tracker] Helper alarm failed:', err));
      }
    }
  }

  function sendConfirmNotification(_alarmId: string, alarmType: 'prediction' | 'detection' = 'detection') {
    if (settingsRef.current.alarmSoundEnabled === false) return;
    triggerAlarmNotification(alarmType, 'Did you have a seizure? Please confirm in the app.')
      .catch(() => {/* ignore */});
  }

  function autoRespondNo(alarmId: string) {
    resolveAlarm(alarmId, false);
  }

  // ── Resolve alarm (confirm or deny) ────────────────────────────────────────

  const resolveAlarm = useCallback(async (alarmId: string, confirmed: boolean) => {
    const recording = alarmRecordingRef.current;
    if (!recording || recording.alarmId !== alarmId) return;

    // Clear timers
    if (recording.autoNoTimer)  clearTimeout(recording.autoNoTimer);
    if (recording.confirmTimer) clearTimeout(recording.confirmTimer);

    // Build final trace
    const trace = {
      predictorProbs: recording.predictorProbs,
      detectorProbs : recording.detectorProbs,
      timestamps    : recording.timestamps,
    };

    alarmRecordingRef.current = null;

    // Update alarm in state
    const updater = (a: AlarmEvent) =>
      a.id === alarmId ? { ...a, confirmed, probabilityTrace: trace } : a;

    setAlarmHistory(prev => prev.map(updater));
    setActiveAlarm(prev => {
      if (prev?.id === alarmId) {
        const updated = { ...prev, confirmed, probabilityTrace: trace };
        activeAlarmRef.current = null;
        return updated;
      }
      return prev;
    });

    if (isRunningRef.current) {
      setStatus('running');
      setStatusMessage('Tracking active — alarm resolved');
    }

    // Find the alarm event for archiving
    const alarm = activeAlarmRef.current ?? alarmHistory.find(a => a.id === alarmId);
    if (!alarm) return;

    // Archive locally
    const archived: ArchivedAlarm = {
      id       : alarmId,
      type     : alarm.type,
      tier     : alarm.tier,
      timestamp: alarm.timestamp,
      confirmed,
      probabilityTrace: trace,
    };

    const { patientId, serverBaseUrl } = appSettings;
    if (patientId) {
      saveAlarmToArchive(patientId, archived).catch(err =>
        console.warn('[Tracker] Local archive save failed:', err));

      if (serverBaseUrl) {
        syncAlarmToBackend(serverBaseUrl, { ...archived, patientId }).catch(err =>
          console.warn('[Tracker] Backend archive sync failed:', err));
      }
    }
  }, [appSettings, alarmHistory]);

  // ── Track EEG connection state ──────────────────────────────────────────────
  // When connected → show "ready" so user can press START.
  // When disconnected while running → stop the loop and inform the user.
  // If user previously pressed START and reconnects → auto-resume.

  useEffect(() => {
    const connected  = eegSession.status === 'connected';
    const hasServer  = !!appSettings.serverBaseUrl;
    const hasPatient = !!appSettings.patientId;

    if (connected && hasServer && hasPatient) {
      if (userWantsRunning.current && !isRunningRef.current) {
        // Auto-resume: user pressed START before, connection recovered
        startLoop();
      } else if (!userWantsRunning.current && !isRunningRef.current) {
        setStatus('ready');
        setStatusMessage('Connected — press START to begin tracking');
      }
    } else if (!connected && isRunningRef.current) {
      // Connection lost while running
      stopLoop();
      cancelSeizureButtonNotification().catch(() => {/* ignore */});
      setStatus('idle');
      setStatusMessage('EEG disconnected — tracking stopped');
      setPredictorHistory([]);
      setDetectorHistory([]);
      // Keep userWantsRunning true so we auto-resume on reconnect
    } else if (!connected) {
      setStatus('idle');
      setStatusMessage('Waiting for EEG connection...');
    }
  }, [eegSession.status, appSettings.serverBaseUrl, appSettings.patientId]);

  // ── Headset auto-fetch on EEG connection ──────────────────────────────────
  // When the EEG simulator connects (and we know who the patient is), fetch
  // the locked headset from the backend. If one exists, push its channel list
  // to the simulator so only those channels stream — guaranteeing every
  // upload matches the locked layout.

  useEffect(() => {
    if (eegSession.status !== 'connected') return;
    if (!appSettings.patientId || !appSettings.serverBaseUrl) return;

    let cancelled = false;
    fetchHeadset(appSettings.serverBaseUrl, appSettings.patientId)
      .then(info => {
        if (cancelled) return;
        setHeadset(info);
        if (info && info.channelNames.length > 0) {
          eegSession.selectChannels(info.channelNames);
        }
      })
      .catch(err => {
        console.warn('[Tracker] fetchHeadset failed:', err?.message ?? err);
      });

    return () => { cancelled = true; };
  }, [eegSession.status, appSettings.patientId, appSettings.serverBaseUrl]);

  const refreshHeadset = useCallback(async () => {
    const { patientId, serverBaseUrl } = appSettings;
    if (!patientId || !serverBaseUrl) return;
    try {
      const info = await fetchHeadset(serverBaseUrl, patientId);
      setHeadset(info);
      if (info && info.channelNames.length > 0) {
        eegSession.selectChannels(info.channelNames);
      }
    } catch (err: any) {
      console.warn('[Tracker] refreshHeadset failed:', err?.message ?? err);
    }
  }, [appSettings, eegSession]);

  // ── Start / Stop helpers ──────────────────────────────────────────────────

  function startLoop() {
    if (isRunningRef.current) return;
    isRunningRef.current = true;
    errorCountRef.current = 0;
    setStatus('running');
    setStatusMessage('Tracking started...');
    scheduleSeizureButtonNotification().catch(() => {/* ignore */});
    // Use ref so the interval always calls the latest runInference closure
    loopRef.current = setInterval(
      () => runInferenceRef.current(),
      settingsRef.current.inferenceIntervalMs,
    );
  }

  // Cleanup on unmount
  useEffect(() => {
    return () => {
      stopLoop();
      if (alarmRecordingRef.current?.autoNoTimer) {
        clearTimeout(alarmRecordingRef.current.autoNoTimer);
      }
      if (alarmRecordingRef.current?.confirmTimer) {
        clearTimeout(alarmRecordingRef.current.confirmTimer);
      }
    };
  }, []);

  // ── Public API ─────────────────────────────────────────────────────────────

  const start = useCallback(() => {
    if (!eegSession.config || eegSession.status !== 'connected') {
      Alert.alert('Not Connected', 'Please connect to the EEG headset first.');
      return;
    }
    if (!appSettings.serverBaseUrl || !appSettings.patientId) {
      Alert.alert('Setup Required', 'Please set Patient ID and Server URL in Settings.');
      return;
    }
    userWantsRunning.current = true;
    startLoop();
  }, [eegSession, appSettings, runInference]);

  const stop = useCallback(() => {
    userWantsRunning.current = false;
    stopLoop();
    cancelSeizureButtonNotification().catch(() => {/* ignore */});
    setStatus('stopped');
    setStatusMessage('Tracking stopped by user.');
    setPredictorHistory([]);
    setDetectorHistory([]);
  }, []);

  const reportSeizure = useCallback(async () => {
    if (!eegSession.config) {
      Alert.alert('Not Connected', 'No EEG session active. Please connect to the headset first.');
      return;
    }

    const { patientId, serverBaseUrl, consentGiven } = appSettings;

    if (!patientId) {
      Alert.alert('Patient ID Required', 'Please set your Patient ID in Settings before reporting a seizure.');
      return;
    }
    if (!consentGiven) {
      Alert.alert('Consent Required', 'Please enable data sharing in Settings to collect seizure data.');
      return;
    }
    if (!serverBaseUrl) {
      Alert.alert('Server URL Missing', 'Please set the Backend URL in Settings.');
      return;
    }

    const sr = eegSession.config.samplingRate;
    setStatusMessage('Collecting seizure data...');

    const pkg = await collectSeizureData(
      eegSession.getLongBufferSnapshot,
      eegSession.config.channels,
      sr,
      patientId,
    );

    if (!pkg) {
      Alert.alert(
        'No Data Yet',
        'No EEG data has been recorded yet. Keep the headset connected for at least a few seconds, then try again.',
      );
      setStatusMessage('Seizure report failed — no EEG data recorded yet');
      return;
    }

    const capturedMins = Math.round(
      Math.min(eegSession.longBufferReadySecs, 21 * 60) / 60
    );
    setStatusMessage('Uploading seizure data...');
    try {
      const client = new BackendClient(serverBaseUrl);
      const resp = await client.uploadSeizureData(pkg);
      setStatusMessage('Seizure data uploaded successfully.');

      // First successful upload (or any subsequent one) — refresh the
      // locked headset so the UI shows what's actually registered.
      refreshHeadset().catch(() => {/* ignore */});

      // Check if satisfaction modal should show
      if (resp.ask_satisfaction) {
        setSatisfactionCount(resp.seizure_count);
        setShowSatisfaction(true);
      }

      const maxMsg = resp.max_reached
        ? '\n\nMaximum seizure data limit reached — no more data collection needed.'
        : '';

      Alert.alert(
        'Uploaded',
        (capturedMins >= 21
          ? 'Full 21 minutes of seizure data sent to the server.'
          : `${capturedMins} minute${capturedMins !== 1 ? 's' : ''} of EEG data sent.\nPartial data is still useful for training.`)
        + (resp.training_queued ? '\n\nNew model training has been queued!' : '')
        + maxMsg,
      );
    } catch (err) {
      if (err instanceof HeadsetMismatchError) {
        setHeadsetMismatch({ expected: err.expected, got: err.got });
        setStatusMessage('Headset mismatch — upload rejected.');
        return;
      }
      console.error('[Tracker] Failed to upload seizure data:', err);
      setStatusMessage('Upload failed — check server connection.');
      Alert.alert('Upload Failed', 'Seizure data was saved locally but could not reach the server.');
    }
  }, [eegSession, appSettings, refreshHeadset]);

  const collectNormalData = useCallback(async () => {
    if (!eegSession.config) {
      Alert.alert('Not Connected', 'No EEG session active. Please connect first.');
      return;
    }

    const { patientId, serverBaseUrl } = appSettings;
    if (!patientId || !serverBaseUrl) {
      Alert.alert('Setup Required', 'Please set Patient ID and Server URL in Settings.');
      return;
    }

    setCollectingNormal(true);
    setStatus('collecting_normal');
    setStatusMessage('Collecting normal EEG data (using buffered data)...');

    try {
      const pkg = await collectNormalDataPackage(
        eegSession.getLongBufferSnapshot,
        eegSession.config.channels,
        eegSession.config.samplingRate,
        patientId,
      );

      if (!pkg) {
        Alert.alert('Not Enough Data', 'Not enough EEG data buffered yet. Keep the headset connected and try again later.');
        setStatusMessage('Normal data collection failed — not enough data');
        setCollectingNormal(false);
        if (isRunningRef.current) setStatus('running');
        else setStatus('idle');
        return;
      }

      setStatusMessage('Uploading normal EEG data...');
      const client = new BackendClient(serverBaseUrl);
      await client.uploadNormalData(pkg);

      setStatusMessage('Normal data uploaded successfully.');
      refreshHeadset().catch(() => {/* ignore */});
      Alert.alert('Success', 'Normal EEG data collected and uploaded to the server.');
    } catch (err) {
      if (err instanceof HeadsetMismatchError) {
        setHeadsetMismatch({ expected: err.expected, got: err.got });
        setStatusMessage('Headset mismatch — upload rejected.');
      } else {
        console.error('[Tracker] Normal data collection failed:', err);
        setStatusMessage('Normal data upload failed — check server connection.');
        Alert.alert('Upload Failed', 'Normal data was saved locally but could not reach the server.');
      }
    } finally {
      setCollectingNormal(false);
      if (isRunningRef.current) setStatus('running');
      else setStatus('idle');
    }
  }, [eegSession, appSettings, refreshHeadset]);

  const dismissAlarm = useCallback(() => {
    activeAlarmRef.current = null;
    setActiveAlarm(null);
    if (isRunningRef.current) {
      setStatus('running');
      setStatusMessage('Tracking active — alarm dismissed');
    }
  }, []);

  const confirmAlarm = useCallback((alarmId: string, confirmed: boolean) => {
    resolveAlarm(alarmId, confirmed);

    if (confirmed) {
      // User confirmed a real seizure — collect seizure data
      reportSeizure();
    }
  }, [resolveAlarm, reportSeizure]);

  const rateAlarm = useCallback((alarmId: string, rating: number) => {
    setAlarmHistory(prev =>
      prev.map(a => a.id === alarmId ? { ...a, rating } : a)
    );
    setActiveAlarm(prev =>
      prev?.id === alarmId ? { ...prev, rating } : prev
    );
  }, []);

  const markFalseAlarm = useCallback(async (alarmId: string) => {
    // Mark as false alarm + resolve as not confirmed
    setAlarmHistory(prev =>
      prev.map(a => a.id === alarmId ? { ...a, isFalseAlarm: true, confirmed: false } : a)
    );
    setActiveAlarm(prev =>
      prev?.id === alarmId ? { ...prev, isFalseAlarm: true, confirmed: false } : prev
    );

    resolveAlarm(alarmId, false);

    if (!eegSession.config || !appSettings.patientId || !appSettings.serverBaseUrl) return;

    const alarm = activeAlarmRef.current ?? alarmHistory.find(a => a.id === alarmId);
    if (!alarm) return;

    const { patientId, serverBaseUrl } = appSettings;
    const { samplingRate, channels }   = eegSession.config;

    try {
      const pkg = await collectFalsePositiveData(
        eegSession.getLongBufferSnapshot,
        channels,
        samplingRate,
        patientId,
        alarmId,
        alarm.type,
        alarm.tier,
      );

      if (pkg) {
        await new BackendClient(serverBaseUrl).uploadFalsePositive(pkg);
        console.log('[Tracker] False positive uploaded — EEG segment sent for retraining.');
      }
    } catch (err) {
      if (err instanceof HeadsetMismatchError) {
        setHeadsetMismatch({ expected: err.expected, got: err.got });
        return;
      }
      console.error('[Tracker] False alarm upload failed:', err);
    }
  }, [eegSession, appSettings, alarmHistory, resolveAlarm]);

  const onSatisfactionAnswer = useCallback((satisfied: boolean) => {
    setShowSatisfaction(false);
    // The actual profile update (consent_to_train = false) is handled
    // by the parent component that controls the satisfaction modal
  }, []);

  // ── Headset mismatch actions ───────────────────────────────────────────────

  const clearHeadsetMismatch = useCallback(() => {
    setHeadsetMismatch(null);
  }, []);

  const confirmHeadsetReset = useCallback(async () => {
    const { patientId, serverBaseUrl } = appSettings;
    if (!patientId || !serverBaseUrl) {
      setHeadsetMismatch(null);
      return;
    }
    try {
      await resetHeadset(serverBaseUrl, patientId);
      setHeadset(null);
      setHeadsetMismatch(null);
      setStatusMessage('Headset reset — next recording will register your new headset.');
      Alert.alert(
        'Headset Reset',
        'Old data cleared. Your next recording will register the new headset.',
      );
    } catch (err: any) {
      console.error('[Tracker] resetHeadset failed:', err);
      Alert.alert(
        'Reset Failed',
        `Could not reset the headset: ${err?.message ?? 'unknown error'}`,
      );
    }
  }, [appSettings]);

  // ── Tier label helper ──────────────────────────────────────────────────────

  function modelVersionLabel(tier: ModelTier): string {
    if (tier === 'none')    return 'No models';
    if (tier === 'general') return 'General';
    return tier.toUpperCase(); // 'v1' → 'V1'
  }

  return {
    status, statusMessage, currentTier,
    currentModelVersion: modelVersionLabel(currentTier),
    activeAlarm, alarmHistory, isSignalLost,
    predictorHistory, detectorHistory,
    showSatisfaction, satisfactionCount,
    collectingNormal,
    headset, headsetMismatch,
    start, stop, reportSeizure, collectNormalData,
    dismissAlarm, confirmAlarm, rateAlarm, markFalseAlarm,
    onSatisfactionAnswer,
    clearHeadsetMismatch, confirmHeadsetReset,
  };
}
