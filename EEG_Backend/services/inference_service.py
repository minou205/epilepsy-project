"""
Inference service - Streamlined to perfectly match the notebook's seizure_alarm_system()
Optimized for real-time streaming, preventing memory leaks and infinite alarms.

KEY FIX (2026-04-09): The bandpass filter (sosfiltfilt, 0.5-50 Hz) MUST be applied
to a long accumulated buffer, NOT to each 5-second window independently.
Filtering a tiny window produces massive edge artifacts that cause false alarms.
The notebook filters the ENTIRE recording first, then extracts windows — we emulate
this by maintaining a rolling raw EEG buffer per patient.
"""
import logging
import numpy as np
import torch
import torch.nn.functional as F
from pathlib import Path
from collections import deque
from typing import Optional

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from config import (
    GENERAL_PREDICTOR_PT, GENERAL_DETECTOR_PT,
    patient_predictor_path, patient_detector_path, ensure_patient_models,
)
from models.model_artifact import ModelArtifact

# Import notebook modules
from services.personal_detection import (
    build_model as build_detection_model,
    SequenceWGANDiscriminator as DetectionDiscriminator,
    apply_clep_filter as detection_clep,
    DELTA0_S as DELTA0_S_DETECTION,
    DISC_FEATURE_DIM,
    WGAN_SEQ_LEN as WGAN_SEQ_LEN_DETECTION,
    FS, CLEN, MA_S, N_CH,
)

from services.personal_prediction import (
    build_model as build_prediction_model,
    SequenceWGANDiscriminator as PredictionDiscriminator,
    apply_clep_filter as prediction_clep,
    DELTA0_S as DELTA0_S_PREDICTION,
    WGAN_SEQ_LEN as WGAN_SEQ_LEN_PREDICTION,
)

logger = logging.getLogger(__name__)

# ── Buffer Configuration ─────────────────────────────────────────────────────
# The bandpass filter needs a long signal context to avoid edge artifacts.
# 60 seconds of data at 256 Hz = 15360 samples — more than enough for the
# 0.5 Hz low-cut (period=2s) to fully stabilize.
RAW_BUFFER_SECONDS = 60
RAW_BUFFER_SAMPLES = RAW_BUFFER_SECONDS * FS  # 15360

# ── Unit Conversion ──────────────────────────────────────────────────────────
# The models were trained on EDF data loaded by MNE, which returns Volts.
# The headset app sends data in microvolts (µV).  We must convert µV → V
# so the normalization (train_ref_mu/std) produces correct values.
UV_TO_V = 1e-6


def adjust_channels(data_np: np.ndarray, expected_channels: int = 18) -> np.ndarray:
    """Dynamically pads or truncates incoming channels to match the model's architecture."""
    current_channels = data_np.shape[0]
    if current_channels == expected_channels:
        return data_np
    
    if current_channels < expected_channels:
        padding = np.zeros((expected_channels - current_channels, data_np.shape[1]))
        return np.vstack((data_np, padding))
    else:
        return data_np[:expected_channels, :]

class ModelCache:
    """Simple model cache - load once, reuse."""
    def __init__(self):
        self._models = {}
        
    def get_or_load(self, key: str, model_path: Path, model_type: str) -> dict:
        if key in self._models:
            return self._models[key]
            
        if not model_path.exists():
            raise FileNotFoundError(f"Model not found: {model_path}")
        
        device = torch.device('cuda' if torch.cuda.is_available() else 'cpu')
        ckpt = torch.load(str(model_path), map_location=device, weights_only=False)
        
        # Read dynamic channel count (defaults to 18 if old model)
        n_channels = int(ckpt.get('n_channels', N_CH)) if isinstance(ckpt, dict) else N_CH
        
        if model_type == 'predictor':
            build_fn = build_prediction_model
            discriminator_cls = PredictionDiscriminator
            seq_len = WGAN_SEQ_LEN_PREDICTION
        else:
            build_fn = build_detection_model
            discriminator_cls = DetectionDiscriminator
            seq_len = WGAN_SEQ_LEN_DETECTION
        
        # Build model with the correct channel count
        model = build_fn(E=n_channels)
        
        if isinstance(ckpt, dict) and 'state_dict' in ckpt:
            model.load_state_dict(ckpt['state_dict'])
        elif isinstance(ckpt, dict):
            model.load_state_dict(ckpt)
        else:
            model = ckpt
            
        model = model.to(device)
        model.eval()
        
        discriminator = None
        disc_calibration = 0.0
        if isinstance(ckpt, dict) and ckpt.get('disc_state_dict'):
            try:
                discriminator = discriminator_cls(DISC_FEATURE_DIM, seq_len)
                discriminator.load_state_dict(ckpt['disc_state_dict'])
                discriminator = discriminator.to(device)
                discriminator.eval()
                disc_calibration = float(ckpt.get('disc_calibration', 0.0))
            except Exception as e:
                logger.warning(f"Failed to load discriminator: {e}")
        
        entry = {
            'model': model,
            'discriminator': discriminator,
            'disc_calibration': disc_calibration,
            'calib_thresh': float(ckpt.get('calib_thresh', 0.5)) if isinstance(ckpt, dict) else 0.5,
            'train_ref_mu': float(ckpt.get('train_ref_mu', 0.0)) if isinstance(ckpt, dict) else 0.0,
            'train_ref_std': float(ckpt.get('train_ref_std', 1.0)) if isinstance(ckpt, dict) else 1.0,
            'n_channels': n_channels,
            'path': str(model_path),
        }
        
        self._models[key] = entry
        return entry
    
    def is_loaded(self, key: str) -> bool:
        return key in self._models
    
    def invalidate(self, patient_id: str):
        """Clears cached models for a patient when a new one is trained."""
        keys_to_remove = [k for k in self._models.keys() if k.startswith(patient_id)]
        for k in keys_to_remove:
            del self._models[k]


