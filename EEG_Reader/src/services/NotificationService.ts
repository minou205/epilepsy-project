/**
 * NotificationService — wraps expo-notifications.
 *
 * Provides:
 *  1. Permission request + push token retrieval
 *  2. Persistent lock-screen "I had a seizure" notification during tracking
 *  3. Immediate local alarm (sound + notification) when a seizure is predicted/detected
 *  4. Daily normal-data-collection reminder scheduling
 *
 * NOTE: expo-notifications requires an Expo Development Build (EAS Build).
 *       The module is imported lazily so the app compiles without it in
 *       earlier development phases.
 */

const SEIZURE_BUTTON_NOTIFICATION_ID = 'tracker_seizure_button';
const CATEGORY_SEIZURE_REPORT        = 'SEIZURE_REPORT';
const CATEGORY_ALARM                 = 'SEIZURE_ALARM';

// ── Lazy module load ───────────────────────────────────────────────────────────

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

// ── Setup ──────────────────────────────────────────────────────────────────────

export async function setupNotifications(): Promise<void> {
  const Notifications = getNotifications();
  if (!Notifications) return;

  // Request permissions upfront (required on Android 13+ and iOS)
  const { status: existingStatus } = await Notifications.getPermissionsAsync();
  if (existingStatus !== 'granted') {
    const { status } = await Notifications.requestPermissionsAsync();
    if (status !== 'granted') {
      console.warn('[Notifications] Permission not granted');
    }
  }

  // Android notification channel (required for Android 8+)
  const Platform = require('react-native').Platform;
  if (Platform.OS === 'android') {
    await Notifications.setNotificationChannelAsync('seizure-alarms', {
      name       : 'Seizure Alarms',
      importance : 4, // MAX — shows heads-up notification with sound
      vibrationPattern: [0, 500, 250, 500],
      sound      : 'default',
      lockscreenVisibility: 1,
      enableVibrate: true,
    });

    await Notifications.setNotificationChannelAsync('tracker-status', {
      name       : 'Tracker Status',
      importance : 3, // HIGH
      sound      : 'default',
    });
  }

  // Foreground behaviour: show alert + play sound
  Notifications.setNotificationHandler({
    handleNotification: async () => ({
      shouldShowBanner: true,
      shouldShowList  : true,
      shouldPlaySound : true,
      shouldSetBadge  : false,
    }),
  });

  // Register action categories
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

// ── Push token ─────────────────────────────────────────────────────────────────

export async function getExpoPushToken(): Promise<string | null> {
  const Notifications = getNotifications();
  const Device        = getDevice();
  if (!Notifications || !Device) return null;

  if (!Device.isDevice) return null; // simulators don't get push tokens

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

// ── Lock-screen "I had a seizure" persistent notification ────────────────────

export async function scheduleSeizureButtonNotification(): Promise<void> {
  const Notifications = getNotifications();
  if (!Notifications) return;

  // Cancel any existing one first
  await Notifications.cancelScheduledNotificationAsync(SEIZURE_BUTTON_NOTIFICATION_ID)
    .catch(() => {/* ignore if not found */});

  await Notifications.scheduleNotificationAsync({
    identifier: SEIZURE_BUTTON_NOTIFICATION_ID,
    content   : {
      title             : 'EEG Tracker Active',
      body              : 'Tracking seizures in background. Tap to report a seizure.',
      categoryIdentifier: CATEGORY_SEIZURE_REPORT,
      sticky            : true,
      autoDismiss       : false,
      ...(require('react-native').Platform.OS === 'android'
        ? { channelId: 'tracker-status' }
        : {}),
    },
    trigger: null, // deliver immediately
  });
}

export async function cancelSeizureButtonNotification(): Promise<void> {
  const Notifications = getNotifications();
  if (!Notifications) return;
  await Notifications.cancelScheduledNotificationAsync(SEIZURE_BUTTON_NOTIFICATION_ID)
    .catch(() => {/* ignore */});
}

// ── Alarm (prediction / detection) ────────────────────────────────────────────

export async function triggerAlarmNotification(
  type   : 'prediction' | 'detection',
  message: string,
): Promise<void> {
  const Notifications = getNotifications();
  if (!Notifications) return;

  const title = type === 'prediction'
    ? 'Seizure Predicted'
    : 'Seizure Detected Now';

  await Notifications.scheduleNotificationAsync({
    content: {
      title,
      body              : message,
      categoryIdentifier: CATEGORY_ALARM,
      sound             : 'default',
      priority          : 'max',
      ...(require('react-native').Platform.OS === 'android'
        ? { channelId: 'seizure-alarms' }
        : {}),
    },
    trigger: null,
  });
}

// ── Daily normal data collection reminder ─────────────────────────────────────

/**
 * Schedule the weekly set of daily reminders.
 * `collectionTimesMinutes` is an array of 7 minute-of-day values (0=Sun … 6=Sat).
 */
export async function scheduleDailyCollectionReminders(
  collectionTimesMinutes: number[],
): Promise<void> {
  const Notifications = getNotifications();
  if (!Notifications) return;

  // Cancel existing reminders
  await Notifications.cancelAllScheduledNotificationsAsync();

  for (let dayIndex = 0; dayIndex < 7; dayIndex++) {
    const totalMins = collectionTimesMinutes[dayIndex] ?? 720;
    const hour      = Math.floor(totalMins / 60);
    const minute    = totalMins % 60;

    // weekday: 1=Sun, 2=Mon … 7=Sat (Expo notation)
    await Notifications.scheduleNotificationAsync({
      content: {
        title: 'Daily EEG Collection',
        body : 'Time for your 30-minute daily EEG data collection. Please keep your headset on.',
        sound: 'default',
      },
      trigger: {
        type   : 'weekly',
        weekday: dayIndex + 1,
        hour,
        minute,
      } as any,
    });
  }
}
