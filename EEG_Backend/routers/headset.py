"""Headset endpoints — query, rename, and reset the per-patient headset lock."""
import shutil
from typing import Optional

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel
from sqlalchemy.ext.asyncio import AsyncSession

from database import get_db
from config import EEG_DATA_DIR
from services.headset_service import get_headset, reset_headset, get_channel_list

router = APIRouter(prefix="/headset", tags=["headset"])


class HeadsetInfo(BaseModel):
    patient_id   : str
    headset_name : str
    n_channels   : int
    channel_names: list[str]
    sampling_rate: int


class RenameBody(BaseModel):
    headset_name: str


@router.get("/{patient_id}", response_model=Optional[HeadsetInfo])
async def get(patient_id: str, db: AsyncSession = Depends(get_db)):
    rec = await get_headset(db, patient_id)
    if rec is None:
        return None
    return HeadsetInfo(
        patient_id   =rec.patient_id,
        headset_name =rec.headset_name,
        n_channels   =rec.n_channels,
        channel_names=get_channel_list(rec),
        sampling_rate=rec.sampling_rate,
    )


@router.post("/{patient_id}/reset")
async def reset(patient_id: str, db: AsyncSession = Depends(get_db)):
    """Wipe the headset lock AND all collected data — user confirmed headset change."""
    await reset_headset(db, patient_id)
    pdir = EEG_DATA_DIR / patient_id
    if pdir.exists():
        shutil.rmtree(pdir, ignore_errors=True)
    return {"ok": True}


@router.patch("/{patient_id}/rename")
async def rename(
    patient_id: str,
    body      : RenameBody,
    db        : AsyncSession = Depends(get_db),
):
    rec = await get_headset(db, patient_id)
    if rec is None:
        raise HTTPException(404, "no headset registered")
    rec.headset_name = body.headset_name or patient_id
    await db.commit()
    return {"ok": True, "headset_name": rec.headset_name}
