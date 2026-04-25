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

RAW_BUFFER_SECONDS = 60
RAW_BUFFER_SAMPLES = RAW_BUFFER_SECONDS * FS

UV_TO_V = 1e-6


def adjust_channels(data_np: np.ndarray, expected_channels: int = 18) -> np.ndarray:
    current_channels = data_np.shape[0]
    if current_channels == expected_channels:
        return data_np

    if current_channels < expected_channels:
        padding = np.zeros((expected_channels - current_channels, data_np.shape[1]))
        return np.vstack((data_np, padding))
    else:
        return data_np[:expected_channels, :]

class ModelCache:
    def __init__(self):
        self._models = {}

    def get_or_load(self, key: str, model_path: Path, model_type: str) -> dict:
        if key in self._models:
            cached = self._models[key]
            if cached.get('path') != str(model_path):
                logger.info(f"Cache stale for {key}: {cached.get('path')} != {model_path}, reloading")
                del self._models[key]
            else:
                return cached

        if not model_path.exists():
            raise FileNotFoundError(f"Model not found: {model_path}")

        device = torch.device('cuda' if torch.cuda.is_available() else 'cpu')
        ckpt = torch.load(str(model_path), map_location=device, weights_only=False)

        n_channels = int(ckpt.get('n_channels', N_CH)) if isinstance(ckpt, dict) else N_CH

        if model_type == 'predictor':
            build_fn = build_prediction_model
            discriminator_cls = PredictionDiscriminator
            seq_len = WGAN_SEQ_LEN_PREDICTION
        else:
            build_fn = build_detection_model
            discriminator_cls = DetectionDiscriminator
            seq_len = WGAN_SEQ_LEN_DETECTION

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
        keys_to_remove = [k for k in self._models.keys() if k.startswith(patient_id)]
        for k in keys_to_remove:
            del self._models[k]
        reset_patient_sessions(patient_id)


model_cache = ModelCache()


async def run_inference(
    patient_id: str,
    eeg_data: list[list[float]],
    general_model_config: str,
    db: AsyncSession,
) -> dict:
    device = torch.device('cuda' if torch.cuda.is_available() else 'cpu')
    data_np = np.array(eeg_data, dtype=np.float32)

    data_np = data_np * UV_TO_V

    ensure_patient_models(patient_id)

    predictor_entry = None
    detector_entry = None
    tier = 'none'

    result = await db.execute(
        select(ModelArtifact)
        .where(ModelArtifact.patient_id == patient_id, ModelArtifact.is_active == 1)
        .order_by(ModelArtifact.version_num.desc())
    )
    artifacts = result.scalars().all()
    logger.info(f"[inference] patient={patient_id} active_artifacts={len(artifacts)}")

    for art in artifacts:
        path_lower = art.file_path.lower()
        if 'predictor' in path_lower:
            actual_type = 'predictor'
        elif 'detector' in path_lower:
            actual_type = 'detector'
        else:
            actual_type = art.model_type

        if actual_type == 'predictor' and predictor_entry is None:
            try:
                predictor_entry = model_cache.get_or_load(
                    f"{patient_id}_predictor", Path(art.file_path), 'predictor'
                )
                tier = art.tier
                logger.info(f"[inference] loaded PERSONAL predictor tier={art.tier} path={art.file_path}")
            except Exception as e:
                logger.error(f"Failed to load predictor artifact: {e}")
        elif actual_type == 'detector' and detector_entry is None:
            try:
                detector_entry = model_cache.get_or_load(
                    f"{patient_id}_detector", Path(art.file_path), 'detector'
                )
                tier = art.tier
                logger.info(f"[inference] loaded PERSONAL detector tier={art.tier} path={art.file_path}")
            except Exception as e:
                logger.error(f"Failed to load detector artifact: {e}")

    if not predictor_entry and not detector_entry:
        logger.info(f"[inference] no personal artifacts loaded, falling back to GENERAL for {patient_id} (config={general_model_config})")
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
                    logger.info(f"[inference] loaded GENERAL predictor path={pred_path}")
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
                    logger.info(f"[inference] loaded GENERAL detector path={det_path}")
            except Exception as e:
                logger.error(f"Failed to load general detector: {e}")

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
        'predictor_threshold': predictor_entry['calib_thresh'] if predictor_entry else None,
        'detector_threshold': detector_entry['calib_thresh'] if detector_entry else None,
        'tier': tier,
        'has_predictor': predictor_entry is not None,
        'has_detector': detector_entry is not None,
    }


_detector_sessions = {}
_predictor_sessions = {}


