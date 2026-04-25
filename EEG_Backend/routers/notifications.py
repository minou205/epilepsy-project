import logging

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel

from services.notification_service import (
    send_push_to_tokens,
    build_prediction_message,
    build_detection_message,
)
from services.supabase_client import fetch_profile, fetch_helper_push_tokens

router = APIRouter(prefix="/notifications", tags=["notifications"])
logger = logging.getLogger(__name__)


class AlarmPayload(BaseModel):
    patient_id: str
    alarm_type: str
    tier      : str | None = None


@router.post("/alarm")
async def send_alarm(payload: AlarmPayload):
    if payload.alarm_type not in ("prediction", "detection"):
        raise HTTPException(400, "alarm_type must be 'prediction' or 'detection'")

    if payload.tier in ("general", "none"):
        logger.info(
            f"[alarm] {payload.patient_id}: suppressed helper push "
            f"(tier={payload.tier}, helpers only notified for personal models)"
        )
        return {"sent_count": 0, "reason": f"tier_{payload.tier}_does_not_notify_helpers"}

    profile = await fetch_profile(payload.patient_id)
    patient_name = (
        profile.get('full_name')
        or profile.get('username')
        or payload.patient_id
    ) if profile else payload.patient_id

    tokens = await fetch_helper_push_tokens(payload.patient_id)
    if not tokens:
        logger.info(f"[alarm] {payload.patient_id}: no helper push tokens registered")
        return {"sent_count": 0, "reason": "no_helpers_registered"}

    if payload.alarm_type == "prediction":
        title, body = build_prediction_message(payload.patient_id, patient_name)
    else:
        title, body = build_detection_message(payload.patient_id, patient_name)

    try:
        sent_count = await send_push_to_tokens(tokens, title, body)
    except Exception as e:
        logger.warning(f"[alarm] {payload.patient_id}: push send failed: {e}")
        return {"sent_count": 0, "reason": "push_send_failed"}

    logger.info(f"[alarm] {payload.patient_id}: sent {sent_count} notifications")
    return {"sent_count": sent_count}
