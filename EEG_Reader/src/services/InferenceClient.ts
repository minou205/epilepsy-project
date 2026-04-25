export interface ServerInferenceResult {
  predictorProb     : number | null;
  detectorProb      : number | null;
  predictorLabel    : string | null;
  detectorLabel     : string | null;
  predictorThreshold: number | null;
  detectorThreshold : number | null;
  tier              : string;
  hasPredictor      : boolean;
  hasDetector       : boolean;
}

export async function requestInference(
  serverBaseUrl     : string,
  patientId         : string,
  eegData           : number[][],
  generalModelConfig: string = 'both',
): Promise<ServerInferenceResult> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 10000);

  let resp: Response;
  try {
    resp = await fetch(`${serverBaseUrl}/inference/run`, {
      method : 'POST',
      headers: { 'Content-Type': 'application/json' },
      signal : controller.signal,
      body   : JSON.stringify({
        patient_id          : patientId,
        eeg_data            : eegData,
        sampling_rate       : 256,
        general_model_config: generalModelConfig,
      }),
    });
  } catch (err: any) {
    clearTimeout(timeout);
    if (err?.name === 'AbortError') {
      throw new Error(`Backend unreachable at ${serverBaseUrl} (10s timeout)`);
    }
    throw err;
  }
  clearTimeout(timeout);

  if (!resp.ok) {
    const text = await resp.text().catch(() => '');
    throw new Error(`Inference failed (${resp.status}): ${text.slice(0, 120)}`);
  }

  const j = await resp.json();
  return {
    predictorProb     : j.predictor_prob      ?? null,
    detectorProb      : j.detector_prob       ?? null,
    predictorLabel    : j.predictor_label     ?? null,
    detectorLabel     : j.detector_label      ?? null,
    predictorThreshold: j.predictor_threshold ?? null,
    detectorThreshold : j.detector_threshold  ?? null,
    tier              : j.tier                ?? 'none',
    hasPredictor      : j.has_predictor       ?? false,
    hasDetector       : j.has_detector        ?? false,
  };
}
