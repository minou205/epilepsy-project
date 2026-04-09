"""Flexible-channel personal model training.

Wraps the 3-stage pipeline (CLEP pretrain → finetune → WGAN discriminator)
from personal_prediction.py / personal_detection.py and makes it work with
ANY channel count (9..18) — not just the hardcoded 18 of the original files.

Public API matches what training_service.py expects:
    train_predictor(patient_id, patient_data_dir, chb_mit_dir, output_dir, tier,
                    channel_names, headset_name=None)
    train_detector(patient_id, patient_data_dir, chb_mit_dir, output_dir, tier,
                   channel_names, headset_name=None)

`channel_names` is the patient's locked headset channel list, fetched by
training_service from the patient_headsets DB table BEFORE training starts.
This avoids the need to open a DB session inside the training executor.
"""
import logging
import os
from pathlib import Path
from typing import Callable

import numpy as np
import torch

from services.eeg_data_loader import (
    load_patient_training_data,
    load_chb_mit_for_patient_channels,
)

logger = logging.getLogger(__name__)


# ═══════════════════════════════════════════════════════════════════════════
#  Public API
# ═══════════════════════════════════════════════════════════════════════════

def train_predictor(
    patient_id      : str,
    patient_data_dir: str | Path,
    chb_mit_dir     : str | Path,
    output_dir      : str | Path,
    tier            : str,
    channel_names   : list[str],
    headset_name    : str | None = None,
) -> tuple[str, dict]:
    """Train a flexible-channel seizure PREDICTION model for one patient."""
    from services.personal_prediction import (
        build_model, pretrain_clep, finetune_best,
        calibrate_threshold, train_discriminator_wgan, find_hard_interictal,
        EEGDataset, EEGAugDataset, SequenceWGANDiscriminator,
        THRESHOLD_W, AUG_NOISE_STD, AUG_CH_DROP,
        WGAN_EPOCHS, WGAN_LR, LAMBDA_GP, DISC_FEATURE_DIM, WGAN_SEQ_LEN,
        TRAIN_CONFIG_SIG, TRAIN_CONFIG,
    )
    return _train_model(
        patient_id, patient_data_dir, chb_mit_dir, output_dir, tier,
        channel_names, headset_name,
        mode             ='prediction',
        model_type_label ='hybrid_sts_stan_v2',
        suffix           ='predictor',
        build_model      =build_model,
        pretrain_clep    =pretrain_clep,
        finetune_best    =finetune_best,
        calibrate_threshold=calibrate_threshold,
        train_discriminator_wgan=train_discriminator_wgan,
        find_hard_interictal=find_hard_interictal,
        EEGDataset       =EEGDataset,
        EEGAugDataset    =EEGAugDataset,
        SequenceWGANDiscriminator=SequenceWGANDiscriminator,
        THRESHOLD_W      =THRESHOLD_W,
        AUG_NOISE_STD    =AUG_NOISE_STD,
        AUG_CH_DROP      =AUG_CH_DROP,
        WGAN_EPOCHS      =WGAN_EPOCHS,
        WGAN_LR          =WGAN_LR,
        LAMBDA_GP        =LAMBDA_GP,
        DISC_FEATURE_DIM =DISC_FEATURE_DIM,
        WGAN_SEQ_LEN     =WGAN_SEQ_LEN,
        TRAIN_CONFIG_SIG =TRAIN_CONFIG_SIG,
        TRAIN_CONFIG     =TRAIN_CONFIG,
    )


