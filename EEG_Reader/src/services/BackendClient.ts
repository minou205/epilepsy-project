import * as FileSystem from 'expo-file-system/legacy';
import { SeizureDataPackage, NormalDataPackage, FalsePositivePackage } from './DataCollector';

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

export class CooldownError extends Error {
  constructor(
    public readonly dataType      : string,
    public readonly remainingSecs : number,
    message?: string,
  ) {
    super(message ?? `Please wait before recording more ${dataType} data.`);
    this.name = 'CooldownError';
  }
}

export interface SeizureUploadResponse {
  seizure_count           : number;
  normal_count            : number;
  training_queued         : boolean;
  training_blocked_reason : string | null;
  needs_normal            : boolean;
  max_reached             : boolean;
  ask_satisfaction        : boolean;
  next_train_at           : number;
}

export interface TrainingJobDetail {
  job_id      : string;
  model_type  : 'predictor' | 'detector';
  status      : 'pending' | 'running' | 'complete' | 'failed';
  queued_at   : string | null;
  started_at  : string | null;
  completed_at: string | null;
  error_msg   : string | null;
}

export interface TrainingStatus {
  overall_status     : 'idle' | 'pending' | 'training' | 'completed' | 'failed';
  tier               : string;
  version_num        : number;
  pending_acceptance : boolean;
  jobs               : TrainingJobDetail[];
  error_msg          : string | null;
}

export interface AcceptResult {
  accepted : number;
  cleaned  : number;
  tier     : string;
}

export interface DataCounts {
  seizure_count       : number;
  normal_count        : number;
  false_positive_count: number;
  needs_normal        : boolean;
  balanced            : boolean;
  next_train_at       : number;
  active_tier         : string;
  pending_acceptance  : boolean;
}

export class BackendClient {
  constructor(private readonly baseUrl: string) {}

  async uploadSeizureData(
    pkg: SeizureDataPackage,
    trainNextVersion: boolean = true,
  ): Promise<SeizureUploadResponse> {
    const form = new FormData();
    form.append('patient_id',         pkg.patientId);
    form.append('seizure_id',         pkg.seizureId);
    form.append('captured_at',        pkg.capturedAt);
    form.append('channel_names',      JSON.stringify(pkg.channelNames));
    form.append('sampling_rate',      String(pkg.samplingRate));
    form.append('train_next_version', String(trainNextVersion));

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

  async sendHelperAlarm(
    patientId: string,
    alarmType: 'prediction' | 'detection',
    tier     : string,
  ): Promise<{ sent_count: number }> {
    return this.post('/notifications/alarm', {
      patient_id: patientId,
      alarm_type: alarmType,
      tier,
    });
  }

  async getTrainingStatus(patientId: string): Promise<TrainingStatus> {
    return this.get(`/training/status?patient_id=${encodeURIComponent(patientId)}`);
  }

  async getDataCounts(patientId: string): Promise<DataCounts> {
    return this.get(`/data/counts/${encodeURIComponent(patientId)}`);
  }

  async acceptModels(patientId: string): Promise<AcceptResult> {
    return this.post(`/training/accept/${encodeURIComponent(patientId)}`, {});
  }

  async deleteModels(patientId: string): Promise<{ deleted: boolean }> {
    return this.post(`/models/delete`, { patient_id: patientId });
  }

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
        }
      }
      if (resp.status === 429) {
        try {
          const body = await resp.json();
          const detail = body?.detail ?? body;
          if (detail?.error === 'cooldown') {
            throw new CooldownError(
              detail.data_type ?? 'data',
              typeof detail.remaining_secs === 'number' ? detail.remaining_secs : 0,
              detail.message,
            );
          }
        } catch (parseErr) {
          if (parseErr instanceof CooldownError) throw parseErr;
        }
      }
      throw new Error(`[BackendClient] POST (form) ${path} → ${resp.status}`);
    }
    return resp.json();
  }
}