model_cache = ModelCache()


async def run_inference(
    patient_id: str,
    eeg_data: list[list[float]],
    general_model_config: str,
    db: AsyncSession,
) -> dict:
    """Run inference on streaming EEG window."""
    device = torch.device('cuda' if torch.cuda.is_available() else 'cpu')
    data_np = np.array(eeg_data, dtype=np.float32)
    
    # Convert from microvolts (headset) to volts (MNE/EDF training units)
    data_np = data_np * UV_TO_V
    
    ensure_patient_models(patient_id)
    
    predictor_entry = None
    detector_entry = None
    tier = 'none'
    
    # TEMP: Force loading from patient directory to test new models
    tier = 'general'
    try:
        pred_path = patient_predictor_path(patient_id)
        if pred_path.exists():
            predictor_entry = model_cache.get_or_load(
                f"{patient_id}_predictor", pred_path, 'predictor'
            )
            logger.info(f"FORCED: Loaded predictor from patient path: {pred_path}")
    except Exception as e:
        logger.error(f"Failed to load patient predictor: {e}")
    
    try:
        det_path = patient_detector_path(patient_id)
        if det_path.exists():
            detector_entry = model_cache.get_or_load(
                f"{patient_id}_detector", det_path, 'detector'
            )
            logger.info(f"FORCED: Loaded detector from patient path: {det_path}")
    except Exception as e:
        logger.error(f"Failed to load patient detector: {e}")
    
    # Original code commented out for testing
    """
    result = await db.execute(
        select(ModelArtifact)
        .where(ModelArtifact.patient_id == patient_id, ModelArtifact.is_active == 1)
        .order_by(ModelArtifact.version_num.desc())
    )
    artifacts = result.scalars().all()
    
    for art in artifacts:
        if art.model_type == 'predictor' and predictor_entry is None:
            try:
                predictor_entry = model_cache.get_or_load(
                    f"{patient_id}_predictor", Path(art.file_path), 'predictor'
                )
                tier = art.tier
                logger.info(f"Loaded predictor from DB artifact: {art.file_path}, tier: {tier}")
            except Exception as e:
                logger.error(f"Failed to load predictor: {e}")
        elif art.model_type == 'detector' and detector_entry is None:
            try:
                detector_entry = model_cache.get_or_load(
                    f"{patient_id}_detector", Path(art.file_path), 'detector'
                )
                tier = art.tier
                logger.info(f"Loaded detector from DB artifact: {art.file_path}, tier: {tier}")
            except Exception as e:
                logger.error(f"Failed to load detector: {e}")
    
    if not predictor_entry and not detector_entry:
        if general_model_config == 'none':
            return _no_models_response()
        
        tier = 'general'
        if general_model_config in ('both', 'prediction_only'):
            try:
                pred_path = patient_predictor_path(patient_id)
                if not pred_path.exists():
                    pred_path = GENERAL_PREDICTOR_PT
                if pred_path.exists():
                    predictor_entry = model_cache.get_or_load(
                        f"{patient_id}_predictor", pred_path, 'predictor'
                    )
                    logger.info(f"Loaded predictor from patient/general path: {pred_path}, tier: {tier}")
            except Exception as e:
                logger.error(f"Failed to load general predictor: {e}")
        
        if general_model_config in ('both', 'detection_only'):
            try:
                det_path = patient_detector_path(patient_id)
                if not det_path.exists():
                    det_path = GENERAL_DETECTOR_PT
                if det_path.exists():
                    detector_entry = model_cache.get_or_load(
                        f"{patient_id}_detector", det_path, 'detector'
                    )
                    logger.info(f"Loaded detector from patient/general path: {det_path}, tier: {tier}")
            except Exception as e:
                logger.error(f"Failed to load general detector: {e}")
    """

    if not predictor_entry and not detector_entry:
        return _no_models_response()
    
    predictor_prob, predictor_label = None, None
    if predictor_entry:
        try:
            predictor_prob, predictor_label = _run_predictor_window(
                predictor_entry, data_np, patient_id, device
            )
        except Exception as e:
            logger.error(f"Predictor failed: {e}")
    
    detector_prob, detector_label = None, None
    if detector_entry:
        try:
            detector_prob, detector_label = _run_detector_window(
                detector_entry, data_np, patient_id, device
            )
        except Exception as e:
            logger.error(f"Detector failed: {e}")
    
    return {
        'predictor_prob': predictor_prob,
        'detector_prob': detector_prob,
        'predictor_label': predictor_label,
        'detector_label': detector_label,
        'tier': tier,
        'has_predictor': predictor_entry is not None,
        'has_detector': detector_entry is not None,
    }

