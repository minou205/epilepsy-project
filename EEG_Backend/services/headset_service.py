import json
import logging
from datetime import datetime, timezone

from sqlalchemy.ext.asyncio import AsyncSession

from models.patient_headset import PatientHeadset

logger = logging.getLogger(__name__)

MIN_CH = 9
MAX_CH = 24


class HeadsetMismatchError(Exception):

    def __init__(self, expected: list[str], got: list[str]):
        self.expected = expected
        self.got = got
        super().__init__(f'Headset mismatch: expected {expected}, got {got}')


def _now() -> str:
    return datetime.now(timezone.utc).isoformat()


async def get_headset(db: AsyncSession, patient_id: str) -> PatientHeadset | None:
    return await db.get(PatientHeadset, patient_id)


async def register_or_validate(
    db: AsyncSession,
    patient_id: str,
    channel_names: list[str],
    sampling_rate: int = 256,
    headset_name: str | None = None,
) -> tuple[PatientHeadset, bool]:
    if not isinstance(channel_names, list) or not all(isinstance(c, str) for c in channel_names):
        raise ValueError('channel_names must be a list of strings')

    n = len(channel_names)
    if n < MIN_CH or n > MAX_CH:
        raise ValueError(f'channel count {n} outside allowed range {MIN_CH}..{MAX_CH}')

    existing = await get_headset(db, patient_id)

    if existing is None:
        rec = PatientHeadset(
            patient_id   =patient_id,
            headset_name =headset_name or patient_id,
            n_channels   =n,
            channel_names=json.dumps(channel_names),
            sampling_rate=sampling_rate,
            created_at   =_now(),
            updated_at   =_now(),
        )
        db.add(rec)
        await db.commit()
        await db.refresh(rec)
        logger.info(f'[headset] registered {patient_id}: {n}ch {channel_names}')
        return rec, True

    expected = json.loads(existing.channel_names)
    if expected != channel_names:
        raise HeadsetMismatchError(expected, channel_names)

    return existing, False


async def reset_headset(db: AsyncSession, patient_id: str) -> None:
    rec = await get_headset(db, patient_id)
    if rec is not None:
        await db.delete(rec)
        await db.commit()
        logger.info(f'[headset] reset for {patient_id}')


def get_channel_list(headset: PatientHeadset) -> list[str]:
    return json.loads(headset.channel_names)
