/**
 * Local archive for alarm events and their probability traces.
 *
 * Stores data as JSON files in the app's document directory.
 * Also syncs to the backend so helpers can view patient archives remotely.
 */
import * as FileSystem from 'expo-file-system/legacy';

// ── Types ────────────────────────────────────────────────────────────────────

export interface ArchivedAlarm {
  id             : string;
  type           : 'prediction' | 'detection';
  tier           : string;
  timestamp      : number;   // ms since epoch
  confirmed      : boolean;  // true = real seizure, false = auto-no or user-denied
  probabilityTrace: {
    predictorProbs: number[];
    detectorProbs : number[];
    timestamps    : number[];   // ms since epoch for each recorded probability
  };
}

export interface ArchiveStats {
  totalAlarms  : number;
  predictions  : number;
  detections   : number;
  confirmedReal: number;
  falseAlarms  : number;
}

// ── Storage ──────────────────────────────────────────────────────────────────

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
  } catch {
    // File doesn't exist yet — start fresh
  }

  existing.push(alarm);
  await FileSystem.writeAsStringAsync(path, JSON.stringify(existing));
}

export async function loadArchive(patientId: string): Promise<ArchivedAlarm[]> {
  const path = archivePath(patientId);
  try {
    const raw = await FileSystem.readAsStringAsync(path);
    const parsed: ArchivedAlarm[] = JSON.parse(raw);
    // Return newest first
    return parsed.sort((a, b) => b.timestamp - a.timestamp);
  } catch {
    return [];
  }
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

// ── Backend sync ─────────────────────────────────────────────────────────────

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
    // Non-critical — local archive is the source of truth
    console.warn('[Archive] Backend sync failed:', err);
  }
}
