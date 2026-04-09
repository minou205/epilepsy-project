import * as FileSystem from 'expo-file-system/legacy';
import { SeizureDataPackage, NormalDataPackage, FalsePositivePackage } from './DataCollector';

/**
 * Thrown when an upload is rejected because its channel set does not match
 * the patient's locked headset. The TrackerScreen catches this and shows
 * the "did you change your headset?" modal.
 */
export class HeadsetMismatchError extends Error {
  constructor(
    public readonly expected: string[],
    public readonly got     : string[],
    message?: string,
  ) {
    super(message ?? 'Uploaded channels differ from registered headset.');
    this.name = 'HeadsetMismatchError';
  }
}

export interface RegisterPatientPayload {
  patient_id  : string;
  patient_name: string;
  push_token  : string | null;
}

export interface AddHelperPayload {
  helper_push_token: string;
}

export interface SeizureUploadResponse {
  seizure_count    : number;
  training_queued  : boolean;
  max_reached      : boolean;
  ask_satisfaction : boolean;
}

export interface TrainingStatus {
  status      : 'idle' | 'queued' | 'running' | 'complete' | 'failed';
  progressPct : number;
  tier        : string;
}

export class BackendClient {
  constructor(private readonly baseUrl: string) {}

  // ── Patient ──────────────────────────────────────────────────────────────

  async registerPatient(payload: RegisterPatientPayload): Promise<{ patient_id: string }> {
    return this.post('/patients/register', payload);
  }

  async addHelper(patientId: string, helperToken: string): Promise<void> {
    await this.post(`/patients/${encodeURIComponent(patientId)}/helpers`, {
      helper_push_token: helperToken,
    });
  }

  // ── Data upload ───────────────────────────────────────────────────────────

  async uploadSeizureData(pkg: SeizureDataPackage): Promise<SeizureUploadResponse> {
    const form = new FormData();
    form.append('patient_id',    pkg.patientId);
    form.append('seizure_id',    pkg.seizureId);
    form.append('captured_at',   pkg.capturedAt);
    form.append('channel_names', JSON.stringify(pkg.channelNames));
    form.append('sampling_rate', String(pkg.samplingRate));

    // React Native FormData: attach local files by URI — no Blob needed
    form.append('preictal_file', {
      uri : pkg.preictalFilePath,
      name: `preictal_${pkg.seizureId}.txt`,
      type: 'text/plain',
    } as any);
    form.append('ictal_file', {
      uri : pkg.ictalFilePath,
      name: `ictal_${pkg.seizureId}.txt`,
      type: 'text/plain',
    } as any);

    return this.postForm('/data/seizure', form);
  }

  async uploadNormalData(pkg: NormalDataPackage): Promise<void> {
    const form = new FormData();
    form.append('patient_id',    pkg.patientId);
    form.append('file_id',       pkg.fileId);
    form.append('captured_at',   pkg.capturedAt);
    form.append('channel_names', JSON.stringify(pkg.channelNames));
    form.append('sampling_rate', String(pkg.samplingRate));

    form.append('eeg_file', {
      uri : pkg.filePath,
      name: `normal_${pkg.fileId}.txt`,
      type: 'text/plain',
    } as any);

    await this.postForm('/data/normal', form);
  }

  async uploadFalsePositive(pkg: FalsePositivePackage): Promise<{ ok: boolean; fp_count: number }> {
    const form = new FormData();
    form.append('patient_id',    pkg.patientId);
    form.append('fp_id',         pkg.fpId);
    form.append('alarm_id',      pkg.alarmId);
    form.append('alarm_type',    pkg.alarmType);
    form.append('model_tier',    pkg.modelTier);
    form.append('captured_at',   pkg.capturedAt);
    form.append('channel_names', JSON.stringify(pkg.channelNames));
    form.append('sampling_rate', String(pkg.samplingRate));

    form.append('eeg_file', {
      uri : pkg.filePath,
      name: `false_positive_${pkg.fpId}.txt`,
      type: 'text/plain',
    } as any);

    return this.postForm('/data/false_positive', form);
  }

  // ── Notifications ─────────────────────────────────────────────────────────

  async sendHelperAlarm(
    patientId: string,
    alarmType: 'prediction' | 'detection',
  ): Promise<{ sent_count: number }> {
    return this.post('/notifications/alarm', {
      patient_id: patientId,
      alarm_type: alarmType,
    });
  }

  // ── Training status ───────────────────────────────────────────────────────

  async getTrainingStatus(patientId: string): Promise<TrainingStatus> {
    return this.get(`/training/status?patient_id=${encodeURIComponent(patientId)}`);
  }

  // ── Model management ──────────────────────────────────────────────────────

  async deleteModels(patientId: string): Promise<{ deleted: boolean }> {
    return this.post(`/models/delete`, { patient_id: patientId });
  }

  // ── Helpers ───────────────────────────────────────────────────────────────

  private async get<T>(path: string): Promise<T> {
    const resp = await fetch(`${this.baseUrl}${path}`, {
      method : 'GET',
      headers: { 'Accept': 'application/json' },
    });
    if (!resp.ok) {
      throw new Error(`[BackendClient] GET ${path} → ${resp.status}`);
    }
    return resp.json();
  }

  private async post<T>(path: string, body: object): Promise<T> {
    const resp = await fetch(`${this.baseUrl}${path}`, {
      method : 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Accept'      : 'application/json',
      },
      body: JSON.stringify(body),
    });
    if (!resp.ok) {
      throw new Error(`[BackendClient] POST ${path} → ${resp.status}`);
    }
    return resp.json();
  }

  private async postForm<T>(path: string, form: FormData): Promise<T> {
    const resp = await fetch(`${this.baseUrl}${path}`, {
      method: 'POST',
      body  : form,
    });
    if (!resp.ok) {
      // Headset-mismatch (409) carries structured detail the UI must read.
      if (resp.status === 409) {
        try {
          const body = await resp.json();
          const detail = body?.detail ?? body;
          if (detail?.error === 'headset_mismatch') {
            throw new HeadsetMismatchError(
              Array.isArray(detail.expected) ? detail.expected : [],
              Array.isArray(detail.got)      ? detail.got      : [],
              detail.message,
            );
          }
        } catch (parseErr) {
          if (parseErr instanceof HeadsetMismatchError) throw parseErr;
          // fall through to generic error below
        }
      }
      throw new Error(`[BackendClient] POST (form) ${path} → ${resp.status}`);
    }
    return resp.json();
  }
}
