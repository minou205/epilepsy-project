"""
Incremental training pipeline.

Runs personal model training (PyTorch) in a background thread.
Supports unlimited version numbers: V1, V2, V3, … Vn.

Key behaviours
──────────────
• Old personal model artifacts are DEACTIVATED (is_active=0), never deleted,
  so that a rollback or audit is always possible.
• False-positive EEG segments (stored under patient_data_dir/false_positives/)
  are automatically included in training to reduce the False Positive Rate.
• The training functions in personal_prediction.py / personal_detection.py
  receive the patient_data_dir; they are expected to scan for ALL labelled
  files (preictal_*.txt, ictal_*.txt, normal_*.txt, false_positive_*.txt).
"""
import asyncio
import logging
import threading
import uuid
from datetime import datetime, timezone
from pathlib import Path

from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy import select

logger = logging.getLogger(__name__)

from config import (
    MODELS_DIR, MODELS_PREDICTION_DIR, MODELS_DETECTION_DIR,
    EEG_DATA_DIR, CHB_MIT_DIR,
    patient_model_dir, patient_predictor_path, patient_detector_path,
)
from models.model_artifact import TrainingJob, ModelArtifact
from services.inference_service import model_cache


def _now() -> str:
    return datetime.now(timezone.utc).isoformat()


async def enqueue_training(
    db         : AsyncSession,
    patient_id : str,
    tier       : str,        # e.g. 'v1', 'v2', 'v3' …
    version_num: int = 1,    # same value as the integer parsed from tier
) -> str:
    """Create a training job record and launch it in a background thread."""
    job_id = str(uuid.uuid4())
    job    = TrainingJob(
        job_id      = job_id,
        patient_id  = patient_id,
        tier        = tier,
        version_num = version_num,
        status      = 'queued',
    )
    db.add(job)
    await db.commit()

    thread = threading.Thread(
        target=_run_training_sync,
        args  =(job_id, patient_id, tier, version_num),
        daemon=True,
    )
    thread.start()
    logger.info(
        f"[training] queued job={job_id} patient={patient_id} "
        f"tier={tier} version={version_num}"
    )
    return job_id


def _run_training_sync(
    job_id     : str,
    patient_id : str,
    tier       : str,
    version_num: int,
) -> None:
    """Synchronous runner (executes in a background thread)."""
    loop = asyncio.new_event_loop()
    asyncio.set_event_loop(loop)
    loop.run_until_complete(_run_training_async(job_id, patient_id, tier, version_num))
    loop.close()


async def _run_training_async(
    job_id     : str,
    patient_id : str,
    tier       : str,
    version_num: int,
) -> None:
    from database import async_session

    async with async_session() as db:
        result = await db.execute(
            select(TrainingJob).where(TrainingJob.job_id == job_id)
        )
        job = result.scalar_one_or_none()
        if not job:
            return

        job.status     = 'running'
        job.started_at = _now()
        await db.commit()

        try:
            predictor_pt, detector_pt = await _train_and_export(
                db, patient_id, tier, version_num
            )

            # ── Deactivate ALL previous model artifacts for this patient ────
            # When personal models arrive, general models are also deactivated
            # so the inference service will only use the new personal models.
            # Old files stay on disk for audit/rollback; only is_active changes.
            old_result = await db.execute(
                select(ModelArtifact).where(
                    ModelArtifact.patient_id == patient_id,
                    ModelArtifact.is_active  == 1,
                )
            )
            for old in old_result.scalars().all():
                old.is_active = 0
            await db.flush()

            # ── Register the new model artifacts (.pt paths) ─────────────────
            for model_type, pt_path in [
                ("predictor", predictor_pt),
                ("detector",  detector_pt),
            ]:
                artifact = ModelArtifact(
                    id          = str(uuid.uuid4()),
                    patient_id  = patient_id,
                    tier        = tier,
                    version_num = version_num,
                    model_type  = model_type,
                    file_path   = str(pt_path),
                    created_at  = _now(),
                    is_active   = 1,
                )
                db.add(artifact)

            job.status       = 'complete'
            job.completed_at = _now()
            await db.commit()

            # ── Invalidate inference cache so next request loads new models ──
            model_cache.invalidate(patient_id)

            logger.info(
                f"[training] complete job={job_id} tier={tier} "
                f"predictor={predictor_pt} detector={detector_pt}"
            )

        except Exception as exc:
            logger.exception(f"[training] FAILED job={job_id}: {exc}")
            job.status    = 'failed'
            job.error_msg = str(exc)
            await db.commit()
            raise


async def _train_and_export(
    db         : AsyncSession,
    patient_id : str,
    tier       : str,
    version_num: int,
):
    """Run full 3-stage training for both predictor and detector models.

    Delegates to personal_prediction.train_predictor() and
    personal_detection.train_detector() which scan patient_data_dir for:
      preictal_*.csv      — confirmed seizure precursors
      ictal_*.csv         — confirmed seizures
      normal_*.csv        — inter-ictal background
      false_positives/
        false_positive_*.csv — user-confirmed non-seizures (golden negatives)

    Models are saved to the per-patient directory:
      storage/models/patients/{patient_id}/{tier}_predictor.pt
      storage/models/patients/{patient_id}/{tier}_detector.pt

    Returns (predictor_pt_path, detector_pt_path).
    """
    from services.personal_training import train_predictor, train_detector
    from services.headset_service import get_headset, get_channel_list

    patient_data_dir = EEG_DATA_DIR / patient_id
    model_dir        = patient_model_dir(patient_id)
    loop             = asyncio.get_event_loop()

    # Fetch the locked headset BEFORE running the training executor.
    # personal_training requires the channel list as an explicit argument
    # (no DB session inside the sync executor).
    headset = await get_headset(db, patient_id)
    if headset is None:
        raise RuntimeError(
            f'[training] cannot train {patient_id}: no headset registered'
        )
    channel_names = get_channel_list(headset)
    headset_name  = headset.headset_name

    # train_predictor saves via _save_checkpoint() into the folder we pass.
    # We pass the per-patient model directory so the .pt lands there.
    await loop.run_in_executor(
        None,
        lambda: train_predictor(
            patient_id, patient_data_dir, CHB_MIT_DIR, str(model_dir), tier,
            channel_names, headset_name,
        ),
    )
    # save_patient_brain writes {folder}/{patient_id}_predictor.pt
    raw_pred = model_dir / f"{patient_id}_predictor.pt"
    # Rename to versioned name: {tier}_predictor.pt (e.g. v1_predictor.pt)
    pred_pt = patient_predictor_path(patient_id, tier)
    if raw_pred.exists():
        raw_pred.rename(pred_pt)
    # Also update the "active" predictor.pt (symlink-like copy for quick access)
    active_pred = model_dir / "predictor.pt"
    if pred_pt.exists():
        import shutil
        shutil.copy2(pred_pt, active_pred)
    logger.info(f"[training] predictor saved → {pred_pt}")

    await loop.run_in_executor(
        None,
        lambda: train_detector(
            patient_id, patient_data_dir, CHB_MIT_DIR, str(model_dir), tier,
            channel_names, headset_name,
        ),
    )
    raw_det = model_dir / f"{patient_id}_detector.pt"
    det_pt = patient_detector_path(patient_id, tier)
    if raw_det.exists():
        raw_det.rename(det_pt)
    active_det = model_dir / "detector.pt"
    if det_pt.exists():
        import shutil
        shutil.copy2(det_pt, active_det)
    logger.info(f"[training] detector  saved → {det_pt}")

    return pred_pt, det_pt
