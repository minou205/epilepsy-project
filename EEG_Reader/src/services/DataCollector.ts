import * as FileSystem from 'expo-file-system/legacy';

const DATA_DIR = `${FileSystem.documentDirectory}eeg_data/`;

async function ensureDir(): Promise<void> {
  const info = await FileSystem.getInfoAsync(DATA_DIR);
  if (!info.exists) {
    await FileSystem.makeDirectoryAsync(DATA_DIR, { intermediates: true });
  }
}

function generateId(): string {
  return `${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;
}

function serialiseSamples(
  channels      : string[],
  buffers       : Map<string, Float32Array>,
  startSampleIdx: number,
  numSamples    : number,
  label         : 'preictal' | 'ictal' | 'normal' | 'false_positive',
  baseTimestampMs: number,
  samplingRate  : number,
): string {
  const rows: string[] = [
    'timestamp_ms,channel,sample_index,label,amplitude_uV',
  ];

  for (const ch of channels) {
    const buf = buffers.get(ch);
    if (!buf) continue;
    for (let i = 0; i < numSamples && i < buf.length; i++) {
      const absIdx = startSampleIdx + i;
      const tMs    = (baseTimestampMs + (i / samplingRate) * 1000).toFixed(2);
      rows.push(`${tMs},${ch},${absIdx},${label},${buf[i].toFixed(4)}`);
    }
  }

  return rows.join('\n') + '\n';
}

export interface SeizureDataPackage {
  seizureId       : string;
  patientId       : string;
  capturedAt      : string;
  preictalFilePath: string;
  ictalFilePath   : string;
  channelNames    : string[];
  samplingRate    : number;
}

export async function collectSeizureData(
  getLongBuffer: (ch: string, secs: number) => Float32Array | null,
  allChannels  : string[],
  samplingRate : number,
  patientId    : string,
): Promise<SeizureDataPackage | null> {

  await ensureDir();

  const IDEAL_TOTAL_SECS  = 21 * 60;
  const MIN_ICTAL_SECS    =  1 * 60;

  const buffers = new Map<string, Float32Array>();
  const channels: string[] = [];

  for (const ch of allChannels) {
    const snap = getLongBuffer(ch, IDEAL_TOTAL_SECS);
    if (snap && snap.length > 0) {
      buffers.set(ch, snap);
      channels.push(ch);
    }
  }

  if (channels.length === 0) return null;

  const totalSamples  = buffers.get(channels[0])!.length;
  const totalSecs     = totalSamples / samplingRate;
  const now           = Date.now();
  const capturedAt    = new Date().toISOString();
  const seizureId     = generateId();

  const ictalSecs     = totalSecs >= 2 * 60 ? MIN_ICTAL_SECS : totalSecs;
  const preictalSecs  = totalSecs - ictalSecs;
  const ictalSamples  = Math.round(ictalSecs    * samplingRate);
  const preictalSamples = totalSamples - ictalSamples;

  const preictalBufs = new Map<string, Float32Array>();
  for (const ch of channels) {
    preictalBufs.set(ch, buffers.get(ch)!.subarray(0, preictalSamples));
  }
  const preictalContent = serialiseSamples(
    channels, preictalBufs, 0, preictalSamples,
    'preictal', now - totalSecs * 1000, samplingRate,
  );

  const ictalBufs = new Map<string, Float32Array>();
  for (const ch of channels) {
    ictalBufs.set(ch, buffers.get(ch)!.subarray(preictalSamples));
  }
  const ictalContent = serialiseSamples(
    channels, ictalBufs, preictalSamples, ictalSamples,
    'ictal', now - ictalSecs * 1000, samplingRate,
  );

  const preictalPath = DATA_DIR + `preictal_${seizureId}.csv`;
  const ictalPath    = DATA_DIR + `ictal_${seizureId}.csv`;

  await Promise.all([
    FileSystem.writeAsStringAsync(preictalPath, preictalContent),
    FileSystem.writeAsStringAsync(ictalPath,    ictalContent),
  ]);

  return {
    seizureId,
    patientId,
    capturedAt,
    preictalFilePath: preictalPath,
    ictalFilePath   : ictalPath,
    channelNames    : channels,
    samplingRate,
  };
}

export interface FalsePositivePackage {
  fpId        : string;
  patientId   : string;
  alarmId     : string;
  alarmType   : string;
  modelTier   : string;
  capturedAt  : string;
  filePath    : string;
  channelNames: string[];
  samplingRate: number;
}

export async function collectFalsePositiveData(
  getLongBuffer: (ch: string, secs: number) => Float32Array | null,
  allChannels  : string[],
  samplingRate : number,
  patientId    : string,
  alarmId      : string,
  alarmType    : string,
  modelTier    : string,
): Promise<FalsePositivePackage | null> {

  await ensureDir();

  const WINDOW_SECS = 5 * 60;

  const buffers  = new Map<string, Float32Array>();
  const channels : string[] = [];

  for (const ch of allChannels) {
    const snap = getLongBuffer(ch, WINDOW_SECS);
    if (snap && snap.length > 0) {
      buffers.set(ch, snap);
      channels.push(ch);
    }
  }

  if (channels.length === 0) return null;

  const fpId      = generateId();
  const now       = Date.now();
  const capturedAt = new Date().toISOString();
  const numSamples = buffers.get(channels[0])!.length;

  const content = serialiseSamples(
    channels, buffers, 0, numSamples,
    'false_positive', now - (numSamples / samplingRate) * 1000, samplingRate,
  );

  const filePath = DATA_DIR + `false_positive_${fpId}.csv`;
  await FileSystem.writeAsStringAsync(filePath, content);

  return {
    fpId,
    patientId,
    alarmId,
    alarmType,
    modelTier,
    capturedAt,
    filePath,
    channelNames: channels,
    samplingRate,
  };
}

export interface NormalDataPackage {
  fileId      : string;
  patientId   : string;
  capturedAt  : string;
  filePath    : string;
  channelNames: string[];
  samplingRate: number;
}

export async function collectNormalData(
  getLongBuffer: (ch: string, secs: number) => Float32Array | null,
  allChannels  : string[],
  samplingRate : number,
  patientId    : string,
): Promise<NormalDataPackage | null> {

  await ensureDir();

  const NORMAL_SECS = 30 * 60;

  const buffers = new Map<string, Float32Array>();
  const channels: string[] = [];

  for (const ch of allChannels) {
    const snap = getLongBuffer(ch, NORMAL_SECS);
    if (snap) {
      buffers.set(ch, snap);
      channels.push(ch);
    }
  }

  if (channels.length === 0) return null;

  const fileId    = generateId();
  const now       = Date.now();
  const capturedAt = new Date().toISOString();

  const content = serialiseSamples(
    channels, buffers, 0, NORMAL_SECS * samplingRate,
    'normal', now - NORMAL_SECS * 1000, samplingRate,
  );

  const filePath = DATA_DIR + `normal_${fileId}.csv`;
  await FileSystem.writeAsStringAsync(filePath, content);

  return {
    fileId,
    patientId,
    capturedAt,
    filePath,
    channelNames: channels,
    samplingRate,
  };
}
