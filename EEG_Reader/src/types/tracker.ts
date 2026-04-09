// ── Model tier type ──────────────────────────────────────────────────────────
// 'none' = no models; 'general' = weak general model; 'v1','v2',… = personal
export type ModelTier = 'general' | 'none' | string;

export type TrackerStatus =
  | 'idle'              // not started, waiting for connection
  | 'ready'             // connected but user hasn't pressed START yet
  | 'running'           // inference loop active
  | 'stopped'           // user explicitly pressed STOP
  | 'signal_lost'       // all-zero detection
  | 'alarm_predict'     // seizure predicted ~15 min out
  | 'alarm_detect'      // seizure detected NOW
  | 'collecting_normal'; // collecting 30-min normal data

export interface AlarmEvent {
  id                   : string;
  type                 : 'prediction' | 'detection';
  tier                 : ModelTier;
  message              : string;
  timestamp            : number;
  confirmationDeadline : number;          // ms timestamp for auto-"No"
  confirmed            : boolean | null;  // true=real, false=no, null=pending
  probabilityTrace     : {
    predictorProbs: number[];
    detectorProbs : number[];
    timestamps    : number[];             // ms timestamps for each recorded prob
  };
  rating               : number | null;   // 1-5 user rating, null = not yet rated
  isFalseAlarm        ?: boolean;         // true after user confirms "False Alarm"
}
