"""
Service discovery for the EHSS backend.

This module writes the backend's reachable public endpoint into Supabase so the
mobile app can subscribe and connect automatically. It prefers a tunnel URL if
one is configured, otherwise it falls back to the local LAN IP and default port.
"""

import asyncio
import logging
import os
import re
import socket
from typing import Optional

import httpx

from config import SUPABASE_SERVICE_ROLE_KEY, SUPABASE_URL

BACKEND_URL_KEY = 'backend_url'
HEARTBEAT_INTERVAL_SECONDS = 30
LOCAL_BACKEND_PORT = 8000


def _normalize_public_url(raw: str) -> Optional[str]:
    if not raw:
        return None

    value = raw.strip().rstrip('/')
    if not value:
        return None

    if value.startswith('http://') or value.startswith('https://'):
        return value

    if re.match(r'^\d+\.\d+\.\d+\.\d+(?::\d+)?$', value):
        return f'http://{value}'

    if value.startswith('localhost') or value.startswith('127.'):
        return f'http://{value}'

    return f'https://{value}'


def detect_tunnel_url() -> Optional[str]:
    for env_name in (
        'CLOUDFLARE_TUNNEL_URL',
        'CF_TUNNEL_URL',
        'TUNNEL_URL',
        'PUBLIC_URL',
        'EXTERNAL_URL',
        'APP_URL',
        'HOSTNAME',
        'DOMAIN',
    ):
        raw = os.getenv(env_name)
        url = _normalize_public_url(raw) if raw else None
        if url:
            logging.info('[discovery] Using public tunnel URL from %s: %s', env_name, url)
            return url
    return None


def detect_lan_ip() -> str:
    try:
        with socket.socket(socket.AF_INET, socket.SOCK_DGRAM) as sock:
            sock.connect(('8.8.8.8', 80))
            ip = sock.getsockname()[0]
            logging.info('[discovery] Detected LAN IP: %s', ip)
            return ip
    except OSError:
        logging.warning('[discovery] Failed to resolve LAN IP, falling back to 127.0.0.1')
        return '127.0.0.1'


def detect_backend_url() -> str:
    public_url = detect_tunnel_url()
    if public_url:
        return public_url
    lan_ip = detect_lan_ip()
    fallback_url = f'http://{lan_ip}:{LOCAL_BACKEND_PORT}'
    logging.info('[discovery] No tunnel URL found; publishing LAN fallback URL %s', fallback_url)
    return fallback_url


async def _upsert_backend_url(url: str) -> None:
    if not SUPABASE_URL or not SUPABASE_SERVICE_ROLE_KEY:
        raise RuntimeError('Supabase URL and SERVICE_ROLE_KEY are required for service discovery')

    endpoint = f'{SUPABASE_URL.rstrip("/")}/rest/v1/system_config?on_conflict=key'
    headers = {
        'apikey': SUPABASE_SERVICE_ROLE_KEY,
        'Authorization': f'Bearer {SUPABASE_SERVICE_ROLE_KEY}',
        'Content-Type': 'application/json',
        'Prefer': 'return=representation,resolution=merge-duplicates',
    }
    payload = [
        {
            'key': BACKEND_URL_KEY,
            'value': url,
        },
    ]

    async with httpx.AsyncClient(timeout=10) as client:
        resp = await client.post(endpoint, json=payload, headers=headers)
        resp.raise_for_status()
        logging.info('[discovery] Published system_config backend_url=%s', url)


async def _heartbeat_loop(stop_event: asyncio.Event) -> None:
    while not stop_event.is_set():
        try:
            url = detect_backend_url()
            await _upsert_backend_url(url)
        except Exception:
            logging.exception('[discovery] Failed to publish backend URL')

        try:
            await asyncio.wait_for(stop_event.wait(), timeout=HEARTBEAT_INTERVAL_SECONDS)
        except asyncio.TimeoutError:
            continue


async def initialize_service_discovery(app) -> None:
    if not SUPABASE_URL or not SUPABASE_SERVICE_ROLE_KEY:
        logging.warning(
            '[discovery] SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY not configured; skipping service discovery',
        )
        return

    stop_event = asyncio.Event()
    task = asyncio.create_task(_heartbeat_loop(stop_event))
    app.state.discovery_stop_event = stop_event
    app.state.discovery_task = task
    logging.info('[discovery] Service discovery started')


async def shutdown_service_discovery(app) -> None:
    stop_event = getattr(app.state, 'discovery_stop_event', None)
    task = getattr(app.state, 'discovery_task', None)
    if stop_event is not None:
        stop_event.set()
    if task is not None:
        task.cancel()
        try:
            await task
        except asyncio.CancelledError:
            pass
        logging.info('[discovery] Service discovery stopped')
