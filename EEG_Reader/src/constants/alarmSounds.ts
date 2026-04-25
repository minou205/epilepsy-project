export interface AlarmSoundOption {
  id          : string;
  label       : string;
  description : string;
  file        : string | null;
  channelId   : string;
}

export const ALARM_SOUNDS: AlarmSoundOption[] = [
  {
    id         : 'default',
    label      : 'Default System Sound',
    description: 'Phone\'s built-in notification sound',
    file       : null,
    channelId  : 'seizure-alarms',
  },
  {
    id         : 'biohazard_alarm',
    label      : 'biohazard_alarm',
    description: 'just listen to it',
    file       : 'biohazard_alarm.mp3',
    channelId  : 'seizure-alarms-siren',
  },
  {
    id         : 'u_alarm',
    label      : 'u_alarm',
    description: 'listen to this too and you will know why it is called u_alarm',
    file       : 'u_alarm.mp3',
    channelId  : 'seizure-alarms-urgent',
  },
  
];

export const DEFAULT_ALARM_SOUND_ID = 'default';

export function findAlarmSound(id: string | null | undefined): AlarmSoundOption {
  return ALARM_SOUNDS.find(s => s.id === id) ?? ALARM_SOUNDS[0];
}
