import argparse
import sqlite3
import sys
import uuid
from datetime import datetime, timezone
from pathlib import Path

BACKEND_DIR   = Path(__file__).resolve().parent.parent
DB_PATH       = BACKEND_DIR / "epilepsy.db"
PATIENTS_ROOT = BACKEND_DIR / "storage" / "models" / "patients"
"""
cd EEG_Backend

# See what it would do (safe)
python scripts/activate_personal_model.py 9d0359cd-cc48-4528-a05e-e48fb03fe9cb v1 --dry-run

# Actually apply the change
python scripts/activate_personal_model.py 9d0359cd-cc48-4528-a05e-e48fb03fe9cb v1
"""

def activate(patient_id: str, tier: str, dry_run: bool) -> int:
    if not tier.startswith("v") or not tier[1:].isdigit():
        print(f"ERROR: tier must look like v1, v2, v3…  got: {tier!r}")
        return 2
    version_num = int(tier[1:])

    patient_dir = PATIENTS_ROOT / patient_id
    if not patient_dir.is_dir():
        print(f"ERROR: patient folder does not exist: {patient_dir}")
        return 2

    pred_path = patient_dir / f"{tier}_predictor.pt"
    det_path  = patient_dir / f"{tier}_detector.pt"

    missing = [p for p in (pred_path, det_path) if not p.is_file()]
    if missing:
        print("ERROR: missing checkpoint file(s):")
        for p in missing:
            print(f"  - {p}")
        return 2

    if not DB_PATH.is_file():
        print(f"ERROR: database not found: {DB_PATH}")
        print("Start the backend once to create it, or check EEG_Backend/config.py")
        return 2

    conn = sqlite3.connect(str(DB_PATH))
    try:
        cur = conn.cursor()

        cur.execute(
            "SELECT COUNT(*) FROM model_artifacts "
            "WHERE patient_id=? AND is_active=1",
            (patient_id,),
        )
        superseded_count = cur.fetchone()[0]

        cur.execute(
            "SELECT id, tier, model_type FROM model_artifacts "
            "WHERE patient_id=? AND tier=? AND is_active IN (1, 2)",
            (patient_id, tier),
        )
        duplicates = cur.fetchall()
        if duplicates:
            print(
                f"ERROR: tier {tier} already exists for this patient "
                f"(is_active=1 or 2). Found rows:"
            )
            for row in duplicates:
                print(f"  - id={row[0]}  tier={row[1]}  type={row[2]}")
            print("Deactivate or delete them first if you want to reinsert.")
            return 2

        now = datetime.now(timezone.utc).isoformat()
        new_rows = [
            (str(uuid.uuid4()), patient_id, tier, version_num,
             "predictor", str(pred_path), now, 1, None),
            (str(uuid.uuid4()), patient_id, tier, version_num,
             "detector",  str(det_path),  now, 1, None),
        ]

        print(f"Patient:     {patient_id}")
        print(f"Tier:        {tier}  (version_num={version_num})")
        print(f"Predictor:   {pred_path}")
        print(f"Detector:    {det_path}")
        print(f"Supersedes:  {superseded_count} existing active row(s)")
        print()

        if dry_run:
            print("DRY RUN — no changes written. Re-run without --dry-run to apply.")
            return 0

        cur.execute(
            "UPDATE model_artifacts SET is_active=0 "
            "WHERE patient_id=? AND is_active=1",
            (patient_id,),
        )

        cur.executemany(
            "INSERT INTO model_artifacts "
            "(id, patient_id, tier, version_num, model_type, file_path, "
            "created_at, is_active, base_model_version) "
            "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
            new_rows,
        )

        conn.commit()
        print(f"Activated {tier} for patient {patient_id}.")
        print("Next inference call will pick up the new models automatically "
              "(the cache detects path changes — no server restart needed).")
        return 0
    finally:
        conn.close()


def main() -> int:
    parser = argparse.ArgumentParser(
        description="Activate a personal model tier (v1, v2, …) for a patient."
    )
    parser.add_argument("patient_id", help="UUID of the patient")
    parser.add_argument("tier", help="Model tier to activate, e.g. v1, v2")
    parser.add_argument(
        "--dry-run", action="store_true",
        help="Print what would happen without writing to the database",
    )
    args = parser.parse_args()
    return activate(args.patient_id, args.tier, args.dry_run)


if __name__ == "__main__":
    sys.exit(main())
