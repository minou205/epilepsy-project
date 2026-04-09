import json
import shutil
import uuid
from datetime import datetime, timezone
from pathlib import Path

from fastapi import APIRouter, Depends, File, Form, UploadFile, BackgroundTasks, HTTPException
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy import func, select

from config import EEG_DATA_DIR, SEIZURES_PER_TRAINING, MAX_SEIZURES
from database import get_db
from models.seizure_event import SeizureEvent, NormalDataFile, FalsePositiveEvent
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
    """Parse channel_names JSON and run register_or_validate.

    Raises HTTPException(400) on bad payload / out-of-range channel count,
    HTTPException(409) on headset mismatch (with structured detail the phone
    can read to show the 'did you change your headset?' modal).
    """
    try:
        ch_list = json.loads(channel_names_json)
    except (json.JSONDecodeError, TypeError):
        raise HTTPException(400, "channel_names must be a JSON array of strings")

    if not isinstance(ch_list, list) or not all(isinstance(c, str) for c in ch_list):
        raise HTTPException(400, "channel_names must be a JSON array of strings")

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
        raise HTTPException(400, str(exc))


# ── Seizure data ───────────────────────────────────────────────────────────────

@router.post("/seizure")
async def upload_seizure(
    background_tasks: BackgroundTasks,
    patient_id     : str        = Form(...),
    seizure_id     : str        = Form(...),
    captured_at    : str        = Form(...),
    channel_names  : str        = Form(...),   # JSON array
    sampling_rate  : int        = Form(256),
    preictal_file  : UploadFile = File(...),
    ictal_file     : UploadFile = File(...),
    db             : AsyncSession = Depends(get_db),
):
    # Validate headset BEFORE writing any files (mismatched uploads are rejected).
    await _validate_headset(db, patient_id, channel_names, sampling_rate)

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

    # Count total confirmed seizures for this patient
    result = await db.execute(
        select(func.count()).where(SeizureEvent.patient_id == patient_id)
    )
    seizure_count = result.scalar() or 0

    training_queued = False
    max_reached     = seizure_count >= MAX_SEIZURES

    # ── Incremental training trigger ──────────────────────────────────────────
    # Fire at every multiple of SEIZURES_PER_TRAINING: seizure 5 → V1,
    # seizure 10 → V2, seizure 15 → V3, etc.  Stop at MAX_SEIZURES.
    if (seizure_count > 0
            and seizure_count % SEIZURES_PER_TRAINING == 0
            and not max_reached):
        version_num = seizure_count // SEIZURES_PER_TRAINING   # 1, 2, 3, …
        tier        = f"v{version_num}"                         # 'v1', 'v2', 'v3', …
        background_tasks.add_task(enqueue_training, db, patient_id, tier, version_num)
        training_queued = True

    # Ask satisfaction every 5 seizures (same cadence as training) up to limit
    ask_satisfaction = (
        seizure_count > 0
        and seizure_count % SEIZURES_PER_TRAINING == 0
        and seizure_count <= MAX_SEIZURES
    )

    return {
        "seizure_count"    : seizure_count,
        "training_queued"  : training_queued,
        "max_reached"      : max_reached,
        "ask_satisfaction" : ask_satisfaction,
        "next_train_at"    : (
            (seizure_count // SEIZURES_PER_TRAINING + 1) * SEIZURES_PER_TRAINING
        ),
    }


# ── Normal data ────────────────────────────────────────────────────────────────

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


# ── False-positive feedback data ───────────────────────────────────────────────

@router.post("/false_positive")
async def upload_false_positive(
    patient_id   : str        = Form(...),
    fp_id        : str        = Form(...),
    alarm_id     : str        = Form(""),
    alarm_type   : str        = Form(""),    # 'prediction' | 'detection'
    model_tier   : str        = Form(""),    # which model fired the alarm
    captured_at  : str        = Form(...),
    channel_names: str        = Form(...),   # JSON array
    sampling_rate: int        = Form(256),
    eeg_file     : UploadFile = File(...),
    db           : AsyncSession = Depends(get_db),
):
    """Store a false-positive EEG segment.

    These 'golden negative' samples are saved in a dedicated sub-folder and
    will be automatically included in the next incremental training run to
    sharpen the model's decision boundary and reduce the False Positive Rate.
    """
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

    # Count how many false positives this patient has accumulated
    fp_result = await db.execute(
        select(func.count()).where(FalsePositiveEvent.patient_id == patient_id)
    )
    fp_count = fp_result.scalar() or 0

    return {"ok": True, "fp_count": fp_count}
