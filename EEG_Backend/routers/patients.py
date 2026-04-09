from datetime import datetime, timezone
import uuid

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy import select

from database import get_db
from models.patient import Patient, HelperToken
from config import ensure_patient_models

router = APIRouter(prefix="/patients", tags=["patients"])


class RegisterPayload(BaseModel):
    patient_id  : str
    patient_name: str
    push_token  : str | None = None


class AddHelperPayload(BaseModel):
    helper_push_token: str


def _now() -> str:
    return datetime.now(timezone.utc).isoformat()


@router.post("/register")
async def register_patient(payload: RegisterPayload, db: AsyncSession = Depends(get_db)):
    existing = await db.get(Patient, payload.patient_id)
    if existing:
        # Update push token if provided
        if payload.push_token:
            existing.push_token = payload.push_token
        await db.commit()
        # Ensure per-patient model dir exists (idempotent)
        ensure_patient_models(payload.patient_id)
        return {"patient_id": payload.patient_id, "created": False}

    patient = Patient(
        patient_id  =payload.patient_id,
        patient_name=payload.patient_name,
        push_token  =payload.push_token,
        created_at  =_now(),
    )
    db.add(patient)
    await db.commit()

    # Provision per-patient model directory with copies of general models
    ensure_patient_models(payload.patient_id)

    return {"patient_id": payload.patient_id, "created": True}


@router.post("/{patient_id}/helpers")
async def add_helper(
    patient_id: str,
    payload   : AddHelperPayload,
    db        : AsyncSession = Depends(get_db),
):
    patient = await db.get(Patient, patient_id)
    if not patient:
        raise HTTPException(404, f"Patient {patient_id} not found")

    helper = HelperToken(
        id           =str(uuid.uuid4()),
        patient_id   =patient_id,
        push_token   =payload.helper_push_token,
        registered_at=_now(),
    )
    db.add(helper)
    await db.commit()
    return {"ok": True}
