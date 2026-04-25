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
import { BackendClient, HeadsetMismatchError, CooldownError, type DataCounts } from '../services/BackendClient';
import {
  HeadsetInfo,
  fetchHeadset,
  resetHeadset,
} from '../services/HeadsetClient';
import {
  scheduleSeizureButtonNotification,
  cancelSeizureButtonNotification,
  triggerAlarmNotification,
  type TrackerNotificationStats,
} from '../services/NotificationService';
import {
  saveAlarmToArchive,
  syncAlarmToBackend,
  ArchivedAlarm,
} from '../services/ArchiveStorage';
import { useAuth } from '../services/AuthContext';

const CHANNELS_18 = [
  'FP1-F7', 'F7-T7', 'T7-P7', 'P7-O1',
  'FP2-F8', 'F8-T8', 'T8-P8', 'P8-O2',
  'FP1-F3', 'F3-C3', 'C3-P3', 'P3-O1',
  'FP2-F4', 'F4-C4', 'C4-P4', 'P4-O2',
  'FZ-CZ',  'CZ-PZ',
] as const;

const DEFAULT_WINDOW_SECS = 5;

function mapToModel(
  getLongBuffer  : (ch: string, secs: number) => Float32Array | null,
  incomingLabels : string[],
  targetLabels   : readonly string[],
  windowSecs     : number,
  samplingRate   : number,
): number[][] {
  const windowSamples = windowSecs * samplingRate;
  const out: number[][] = [];

  const upperMap = new Map(incomingLabels.map(l => [l.toUpperCase(), l]));

  for (let ti = 0; ti < targetLabels.length; ti++) {
    const row = new Array<number>(windowSamples).fill(0);
    const match = upperMap.get(targetLabels[ti].toUpperCase());

    if (match) {
      const snap = getLongBuffer(match, windowSecs);
      if (snap && snap.length > 0) {
        if (snap.length >= windowSamples) {
          for (let i = 0; i < windowSamples; i++) {
            row[i] = snap[snap.length - windowSamples + i];
          }
        } else {
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
  predictorThreshold  : number;
  detectorThreshold   : number;
  showSatisfaction    : boolean;
  satisfactionCount   : number;
  collectingNormal    : boolean;
  headset             : HeadsetInfo | null;
  headsetMismatch     : { expected: string[]; got: string[] } | null;
  pendingAcceptance   : boolean;
  pendingTier         : string | null;
  seizureCount        : number;
  normalCount         : number;
  nextTrainAt         : number;

  start               : () => void;
  stop                : () => void;
  reportSeizure       : () => void;
  collectNormalData   : () => void;
  dismissAlarm        : () => void;
  confirmAlarm        : (alarmId: string, confirmed: boolean) => void;
  markFalseAlarm      : (alarmId: string) => Promise<void>;
  onSatisfactionAnswer: (satisfied: boolean) => void;
  clearHeadsetMismatch: () => void;
  confirmHeadsetReset : () => Promise<void>;
  acceptNewModel      : () => Promise<void>;
}

export function useTrackerSession(
  eegSession  : EEGSession,
  appSettings : AppSettings,
): TrackerSessionAPI {

  const { profile } = useAuth();
  const trainNextVersionRef = useRef<boolean>(true);
  trainNextVersionRef.current = profile?.train_next_version ?? true;

  const [status,            setStatus           ] = useState<TrackerStatus>('idle');
  const [statusMessage,     setStatusMessage    ] = useState('Waiting for EEG connection...');
  const [currentTier,       setCurrentTier      ] = useState<ModelTier>('none');
  const [activeAlarm,       setActiveAlarm      ] = useState<AlarmEvent | null>(null);
  const [alarmHistory,      setAlarmHistory     ] = useState<AlarmEvent[]>([]);
  const [isSignalLost,      setIsSignalLost     ] = useState(false);
  const [predictorHistory,  setPredictorHistory ] = useState<number[]>([]);
  const [detectorHistory,   setDetectorHistory  ] = useState<number[]>([]);
  const [predictorThreshold, setPredictorThreshold] = useState(0.5);
  const [detectorThreshold,  setDetectorThreshold ] = useState(0.5);
  const [showSatisfaction,  setShowSatisfaction ] = useState(false);
  const [satisfactionCount, setSatisfactionCount] = useState(0);
  const [collectingNormal,  setCollectingNormal ] = useState(false);
  const [headset,           setHeadset          ] = useState<HeadsetInfo | null>(null);
  const [headsetMismatch,   setHeadsetMismatch  ] = useState<{ expected: string[]; got: string[] } | null>(null);
  const [pendingAcceptance, setPendingAcceptance] = useState(false);
  const [pendingTier,       setPendingTier      ] = useState<string | null>(null);
  const [seizureCount,      setSeizureCount     ] = useState(0);
  const [normalCount,       setNormalCount      ] = useState(0);
  const [nextTrainAt,       setNextTrainAt      ] = useState(5);

  const loopRef           = useRef<ReturnType<typeof setInterval> | null>(null);
  const tierRef           = useRef<ModelTier>('none');
  const checkerRef        = useRef<SignalChecker | null>(null);
  const isRunningRef      = useRef(false);
  const activeAlarmRef    = useRef<AlarmEvent | null>(null);
  const errorCountRef     = useRef(0);
  const userWantsRunning  = useRef(false);
  const runInferenceRef   = useRef<() => void>(() => {});
  const settingsRef       = useRef(appSettings);
  settingsRef.current     = appSettings;
  const headsetRef        = useRef<HeadsetInfo | null>(null);
  headsetRef.current      = headset;
  const MAX_SILENT_ERRORS = 3;
  const ALARM_COOLDOWN_MS         = 10 * 60 * 1000;
  const lastPredictionAlarmRef    = useRef(0);
  const lastDetectionAlarmRef     = useRef(0);

  const alarmRecordingRef = useRef<{
    alarmId        : string;
    alarmEvent     : AlarmEvent;
    predictorProbs : number[];
    detectorProbs  : number[];
    timestamps     : number[];
    autoNoTimer    : ReturnType<typeof setTimeout> | null;
    confirmTimer   : ReturnType<typeof setTimeout> | null;
  } | null>(null);

  const MAX_HISTORY_POINTS = 60;

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

    const targetLabels: readonly string[] =
      headsetRef.current?.channelNames && headsetRef.current.channelNames.length > 0
        ? headsetRef.current.channelNames
        : CHANNELS_18;

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

      errorCountRef.current = 0;

      const tier = result.tier as ModelTier;
      tierRef.current = tier;
      setCurrentTier(tier);

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
      if (result.predictorThreshold !== null) setPredictorThreshold(result.predictorThreshold);
      if (result.detectorThreshold  !== null) setDetectorThreshold(result.detectorThreshold);

      if (alarmRecordingRef.current) {
        alarmRecordingRef.current.predictorProbs.push(result.predictorProb ?? 0);
        alarmRecordingRef.current.detectorProbs.push(result.detectorProb ?? 0);
        alarmRecordingRef.current.timestamps.push(Date.now());
      }

      const tierLabel = tier === 'general' ? 'General'
                      : tier === 'none'    ? 'No models'
                      : `Personal ${tier.toUpperCase()}`;
      const notifStats: TrackerNotificationStats = {
        status       : activeAlarmRef.current
                         ? (activeAlarmRef.current.type === 'detection' ? 'SEIZURE DETECTED' : 'SEIZURE PREDICTED')
                         : 'Tracking Active',
        predictionPct: result.predictorProb !== null ? result.predictorProb * 100 : null,
        detectionPct : result.detectorProb  !== null ? result.detectorProb  * 100 : null,
        tier         : tierLabel,
      };
      scheduleSeizureButtonNotification(notifStats).catch(() => {});

      if (!activeAlarmRef.current) {
        if (result.predictorLabel === 'preictal') {
          fireAlarm('prediction', tier);
        } else if (result.detectorLabel === 'ictal') {
          fireAlarm('detection', tier);
        } else {
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
        const msg = err?.message?.includes('Network request failed')
          ? 'Backend unreachable — check server connection'
          : `Inference error — ${(err?.message ?? 'unknown error').slice(0, 60)}`;
        setStatusMessage(msg);
        setStatus('running');
      }
    }
  }, [eegSession, appSettings]);

  runInferenceRef.current = runInference;

  function fireAlarm(type: 'prediction' | 'detection', tier: ModelTier) {
    const now = Date.now();
    const lastRef = type === 'prediction' ? lastPredictionAlarmRef : lastDetectionAlarmRef;
    if (now - lastRef.current < ALARM_COOLDOWN_MS) {
      return;
    }
    lastRef.current = now;

    const deadline = type === 'prediction' ? 60 * 60 * 1000 : 60 * 1000;
    const confirmDelay = type === 'prediction' ? 15 * 60 * 1000 : 0;

    const event: AlarmEvent = {
      id                  : generateId(),
      type,
      tier,
      message             : buildAlarmMessage(type, tier),
      timestamp           : Date.now(),
      confirmationDeadline: Date.now() + deadline,
      confirmed           : null,
      probabilityTrace    : { predictorProbs: [], detectorProbs: [], timestamps: [] },
    };

    activeAlarmRef.current = event;
    setActiveAlarm(event);
    setAlarmHistory(prev => [event, ...prev]);
    setStatus(type === 'prediction' ? 'alarm_predict' : 'alarm_detect');

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

    if (type === 'detection') {
      sendConfirmNotification(event.id, type);
    }

    if (settingsRef.current.alarmSoundEnabled !== false) {
      triggerAlarmNotification(type, event.message).catch(() => {});
    }

    if (tier !== 'general' && tier !== 'none') {
      const { patientId, serverBaseUrl } = appSettings;
      if (patientId && serverBaseUrl) {
        new BackendClient(serverBaseUrl)
          .sendHelperAlarm(patientId, type, tier)
          .catch(err => console.error('[Tracker] Helper alarm failed:', err));
      }
    }
  }

  function sendConfirmNotification(_alarmId: string, alarmType: 'prediction' | 'detection' = 'detection') {
    if (settingsRef.current.alarmSoundEnabled === false) return;
    triggerAlarmNotification(alarmType, 'Did you have a seizure? Please confirm in the app.')
      .catch(() => {});
  }

  function autoRespondNo(alarmId: string) {
    resolveAlarm(alarmId, false);
  }

  const resolveAlarm = useCallback(async (alarmId: string, confirmed: boolean) => {
    const recording = alarmRecordingRef.current;
    if (!recording || recording.alarmId !== alarmId) return;

    if (recording.autoNoTimer)  clearTimeout(recording.autoNoTimer);
    if (recording.confirmTimer) clearTimeout(recording.confirmTimer);

    const trace = {
      predictorProbs: recording.predictorProbs,
      detectorProbs : recording.detectorProbs,
      timestamps    : recording.timestamps,
    };

    alarmRecordingRef.current = null;

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

    const alarm = activeAlarmRef.current ?? alarmHistory.find(a => a.id === alarmId);
    if (!alarm) return;

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

  useEffect(() => {
    const connected  = eegSession.status === 'connected';
    const hasServer  = !!appSettings.serverBaseUrl;
    const hasPatient = !!appSettings.patientId;

    if (connected && hasServer && hasPatient) {
      if (userWantsRunning.current && !isRunningRef.current) {
        startLoop();
      } else if (!userWantsRunning.current && !isRunningRef.current) {
        setStatus('ready');
        setStatusMessage('Connected — press START to begin tracking');
      }
    } else if (!connected && isRunningRef.current) {
      stopLoop();
      cancelSeizureButtonNotification().catch(() => {});
      setStatus('idle');
      setStatusMessage('EEG disconnected — tracking stopped');
      setPredictorHistory([]);
      setDetectorHistory([]);
    } else if (!connected) {
      setStatus('idle');
      setStatusMessage('Waiting for EEG connection...');
    }
  }, [eegSession.status, appSettings.serverBaseUrl, appSettings.patientId]);

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

  const eegSessionRef = useRef(eegSession);
  eegSessionRef.current = eegSession;

  const refreshHeadset = useCallback(async () => {
    const { patientId, serverBaseUrl } = settingsRef.current;
    if (!patientId || !serverBaseUrl) return;
    try {
      const info = await fetchHeadset(serverBaseUrl, patientId);
      setHeadset(info);
      if (info && info.channelNames.length > 0) {
        eegSessionRef.current.selectChannels(info.channelNames);
      }
    } catch (err: any) {
      console.warn('[Tracker] refreshHeadset failed:', err?.message ?? err);
    }
  }, []);

  const refreshDataCounts = useCallback(async () => {
    const { patientId, serverBaseUrl } = settingsRef.current;
    if (!patientId || !serverBaseUrl) return;
    try {
      const client = new BackendClient(serverBaseUrl);
      const counts = await client.getDataCounts(patientId);
      setSeizureCount(counts.seizure_count);
      setNormalCount(counts.normal_count);
      setNextTrainAt(counts.next_train_at);
    } catch (err: any) {
      console.warn('[Tracker] refreshDataCounts failed:', err?.message ?? err);
    }
  }, []);

  useEffect(() => {
    refreshDataCounts();
  }, [appSettings.patientId, appSettings.serverBaseUrl]);

  function startLoop() {
    if (isRunningRef.current) return;
    isRunningRef.current = true;
    errorCountRef.current = 0;
    setStatus('running');
    setStatusMessage('Tracking started...');
    scheduleSeizureButtonNotification().catch(() => {});
    loopRef.current = setInterval(
      () => runInferenceRef.current(),
      settingsRef.current.inferenceIntervalMs,
    );
  }

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
    cancelSeizureButtonNotification().catch(() => {});
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
      const resp = await client.uploadSeizureData(pkg, trainNextVersionRef.current);
      setStatusMessage('Seizure data uploaded successfully.');

      refreshHeadset().catch(() => {});
      refreshDataCounts().catch(() => {});

      if (resp.ask_satisfaction) {
        setSatisfactionCount(resp.seizure_count);
        setShowSatisfaction(true);
      }

      const maxMsg = resp.max_reached
        ? '\n\nMaximum seizure data limit reached — no more data collection needed.'
        : '';

      const balanceMsg = resp.needs_normal
        ? `\n\nYou have ${resp.seizure_count} seizure recording${resp.seizure_count !== 1 ? 's' : ''} `
          + `but only ${resp.normal_count} normal recording${resp.normal_count !== 1 ? 's' : ''}. `
          + 'Please collect more Normal EEG data so training can start.'
        : '';

      const trainingMsg = resp.training_queued
        ? '\n\nNew model training has been queued!'
        : resp.training_blocked_reason === 'insufficient_normal_data'
          ? '\n\nTraining is ready but waiting for more normal data.'
          : '';

      Alert.alert(
        'Uploaded',
        (capturedMins >= 21
          ? 'Full 21 minutes of seizure data sent to the server.'
          : `${capturedMins} minute${capturedMins !== 1 ? 's' : ''} of EEG data sent.\nPartial data is still useful for training.`)
        + trainingMsg
        + balanceMsg
        + maxMsg,
      );
    } catch (err) {
      if (err instanceof HeadsetMismatchError) {
        setHeadsetMismatch({ expected: err.expected, got: err.got });
        setStatusMessage('Headset mismatch — upload rejected.');
        return;
      }
      if (err instanceof CooldownError) {
        const mins = Math.ceil(err.remainingSecs / 60);
        setStatusMessage(`Cooldown — wait ${mins} min before next seizure recording.`);
        Alert.alert(
          'Please Wait',
          err.message || `Please wait ${mins} more minute${mins !== 1 ? 's' : ''} before recording more seizure data.`,
        );
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
      refreshHeadset().catch(() => {});
      refreshDataCounts().catch(() => {});
      Alert.alert('Success', 'Normal EEG data collected and uploaded to the server.');
    } catch (err) {
      if (err instanceof HeadsetMismatchError) {
        setHeadsetMismatch({ expected: err.expected, got: err.got });
        setStatusMessage('Headset mismatch — upload rejected.');
      } else if (err instanceof CooldownError) {
        const mins = Math.ceil(err.remainingSecs / 60);
        setStatusMessage(`Cooldown — wait ${mins} min before next normal recording.`);
        Alert.alert(
          'Please Wait',
          err.message || `Please wait ${mins} more minute${mins !== 1 ? 's' : ''} before recording more normal data.`,
        );
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
      reportSeizure();
    }
  }, [resolveAlarm, reportSeizure]);

  const markFalseAlarm = useCallback(async (alarmId: string) => {
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
  }, []);

  useEffect(() => {
    const { patientId, serverBaseUrl } = appSettings;
    if (!patientId || !serverBaseUrl) return;

    const client = new BackendClient(serverBaseUrl);
    let timer: ReturnType<typeof setInterval> | null = null;

    const poll = async () => {
      try {
        const st = await client.getTrainingStatus(patientId);
        if (st.pending_acceptance) {
          setPendingAcceptance(true);
          setPendingTier(st.tier);
          if (timer) { clearInterval(timer); timer = null; }
        } else if (st.overall_status === 'idle' || st.overall_status === 'failed') {
          setPendingAcceptance(false);
          setPendingTier(null);
          if (timer) { clearInterval(timer); timer = null; }
        }
      } catch {}
    };

    timer = setInterval(poll, 30_000);
    poll();

    return () => { if (timer) clearInterval(timer); };
  }, [appSettings.patientId, appSettings.serverBaseUrl]);

  const acceptNewModel = useCallback(async () => {
    const { patientId, serverBaseUrl } = appSettings;
    if (!patientId || !serverBaseUrl) return;

    try {
      const client = new BackendClient(serverBaseUrl);
      const result = await client.acceptModels(patientId);

      const newTier = result.tier as ModelTier;
      setCurrentTier(newTier);
      tierRef.current = newTier;

      setPendingAcceptance(false);
      setPendingTier(null);

      setPredictorHistory([]);
      setDetectorHistory([]);

      Alert.alert(
        'Model Activated',
        `Your new ${result.tier.toUpperCase()} model is now active. `
        + `${result.cleaned} old model file${result.cleaned !== 1 ? 's' : ''} cleaned up.`,
      );
    } catch (err: any) {
      console.error('[Tracker] acceptNewModel failed:', err);
      Alert.alert('Accept Failed', err?.message ?? 'Could not activate the new model.');
    }
  }, [appSettings]);

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

  function modelVersionLabel(tier: ModelTier): string {
    if (tier === 'none')    return 'No models';
    if (tier === 'general') return 'General';
    return `Personal ${tier.toUpperCase()}`;
  }

  return {
    status, statusMessage, currentTier,
    currentModelVersion: modelVersionLabel(currentTier),
    activeAlarm, alarmHistory, isSignalLost,
    predictorHistory, detectorHistory,
    predictorThreshold, detectorThreshold,
    showSatisfaction, satisfactionCount,
    collectingNormal,
    headset, headsetMismatch,
    pendingAcceptance, pendingTier,
    seizureCount, normalCount, nextTrainAt,
    start, stop, reportSeizure, collectNormalData,
    dismissAlarm, confirmAlarm, markFalseAlarm,
    onSatisfactionAnswer,
    clearHeadsetMismatch, confirmHeadsetReset,
    acceptNewModel,
  };
}
