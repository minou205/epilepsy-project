from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy import select

from database import get_db
from models.patient import Patient, HelperToken
from services.notification_service import (
    send_push_to_tokens,
    build_prediction_message,
    build_detection_message,
)

router = APIRouter(prefix="/notifications", tags=["notifications"])


class AlarmPayload(BaseModel):
    patient_id: str
    alarm_type: str   # 'prediction' | 'detection'


@router.post("/alarm")
async def send_alarm(payload: AlarmPayload, db: AsyncSession = Depends(get_db)):
    patient = await db.get(Patient, payload.patient_id)
    if not patient:
        raise HTTPException(404, f"Patient {payload.patient_id} not found")

    # Get all helper push tokens
    result = await db.execute(
        select(HelperToken).where(HelperToken.patient_id == payload.patient_id)
    )
    helpers = result.scalars().all()
    tokens  = [h.push_token for h in helpers]

    if payload.alarm_type == "prediction":
        title, body = build_prediction_message(payload.patient_id, patient.patient_name)
    elif payload.alarm_type == "detection":
        title, body = build_detection_message(payload.patient_id, patient.patient_name)
    else:
        raise HTTPException(400, "alarm_type must be 'prediction' or 'detection'")

    sent_count = await send_push_to_tokens(tokens, title, body)
    return {"sent_count": sent_count}
