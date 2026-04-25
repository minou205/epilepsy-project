import json
import logging
import shutil
import uuid
from datetime import datetime, timezone
from pathlib import Path

from fastapi import APIRouter, Depends, File, Form, UploadFile, HTTPException
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy import func, select

from config import (
    EEG_DATA_DIR, SEIZURES_PER_TRAINING, MAX_SEIZURES,
    UPLOAD_COOLDOWN_SECS, BALANCE_MIN_RATIO,
)

logger = logging.getLogger(__name__)
from database import get_db
from models.seizure_event import SeizureEvent, NormalDataFile, FalsePositiveEvent
from models.model_artifact import ModelArtifact
from services.training_service import enqueue_training
from services.headset_service import register_or_validate, HeadsetMismatchError

router = APIRouter(prefix="/data", tags=["data"])


def _now() -> str:
    return datetime.now(timezone.utc).isoformat()


async def _save_upload(upload: UploadFile, dest: Path) -> None:
    dest.parent.mkdir(parents=True, exist_ok=True)
    with dest.open("wb") as f:
        shutil.copyfileobj(upload.file, f)


async def _validate_headset(
    db: AsyncSession,
    patient_id: str,
    channel_names_json: str,
    sampling_rate: int,
) -> None:
    try:
        ch_list = json.loads(channel_names_json)
    except (json.JSONDecodeError, TypeError):
        logger.warning(f"[upload] patient={patient_id} rejected: channel_names JSON invalid: {channel_names_json!r}")
        raise HTTPException(400, "channel_names must be a JSON array of strings")

    if not isinstance(ch_list, list) or not all(isinstance(c, str) for c in ch_list):
        logger.warning(f"[upload] patient={patient_id} rejected: channel_names shape wrong: {ch_list!r}")
        raise HTTPException(400, "channel_names must be a JSON array of strings")

    logger.info(f"[upload] patient={patient_id} channels={len(ch_list)} names={ch_list}")

    try:
        await register_or_validate(db, patient_id, ch_list, sampling_rate)
    except HeadsetMismatchError as exc:
        raise HTTPException(
            status_code=409,
            detail={
                "error"   : "headset_mismatch",
                "expected": exc.expected,
                "got"     : exc.got,
                "message" : "Uploaded channels differ from your registered headset.",
            },
        )
    except ValueError as exc:
        logger.warning(f"[upload] patient={patient_id} rejected: {exc}")
        raise HTTPException(400, str(exc))


