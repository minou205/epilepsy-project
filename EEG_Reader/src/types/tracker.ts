export type ModelTier = 'general' | 'none' | string;

export type TrackerStatus =
  | 'idle'
  | 'ready'
  | 'running'
  | 'stopped'
  | 'signal_lost'
  | 'alarm_predict'
  | 'alarm_detect'
  | 'collecting_normal';

export interface AlarmEvent {
  id                   : string;
  type                 : 'prediction' | 'detection';
  tier                 : ModelTier;
  message              : string;
  timestamp            : number;
  confirmationDeadline : number;
  confirmed            : boolean | null;
  probabilityTrace     : {
    predictorProbs: number[];
    detectorProbs : number[];
    timestamps    : number[];
  };
  isFalseAlarm        ?: boolean;
}
