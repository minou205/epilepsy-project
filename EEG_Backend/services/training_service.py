import asyncio
import logging
import shutil
import uuid
from datetime import datetime, timezone
from pathlib import Path

from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy import select

logger = logging.getLogger(__name__)

from config import (
    MODELS_DIR, EEG_DATA_DIR, CHB_MIT_DIR,
    patient_model_dir, patient_predictor_path, patient_detector_path,
)
from models.model_artifact import TrainingJob, ModelArtifact
from services.inference_service import model_cache


def _now() -> str:
    return datetime.now(timezone.utc).isoformat()


async def enqueue_training(
    db         : AsyncSession,
    patient_id : str,
    tier       : str,
    version_num: int = 1,
) -> list[str]:
    now = _now()
    job_ids = []

    for model_type in ('detector', 'predictor'):
        job_id = str(uuid.uuid4())
        job = TrainingJob(
            job_id      = job_id,
            patient_id  = patient_id,
            tier        = tier,
            version_num = version_num,
            model_type  = model_type,
            status      = 'pending',
            queued_at   = now,
        )
        db.add(job)
        job_ids.append(job_id)

    await db.commit()

    from services.training_queue import training_queue
    training_queue.notify()

    logger.info(
        f"[training] enqueued patient={patient_id} tier={tier} "
        f"version={version_num} → jobs={job_ids}"
    )
    return job_ids


async def process_single_training_job(
    db : AsyncSession,
    job: TrainingJob,
) -> None:
    from services.personal_training import train_predictor, train_detector
    from services.headset_service import get_headset, get_channel_list

    patient_id = job.patient_id
    model_type = job.model_type
    tier       = job.tier
    version_num = job.version_num

    patient_data_dir = EEG_DATA_DIR / patient_id
    model_dir        = patient_model_dir(patient_id)

    headset = await get_headset(db, patient_id)
    if headset is None:
        raise RuntimeError(
            f'cannot train {patient_id}: no headset registered'
        )
    channel_names = get_channel_list(headset)
    headset_name  = headset.headset_name

    loop = asyncio.get_event_loop()

    if model_type == 'predictor':
        result = await loop.run_in_executor(
            None,
            lambda: train_predictor(
                patient_id, patient_data_dir, CHB_MIT_DIR, str(model_dir), tier,
                channel_names, headset_name,
            ),
        )
    else:
        result = await loop.run_in_executor(
            None,
            lambda: train_detector(
                patient_id, patient_data_dir, CHB_MIT_DIR, str(model_dir), tier,
                channel_names, headset_name,
            ),
        )

    _, meta = result

    suffix = 'predictor' if model_type == 'predictor' else 'detector'
    raw_file = model_dir / f"{patient_id}_{suffix}.pt"
    versioned_file = model_dir / f"{tier}_{suffix}.pt"
    if raw_file.exists():
        raw_file.rename(versioned_file)

    base_version = meta.get('base_model_version')

    artifact = ModelArtifact(
        id                 = str(uuid.uuid4()),
        patient_id         = patient_id,
        tier               = tier,
        version_num        = version_num,
        model_type         = model_type,
        file_path          = str(versioned_file),
        created_at         = _now(),
        is_active          = 2,
        base_model_version = base_version,
    )
    db.add(artifact)
    await db.commit()

    logger.info(
        f"[training] {model_type} saved → {versioned_file} "
        f"(is_active=2, pending acceptance)"
    )


