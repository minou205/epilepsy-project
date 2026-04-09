"""
Archive endpoints — store and retrieve alarm events for patient/helper access.

The phone POSTs alarm results (confirmed or auto-dismissed) after each alarm
is resolved. Helpers can then GET the archive for their associated patients.
"""
import json
from datetime import datetime, timezone

from fastapi import APIRouter, Depends
from pydantic import BaseModel, Field
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession
from typing import Optional

from database import get_db
from models.alarm_event import AlarmEventRecord

router = APIRouter(prefix="/archive", tags=["archive"])


def _now() -> str:
    return datetime.now(timezone.utc).isoformat()


# ── Schemas ───────────────────────────────────────────────────────────────────

class AlarmEventCreate(BaseModel):
    id: str
    patient_id: str
    alarm_type: str                          # 'prediction' | 'detection'
    tier: str                                # 'general' | 'v1' | 'v2' …
    timestamp: str                           # ISO timestamp
    confirmed: Optional[int] = None          # 1=real, 0=false/auto-no
    predictor_probs: Optional[list[float]] = None
    detector_probs: Optional[list[float]] = None
    prob_timestamps: Optional[list[float]] = None


class AlarmEventOut(BaseModel):
    id: str
    patient_id: str
    alarm_type: str
    tier: str
    timestamp: str
    confirmed: Optional[int]
    predictor_probs: Optional[list[float]]
    detector_probs: Optional[list[float]]
    prob_timestamps: Optional[list[float]]
    created_at: str


class ArchiveStats(BaseModel):
    total_alarms: int
    predictions: int
    detections: int
    confirmed_real: int
    false_alarms: int


# ── Endpoints ─────────────────────────────────────────────────────────────────

@router.post("/event")
async def save_alarm_event(
    event: AlarmEventCreate,
    db: AsyncSession = Depends(get_db),
):
    """Save an alarm event from the phone app."""
    record = AlarmEventRecord(
        id=event.id,
        patient_id=event.patient_id,
        alarm_type=event.alarm_type,
        tier=event.tier,
        timestamp=event.timestamp,
        confirmed=event.confirmed,
        predictor_probs=json.dumps(event.predictor_probs) if event.predictor_probs else None,
        detector_probs=json.dumps(event.detector_probs) if event.detector_probs else None,
        prob_timestamps=json.dumps(event.prob_timestamps) if event.prob_timestamps else None,
        created_at=_now(),
    )
    db.add(record)
    await db.commit()
    return {"ok": True}


@router.get("/{patient_id}", response_model=list[AlarmEventOut])
async def get_archive(
    patient_id: str,
    db: AsyncSession = Depends(get_db),
):
    """Retrieve alarm history for a patient."""
    result = await db.execute(
        select(AlarmEventRecord)
        .where(AlarmEventRecord.patient_id == patient_id)
        .order_by(AlarmEventRecord.timestamp.desc())
    )
    rows = result.scalars().all()

    events = []
    for r in rows:
        events.append(AlarmEventOut(
            id=r.id,
            patient_id=r.patient_id,
            alarm_type=r.alarm_type,
            tier=r.tier,
            timestamp=r.timestamp,
            confirmed=r.confirmed,
            predictor_probs=json.loads(r.predictor_probs) if r.predictor_probs else None,
            detector_probs=json.loads(r.detector_probs) if r.detector_probs else None,
            prob_timestamps=json.loads(r.prob_timestamps) if r.prob_timestamps else None,
            created_at=r.created_at,
        ))
    return events


@router.get("/{patient_id}/stats", response_model=ArchiveStats)
async def get_archive_stats(
    patient_id: str,
    db: AsyncSession = Depends(get_db),
):
    """Get summary statistics for a patient's alarm history."""
    result = await db.execute(
        select(AlarmEventRecord)
        .where(AlarmEventRecord.patient_id == patient_id)
    )
    rows = result.scalars().all()

    total = len(rows)
    predictions = sum(1 for r in rows if r.alarm_type == 'prediction')
    detections = sum(1 for r in rows if r.alarm_type == 'detection')
    confirmed_real = sum(1 for r in rows if r.confirmed == 1)
    false_alarms = sum(1 for r in rows if r.confirmed == 0)

    return ArchiveStats(
        total_alarms=total,
        predictions=predictions,
        detections=detections,
        confirmed_real=confirmed_real,
        false_alarms=false_alarms,
    )
