"""
Inference endpoint — receives EEG windows from the phone and returns
seizure prediction/detection probabilities using PyTorch .pt models.
"""
from fastapi import APIRouter, Depends
from pydantic import BaseModel, Field
from sqlalchemy.ext.asyncio import AsyncSession
from typing import Optional

from database import get_db
from services.inference_service import run_inference, model_cache
from config import GENERAL_PREDICTOR_PT, GENERAL_DETECTOR_PT

router = APIRouter(prefix="/inference", tags=["inference"])


# ── Request / Response schemas ────────────────────────────────────────────────

class InferenceRequest(BaseModel):
    patient_id: str
    eeg_data: list[list[float]] = Field(
        ...,
        description="[18][1280] — 18 EEG channels × 5 seconds @ 256 Hz",
    )
    sampling_rate: int = 256
    general_model_config: str = Field(
        default='both',
        description="Which general models to use: 'both' | 'prediction_only' | 'detection_only' | 'none'",
    )


class InferenceResponse(BaseModel):
    predictor_prob: Optional[float] = None
    detector_prob: Optional[float] = None
    predictor_label: Optional[str] = None   # 'normal' | 'preictal'
    detector_label: Optional[str] = None    # 'normal' | 'ictal'
    tier: str                                # 'none' | 'general' | 'v1' | 'v2' …
    has_predictor: bool
    has_detector: bool


# ── Endpoint ──────────────────────────────────────────────────────────────────

@router.post("/run", response_model=InferenceResponse)
async def run_inference_endpoint(
    req: InferenceRequest,
    db: AsyncSession = Depends(get_db),
):
    """
    Run seizure prediction and/or detection on a 5-second EEG window.

    The phone sends 18 channels × 1280 samples every ~4 seconds.
    The server loads the appropriate .pt model (personal or general),
    runs a forward pass, and returns probabilities.
    """
    result = await run_inference(
        patient_id=req.patient_id,
        eeg_data=req.eeg_data,
        general_model_config=req.general_model_config,
        db=db,
    )
    return InferenceResponse(**result)


# ── Model status endpoint (for debugging) ────────────────────────────────────

@router.get("/models/status")
async def models_status():
    """
    Returns which general models are available on disk and loaded in cache.
    Useful for debugging "no models" issues from the phone.
    """
    predictor_on_disk = GENERAL_PREDICTOR_PT.exists()
    detector_on_disk  = GENERAL_DETECTOR_PT.exists()
    predictor_cached  = model_cache.is_loaded("general_predictor")
    detector_cached   = model_cache.is_loaded("general_detector")

    return {
        "general_predictor": {
            "path": str(GENERAL_PREDICTOR_PT),
            "exists_on_disk": predictor_on_disk,
            "loaded_in_cache": predictor_cached,
        },
        "general_detector": {
            "path": str(GENERAL_DETECTOR_PT),
            "exists_on_disk": detector_on_disk,
            "loaded_in_cache": detector_cached,
        },
        "summary": (
            "both loaded" if predictor_cached and detector_cached
            else "predictor only" if predictor_cached
            else "detector only" if detector_cached
            else "none loaded"
        ),
    }