async def accept_models(
    db         : AsyncSession,
    patient_id : str,
) -> dict:
    pending_result = await db.execute(
        select(ModelArtifact).where(
            ModelArtifact.patient_id == patient_id,
            ModelArtifact.is_active == 2,
        )
    )
    pending_artifacts = pending_result.scalars().all()

    if not pending_artifacts:
        return {"accepted": 0, "cleaned": 0, "tier": "none"}

    tier = pending_artifacts[0].tier

    active_result = await db.execute(
        select(ModelArtifact).where(
            ModelArtifact.patient_id == patient_id,
            ModelArtifact.is_active == 1,
        )
    )
    old_active = active_result.scalars().all()

    superseded_result = await db.execute(
        select(ModelArtifact).where(
            ModelArtifact.patient_id == patient_id,
            ModelArtifact.is_active == 0,
        )
    )
    old_superseded = superseded_result.scalars().all()

    old_files: list[Path] = []
    for art in old_active + old_superseded:
        p = Path(art.file_path)
        if p.exists():
            old_files.append(p)

    for art in old_active:
        art.is_active = 0

    model_dir = patient_model_dir(patient_id)
    new_paths: set[Path] = set()

    for art in pending_artifacts:
        art.is_active = 1
        new_paths.add(Path(art.file_path).resolve())

        alias = model_dir / f"{art.model_type}.pt"
        src = Path(art.file_path)
        if src.exists():
            shutil.copy2(src, alias)
            new_paths.add(alias.resolve())

    await db.commit()

    keep = new_paths | {
        (model_dir / "predictor.pt").resolve(),
        (model_dir / "detector.pt").resolve(),
    }
    deleted = 0
    for old_path in old_files:
        if old_path.resolve() not in keep:
            try:
                old_path.unlink()
                deleted += 1
            except OSError as e:
                logger.warning(f"[training] could not delete {old_path}: {e}")

    if deleted:
        logger.info(f"[training] cleaned up {deleted} old model file(s) for {patient_id}")

    model_cache.invalidate(patient_id)

    logger.info(
        f"[training] accepted tier={tier} for {patient_id}: "
        f"{len(pending_artifacts)} artifact(s) activated, {deleted} old file(s) deleted"
    )

    return {
        "accepted": len(pending_artifacts),
        "cleaned": deleted,
        "tier": tier,
    }


async def get_patient_training_status(
    db         : AsyncSession,
    patient_id : str,
) -> dict:
    jobs_result = await db.execute(
        select(TrainingJob)
        .where(TrainingJob.patient_id == patient_id)
        .order_by(TrainingJob.queued_at.desc())
    )
    all_jobs = jobs_result.scalars().all()

    latest_tier = all_jobs[0].tier if all_jobs else None
    latest_jobs = [j for j in all_jobs if j.tier == latest_tier] if latest_tier else []

    statuses = [j.status for j in latest_jobs]

    if not statuses:
        overall = 'idle'
    elif 'running' in statuses:
        overall = 'training'
    elif 'pending' in statuses:
        overall = 'pending'
    elif 'failed' in statuses and 'complete' not in statuses:
        overall = 'failed'
    elif all(s == 'complete' for s in statuses):
        overall = 'completed'
    elif 'failed' in statuses:
        overall = 'failed'
    else:
        overall = 'idle'

    pending_result = await db.execute(
        select(ModelArtifact).where(
            ModelArtifact.patient_id == patient_id,
            ModelArtifact.is_active == 2,
        )
    )
    pending_artifacts = pending_result.scalars().all()
    pending_acceptance = len(pending_artifacts) > 0

    job_details = []
    for j in latest_jobs:
        job_details.append({
            "job_id"      : j.job_id,
            "model_type"  : j.model_type,
            "status"      : j.status,
            "queued_at"   : j.queued_at,
            "started_at"  : j.started_at,
            "completed_at": j.completed_at,
            "error_msg"   : j.error_msg,
        })

    error_msg = None
    for j in latest_jobs:
        if j.status == 'failed' and j.error_msg:
            error_msg = j.error_msg
            break

    return {
        "overall_status"    : overall,
        "tier"              : latest_tier or "none",
        "version_num"       : latest_jobs[0].version_num if latest_jobs else 0,
        "pending_acceptance": pending_acceptance,
        "jobs"              : job_details,
        "error_msg"         : error_msg,
    }