def train_detector(
    patient_id      : str,
    patient_data_dir: str | Path,
    chb_mit_dir     : str | Path,
    output_dir      : str | Path,
    tier            : str,
    channel_names   : list[str],
    headset_name    : str | None = None,
) -> tuple[str, dict]:
    """Train a flexible-channel seizure DETECTION model for one patient."""
    from services.personal_detection import (
        build_model, pretrain_clep, finetune_best,
        calibrate_threshold, train_discriminator_wgan, find_hard_interictal,
        EEGDataset, EEGAugDataset, SequenceWGANDiscriminator,
        THRESHOLD_W, AUG_NOISE_STD, AUG_CH_DROP,
        WGAN_EPOCHS, WGAN_LR, LAMBDA_GP, DISC_FEATURE_DIM, WGAN_SEQ_LEN,
        TRAIN_CONFIG_SIG, TRAIN_CONFIG,
    )
    return _train_model(
        patient_id, patient_data_dir, chb_mit_dir, output_dir, tier,
        channel_names, headset_name,
        mode             ='detection',
        model_type_label ='hybrid_sts_detection_v1',
        suffix           ='detector',
        build_model      =build_model,
        pretrain_clep    =pretrain_clep,
        finetune_best    =finetune_best,
        calibrate_threshold=calibrate_threshold,
        train_discriminator_wgan=train_discriminator_wgan,
        find_hard_interictal=find_hard_interictal,
        EEGDataset       =EEGDataset,
        EEGAugDataset    =EEGAugDataset,
        SequenceWGANDiscriminator=SequenceWGANDiscriminator,
        THRESHOLD_W      =THRESHOLD_W,
        AUG_NOISE_STD    =AUG_NOISE_STD,
        AUG_CH_DROP      =AUG_CH_DROP,
        WGAN_EPOCHS      =WGAN_EPOCHS,
        WGAN_LR          =WGAN_LR,
        LAMBDA_GP        =LAMBDA_GP,
        DISC_FEATURE_DIM =DISC_FEATURE_DIM,
        WGAN_SEQ_LEN     =WGAN_SEQ_LEN,
        TRAIN_CONFIG_SIG =TRAIN_CONFIG_SIG,
        TRAIN_CONFIG     =TRAIN_CONFIG,
    )


# ═══════════════════════════════════════════════════════════════════════════
#  Shared training pipeline (channel-agnostic)
# ═══════════════════════════════════════════════════════════════════════════

def _save_checkpoint(
    *,
    model, discriminator, patient_id: str, model_type_label: str, suffix: str,
    disc_calibration: float, calib_thresh: float,
    train_ref_mu: float, train_ref_std: float,
    train_config_sig, train_config,
    folder: str, n_channels: int, channel_names: list[str],
    sampling_rate: int = 256,
) -> str:
    """Save the .pt checkpoint with full channel metadata.

    Output filename: {folder}/{patient_id}_{suffix}.pt
    (training_service then renames it to {tier}_{suffix}.pt)
    """
    os.makedirs(folder, exist_ok=True)
    path = os.path.join(folder, f'{patient_id}_{suffix}.pt')
    has_disc = discriminator is not None
    torch.save({
        'state_dict'       : model.state_dict(),
        'disc_state_dict'  : discriminator.state_dict() if has_disc else None,
        'has_discriminator': has_disc,
        'disc_calibration' : float(disc_calibration),
        'train_config_sig' : train_config_sig,
        'train_config'     : train_config,
        'calib_thresh'     : float(calib_thresh),
        'train_ref_mu'     : float(train_ref_mu),
        'train_ref_std'    : float(train_ref_std),
        'model_type'       : model_type_label,
        'n_channels'       : int(n_channels),
        'channel_names'    : list(channel_names),
        'sampling_rate'    : int(sampling_rate),
    }, path)
    logger.info(
        f'[personal_training] saved {suffix} → {path} '
        f'(thresh={calib_thresh:.3f}, n_ch={n_channels})'
    )
    return path


