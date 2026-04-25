export interface HeadsetInfo {
  patientId    : string;
  headsetName  : string;
  nChannels    : number;
  channelNames : string[];
  samplingRate : number;
}

interface RawHeadsetInfo {
  patient_id    : string;
  headset_name  : string;
  n_channels    : number;
  channel_names : string[];
  sampling_rate : number;
}

function normalize(raw: RawHeadsetInfo): HeadsetInfo {
  return {
    patientId   : raw.patient_id,
    headsetName : raw.headset_name,
    nChannels   : raw.n_channels,
    channelNames: raw.channel_names,
    samplingRate: raw.sampling_rate,
  };
}

export async function fetchHeadset(
  serverUrl: string,
  patientId: string,
): Promise<HeadsetInfo | null> {
  const url = `${serverUrl}/headset/${encodeURIComponent(patientId)}`;
  const resp = await fetch(url, {
    method : 'GET',
    headers: { 'Accept': 'application/json' },
  });
  if (!resp.ok) {
    throw new Error(`[HeadsetClient] GET /headset/${patientId} → ${resp.status}`);
  }
  const body = await resp.json();
  if (body == null) return null;
  return normalize(body as RawHeadsetInfo);
}

export async function resetHeadset(
  serverUrl: string,
  patientId: string,
): Promise<void> {
  const url = `${serverUrl}/headset/${encodeURIComponent(patientId)}/reset`;
  const resp = await fetch(url, { method: 'POST' });
  if (!resp.ok) {
    throw new Error(`[HeadsetClient] POST reset → ${resp.status}`);
  }
}

export async function renameHeadset(
  serverUrl: string,
  patientId: string,
  headsetName: string,
): Promise<void> {
  const url = `${serverUrl}/headset/${encodeURIComponent(patientId)}/rename`;
  const resp = await fetch(url, {
    method : 'PATCH',
    headers: {
      'Content-Type': 'application/json',
      'Accept'      : 'application/json',
    },
    body: JSON.stringify({ headset_name: headsetName }),
  });
  if (!resp.ok) {
    throw new Error(`[HeadsetClient] PATCH rename → ${resp.status}`);
  }
}
