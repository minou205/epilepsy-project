import argparse
import hashlib
import logging
import os
import time
from datetime import datetime, timezone
from pathlib import Path

import numpy as np
import torch

logger = logging.getLogger(__name__)

DEFAULT_N_CHANNELS = 18
DEFAULT_EPOCHS     = 50
FS                 = 256
CLIP_S             = 5
CLEN               = FS * CLIP_S


def train_base_model(
    mode         : str,
    chb_mit_dir  : Path,
    output_path  : Path,
    n_channels   : int = DEFAULT_N_CHANNELS,
    epochs       : int = DEFAULT_EPOCHS,
    channel_names: list[str] | None = None,
) -> str:
    dev = torch.device('cuda' if torch.cuda.is_available() else 'cpu')
    if dev.type == 'cuda':
        torch.backends.cudnn.benchmark = True
    logger.info(f'[base_model] training {mode} base model on {dev} '
                f'(n_ch={n_channels}, epochs={epochs})')

    if mode == 'prediction':
        from services.personal_prediction import (
            build_model, pretrain_clep, EEGDataset, EEGAugDataset,
            AUG_NOISE_STD, AUG_CH_DROP,
            TRAIN_CONFIG_SIG, TRAIN_CONFIG, CH18,
        )
        model_type_label = 'hybrid_sts_stan_v2'
        suffix           = 'predictor'
    else:
        from services.personal_detection import (
            build_model, pretrain_clep, EEGDataset, EEGAugDataset,
            AUG_NOISE_STD, AUG_CH_DROP,
            TRAIN_CONFIG_SIG, TRAIN_CONFIG, CH18,
        )
        model_type_label = 'hybrid_sts_detection_v1'
        suffix           = 'detector'

    from services.eeg_data_loader import load_chb_mit_for_patient_channels

    if channel_names:
        n_channels = len(channel_names)
    else:
        channel_names = list(CH18[:n_channels])

    logger.info(f'[base_model] channel set ({n_channels}ch): {channel_names}')
    logger.info(f'[base_model] loading CHB-MIT data from {chb_mit_dir} ...')
    chb_data = load_chb_mit_for_patient_channels(
        chb_mit_dir, channel_names, mode=mode,
    )

    if not chb_data:
        raise RuntimeError(
            f'[base_model] no CHB-MIT data found in {chb_mit_dir}. '
            f'Please download the CHB-MIT dataset first.'
        )

    source_datasets = []
    for clips, labels in chb_data:
        source_datasets.append(EEGDataset(clips, labels))

    total_clips = sum(len(ds) for ds in source_datasets)
    logger.info(f'[base_model] {len(source_datasets)} CHB-MIT patients, '
                f'{total_clips} total clips')

    encoder = build_model(E=n_channels).to(dev)
    t0 = time.time()
    encoder = pretrain_clep(encoder, source_datasets, epochs=epochs, dev=dev)
    elapsed = time.time() - t0
    logger.info(f'[base_model] CLEP pretraining done in {elapsed:.0f}s')

    output_path = Path(output_path)
    output_path.parent.mkdir(parents=True, exist_ok=True)

    channel_sig = ','.join(channel_names)
    version_hash = hashlib.md5(
        f'{model_type_label}:{n_channels}:{channel_sig}:{epochs}:{datetime.now(timezone.utc).isoformat()}'
        .encode()
    ).hexdigest()[:12]

    checkpoint = {
        'state_dict'      : encoder.state_dict(),
        'model_type'      : model_type_label,
        'mode'            : mode,
        'n_channels'      : n_channels,
        'channel_names'   : channel_names,
        'sampling_rate'   : FS,
        'pretrain_epochs' : epochs,
        'chb_patients'    : len(source_datasets),
        'total_clips'     : total_clips,
        'train_config_sig': TRAIN_CONFIG_SIG,
        'train_config'    : TRAIN_CONFIG,
        'base_version'    : version_hash,
        'created_at'      : datetime.now(timezone.utc).isoformat(),
        'is_base_model'   : True,
    }

    torch.save(checkpoint, str(output_path))
    logger.info(f'[base_model] saved {mode} base model → {output_path} '
                f'(version={version_hash})')

    return str(output_path)