# ============================================================================
# STATEFUL INFERENCE SESSIONS (Fixes Memory Leaks & Real-time Issues)
# ============================================================================

_detector_sessions = {}
_predictor_sessions = {}

def _get_or_create_detector_session(patient_id: str, n_channels: int):
    """Maintains a lightweight, bounded rolling window for real-time detection.
    
    Includes a raw EEG buffer for proper bandpass filtering (matching notebook).
    """
    if patient_id not in _detector_sessions:
        _detector_sessions[patient_id] = {
            # Pre-fill with zeros so the MA doesn't over-react to early values
            'fused_probs': deque([0.0] * MA_S, maxlen=MA_S),
            'consec': 0,
            'emb_buffer': deque(maxlen=WGAN_SEQ_LEN_DETECTION),
            # Raw EEG buffer — accumulates incoming windows so the bandpass
            # filter can operate on a long continuous signal (matching notebook).
            'raw_buffer': np.zeros((n_channels, 0), dtype=np.float32),
        }
    return _detector_sessions[patient_id]

def _get_or_create_predictor_session(patient_id: str, n_channels: int):
    """Maintains a lightweight, bounded rolling window for real-time prediction.
    
    Includes a raw EEG buffer for proper bandpass filtering (matching notebook).
    """
    if patient_id not in _predictor_sessions:
        _predictor_sessions[patient_id] = {
            # Pre-fill with zeros so the MA doesn't over-react to early values
            'fused_probs': deque([0.0] * MA_S, maxlen=MA_S),
            'consec': 0,
            'emb_buffer': deque(maxlen=WGAN_SEQ_LEN_PREDICTION),
            # Raw EEG buffer — accumulates incoming windows so the bandpass
            # filter can operate on a long continuous signal (matching notebook).
            'raw_buffer': np.zeros((n_channels, 0), dtype=np.float32),
        }
    return _predictor_sessions[patient_id]


def _filter_from_buffer(raw_buffer: np.ndarray, filter_fn, clen: int) -> np.ndarray:
    """Apply bandpass filter to the accumulated buffer, return last `clen` samples.
    
    This is the KEY fix: the notebook's seizure_alarm_system() filters the ENTIRE
    recording with sosfiltfilt, then extracts 5-second windows. We emulate this by
    filtering our accumulated buffer (up to 60 seconds) and taking the last window.
    
    With a long buffer, sosfiltfilt's edge artifacts only affect the first/last
    few samples of the buffer — the window we extract from the end is clean.
    """
    filtered = filter_fn(raw_buffer, sfreq=FS)
    return filtered[:, -clen:]


