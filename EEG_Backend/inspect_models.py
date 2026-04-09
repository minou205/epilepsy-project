"""Quick diagnostic: inspect what's actually stored in the .pt model files."""
import torch
from pathlib import Path

patient_dir = Path(r"C:\Users\moham\OneDrive\Desktop\epilepsy_app\EEG_Backend\storage\models\patients\9d0359cd-cc48-4528-a05e-e48fb03fe9cb")
general_dir = Path(r"C:\Users\moham\OneDrive\Desktop\epilepsy_app\EEG_Backend\storage\models\general")

for label, d in [("PATIENT", patient_dir), ("GENERAL", general_dir)]:
    print(f"\n{'='*60}")
    print(f"  {label} DIR: {d}")
    print(f"{'='*60}")
    for f in sorted(d.glob("*.pt")):
        ckpt = torch.load(str(f), map_location="cpu", weights_only=False)
        print(f"\n  File: {f.name} ({f.stat().st_size:,} bytes)")
        if isinstance(ckpt, dict):
            print(f"    Keys: {list(ckpt.keys())}")
            print(f"    calib_thresh:      {ckpt.get('calib_thresh', 'MISSING')}")
            print(f"    train_ref_mu:      {ckpt.get('train_ref_mu', 'MISSING')}")
            print(f"    train_ref_std:     {ckpt.get('train_ref_std', 'MISSING')}")
            print(f"    disc_calibration:  {ckpt.get('disc_calibration', 'MISSING')}")
            print(f"    has_discriminator: {ckpt.get('has_discriminator', 'MISSING')}")
            print(f"    model_type:        {ckpt.get('model_type', 'MISSING')}")
            print(f"    n_channels:        {ckpt.get('n_channels', 'MISSING')}")
            print(f"    train_config_sig:  {ckpt.get('train_config_sig', 'MISSING')}")
            if "state_dict" in ckpt:
                sd = ckpt["state_dict"]
                print(f"    state_dict:        {len(sd)} keys")
            if ckpt.get("disc_state_dict"):
                print(f"    disc_state_dict:   {len(ckpt['disc_state_dict'])} keys")
            else:
                print(f"    disc_state_dict:   None")
        else:
            print(f"    NOT a dict - type: {type(ckpt)}")

# Check if patient files are identical to general files
print(f"\n{'='*60}")
print("  FILE COMPARISON")
print(f"{'='*60}")
for name in ["predictor.pt", "detector.pt"]:
    pf = patient_dir / name
    gf = general_dir / name
    if pf.exists() and gf.exists():
        p_bytes = pf.read_bytes()
        g_bytes = gf.read_bytes()
        identical = p_bytes == g_bytes
        print(f"  {name}: patient={len(p_bytes):,}B  general={len(g_bytes):,}B  IDENTICAL={identical}")
    else:
        print(f"  {name}: patient_exists={pf.exists()}  general_exists={gf.exists()}")
