/**
 * Server-side inference client.
 *
 * Sends 18-channel × 1280-sample EEG windows to the backend and receives
 * seizure prediction/detection probabilities. Replaces the old on-device
 * ONNX inference pipeline entirely.
 */

export interface ServerInferenceResult {
  predictorProb : number | null;
  detectorProb  : number | null;
  predictorLabel: string | null;  // 'normal' | 'preictal'
  detectorLabel : string | null;  // 'normal' | 'ictal'
  tier          : string;         // 'none' | 'general' | 'v1' | 'v2' …
  hasPredictor  : boolean;
  hasDetector   : boolean;
}

/**
 * Send an EEG window to the server for inference.
 *
 * @param serverBaseUrl      e.g. "http://192.168.1.42:8000"
 * @param patientId          Supabase user UUID
 * @param eegData            [18][1280] — row-major 18 channels × 5s @ 256 Hz
 * @param generalModelConfig 'both' | 'prediction_only' | 'detection_only' | 'none'
 */
export async function requestInference(
  serverBaseUrl     : string,
  patientId         : string,
  eegData           : number[][],
  generalModelConfig: string = 'both',
): Promise<ServerInferenceResult> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 10000); // 10s timeout

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
    predictorProb : j.predictor_prob  ?? null,
    detectorProb  : j.detector_prob   ?? null,
    predictorLabel: j.predictor_label ?? null,
    detectorLabel : j.detector_label  ?? null,
    tier          : j.tier            ?? 'none',
    hasPredictor  : j.has_predictor   ?? false,
    hasDetector   : j.has_detector    ?? false,
  };
}