def _run_detector_window(entry: dict, data_np: np.ndarray, patient_id: str, device) -> tuple:
    expected_channels = entry.get('n_channels', 18)
    session = _get_or_create_detector_session(patient_id, expected_channels)
    
    model = entry['model'].to(device)
    alarm_thresh = entry['calib_thresh']
    train_ref_mu = entry['train_ref_mu']
    train_ref_std = entry['train_ref_std']
    disc_calibration = entry.get('disc_calibration', 0.0)
    discriminator = entry.get('discriminator')
    
    # 1. Adjust channels to match model expectation
    adjusted_data = adjust_channels(data_np, expected_channels=expected_channels)
    
    # 2. ACCUMULATE raw samples into the persistent buffer (bounded to 60s)
    session['raw_buffer'] = np.concatenate(
        [session['raw_buffer'], adjusted_data], axis=1
    )[:, -RAW_BUFFER_SAMPLES:]  # Keep last 60 seconds only
    
    # 3. Need at least one full window in the buffer to run inference
    if session['raw_buffer'].shape[1] < CLEN:
        return 0.0, 'normal'
    
    # 4. Filter the ENTIRE accumulated buffer, extract last CLEN samples
    #    This matches the notebook: filter whole recording, then slice windows.
    filtered_window = _filter_from_buffer(session['raw_buffer'], detection_clep, CLEN)
    
    # 5. Normalize using training reference stats (same as notebook)
    norm_data = (filtered_window - train_ref_mu) / (train_ref_std + 1e-8)
    
    win_t = torch.from_numpy(norm_data).float().unsqueeze(0).to(device)
    
    with torch.no_grad():
        feats = model.encode(win_t)
        p_ict = F.softmax(model.fc(feats), dim=1)[0, 1].item()
        
        # Discriminator suppression (identical to notebook)
        suppression = 1.0
        if discriminator is not None:
            session['emb_buffer'].append(feats.squeeze(0).cpu())
            if len(session['emb_buffer']) == WGAN_SEQ_LEN_DETECTION:
                seq = torch.stack(list(session['emb_buffer'])).unsqueeze(0).to(device)
                raw_d = discriminator(seq).item()
                disc_int_p = float(torch.sigmoid(torch.tensor(raw_d - disc_calibration)).item())
                suppression = (1.0 - disc_int_p)
        
        fused_prob = p_ict * suppression
        session['fused_probs'].append(fused_prob)
    
    # 6. Real-time Causal Smoothing
    current_smoothed = float(np.mean(session['fused_probs']))
    
    # 7. Real-time Alarm Check (Stateful, no history looping)
    if current_smoothed >= alarm_thresh:
        session['consec'] += 1
    else:
        session['consec'] = 0
    
    label = 'ictal' if session['consec'] >= DELTA0_S_DETECTION else 'normal'
    
    return current_smoothed, label


def _run_predictor_window(entry: dict, data_np: np.ndarray, patient_id: str, device) -> tuple:
    expected_channels = entry.get('n_channels', 18)
    session = _get_or_create_predictor_session(patient_id, expected_channels)
    
    model = entry['model'].to(device)
    alarm_thresh = entry['calib_thresh']
    train_ref_mu = entry['train_ref_mu']
    train_ref_std = entry['train_ref_std']
    disc_calibration = entry.get('disc_calibration', 0.0)
    discriminator = entry.get('discriminator')
    
    # 1. Adjust channels to match model expectation
    adjusted_data = adjust_channels(data_np, expected_channels=expected_channels)
    
    # 2. ACCUMULATE raw samples into the persistent buffer (bounded to 60s)
    session['raw_buffer'] = np.concatenate(
        [session['raw_buffer'], adjusted_data], axis=1
    )[:, -RAW_BUFFER_SAMPLES:]  # Keep last 60 seconds only
    
    # 3. Need at least one full window in the buffer to run inference
    if session['raw_buffer'].shape[1] < CLEN:
        return 0.0, 'normal'
    
    # 4. Filter the ENTIRE accumulated buffer, extract last CLEN samples
    #    This matches the notebook: filter whole recording, then slice windows.
    filtered_window = _filter_from_buffer(session['raw_buffer'], prediction_clep, CLEN)
    
    # 5. Normalize using training reference stats (same as notebook)
    norm_data = (filtered_window - train_ref_mu) / (train_ref_std + 1e-8)
    
    win_t = torch.from_numpy(norm_data).float().unsqueeze(0).to(device)
    
    with torch.no_grad():
        feats = model.encode(win_t)
        p_pre = F.softmax(model.fc(feats), dim=1)[0, 1].item()
        
        # Discriminator suppression (identical to notebook)
        suppression = 1.0
        if discriminator is not None:
            session['emb_buffer'].append(feats.squeeze(0).cpu())
            if len(session['emb_buffer']) == WGAN_SEQ_LEN_PREDICTION:
                seq = torch.stack(list(session['emb_buffer'])).unsqueeze(0).to(device)
                raw_d = discriminator(seq).item()
                disc_int_p = float(torch.sigmoid(torch.tensor(raw_d - disc_calibration)).item())
                suppression = (1.0 - disc_int_p)
        
        fused_prob = p_pre * suppression
        session['fused_probs'].append(fused_prob)
    
    # 6. Real-time Causal Smoothing
    current_smoothed = float(np.mean(session['fused_probs']))
    
    # 7. Real-time Alarm Check
    if current_smoothed >= alarm_thresh:
        session['consec'] += 1
    else:
        session['consec'] = 0
    
    label = 'preictal' if session['consec'] >= DELTA0_S_PREDICTION else 'normal'
    
    return current_smoothed, label


def _no_models_response() -> dict:
    return {
        'predictor_prob': None,
        'detector_prob': None,
        'predictor_label': None,
        'detector_label': None,
        'tier': 'none',
        'has_predictor': False,
        'has_detector': False,
    }