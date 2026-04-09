from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy import select

from database import get_db
from models.model_artifact import TrainingJob

router = APIRouter(prefix="/training", tags=["training"])


@router.get("/status")
async def get_training_status(patient_id: str, db: AsyncSession = Depends(get_db)):
    result = await db.execute(
        select(TrainingJob)
        .where(TrainingJob.patient_id == patient_id)
        .order_by(TrainingJob.started_at.desc())
    )
    job = result.scalars().first()

    if not job:
        return {"status": "idle", "progress_pct": 0, "tier": "none"}

    return {
        "status"      : job.status,
        "progress_pct": 100 if job.status == "complete" else 0,
        "tier"        : job.tier,
        "started_at"  : job.started_at,
        "completed_at": job.completed_at,
        "error_msg"   : job.error_msg,
    }
