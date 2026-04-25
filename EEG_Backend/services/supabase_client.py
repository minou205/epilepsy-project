import logging
from typing import Optional

import httpx

from config import SUPABASE_SERVICE_ROLE_KEY, SUPABASE_URL

logger = logging.getLogger(__name__)


def _is_configured() -> bool:
    return (
        bool(SUPABASE_URL)
        and bool(SUPABASE_SERVICE_ROLE_KEY)
        and 'YOUR_PROJECT_ID' not in SUPABASE_URL
        and 'YOUR_SUPABASE_SERVICE_ROLE_KEY' not in SUPABASE_SERVICE_ROLE_KEY
    )


def _headers() -> dict[str, str]:
    return {
        'apikey': SUPABASE_SERVICE_ROLE_KEY,
        'Authorization': f'Bearer {SUPABASE_SERVICE_ROLE_KEY}',
        'Content-Type': 'application/json',
    }


async def fetch_profile(profile_id: str) -> Optional[dict]:
    if not _is_configured():
        logger.warning('[supabase] not configured, cannot fetch profile')
        return None

    url = (
        f'{SUPABASE_URL.rstrip("/")}/rest/v1/profiles'
        f'?id=eq.{profile_id}'
        f'&select=id,full_name,username,expo_push_token,role'
    )

    try:
        async with httpx.AsyncClient(timeout=5) as client:
            resp = await client.get(url, headers=_headers())
            resp.raise_for_status()
            rows = resp.json()
    except httpx.HTTPError as e:
        logger.warning(f'[supabase] fetch_profile({profile_id}) failed: {e}')
        return None

    return rows[0] if rows else None


async def fetch_helper_push_tokens(patient_id: str) -> list[str]:
    if not _is_configured():
        logger.warning('[supabase] not configured, cannot fetch helper tokens')
        return []

    rel_url = (
        f'{SUPABASE_URL.rstrip("/")}/rest/v1/helper_patients'
        f'?patient_id=eq.{patient_id}'
        f'&select=helper_id'
    )

    try:
        async with httpx.AsyncClient(timeout=5) as client:
            rel_resp = await client.get(rel_url, headers=_headers())
            rel_resp.raise_for_status()
            rows = rel_resp.json()

            helper_ids = [r['helper_id'] for r in rows if r.get('helper_id')]
            if not helper_ids:
                return []

            ids_filter = ','.join(helper_ids)
            prof_url = (
                f'{SUPABASE_URL.rstrip("/")}/rest/v1/profiles'
                f'?id=in.({ids_filter})'
                f'&select=id,expo_push_token'
            )
            prof_resp = await client.get(prof_url, headers=_headers())
            prof_resp.raise_for_status()
            profiles = prof_resp.json()
    except httpx.HTTPError as e:
        logger.warning(f'[supabase] fetch_helper_push_tokens({patient_id}) failed: {e}')
        return []

    return [p['expo_push_token'] for p in profiles if p.get('expo_push_token')]
