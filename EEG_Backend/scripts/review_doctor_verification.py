import argparse
import sys
from datetime import datetime, timezone
from pathlib import Path

SCRIPT_DIR  = Path(__file__).resolve().parent
BACKEND_DIR = SCRIPT_DIR.parent

sys.path.insert(0, str(BACKEND_DIR))

import httpx
from config import SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY


"""
cd EEG_Backend

# List all pending verifications (with doctor name, username, submission time)
python scripts/review_doctor_verification.py list

# Get a signed 1-hour URL to open the uploaded document in a browser
python scripts/review_doctor_verification.py show <verification_id>

# Approve — flips doctor_verifications.status to 'approved'
# AND sets the doctor's profiles.doctor_verified = true
python scripts/review_doctor_verification.py review <verification_id> approve

# Reject with optional note
python scripts/review_doctor_verification.py review <verification_id> reject --notes "License number unreadable"

"""

def _headers() -> dict[str, str]:
    return {
        'apikey'       : SUPABASE_SERVICE_ROLE_KEY,
        'Authorization': f'Bearer {SUPABASE_SERVICE_ROLE_KEY}',
        'Content-Type' : 'application/json',
        'Prefer'       : 'return=representation',
    }


def _configured() -> bool:
    return (
        bool(SUPABASE_URL) and bool(SUPABASE_SERVICE_ROLE_KEY)
        and 'YOUR_PROJECT_ID' not in SUPABASE_URL
        and 'YOUR_SUPABASE_SERVICE_ROLE_KEY' not in SUPABASE_SERVICE_ROLE_KEY
    )


def list_pending() -> int:
    url = (
        f'{SUPABASE_URL.rstrip("/")}/rest/v1/doctor_verifications'
        f'?status=eq.pending&select=id,doctor_id,document_url,submitted_at'
        f'&order=submitted_at.asc'
    )
    resp = httpx.get(url, headers=_headers(), timeout=10)
    resp.raise_for_status()
    rows = resp.json()

    if not rows:
        print("No pending verifications.")
        return 0

    doctor_ids = ','.join(r['doctor_id'] for r in rows)
    prof_url = (
        f'{SUPABASE_URL.rstrip("/")}/rest/v1/profiles'
        f'?id=in.({doctor_ids})&select=id,full_name,username'
    )
    prof_resp = httpx.get(prof_url, headers=_headers(), timeout=10)
    prof_resp.raise_for_status()
    profiles = {p['id']: p for p in prof_resp.json()}

    print(f"\n{len(rows)} pending verification(s):\n")
    for r in rows:
        p = profiles.get(r['doctor_id'], {})
        print(f"  id:           {r['id']}")
        print(f"  doctor:       {p.get('full_name', '?')} (@{p.get('username', '?')})")
        print(f"  doctor_id:    {r['doctor_id']}")
        print(f"  document:     {r['document_url']}")
        print(f"  submitted_at: {r['submitted_at']}")
        print()
    return 0


def _signed_doc_url(storage_path: str, expires_secs: int = 3600) -> str | None:
    endpoint = f'{SUPABASE_URL.rstrip("/")}/storage/v1/object/sign/doctor-docs/{storage_path}'
    resp = httpx.post(
        endpoint,
        headers=_headers(),
        json={'expiresIn': expires_secs},
        timeout=10,
    )
    if resp.status_code != 200:
        print(f"Could not sign document URL: {resp.status_code} {resp.text}")
        return None
    signed = resp.json().get('signedURL')
    return f'{SUPABASE_URL.rstrip("/")}/storage/v1{signed}' if signed else None


def show_doc(verification_id: str) -> int:
    url = (
        f'{SUPABASE_URL.rstrip("/")}/rest/v1/doctor_verifications'
        f'?id=eq.{verification_id}&select=document_url,doctor_id,status'
    )
    resp = httpx.get(url, headers=_headers(), timeout=10)
    resp.raise_for_status()
    rows = resp.json()
    if not rows:
        print(f"No verification found with id={verification_id}")
        return 2
    r = rows[0]
    signed = _signed_doc_url(r['document_url'])
    print(f"Doctor:    {r['doctor_id']}")
    print(f"Status:    {r['status']}")
    print(f"Document:  {r['document_url']}")
    if signed:
        print(f"Signed URL (expires in 1h):\n  {signed}")
    return 0


def review(verification_id: str, decision: str, notes: str | None) -> int:
    if decision not in ('approve', 'reject'):
        print(f"ERROR: decision must be 'approve' or 'reject', got {decision!r}")
        return 2

    get_url = (
        f'{SUPABASE_URL.rstrip("/")}/rest/v1/doctor_verifications'
        f'?id=eq.{verification_id}&select=doctor_id,status'
    )
    resp = httpx.get(get_url, headers=_headers(), timeout=10)
    resp.raise_for_status()
    rows = resp.json()
    if not rows:
        print(f"No verification found with id={verification_id}")
        return 2
    row = rows[0]
    if row['status'] != 'pending':
        print(f"ERROR: verification is already '{row['status']}', not 'pending'.")
        return 2

    doctor_id  = row['doctor_id']
    new_status = 'approved' if decision == 'approve' else 'rejected'
    now        = datetime.now(timezone.utc).isoformat()

    patch_url = (
        f'{SUPABASE_URL.rstrip("/")}/rest/v1/doctor_verifications?id=eq.{verification_id}'
    )
    patch_body: dict = {
        'status'     : new_status,
        'reviewed_at': now,
    }
    if notes:
        patch_body['notes'] = notes
    resp = httpx.patch(patch_url, headers=_headers(), json=patch_body, timeout=10)
    resp.raise_for_status()

    if decision == 'approve':
        prof_url = f'{SUPABASE_URL.rstrip("/")}/rest/v1/profiles?id=eq.{doctor_id}'
        resp = httpx.patch(
            prof_url, headers=_headers(),
            json={'doctor_verified': True},
            timeout=10,
        )
        resp.raise_for_status()
        print(f"Approved. doctor_id={doctor_id} now has doctor_verified=true.")
    else:
        print(f"Rejected. doctor_id={doctor_id} stays unverified.")
    return 0


def main() -> int:
    if not _configured():
        print("ERROR: SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY not configured.")
        print("Set them as env vars or in EEG_Backend/config.py.")
        return 2

    parser = argparse.ArgumentParser(
        description="Admin tool to review doctor verification submissions."
    )
    sub = parser.add_subparsers(dest='cmd', required=True)

    sub.add_parser('list', help='List all pending verifications')

    show = sub.add_parser('show', help='Show a single verification with a signed document URL')
    show.add_argument('verification_id')

    rev = sub.add_parser('review', help='Approve or reject a verification')
    rev.add_argument('verification_id')
    rev.add_argument('decision', choices=['approve', 'reject'])
    rev.add_argument('--notes', default=None, help='Optional notes shown to the doctor')

    args = parser.parse_args()

    if args.cmd == 'list':
        return list_pending()
    if args.cmd == 'show':
        return show_doc(args.verification_id)
    if args.cmd == 'review':
        return review(args.verification_id, args.decision, args.notes)
    return 2


if __name__ == '__main__':
    sys.exit(main())
