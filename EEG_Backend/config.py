import os
import shutil
from pathlib import Path

BASE_DIR     = Path(__file__).parent
STORAGE_DIR  = BASE_DIR / "storage"
EEG_DATA_DIR = STORAGE_DIR / "eeg_data"
MODELS_DIR   = STORAGE_DIR / "models"

GENERAL_MODELS_DIR    = MODELS_DIR / "general"
PATIENT_MODELS_DIR    = MODELS_DIR / "patients"

CHB_MIT_DIR  = BASE_DIR / "data" / "chb_mit"
DB_PATH      = BASE_DIR / "epilepsy.db"
DATABASE_URL = f"sqlite+aiosqlite:///{DB_PATH}"

SUPABASE_URL = os.getenv('SUPABASE_URL', 'https://lgxybjdacsjzbmdsgoxo.supabase.co')
SUPABASE_SERVICE_ROLE_KEY = os.getenv(
    'SUPABASE_SERVICE_ROLE_KEY',
    'YOUR_SUPABASE_SERVICE_ROLE_KEY',
)

SEIZURES_PER_TRAINING = 5
MAX_SEIZURES = 50
UPLOAD_COOLDOWN_SECS = 2 * 60 * 60  # 2 hours
BALANCE_MIN_RATIO = 1

GENERAL_PREDICTOR_PT = GENERAL_MODELS_DIR / "predictor.pt"
GENERAL_DETECTOR_PT  = GENERAL_MODELS_DIR / "detector.pt"

BASE_MODELS_DIR      = MODELS_DIR / "base"
BASE_PREDICTOR_PT    = BASE_MODELS_DIR / "base_predictor_18.pt"
BASE_DETECTOR_PT     = BASE_MODELS_DIR / "base_detector_18.pt"

EXPO_PUSH_URL = "https://exp.host/--/api/v2/push/send"

EEG_DATA_DIR.mkdir(parents=True, exist_ok=True)
GENERAL_MODELS_DIR.mkdir(parents=True, exist_ok=True)
PATIENT_MODELS_DIR.mkdir(parents=True, exist_ok=True)
BASE_MODELS_DIR.mkdir(parents=True, exist_ok=True)
CHB_MIT_DIR.mkdir(parents=True, exist_ok=True)


def patient_model_dir(patient_id: str) -> Path:
    d = PATIENT_MODELS_DIR / patient_id
    d.mkdir(parents=True, exist_ok=True)
    return d


def ensure_patient_models(patient_id: str) -> None:
    d = patient_model_dir(patient_id)
    for name in ("predictor.pt", "detector.pt"):
        dest = d / name
        src  = GENERAL_MODELS_DIR / name
        if not dest.exists() and src.exists():
            shutil.copy2(src, dest)


def patient_predictor_path(patient_id: str, tier: str | None = None) -> Path:
    d = patient_model_dir(patient_id)
    if tier and tier != "general":
        return d / f"{tier}_predictor.pt"
    return d / "predictor.pt"


def patient_detector_path(patient_id: str, tier: str | None = None) -> Path:
    d = patient_model_dir(patient_id)
    if tier and tier != "general":
        return d / f"{tier}_detector.pt"
    return d / "detector.pt"
