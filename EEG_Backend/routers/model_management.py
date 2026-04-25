import re
import shutil
from pathlib import Path

from fastapi import APIRouter, Depends, HTTPException

from fastapi.responses import FileResponse
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy import select

from config import MODELS_DIR
from database import get_db
from models.model_artifact import ModelArtifact
from pydantic import BaseModel
from services.inference_service import model_cache


class DeleteModelsRequest(BaseModel):
    patient_id: str


class ReloadModelsRequest(BaseModel):
    patient_id: str


router = APIRouter(prefix="/models", tags=["models"])


def _tier_version_num(tier: str) -> int:
    if tier == "general":
        return 0
    m = re.match(r"^v(\d+)$", tier, re.IGNORECASE)
    return int(m.group(1)) if m else -1


def _tier_label(tier: str) -> str:
    if tier == "general":
        return "General"
    m = re.match(r"^v(\d+)$", tier, re.IGNORECASE)
    return f"Personal V{m.group(1)}" if m else tier.capitalize()


@router.post("/reload-models")
async def reload_models(req: ReloadModelsRequest):
    patient_id = req.patient_id
    was_loaded = model_cache.is_loaded(f"{patient_id}_predictor") or \
                 model_cache.is_loaded(f"{patient_id}_detector")
    model_cache.invalidate(patient_id)
    return {
        "patient_id": patient_id,
        "cache_cleared": True,
        "was_cached": was_loaded,
        "message": (
            f"Cache cleared for patient {patient_id}. "
            "New model files will be loaded on the next inference request."
        ),
    }


@router.get("/check")
async def check_models(patient_id: str, db: AsyncSession = Depends(get_db)):
    result = await db.execute(
        select(ModelArtifact)
        .where(
            ModelArtifact.patient_id == patient_id,
            ModelArtifact.is_active  == 1,
        )
        .order_by(ModelArtifact.version_num.desc())
    )
    artifacts = result.scalars().all()

    if not artifacts:
        return {
            "tier"         : "none",
            "version_num"  : 0,
            "version_label": "No Model",
            "predictor_url": None,
            "detector_url" : None,
        }

    best_version_num = max(_tier_version_num(a.tier) for a in artifacts)
    best_tier = next(
        (a.tier for a in artifacts if _tier_version_num(a.tier) == best_version_num),
        "none",
    )

    predictor = next(
        (a for a in artifacts if a.tier == best_tier and a.model_type == "predictor"),
        None,
    )
    detector = next(
        (a for a in artifacts if a.tier == best_tier and a.model_type == "detector"),
        None,
    )

    predictor_rel = f"prediction/{Path(predictor.file_path).name}" if predictor else None
    detector_rel  = f"detection/{Path(detector.file_path).name}"   if detector  else None

    base_url = "/models/download"
    return {
        "tier"         : best_tier,
        "version_num"  : best_version_num,
        "version_label": _tier_label(best_tier),
        "predictor_url": f"{base_url}/{predictor_rel}" if predictor_rel else None,
        "detector_url" : f"{base_url}/{detector_rel}"  if detector_rel  else None,
    }


@router.get("/download/{file_path:path}")
async def download_model(file_path: str):
    path = (MODELS_DIR / file_path).resolve()

    try:
        path.relative_to(MODELS_DIR.resolve())
    except ValueError:
        raise HTTPException(400, "Invalid file path")

    if not path.exists():
        raise HTTPException(404, f"Model file not found: {file_path}")

    return FileResponse(
        path=str(path),
        media_type="application/octet-stream",
        filename=path.name,
    )


@router.post("/delete")
async def delete_models(req: DeleteModelsRequest, db: AsyncSession = Depends(get_db)):
    patient_id = req.patient_id

    try:
        from config import patient_model_dir, PATIENT_MODELS_DIR

        patient_dir = PATIENT_MODELS_DIR / patient_id

        if patient_dir.exists():
            shutil.rmtree(patient_dir)

        from sqlalchemy import update
        stmt = (
            update(ModelArtifact)
            .where(
                ModelArtifact.patient_id == patient_id,
                ModelArtifact.tier != "general",
            )
            .values(is_active=0)
        )
        await db.execute(stmt)
        await db.commit()

        return {
            "deleted"  : True,
            "patient_id": patient_id,
            "message"  : "All personal models deleted successfully. General models will be used for inference.",
        }
    except Exception as exc:
        raise HTTPException(500, f"Failed to delete models: {exc}")
