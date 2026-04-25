import * as FileSystem from 'expo-file-system/legacy';

export interface ArchivedAlarm {
  id             : string;
  type           : 'prediction' | 'detection';
  tier           : string;
  timestamp      : number;
  confirmed      : boolean;
  probabilityTrace: {
    predictorProbs: number[];
    detectorProbs : number[];
    timestamps    : number[];
  };
}

export interface ArchiveStats {
  totalAlarms  : number;
  predictions  : number;
  detections   : number;
  confirmedReal: number;
  falseAlarms  : number;
}

const ARCHIVE_DIR = `${FileSystem.documentDirectory}archive/`;

function archivePath(patientId: string): string {
  return `${ARCHIVE_DIR}${patientId}.json`;
}

export async function saveAlarmToArchive(
  patientId: string,
  alarm    : ArchivedAlarm,
): Promise<void> {
  await FileSystem.makeDirectoryAsync(ARCHIVE_DIR, { intermediates: true });
  const path = archivePath(patientId);

  let existing: ArchivedAlarm[] = [];
  try {
    const raw = await FileSystem.readAsStringAsync(path);
    existing = JSON.parse(raw);
  } catch {}

  existing.push(alarm);
  await FileSystem.writeAsStringAsync(path, JSON.stringify(existing));
}

export async function loadArchive(patientId: string): Promise<ArchivedAlarm[]> {
  const path = archivePath(patientId);
  try {
    const raw = await FileSystem.readAsStringAsync(path);
    const parsed: ArchivedAlarm[] = JSON.parse(raw);
    return parsed.sort((a, b) => b.timestamp - a.timestamp);
  } catch {
    return [];
  }
}

export async function clearArchive(patientId: string): Promise<void> {
  const path = archivePath(patientId);
  try {
    await FileSystem.deleteAsync(path, { idempotent: true });
  } catch {}
}

export async function getArchiveStats(patientId: string): Promise<ArchiveStats> {
  const alarms = await loadArchive(patientId);

  return {
    totalAlarms  : alarms.length,
    predictions  : alarms.filter(a => a.type === 'prediction').length,
    detections   : alarms.filter(a => a.type === 'detection').length,
    confirmedReal: alarms.filter(a => a.confirmed).length,
    falseAlarms  : alarms.filter(a => !a.confirmed).length,
  };
}

export async function syncAlarmToBackend(
  serverBaseUrl: string,
  alarm        : ArchivedAlarm & { patientId: string },
): Promise<void> {
  try {
    await fetch(`${serverBaseUrl}/archive/event`, {
      method : 'POST',
      headers: { 'Content-Type': 'application/json' },
      body   : JSON.stringify({
        id             : alarm.id,
        patient_id     : alarm.patientId,
        alarm_type     : alarm.type,
        tier           : alarm.tier,
        timestamp      : new Date(alarm.timestamp).toISOString(),
        confirmed      : alarm.confirmed ? 1 : 0,
        predictor_probs: alarm.probabilityTrace.predictorProbs,
        detector_probs : alarm.probabilityTrace.detectorProbs,
        prob_timestamps: alarm.probabilityTrace.timestamps,
      }),
    });
  } catch (err) {
    console.warn('[Archive] Backend sync failed:', err);
  }
}
