import os
import shutil
from pathlib import Path

BASE_DIR     = Path(__file__).parent
STORAGE_DIR  = BASE_DIR / "storage"
EEG_DATA_DIR = STORAGE_DIR / "eeg_data"
MODELS_DIR   = STORAGE_DIR / "models"

# ── Model directory layout ───────────────────────────────────────────────────
# storage/models/
#   general/            ← shared baseline models (placed manually)
#     predictor.pt
#     detector.pt
#   patients/           ← per-patient isolation
#     {patient_id}/
#       predictor.pt    ← starts as copy of general, replaced by personal after training
#       detector.pt
#       v1_predictor.pt ← personal v1 (after 5 seizures)
#       v1_detector.pt
#       v2_predictor.pt ← personal v2 (after 10 seizures), etc.

GENERAL_MODELS_DIR    = MODELS_DIR / "general"
PATIENT_MODELS_DIR    = MODELS_DIR / "patients"

# Legacy flat dirs (kept for backward compat during migration)
MODELS_PREDICTION_DIR = MODELS_DIR / "prediction"
MODELS_DETECTION_DIR  = MODELS_DIR / "detection"

CHB_MIT_DIR  = BASE_DIR / "data" / "chb_mit"
DB_PATH      = BASE_DIR / "ehss.db"
DATABASE_URL = f"sqlite+aiosqlite:///{DB_PATH}"

SUPABASE_URL = os.getenv('SUPABASE_URL', 'https://YOUR_PROJECT_ID.supabase.co')
SUPABASE_SERVICE_ROLE_KEY = os.getenv(
    'SUPABASE_SERVICE_ROLE_KEY',
    'YOUR_SUPABASE_SERVICE_ROLE_KEY',
)

# Incremental training: trigger a new personal model every N confirmed seizures.
SEIZURES_PER_TRAINING = 5

# Maximum seizures before we stop training (prevents overfitting).
MAX_SEIZURES = 50

# General .pt model paths (placed manually by the user)
GENERAL_PREDICTOR_PT = GENERAL_MODELS_DIR / "predictor.pt"
GENERAL_DETECTOR_PT  = GENERAL_MODELS_DIR / "detector.pt"

# Expo Push Notification API
EXPO_PUSH_URL = "https://exp.host/--/api/v2/push/send"

# Ensure storage directories exist
EEG_DATA_DIR.mkdir(parents=True, exist_ok=True)
GENERAL_MODELS_DIR.mkdir(parents=True, exist_ok=True)
PATIENT_MODELS_DIR.mkdir(parents=True, exist_ok=True)
MODELS_PREDICTION_DIR.mkdir(parents=True, exist_ok=True)
MODELS_DETECTION_DIR.mkdir(parents=True, exist_ok=True)
CHB_MIT_DIR.mkdir(parents=True, exist_ok=True)


# ── Per-patient helpers ──────────────────────────────────────────────────────

def patient_model_dir(patient_id: str) -> Path:
    """Return (and create) the per-patient model directory."""
    d = PATIENT_MODELS_DIR / patient_id
    d.mkdir(parents=True, exist_ok=True)
    return d


def ensure_patient_models(patient_id: str) -> None:
    """Copy general models into a patient's directory if they don't have any yet."""
    d = patient_model_dir(patient_id)
    for name in ("predictor.pt", "detector.pt"):
        dest = d / name
        src  = GENERAL_MODELS_DIR / name
        if not dest.exists() and src.exists():
            shutil.copy2(src, dest)


def patient_predictor_path(patient_id: str, tier: str | None = None) -> Path:
    """Path to a patient's predictor model (active or versioned)."""
    d = patient_model_dir(patient_id)
    if tier and tier != "general":
        return d / f"{tier}_predictor.pt"
    return d / "predictor.pt"


def patient_detector_path(patient_id: str, tier: str | None = None) -> Path:
    """Path to a patient's detector model (active or versioned)."""
    d = patient_model_dir(patient_id)
    if tier and tier != "general":
        return d / f"{tier}_detector.pt"
    return d / "detector.pt"


# ── Auto-migrate legacy flat model files ─────────────────────────────────────
# Move old storage/models/prediction/general_predictor.pt → general/predictor.pt

def _migrate_legacy_models():
    legacy_pred = MODELS_PREDICTION_DIR / "general_predictor.pt"
    legacy_det  = MODELS_DETECTION_DIR  / "general_detector.pt"
    if legacy_pred.exists() and not GENERAL_PREDICTOR_PT.exists():
        shutil.copy2(legacy_pred, GENERAL_PREDICTOR_PT)
    if legacy_det.exists() and not GENERAL_DETECTOR_PT.exists():
        shutil.copy2(legacy_det, GENERAL_DETECTOR_PT)

_migrate_legacy_models()