def _train_model(
    patient_id      : str,
    patient_data_dir: str | Path,
    chb_mit_dir     : str | Path,
    output_dir      : str | Path,
    tier            : str,
    channel_names   : list[str],
    headset_name    : str | None,
    *,
    mode            : str,
    model_type_label: str,
    suffix          : str,
    build_model     : Callable,
    pretrain_clep   : Callable,
    finetune_best   : Callable,
    calibrate_threshold     : Callable,
    train_discriminator_wgan: Callable,
    find_hard_interictal    : Callable,
    EEGDataset              : type,
    EEGAugDataset           : type,
    SequenceWGANDiscriminator: type,
    THRESHOLD_W     : float,
    AUG_NOISE_STD   : float,
    AUG_CH_DROP     : float,
    WGAN_EPOCHS     : int,
    WGAN_LR         : float,
    LAMBDA_GP       : float,
    DISC_FEATURE_DIM: int,
    WGAN_SEQ_LEN    : int,
    TRAIN_CONFIG_SIG,
    TRAIN_CONFIG,
) -> tuple[str, dict]:
    """Unified training pipeline that works with any channel count.

    Steps:
      1. Load patient CSV data via load_patient_training_data()
      2. Verify the loaded channel_names matches the locked headset
      3. Load CHB-MIT pretraining data adapted to the patient's channel layout
      4. Split, normalize, pretrain (CLEP), finetune, calibrate threshold
      5. Train WGAN discriminator
      6. Save checkpoint with channel metadata
    """
    patient_data_dir = Path(patient_data_dir)
    chb_mit_dir      = Path(chb_mit_dir)
    output_dir       = str(output_dir)

    if not channel_names or not isinstance(channel_names, list):
        raise ValueError(
            f'[personal_training] channel_names is required for {patient_id} '
            f'(headset must be registered before training)'
        )

    n_ch = len(channel_names)
    if n_ch < 9 or n_ch > 18:
        raise ValueError(
            f'[personal_training] channel count {n_ch} outside allowed range 9..18'
        )

    pos_name = 'preictal' if mode == 'prediction' else 'ictal'
    dev = torch.device('cuda' if torch.cuda.is_available() else 'cpu')

    PRETRAIN_EPOCHS = 50
    FINETUNE_EPOCHS = 60

    # ── 1. Load patient CSV data ────────────────────────────────────────────
    clips, labels, data_n_ch, data_channels, ref_mu, ref_std = \
        load_patient_training_data(patient_data_dir, patient_id, mode=mode)

    if clips is None or len(clips) < 4:
        raise ValueError(
            f'[personal_training] not enough data for {patient_id}: '
            f'{0 if clips is None else len(clips)} clips'
        )

    # ── 2. Verify channels match the locked headset ─────────────────────────
    if data_channels != channel_names:
        raise ValueError(
            f'[personal_training] channel mismatch for {patient_id}: '
            f'data has {data_channels} but headset is locked to {channel_names}'
        )

    pos_clips    = clips[labels == 1]
    normal_clips = clips[labels == 0]

    if len(pos_clips) < 2:
        raise ValueError(f'[personal_training] not enough {pos_name}: {len(pos_clips)}')
    if len(normal_clips) < 2:
        raise ValueError(f'[personal_training] not enough normal: {len(normal_clips)}')

    logger.info(
        f'[personal_training] {patient_id} ({mode}): {len(pos_clips)} {pos_name}, '
        f'{len(normal_clips)} normal, {n_ch}ch'
    )

    # ── 3. Load CHB-MIT for pretraining (adapted to patient channels) ───────
    source_dss = []
    if chb_mit_dir.exists():
        chb_data = load_chb_mit_for_patient_channels(
            chb_mit_dir, channel_names, mode=mode,
        )
        for c, l in chb_data:
            source_dss.append(EEGDataset(c, l))
        logger.info(
            f'[personal_training] {len(source_dss)} CHB-MIT source patients '
            f'(adapted to {n_ch}ch)'
        )

    # ── 4. Split train/val ──────────────────────────────────────────────────
    np.random.shuffle(normal_clips)
    split_p = max(1, int(len(pos_clips) * 0.8))
    train_pos, val_pos = pos_clips[:split_p], pos_clips[split_p:]
    split_n = max(1, int(len(normal_clips) * 0.8))
    train_int, val_int = normal_clips[:split_n], normal_clips[split_n:]

    if len(val_pos) == 0:
        val_pos = train_pos[-1:]
    if len(val_int) == 0:
        val_int = train_int[-1:]

    train_ref_mu  = float(train_int.mean())
    train_ref_std = float(train_int.std()) + 1e-8

    train_pos = (train_pos - train_ref_mu) / train_ref_std
    train_int = (train_int - train_ref_mu) / train_ref_std
    val_pos   = (val_pos   - train_ref_mu) / train_ref_std
    val_int   = (val_int   - train_ref_mu) / train_ref_std

    train_clips  = np.concatenate([train_pos, train_int])
    train_labels = np.array([1] * len(train_pos) + [0] * len(train_int))
    val_clips    = np.concatenate([val_pos, val_int])
    val_labels   = np.array([1] * len(val_pos) + [0] * len(val_int))

    train_ds = EEGDataset(train_clips, train_labels)
    val_ds   = EEGDataset(val_clips, val_labels)

    # ── 5. Build + pretrain + finetune ──────────────────────────────────────
    enc = build_model(E=n_ch).to(dev)

    if source_dss:
        enc = pretrain_clep(enc, source_dss, epochs=PRETRAIN_EPOCHS, dev=dev)

    hard_int_idxs = find_hard_interictal(enc, train_int, THRESHOLD_W, dev)
    if len(hard_int_idxs) > 10:
        extra_int = train_int[hard_int_idxs]
        adv_clips  = np.concatenate([train_pos, extra_int, train_int])
        adv_labels = np.array(
            [1] * len(train_pos) + [0] * len(extra_int) + [0] * len(train_int)
        )
        adv_ds = EEGAugDataset(adv_clips, adv_labels, AUG_NOISE_STD, AUG_CH_DROP)
        enc = finetune_best(
            enc, adv_ds, val_dataset=val_ds,
            epochs=FINETUNE_EPOCHS, batch_size=16, dev=dev,
        )
    else:
        aug_ds = EEGAugDataset(train_clips, train_labels, AUG_NOISE_STD, AUG_CH_DROP)
        enc = finetune_best(
            enc, aug_ds, val_dataset=val_ds,
            epochs=FINETUNE_EPOCHS, batch_size=16, dev=dev,
        )

    calib_thresh = calibrate_threshold(enc, val_ds, dev=dev)

    # ── 6. WGAN discriminator ───────────────────────────────────────────────
    disc = SequenceWGANDiscriminator(DISC_FEATURE_DIM, WGAN_SEQ_LEN).to(dev)
    disc, disc_cal = train_discriminator_wgan(
        enc, disc, train_ds,
        epochs=WGAN_EPOCHS, batch_size=32, lr=WGAN_LR,
        lambda_gp=LAMBDA_GP, dev=dev,
    )

    # ── 7. Save with channel metadata ───────────────────────────────────────
    pt_path = _save_checkpoint(
        model            =enc,
        discriminator    =disc,
        patient_id       =patient_id,
        model_type_label =model_type_label,
        suffix           =suffix,
        disc_calibration =disc_cal,
        calib_thresh     =calib_thresh,
        train_ref_mu     =train_ref_mu,
        train_ref_std    =train_ref_std,
        train_config_sig =TRAIN_CONFIG_SIG,
        train_config     =TRAIN_CONFIG,
        folder           =output_dir,
        n_channels       =n_ch,
        channel_names    =channel_names,
    )

    meta = {
        'tier'           : tier,
        f'{pos_name}_clips': int(len(pos_clips)),
        'normal_clips'   : int(len(normal_clips)),
        'n_channels'     : n_ch,
        'channel_names'  : channel_names,
        'headset_name'   : headset_name,
        'calib_thresh'   : float(calib_thresh),
    }
    return pt_path, meta