def train_all_base_models(
    chb_mit_dir  : Path,
    output_dir   : Path,
    n_channels   : int = DEFAULT_N_CHANNELS,
    epochs       : int = DEFAULT_EPOCHS,
    channel_names: list[str] | None = None,
) -> dict:
    if channel_names:
        n_channels = len(channel_names)

    results = {}
    for mode, filename in [('prediction', f'base_predictor_{n_channels}.pt'),
                           ('detection',  f'base_detector_{n_channels}.pt')]:
        out_path = output_dir / filename
        path = train_base_model(
            mode=mode,
            chb_mit_dir=chb_mit_dir,
            output_path=out_path,
            n_channels=n_channels,
            epochs=epochs,
            channel_names=channel_names,
        )
        results[mode] = path
    return results


if __name__ == '__main__':
    import sys
    _backend_dir = str(Path(__file__).resolve().parent.parent)
    if _backend_dir not in sys.path:
        sys.path.insert(0, _backend_dir)

    logging.basicConfig(
        level=logging.INFO,
        format='%(asctime)s [%(name)s] %(levelname)s: %(message)s',
    )

    parser = argparse.ArgumentParser(
        description='Train CHB-MIT base (foundation) models for predictor and detector.',
    )
    parser.add_argument(
        '--chb-mit-dir', type=str, default=None,
        help='Path to the CHB-MIT data directory (default: config.CHB_MIT_DIR)',
    )
    parser.add_argument(
        '--output-dir', type=str, default=None,
        help='Directory to save base models (default: config.BASE_MODELS_DIR)',
    )
    parser.add_argument(
        '--epochs', type=int, default=DEFAULT_EPOCHS,
        help=f'Number of CLEP pretraining epochs (default: {DEFAULT_EPOCHS})',
    )
    parser.add_argument(
        '--n-channels', type=int, default=DEFAULT_N_CHANNELS,
        help=f'Channel count for the model (default: {DEFAULT_N_CHANNELS}). Ignored if --channels is given.',
    )
    parser.add_argument(
        '--channels', type=str, default=None,
        help='Exact channel list, comma-separated (e.g. "FP1-F7,F7-T7,…"). '
             'Overrides --n-channels. Order matters — must match the headset exactly.',
    )
    parser.add_argument(
        '--mode', type=str, default='both', choices=['prediction', 'detection', 'both'],
        help='Which base model to train (default: both)',
    )

    args = parser.parse_args()

    channel_names = None
    if args.channels:
        channel_names = [c.strip() for c in args.channels.split(',') if c.strip()]
        if not channel_names:
            parser.error('--channels parsed to an empty list')
        n_channels = len(channel_names)
    else:
        n_channels = args.n_channels

    from config import CHB_MIT_DIR, BASE_MODELS_DIR
    chb_dir = Path(args.chb_mit_dir) if args.chb_mit_dir else CHB_MIT_DIR
    out_dir = Path(args.output_dir) if args.output_dir else BASE_MODELS_DIR

    if args.mode == 'both':
        results = train_all_base_models(
            chb_dir, out_dir,
            n_channels=n_channels, epochs=args.epochs,
            channel_names=channel_names,
        )
        for mode, path in results.items():
            print(f'  {mode}: {path}')
    else:
        filename = f'base_predictor_{n_channels}.pt' if args.mode == 'prediction' else f'base_detector_{n_channels}.pt'
        path = train_base_model(
            mode=args.mode,
            chb_mit_dir=chb_dir,
            output_path=out_dir / filename,
            n_channels=n_channels,
            epochs=args.epochs,
            channel_names=channel_names,
        )
        print(f'  {args.mode}: {path}')

    print('Done.')
