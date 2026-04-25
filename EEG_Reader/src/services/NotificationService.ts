import { ALARM_SOUNDS, findAlarmSound } from '../constants/alarmSounds';

const SEIZURE_BUTTON_NOTIFICATION_ID = 'tracker_seizure_button';
const CATEGORY_SEIZURE_REPORT        = 'SEIZURE_REPORT';
const CATEGORY_ALARM                 = 'SEIZURE_ALARM';

function getNotifications() {
  try {
    return require('expo-notifications');
  } catch {
    return null;
  }
}

function getDevice() {
  try {
    return require('expo-device');
  } catch {
    return null;
  }
}

export async function setupNotifications(): Promise<void> {
  const Notifications = getNotifications();
  if (!Notifications) return;

  const { status: existingStatus } = await Notifications.getPermissionsAsync();
  if (existingStatus !== 'granted') {
    const { status } = await Notifications.requestPermissionsAsync();
    if (status !== 'granted') {
      console.warn('[Notifications] Permission not granted');
    }
  }

  const Platform = require('react-native').Platform;
  if (Platform.OS === 'android') {
    for (const opt of ALARM_SOUNDS) {
      try {
        await Notifications.deleteNotificationChannelAsync(opt.channelId);
      } catch {}
      await Notifications.setNotificationChannelAsync(opt.channelId, {
        name        : `Seizure Alarms (${opt.label})`,
        importance  : 4,
        vibrationPattern    : [0, 500, 250, 500],
        sound       : opt.file ?? 'default',
        lockscreenVisibility: 1,
        enableVibrate       : true,
      });
    }

    await Notifications.setNotificationChannelAsync('tracker-status', {
      name       : 'Tracker Status',
      importance : 3,
      sound      : 'default',
    });

    await Notifications.setNotificationChannelAsync('normal-data-reminder', {
      name       : 'Daily EEG Reminder',
      importance : 4,
      sound      : 'default',
    });
  }

  Notifications.setNotificationHandler({
    handleNotification: async () => ({
      shouldShowBanner: true,
      shouldShowList  : true,
      shouldPlaySound : true,
      shouldSetBadge  : false,
    }),
  });

  await Notifications.setNotificationCategoryAsync(CATEGORY_SEIZURE_REPORT, [
    {
      identifier: 'REPORT',
      buttonTitle: 'Report Seizure',
      options    : { opensAppToForeground: true },
    },
    {
      identifier: 'DISMISS',
      buttonTitle: 'Dismiss',
      options    : { isDestructive: true },
    },
  ]);

  await Notifications.setNotificationCategoryAsync(CATEGORY_ALARM, [
    {
      identifier: 'ACKNOWLEDGE',
      buttonTitle: 'I Understand',
      options    : { opensAppToForeground: true },
    },
  ]);

  console.log('[Notifications] Setup complete');
}

export async function getExpoPushToken(): Promise<string | null> {
  const Notifications = getNotifications();
  const Device        = getDevice();
  if (!Notifications || !Device) return null;

  if (!Device.isDevice) return null;

  const { status } = await Notifications.requestPermissionsAsync();
  if (status !== 'granted') return null;

  try {
    const token = await Notifications.getExpoPushTokenAsync();
    return token.data;
  } catch (err) {
    console.error('[Notifications] Failed to get push token:', err);
    return null;
  }
}

export interface TrackerNotificationStats {
  status          : string;
  predictionPct   : number | null;
  detectionPct    : number | null;
  tier            : string;
}

export async function scheduleSeizureButtonNotification(
  stats?: TrackerNotificationStats,
): Promise<void> {
  const Notifications = getNotifications();
  if (!Notifications) return;

  await Notifications.cancelScheduledNotificationAsync(SEIZURE_BUTTON_NOTIFICATION_ID)
    .catch(() => {});

  let title = 'EEG Tracker Active';
  let body  = 'Tracking seizures in background. Tap to report a seizure.';

  if (stats) {
    title = `EEG Tracker — ${stats.status}`;

    const parts: string[] = [];
    if (stats.predictionPct !== null) {
      parts.push(`Prediction: ${stats.predictionPct.toFixed(1)}%`);
    }
    if (stats.detectionPct !== null) {
      parts.push(`Detection: ${stats.detectionPct.toFixed(1)}%`);
    }
    if (parts.length > 0) {
      body = parts.join('  |  ') + `\nModel: ${stats.tier}`;
    } else {
      body = `Model: ${stats.tier} — waiting for inference data`;
    }
  }

  await Notifications.scheduleNotificationAsync({
    identifier: SEIZURE_BUTTON_NOTIFICATION_ID,
    content   : {
      title,
      body,
      categoryIdentifier: CATEGORY_SEIZURE_REPORT,
      sticky            : true,
      autoDismiss       : false,
      ...(require('react-native').Platform.OS === 'android'
        ? { channelId: 'tracker-status' }
        : {}),
    },
    trigger: null,
  });
}

export async function cancelSeizureButtonNotification(): Promise<void> {
  const Notifications = getNotifications();
  if (!Notifications) return;
  await Notifications.cancelScheduledNotificationAsync(SEIZURE_BUTTON_NOTIFICATION_ID)
    .catch(() => {});
}

export async function triggerAlarmNotification(
  type    : 'prediction' | 'detection',
  message : string,
  soundId?: string,
): Promise<void> {
  const Notifications = getNotifications();
  if (!Notifications) return;

  const title = type === 'prediction'
    ? 'Seizure Predicted'
    : 'Seizure Detected Now';

  const sound = findAlarmSound(soundId);

  await Notifications.scheduleNotificationAsync({
    content: {
      title,
      body              : message,
      categoryIdentifier: CATEGORY_ALARM,
      sound             : sound.file ?? 'default',
      priority          : 'max',
      ...(require('react-native').Platform.OS === 'android'
        ? { channelId: sound.channelId }
        : {}),
    },
    trigger: null,
  });
}

const NORMAL_DATA_REMINDER_PREFIX = 'normal_data_reminder_';

export async function scheduleNormalDataReminder(
  timeStr: string | null | undefined,
): Promise<void> {
  const Notifications = getNotifications();
  if (!Notifications) return;

  const all = await Notifications.getAllScheduledNotificationsAsync();
  for (const n of all) {
    if (typeof n.identifier === 'string' && n.identifier.startsWith(NORMAL_DATA_REMINDER_PREFIX)) {
      await Notifications.cancelScheduledNotificationAsync(n.identifier).catch(() => {});
    }
  }

  if (!timeStr) return;
  const m = /^(\d{1,2}):(\d{2})$/.exec(timeStr);
  if (!m) {
    console.warn('[Notifications] invalid normal_alarm_time format:', timeStr);
    return;
  }
  const hour   = Math.max(0, Math.min(23, parseInt(m[1], 10)));
  const minute = Math.max(0, Math.min(59, parseInt(m[2], 10)));
  const Platform = require('react-native').Platform;

  for (let weekday = 1; weekday <= 7; weekday++) {
    await Notifications.scheduleNotificationAsync({
      identifier: `${NORMAL_DATA_REMINDER_PREFIX}${weekday}`,
      content: {
        title: 'Daily EEG Collection',
        body : 'Time for your 30-minute daily EEG data collection. Please keep your headset on.',
        sound: 'default',
        ...(Platform.OS === 'android' ? { channelId: 'normal-data-reminder' } : {}),
      },
      trigger: {
        type   : 'weekly',
        weekday,
        hour,
        minute,
      } as any,
    });
  }
}
