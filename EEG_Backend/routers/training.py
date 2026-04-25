import threading

from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy import select

from database import get_db
from models.model_artifact import TrainingJob, ModelArtifact

router = APIRouter(prefix="/training", tags=["training"])

_base_training_state = {"status": "idle", "error": None}


@router.get("/status")
async def get_training_status(patient_id: str, db: AsyncSession = Depends(get_db)):
    from services.training_service import get_patient_training_status
    return await get_patient_training_status(db, patient_id)


@router.post("/accept/{patient_id}")
async def accept_patient_models(patient_id: str, db: AsyncSession = Depends(get_db)):
    from services.training_service import accept_models
    result = await accept_models(db, patient_id)

    if result["accepted"] == 0:
        raise HTTPException(404, "No pending models to accept for this patient.")

    return result


@router.get("/queue")
async def get_queue_status(db: AsyncSession = Depends(get_db)):
    result = await db.execute(
        select(TrainingJob)
        .where(TrainingJob.status.in_(['pending', 'running']))
        .order_by(TrainingJob.queued_at.asc())
    )
    jobs = result.scalars().all()

    return {
        "queue_length": len(jobs),
        "jobs": [
            {
                "job_id"    : j.job_id,
                "patient_id": j.patient_id,
                "tier"      : j.tier,
                "model_type": j.model_type,
                "status"    : j.status,
                "queued_at" : j.queued_at,
                "started_at": j.started_at,
            }
            for j in jobs
        ],
    }


@router.post("/base-model")
async def train_base_models(
    epochs    : int = 50,
    n_channels: int = 18,
    mode      : str = "both",
    channels  : str | None = None,
):
    if _base_training_state["status"] == "running":
        raise HTTPException(409, "Base model training is already in progress.")

    if mode not in ("both", "prediction", "detection"):
        raise HTTPException(400, "mode must be 'both', 'prediction', or 'detection'")

    channel_names: list[str] | None = None
    if channels:
        channel_names = [c.strip() for c in channels.split(',') if c.strip()]
        if not channel_names:
            raise HTTPException(400, "channels parsed to an empty list")
        n_channels = len(channel_names)

    _base_training_state["status"] = "running"
    _base_training_state["error"]  = None

    thread = threading.Thread(
        target=_run_base_training,
        args=(epochs, n_channels, mode, channel_names),
        daemon=True,
    )
    thread.start()

    return {
        "status"       : "started",
        "epochs"       : epochs,
        "n_channels"   : n_channels,
        "channel_names": channel_names,
        "mode"         : mode,
    }


def _run_base_training(
    epochs       : int,
    n_channels   : int,
    mode         : str,
    channel_names: list[str] | None,
):
    try:
        from config import CHB_MIT_DIR, BASE_MODELS_DIR
        from services.base_model_training import train_base_model, train_all_base_models

        if mode == "both":
            train_all_base_models(
                CHB_MIT_DIR, BASE_MODELS_DIR,
                n_channels=n_channels, epochs=epochs,
                channel_names=channel_names,
            )
        else:
            filename = f'base_predictor_{n_channels}.pt' if mode == 'prediction' else f'base_detector_{n_channels}.pt'
            train_base_model(
                mode=mode,
                chb_mit_dir=CHB_MIT_DIR,
                output_path=BASE_MODELS_DIR / filename,
                n_channels=n_channels,
                epochs=epochs,
                channel_names=channel_names,
            )

        _base_training_state["status"] = "complete"
    except Exception as exc:
        _base_training_state["status"] = "failed"
        _base_training_state["error"]  = str(exc)


@router.get("/base-model/status")
async def base_model_status():
    from config import BASE_MODELS_DIR
    import torch

    def _summarize(pt_file):
        try:
            ckpt = torch.load(str(pt_file), map_location='cpu', weights_only=False)
        except Exception:
            return {"file": pt_file.name, "readable": False}
        if not isinstance(ckpt, dict):
            return {"file": pt_file.name, "readable": False}
        return {
            "file"           : pt_file.name,
            "readable"       : True,
            "mode"           : ckpt.get('mode'),
            "version"        : ckpt.get('base_version', 'unknown'),
            "n_channels"     : ckpt.get('n_channels'),
            "channel_names"  : ckpt.get('channel_names'),
            "pretrain_epochs": ckpt.get('pretrain_epochs'),
            "created_at"     : ckpt.get('created_at'),
        }

    predictors = []
    detectors  = []
    if BASE_MODELS_DIR.is_dir():
        for pt_file in sorted(BASE_MODELS_DIR.glob('base_predictor*.pt')):
            predictors.append(_summarize(pt_file))
        for pt_file in sorted(BASE_MODELS_DIR.glob('base_detector*.pt')):
            detectors.append(_summarize(pt_file))

    return {
        "training_status": _base_training_state["status"],
        "training_error" : _base_training_state["error"],
        "predictors"     : predictors,
        "detectors"      : detectors,
    }


@router.get("/models/{patient_id}")
async def get_patient_models(patient_id: str, db: AsyncSession = Depends(get_db)):
    result = await db.execute(
        select(ModelArtifact)
        .where(ModelArtifact.patient_id == patient_id)
        .order_by(ModelArtifact.version_num.desc())
    )
    artifacts = result.scalars().all()

    return [
        {
            "id": a.id,
            "tier": a.tier,
            "version_num": a.version_num,
            "model_type": a.model_type,
            "is_active": a.is_active,
            "base_model_version": a.base_model_version,
            "created_at": a.created_at,
        }
        for a in artifacts
    ]