def _fresh_session(n_channels: int, seq_len: int, model_path: str) -> dict:
    return {
        'fused_probs': deque([0.0] * MA_S, maxlen=MA_S),
        'consec': 0,
        'emb_buffer': deque(maxlen=seq_len),
        'raw_buffer': np.zeros((n_channels, 0), dtype=np.float32),
        'model_path': model_path,
    }


def _get_or_create_detector_session(patient_id: str, entry: dict):
    n_channels = entry.get('n_channels', 18)
    model_path = entry['path']
    existing = _detector_sessions.get(patient_id)
    if existing is None or existing.get('model_path') != model_path:
        _detector_sessions[patient_id] = _fresh_session(
            n_channels, WGAN_SEQ_LEN_DETECTION, model_path,
        )
    return _detector_sessions[patient_id]


def _get_or_create_predictor_session(patient_id: str, entry: dict):
    n_channels = entry.get('n_channels', 18)
    model_path = entry['path']
    existing = _predictor_sessions.get(patient_id)
    if existing is None or existing.get('model_path') != model_path:
        _predictor_sessions[patient_id] = _fresh_session(
            n_channels, WGAN_SEQ_LEN_PREDICTION, model_path,
        )
    return _predictor_sessions[patient_id]


def reset_patient_sessions(patient_id: str) -> None:
    _detector_sessions.pop(patient_id, None)
    _predictor_sessions.pop(patient_id, None)


def _filter_from_buffer(raw_buffer: np.ndarray, filter_fn, clen: int) -> np.ndarray:
    filtered = filter_fn(raw_buffer, sfreq=FS)
    return filtered[:, -clen:]


def _run_detector_window(entry: dict, data_np: np.ndarray, patient_id: str, device) -> tuple:
    expected_channels = entry.get('n_channels', 18)
    session = _get_or_create_detector_session(patient_id, entry)

    model = entry['model'].to(device)
    alarm_thresh = entry['calib_thresh']
    train_ref_mu = entry['train_ref_mu']
    train_ref_std = entry['train_ref_std']
    disc_calibration = entry.get('disc_calibration', 0.0)
    discriminator = entry.get('discriminator')

    adjusted_data = adjust_channels(data_np, expected_channels=expected_channels)

    session['raw_buffer'] = np.concatenate(
        [session['raw_buffer'], adjusted_data], axis=1
    )[:, -RAW_BUFFER_SAMPLES:]

    if session['raw_buffer'].shape[1] < CLEN:
        return 0.0, 'normal'

    filtered_window = _filter_from_buffer(session['raw_buffer'], detection_clep, CLEN)

    norm_data = (filtered_window - train_ref_mu) / (train_ref_std + 1e-8)

    win_t = torch.from_numpy(norm_data).float().unsqueeze(0).to(device)

    with torch.no_grad():
        feats = model.encode(win_t)
        p_ict = F.softmax(model.fc(feats), dim=1)[0, 1].item()

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

    current_smoothed = float(np.mean(session['fused_probs']))

    if current_smoothed >= alarm_thresh:
        session['consec'] += 1
    else:
        session['consec'] = 0

    label = 'ictal' if session['consec'] >= DELTA0_S_DETECTION else 'normal'

    return current_smoothed, label


def _run_predictor_window(entry: dict, data_np: np.ndarray, patient_id: str, device) -> tuple:
    expected_channels = entry.get('n_channels', 18)
    session = _get_or_create_predictor_session(patient_id, entry)

    model = entry['model'].to(device)
    alarm_thresh = entry['calib_thresh']
    train_ref_mu = entry['train_ref_mu']
    train_ref_std = entry['train_ref_std']
    disc_calibration = entry.get('disc_calibration', 0.0)
    discriminator = entry.get('discriminator')

    adjusted_data = adjust_channels(data_np, expected_channels=expected_channels)

    session['raw_buffer'] = np.concatenate(
        [session['raw_buffer'], adjusted_data], axis=1
    )[:, -RAW_BUFFER_SAMPLES:]

    if session['raw_buffer'].shape[1] < CLEN:
        return 0.0, 'normal'

    filtered_window = _filter_from_buffer(session['raw_buffer'], prediction_clep, CLEN)

    norm_data = (filtered_window - train_ref_mu) / (train_ref_std + 1e-8)

    win_t = torch.from_numpy(norm_data).float().unsqueeze(0).to(device)

    with torch.no_grad():
        feats = model.encode(win_t)
        p_pre = F.softmax(model.fc(feats), dim=1)[0, 1].item()

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

    current_smoothed = float(np.mean(session['fused_probs']))

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
        'predictor_threshold': None,
        'detector_threshold': None,
        'tier': 'none',
        'has_predictor': False,
        'has_detector': False,
    }