async def _check_cooldown(
    db: AsyncSession,
    patient_id: str,
    data_type: str,
) -> None:
    if data_type == 'seizure':
        q = (select(SeizureEvent.uploaded_at)
             .where(SeizureEvent.patient_id == patient_id)
             .order_by(SeizureEvent.uploaded_at.desc())
             .limit(1))
    else:
        q = (select(NormalDataFile.uploaded_at)
             .where(NormalDataFile.patient_id == patient_id)
             .order_by(NormalDataFile.uploaded_at.desc())
             .limit(1))

    result = await db.execute(q)
    last_ts = result.scalar_one_or_none()
    if last_ts is None:
        return

    try:
        last_dt = datetime.fromisoformat(last_ts)
    except (ValueError, TypeError):
        return

    now       = datetime.now(timezone.utc)
    elapsed   = (now - last_dt).total_seconds()
    remaining = UPLOAD_COOLDOWN_SECS - elapsed

    if remaining > 0:
        mins = int(remaining // 60) + 1
        raise HTTPException(
            status_code=429,
            detail={
                "error"          : "cooldown",
                "data_type"      : data_type,
                "remaining_secs" : int(remaining),
                "message"        : f"Please wait {mins} more minute{'s' if mins != 1 else ''} "
                                   f"before recording more {data_type} data.",
            },
        )


async def _get_data_balance(
    db: AsyncSession,
    patient_id: str,
) -> dict:
    seizure_result = await db.execute(
        select(func.count()).where(SeizureEvent.patient_id == patient_id)
    )
    seizure_count = seizure_result.scalar() or 0

    normal_result = await db.execute(
        select(func.count()).where(NormalDataFile.patient_id == patient_id)
    )
    normal_count = normal_result.scalar() or 0

    needs_normal = (
        seizure_count > 0
        and (normal_count < seizure_count * BALANCE_MIN_RATIO)
    )
    balanced = (
        seizure_count > 0
        and normal_count > 0
        and normal_count >= seizure_count * BALANCE_MIN_RATIO
    )

    return {
        "seizure_count": seizure_count,
        "normal_count" : normal_count,
        "needs_normal"  : needs_normal,
        "balanced"      : balanced,
    }


@router.post("/seizure")
async def upload_seizure(
    patient_id        : str        = Form(...),
    seizure_id        : str        = Form(...),
    captured_at       : str        = Form(...),
    channel_names     : str        = Form(...),
    sampling_rate     : int        = Form(256),
    train_next_version: bool       = Form(True),
    preictal_file     : UploadFile = File(...),
    ictal_file        : UploadFile = File(...),
    db                : AsyncSession = Depends(get_db),
):
    await _validate_headset(db, patient_id, channel_names, sampling_rate)
    await _check_cooldown(db, patient_id, 'seizure')

    preictal_dest = EEG_DATA_DIR / patient_id / f"preictal_{seizure_id}.csv"
    ictal_dest    = EEG_DATA_DIR / patient_id / f"ictal_{seizure_id}.csv"

    await _save_upload(preictal_file, preictal_dest)
    await _save_upload(ictal_file,    ictal_dest)

    event = SeizureEvent(
        seizure_id   =seizure_id,
        patient_id   =patient_id,
        captured_at  =captured_at,
        preictal_file=str(preictal_dest),
        ictal_file   =str(ictal_dest),
        channel_names=channel_names,
        sampling_rate=sampling_rate,
        uploaded_at  =_now(),
    )
    db.add(event)
    await db.commit()

    result = await db.execute(
        select(func.count()).where(SeizureEvent.patient_id == patient_id)
    )
    seizure_count = result.scalar() or 0

    balance = await _get_data_balance(db, patient_id)

    training_queued         = False
    training_blocked_reason = None
    max_reached             = seizure_count >= MAX_SEIZURES

    at_training_boundary = (
        seizure_count > 0
        and seizure_count % SEIZURES_PER_TRAINING == 0
        and not max_reached
    )
    if at_training_boundary:
        if not train_next_version:
            training_blocked_reason = "user_opted_out"
        elif balance["balanced"]:
            version_num = seizure_count // SEIZURES_PER_TRAINING
            tier        = f"v{version_num}"
            await enqueue_training(db, patient_id, tier, version_num)
            training_queued = True
        else:
            training_blocked_reason = "insufficient_normal_data"

    ask_satisfaction = (
        seizure_count > 0
        and seizure_count % SEIZURES_PER_TRAINING == 0
        and seizure_count <= MAX_SEIZURES
    )

    return {
        "seizure_count"          : seizure_count,
        "normal_count"           : balance["normal_count"],
        "training_queued"        : training_queued,
        "training_blocked_reason": training_blocked_reason,
        "needs_normal"           : balance["needs_normal"],
        "max_reached"            : max_reached,
        "ask_satisfaction"       : ask_satisfaction,
        "next_train_at"          : (
            (seizure_count // SEIZURES_PER_TRAINING + 1) * SEIZURES_PER_TRAINING
        ),
    }


@router.post("/normal")
async def upload_normal(
    patient_id   : str        = Form(...),
    file_id      : str        = Form(...),
    captured_at  : str        = Form(...),
    channel_names: str        = Form(...),
    sampling_rate: int        = Form(256),
    eeg_file     : UploadFile = File(...),
    db           : AsyncSession = Depends(get_db),
):
    await _validate_headset(db, patient_id, channel_names, sampling_rate)
    await _check_cooldown(db, patient_id, 'normal')

    dest = EEG_DATA_DIR / patient_id / f"normal_{file_id}.csv"
    await _save_upload(eeg_file, dest)

    record = NormalDataFile(
        file_id      =file_id,
        patient_id   =patient_id,
        captured_at  =captured_at,
        eeg_file     =str(dest),
        channel_names=channel_names,
        sampling_rate=sampling_rate,
        uploaded_at  =_now(),
    )
    db.add(record)
    await db.commit()
    return {"ok": True}


@router.post("/false_positive")
async def upload_false_positive(
    patient_id   : str        = Form(...),
    fp_id        : str        = Form(...),
    alarm_id     : str        = Form(""),
    alarm_type   : str        = Form(""),
    model_tier   : str        = Form(""),
    captured_at  : str        = Form(...),
    channel_names: str        = Form(...),
    sampling_rate: int        = Form(256),
    eeg_file     : UploadFile = File(...),
    db           : AsyncSession = Depends(get_db),
):
    await _validate_headset(db, patient_id, channel_names, sampling_rate)

    dest = EEG_DATA_DIR / patient_id / "false_positives" / f"false_positive_{fp_id}.csv"
    await _save_upload(eeg_file, dest)

    record = FalsePositiveEvent(
        fp_id        =fp_id,
        patient_id   =patient_id,
        alarm_id     =alarm_id     or None,
        alarm_type   =alarm_type   or None,
        model_tier   =model_tier   or None,
        captured_at  =captured_at,
        eeg_file     =str(dest),
        channel_names=channel_names,
        sampling_rate=sampling_rate,
        uploaded_at  =_now(),
    )
    db.add(record)
    await db.commit()

    fp_result = await db.execute(
        select(func.count()).where(FalsePositiveEvent.patient_id == patient_id)
    )
    fp_count = fp_result.scalar() or 0

    return {"ok": True, "fp_count": fp_count}


@router.get("/counts/{patient_id}")
async def get_data_counts(patient_id: str, db: AsyncSession = Depends(get_db)):
    balance = await _get_data_balance(db, patient_id)

    fp_result = await db.execute(
        select(func.count()).where(FalsePositiveEvent.patient_id == patient_id)
    )
    fp_count = fp_result.scalar() or 0

    active_result = await db.execute(
        select(ModelArtifact.tier)
        .where(ModelArtifact.patient_id == patient_id, ModelArtifact.is_active == 1)
        .order_by(ModelArtifact.version_num.desc())
        .limit(1)
    )
    active_tier = active_result.scalar_one_or_none() or "none"

    pending_result = await db.execute(
        select(func.count())
        .where(ModelArtifact.patient_id == patient_id, ModelArtifact.is_active == 2)
    )
    pending_count = pending_result.scalar() or 0

    return {
        "seizure_count"       : balance["seizure_count"],
        "normal_count"        : balance["normal_count"],
        "false_positive_count": fp_count,
        "needs_normal"        : balance["needs_normal"],
        "balanced"            : balance["balanced"],
        "next_train_at"       : (
            (balance["seizure_count"] // SEIZURES_PER_TRAINING + 1) * SEIZURES_PER_TRAINING
        ),
        "active_tier"         : active_tier,
        "pending_acceptance"  : pending_count > 0,
    }
