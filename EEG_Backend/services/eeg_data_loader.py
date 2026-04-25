import math
import re
import warnings
from collections import defaultdict
from pathlib import Path

import numpy as np
from scipy.signal import butter, sosfiltfilt

FS           = 256
CLIP_S       = 5
CLEN         = FS * CLIP_S
N_CH         = 18
INTER_H      = 2
POSTICTAL_H  = 2
PREICTAL_MIN = 15

CH18 = [
    'FP1-F7', 'F7-T7', 'T7-P7', 'P7-O1',
    'FP2-F8', 'F8-T8', 'T8-P8', 'P8-O2',
    'FP1-F3', 'F3-C3', 'C3-P3', 'P3-O1',
    'FP2-F4', 'F4-C4', 'C4-P4', 'P4-O2',
    'FZ-CZ',  'CZ-PZ',
]


def apply_clep_filter(data: np.ndarray, sfreq: int = 256) -> np.ndarray:
    nyq  = 0.5 * sfreq
    low  = 0.5  / nyq
    high = 50.0 / nyq
    sos  = butter(5, [low, high], btype='bandpass', output='sos')
    return sosfiltfilt(sos, data, axis=1).astype(np.float32)


def global_zscore(data: np.ndarray):
    mu  = float(data.mean())
    std = float(data.std()) + 1e-8
    return (data - mu) / std, mu, std


def _parse_txt_file(path: Path):
    channel_data: dict[str, list[tuple[int, float]]] = defaultdict(list)
    label = None

    with open(path, 'r') as f:
        header = f.readline().strip()
        if not header.startswith('timestamp_ms'):
            return channel_data, label

        for line in f:
            parts = line.strip().split(',')
            if len(parts) < 5:
                continue
            ch_name   = parts[1].strip()
            samp_idx  = int(parts[2].strip())
            lbl       = parts[3].strip()
            amplitude = float(parts[4].strip())

            channel_data[ch_name].append((samp_idx, amplitude))
            if label is None:
                label = lbl

    for ch in channel_data:
        channel_data[ch].sort(key=lambda x: x[0])

    return channel_data, label


def _reconstruct_continuous_signal(
    txt_files: list[Path],
    target_label: str,
) -> tuple[np.ndarray | None, list[str]]:
    all_channels: set[str] = set()
    file_data: list[dict[str, list[tuple[int, float]]]] = []

    for path in txt_files:
        ch_data, label = _parse_txt_file(path)
        if label != target_label or not ch_data:
            continue
        file_data.append(ch_data)
        all_channels.update(ch_data.keys())

    if not file_data:
        return None, []

    channel_names = []
    for ch in CH18:
        if ch in all_channels:
            channel_names.append(ch)
            all_channels.discard(ch)
    channel_names.extend(sorted(all_channels))

    per_channel: dict[str, list[float]] = {ch: [] for ch in channel_names}

    for ch_data in file_data:
        for ch in channel_names:
            if ch in ch_data:
                per_channel[ch].extend([amp for _, amp in ch_data[ch]])

    if not per_channel or not any(per_channel.values()):
        return None, []

    max_len = max(len(v) for v in per_channel.values())
    n_ch    = len(channel_names)
    signal  = np.zeros((n_ch, max_len), dtype=np.float32)

    for i, ch in enumerate(channel_names):
        samples = per_channel[ch]
        signal[i, :len(samples)] = np.array(samples, dtype=np.float32)

    return signal, channel_names


def _slice_clips(signal: np.ndarray, clip_len: int = CLEN) -> np.ndarray:
    C, T = signal.shape
    n_clips = T // clip_len
    if n_clips == 0:
        return np.empty((0, C, clip_len), dtype=np.float32)
    clipped_T = n_clips * clip_len
    reshaped  = signal[:, :clipped_T].reshape(C, n_clips, clip_len)
    return reshaped.transpose(1, 0, 2)


def load_patient_txt_data(
    data_dir: Path,
    patient_id: str,
    positive_label: str,
    negative_label: str,
) -> tuple[np.ndarray | None, np.ndarray | None, list[str], float, float]:
    patient_dir = data_dir
    if not patient_dir.exists():
        return None, None, [], 0.0, 1.0

    pos_files = sorted(patient_dir.glob(f'{positive_label}_*.csv'))
    neg_files = sorted(patient_dir.glob(f'{negative_label}_*.csv'))

    if not pos_files and not neg_files:
        return None, None, [], 0.0, 1.0

    pos_signal, pos_channels = _reconstruct_continuous_signal(pos_files, positive_label)
    neg_signal, neg_channels = _reconstruct_continuous_signal(neg_files, negative_label)

    if pos_channels and neg_channels:
        channel_names = pos_channels if len(pos_channels) >= len(neg_channels) else neg_channels
    elif pos_channels:
        channel_names = pos_channels
    elif neg_channels:
        channel_names = neg_channels
    else:
        return None, None, [], 0.0, 1.0

    n_ch = len(channel_names)

    all_signals = []
    if pos_signal is not None:
        all_signals.append(pos_signal[:n_ch])
    if neg_signal is not None:
        all_signals.append(neg_signal[:n_ch])

    combined = np.concatenate(all_signals, axis=1)
    filtered = apply_clep_filter(combined, sfreq=FS)
    ref_mu   = float(filtered.mean())
    ref_std  = float(filtered.std()) + 1e-8

    pos_clips_list = []
    if pos_signal is not None:
        pf = apply_clep_filter(pos_signal[:n_ch], sfreq=FS)
        pn = (pf - ref_mu) / ref_std
        pos_clips_list.append(_slice_clips(pn))

    neg_clips_list = []
    if neg_signal is not None:
        nf = apply_clep_filter(neg_signal[:n_ch], sfreq=FS)
        nn = (nf - ref_mu) / ref_std
        neg_clips_list.append(_slice_clips(nn))

    pos_clips = np.concatenate(pos_clips_list) if pos_clips_list else np.empty((0, n_ch, CLEN))
    neg_clips = np.concatenate(neg_clips_list) if neg_clips_list else np.empty((0, n_ch, CLEN))

    if len(pos_clips) == 0 and len(neg_clips) == 0:
        return None, None, channel_names, ref_mu, ref_std

    if len(neg_clips) > len(pos_clips) and len(pos_clips) > 0:
        idx = np.round(np.linspace(0, len(neg_clips) - 1, len(pos_clips))).astype(int)
        neg_clips = neg_clips[idx]
    elif len(pos_clips) > len(neg_clips) and len(neg_clips) > 0:
        idx = np.round(np.linspace(0, len(pos_clips) - 1, len(neg_clips))).astype(int)
        pos_clips = pos_clips[idx]

    clips  = np.concatenate([pos_clips, neg_clips]).astype(np.float32)
    labels = np.array(
        [1] * len(pos_clips) + [0] * len(neg_clips),
        dtype=np.int64,
    )

    return clips, labels, channel_names, ref_mu, ref_std


def load_patient_training_data(
    patient_data_dir: Path,
    patient_id: str,
    mode: str = 'prediction',
) -> tuple[np.ndarray | None, np.ndarray | None, int, list[str], float, float]:
    patient_data_dir = Path(patient_data_dir)
    positive_label = 'preictal' if mode == 'prediction' else 'ictal'
    negative_label = 'normal'

    clips, labels, channel_names, ref_mu, ref_std = load_patient_txt_data(
        patient_data_dir, patient_id, positive_label, negative_label,
    )

    fp_dir = patient_data_dir / 'false_positives'
    if fp_dir.exists() and ref_std > 0:
        fp_files = sorted(fp_dir.glob('false_positive_*.csv'))
        if fp_files:
            fp_signal, fp_channels = _reconstruct_continuous_signal(
                fp_files, 'false_positive',
            )
            if fp_signal is not None and channel_names:
                ordered = np.zeros(
                    (len(channel_names), fp_signal.shape[1]),
                    dtype=np.float32,
                )
                for tgt_i, ch in enumerate(channel_names):
                    if ch in fp_channels:
                        src_i = fp_channels.index(ch)
                        ordered[tgt_i] = fp_signal[src_i]
                fp_filtered = apply_clep_filter(ordered, sfreq=FS)
                fp_norm = (fp_filtered - ref_mu) / ref_std
                fp_clips = _slice_clips(fp_norm)
                if len(fp_clips) > 0 and clips is not None:
                    clips = np.concatenate([clips, fp_clips])
                    labels = np.concatenate([
                        labels, np.zeros(len(fp_clips), dtype=np.int64),
                    ])

    n_channels = len(channel_names) if channel_names else 0
    return clips, labels, n_channels, channel_names, ref_mu, ref_std


def _try_import_mne():
    try:
        import mne
        mne.set_log_level('ERROR')
        return mne
    except ImportError:
        return None


def parse_summary(path: Path) -> dict:
    out, cur = {}, None
    with open(path) as f:
        for line in f:
            m = re.match(r'File Name:\s+(\S+)', line)
            if m:
                cur = m.group(1)
                out.setdefault(cur, [])
            mo = re.match(r'Seizure.*Start.*:\s+(\d+)', line)
            me = re.match(r'Seizure.*End.*:\s+(\d+)', line)
            if mo and cur:
                out[cur].append([int(mo.group(1)), None])
            if me and cur and out.get(cur):
                out[cur][-1][1] = int(me.group(1))
    return {k: [tuple(v) for v in vs if v[1]] for k, vs in out.items() if vs}


def _dedup_channels(raw, mne_mod):
    norm = {c: c.upper().replace(' ', '-') for c in raw.ch_names}
    raw.rename_channels(norm)
    rename_map = {}
    already_used = set()
    for target in CH18:
        if target in raw.ch_names and target not in already_used:
            already_used.add(target)
            continue
        candidates = [
            c for c in raw.ch_names
            if re.match(rf'^{re.escape(target)}-\d+$', c)
            and c not in already_used
        ]
        if candidates:
            rename_map[candidates[0]] = target
            already_used.add(target)
    if rename_map:
        raw.rename_channels(rename_map)
    return raw


def load_edf_raw(path: Path, mne_mod=None):
    if mne_mod is None:
        mne_mod = _try_import_mne()
    if mne_mod is None:
        return None
    try:
        with warnings.catch_warnings():
            warnings.simplefilter('ignore')
            raw = mne_mod.io.read_raw_edf(str(path), preload=True, verbose=False)
    except Exception:
        return None
    raw = _dedup_channels(raw, mne_mod)
    avail = [c for c in CH18 if c in raw.ch_names]
    if not avail:
        return None
    raw.pick_channels(avail)
    if raw.info['sfreq'] != FS:
        raw.resample(FS, verbose=False)
    if len(avail) < N_CH:
        data, _ = raw[:]
        T = data.shape[1]
        full = np.zeros((N_CH, T), dtype=np.float32)
        for src_i, ch in enumerate(avail):
            tgt_i = CH18.index(ch)
            full[tgt_i] = data[src_i].astype(np.float32)
        return full
    data, _ = raw[:]
    return data.astype(np.float32)


def load_chb_mit_patient(
    patient_dir: Path,
    mode: str = 'prediction',
    use_cluster_rule: bool = True,
    normalize: bool = True,
) -> tuple[np.ndarray | None, np.ndarray | None]:
    mne_mod = _try_import_mne()
    if mne_mod is None:
        print('[eeg_data_loader] mne not available — skipping CHB-MIT')
        return None, None

    sumf = list(patient_dir.glob('*-summary.txt'))
    if not sumf:
        return None, None
    szmap = parse_summary(sumf[0])
    edfs  = sorted(patient_dir.glob('*.edf'))

    file_starts: dict[str, tuple[float, float]] = {}
    all_sz: list[float] = []
    cursor = 0.0
    for edf in edfs:
        try:
            with warnings.catch_warnings():
                warnings.simplefilter('ignore')
                raw = mne_mod.io.read_raw_edf(str(edf), preload=False, verbose=False)
            dur = raw.n_times / raw.info['sfreq']
        except Exception:
            dur = 0.0
        file_starts[edf.name] = (cursor, dur)
        for onset, _ in szmap.get(edf.name, []):
            all_sz.append(cursor + onset)
        cursor += dur

    if len(all_sz) < 2:
        return None, None

    if use_cluster_rule:
        used_sz = []
        for t in sorted(all_sz):
            if not used_sz or t - used_sz[-1] > INTER_H * 3600:
                used_sz.append(t)
    else:
        used_sz = sorted(all_sz)

    all_pos, all_neg = [], []

    for edf in edfs:
        abs_start, dur = file_starts.get(edf.name, (0, 0))
        if dur == 0:
            continue
        raw_data = load_edf_raw(edf, mne_mod)
        if raw_data is None:
            continue

        filtered = apply_clep_filter(raw_data, sfreq=FS)
        if normalize:
            norm_data, _, _ = global_zscore(filtered)
        else:
            norm_data = filtered

        for onset_r, end_r in szmap.get(edf.name, []):
            if (abs_start + onset_r) not in used_sz:
                continue

            if mode == 'prediction':
                t0 = max(0, onset_r - PREICTAL_MIN * 60)
                for s in range(int(t0 * FS), int(onset_r * FS) - CLEN + 1, CLEN):
                    c = norm_data[:, s:s + CLEN]
                    if c.shape[1] == CLEN:
                        all_pos.append(c[None])
            elif mode == 'detection':
                for s in range(int(onset_r * FS), int(end_r * FS) - CLEN + 1, CLEN):
                    c = norm_data[:, s:s + CLEN]
                    if c.shape[1] == CLEN:
                        all_pos.append(c[None])

        for s in range(0, norm_data.shape[1] - CLEN, CLEN):
            t_abs = abs_start + s / FS
            if all(abs(t_abs - sz) > INTER_H * 3600 for sz in all_sz):
                c = norm_data[:, s:s + CLEN]
                if c.shape[1] == CLEN:
                    all_neg.append(c[None])

    if not all_pos:
        return None, None

    pos = np.concatenate(all_pos)

    if not all_neg:
        all_neg_fb = []
        for edf in edfs:
            abs_start, dur = file_starts.get(edf.name, (0, 0))
            if dur == 0:
                continue
            raw_data = load_edf_raw(edf, mne_mod)
            if raw_data is None:
                continue
            filtered = apply_clep_filter(raw_data, sfreq=FS)
            if normalize:
                norm_data, _, _ = global_zscore(filtered)
            else:
                norm_data = filtered
            for s in range(0, norm_data.shape[1] - CLEN, CLEN):
                t_abs = abs_start + s / FS
                if all(abs(t_abs - sz) > 30 * 60 for sz in all_sz):
                    c = norm_data[:, s:s + CLEN]
                    if c.shape[1] == CLEN:
                        all_neg_fb.append(c[None])
        if not all_neg_fb:
            return None, None
        all_neg = all_neg_fb

    neg = np.concatenate(all_neg)

    if len(neg) > len(pos):
        idx = np.round(np.linspace(0, len(neg) - 1, len(pos))).astype(int)
        neg = neg[idx]

    clips  = np.concatenate([pos, neg])
    labels = np.array([1] * len(pos) + [0] * len(neg))

    return clips, labels


def load_chb_mit_for_pretraining(
    chb_mit_dir: Path,
    mode: str = 'prediction',
) -> list:
    if not chb_mit_dir.exists():
        print(f'[eeg_data_loader] CHB-MIT directory not found: {chb_mit_dir}')
        return []

    datasets = []
    for d in sorted(chb_mit_dir.glob('chb*')):
        if not d.is_dir():
            continue
        clips, labels = load_chb_mit_patient(
            d, mode=mode, use_cluster_rule=True)
        if clips is not None:
            datasets.append((clips, labels))
            print(f'  {d.name}: {len(clips)} clips '
                  f'(pos={int((labels == 1).sum())}, neg={int((labels == 0).sum())})')

    print(f'[eeg_data_loader] Loaded {len(datasets)} CHB-MIT patients for {mode} pretraining.')
    return datasets


def load_edf_raw_for_channels(
    path: Path,
    target_channels: list[str],
    mne_mod=None,
) -> np.ndarray | None:
    if mne_mod is None:
        mne_mod = _try_import_mne()
    if mne_mod is None:
        return None
    try:
        with warnings.catch_warnings():
            warnings.simplefilter('ignore')
            raw = mne_mod.io.read_raw_edf(str(path), preload=True, verbose=False)
    except Exception:
        return None

    raw  = _dedup_channels(raw, mne_mod)
    avail = [c for c in target_channels if c in raw.ch_names]
    if not avail:
        return None

    raw.pick_channels(avail)
    if raw.info['sfreq'] != FS:
        raw.resample(FS, verbose=False)

    n_target = len(target_channels)
    data, _  = raw[:]
    T        = data.shape[1]
    full     = np.zeros((n_target, T), dtype=np.float32)
    for src_i, ch in enumerate(avail):
        tgt_i = target_channels.index(ch)
        full[tgt_i] = data[src_i].astype(np.float32)
    return full


def load_chb_mit_patient_for_channels(
    patient_dir: Path,
    target_channels: list[str],
    mode: str = 'prediction',
    use_cluster_rule: bool = True,
    normalize: bool = True,
) -> tuple[np.ndarray | None, np.ndarray | None]:
    mne_mod = _try_import_mne()
    if mne_mod is None:
        print('[eeg_data_loader] mne not available — skipping CHB-MIT')
        return None, None

    sumf = list(patient_dir.glob('*-summary.txt'))
    if not sumf:
        return None, None
    szmap = parse_summary(sumf[0])
    edfs  = sorted(patient_dir.glob('*.edf'))

    file_starts: dict[str, tuple[float, float]] = {}
    all_sz: list[float] = []
    cursor = 0.0
    for edf in edfs:
        try:
            with warnings.catch_warnings():
                warnings.simplefilter('ignore')
                raw = mne_mod.io.read_raw_edf(str(edf), preload=False, verbose=False)
            dur = raw.n_times / raw.info['sfreq']
        except Exception:
            dur = 0.0
        file_starts[edf.name] = (cursor, dur)
        for onset, _ in szmap.get(edf.name, []):
            all_sz.append(cursor + onset)
        cursor += dur

    if len(all_sz) < 2:
        return None, None

    if use_cluster_rule:
        used_sz = []
        for t in sorted(all_sz):
            if not used_sz or t - used_sz[-1] > INTER_H * 3600:
                used_sz.append(t)
    else:
        used_sz = sorted(all_sz)

    all_pos, all_neg = [], []

    for edf in edfs:
        abs_start, dur = file_starts.get(edf.name, (0, 0))
        if dur == 0:
            continue
        raw_data = load_edf_raw_for_channels(edf, target_channels, mne_mod)
        if raw_data is None:
            continue

        filtered = apply_clep_filter(raw_data, sfreq=FS)
        if normalize:
            norm_data, _, _ = global_zscore(filtered)
        else:
            norm_data = filtered

        for onset_r, end_r in szmap.get(edf.name, []):
            if (abs_start + onset_r) not in used_sz:
                continue

            if mode == 'prediction':
                t0 = max(0, onset_r - PREICTAL_MIN * 60)
                for s in range(int(t0 * FS), int(onset_r * FS) - CLEN + 1, CLEN):
                    c = norm_data[:, s:s + CLEN]
                    if c.shape[1] == CLEN:
                        all_pos.append(c[None])
            elif mode == 'detection':
                for s in range(int(onset_r * FS), int(end_r * FS) - CLEN + 1, CLEN):
                    c = norm_data[:, s:s + CLEN]
                    if c.shape[1] == CLEN:
                        all_pos.append(c[None])

        for s in range(0, norm_data.shape[1] - CLEN, CLEN):
            t_abs = abs_start + s / FS
            if all(abs(t_abs - sz) > INTER_H * 3600 for sz in all_sz):
                c = norm_data[:, s:s + CLEN]
                if c.shape[1] == CLEN:
                    all_neg.append(c[None])

    if not all_pos:
        return None, None

    pos = np.concatenate(all_pos)

    if not all_neg:
        all_neg_fb = []
        for edf in edfs:
            abs_start, dur = file_starts.get(edf.name, (0, 0))
            if dur == 0:
                continue
            raw_data = load_edf_raw_for_channels(edf, target_channels, mne_mod)
            if raw_data is None:
                continue
            filtered = apply_clep_filter(raw_data, sfreq=FS)
            if normalize:
                norm_data, _, _ = global_zscore(filtered)
            else:
                norm_data = filtered
            for s in range(0, norm_data.shape[1] - CLEN, CLEN):
                t_abs = abs_start + s / FS
                if all(abs(t_abs - sz) > 30 * 60 for sz in all_sz):
                    c = norm_data[:, s:s + CLEN]
                    if c.shape[1] == CLEN:
                        all_neg_fb.append(c[None])
        if not all_neg_fb:
            return None, None
        all_neg = all_neg_fb

    neg = np.concatenate(all_neg)

    if len(neg) > len(pos):
        idx = np.round(np.linspace(0, len(neg) - 1, len(pos))).astype(int)
        neg = neg[idx]

    clips  = np.concatenate([pos, neg])
    labels = np.array([1] * len(pos) + [0] * len(neg))
    return clips, labels


def load_chb_mit_for_patient_channels(
    chb_mit_dir: Path,
    target_channels: list[str],
    mode: str = 'prediction',
) -> list:
    if not chb_mit_dir.exists():
        print(f'[eeg_data_loader] CHB-MIT directory not found: {chb_mit_dir}')
        return []

    datasets = []
    for d in sorted(chb_mit_dir.glob('chb*')):
        if not d.is_dir():
            continue
        clips, labels = load_chb_mit_patient_for_channels(
            d, target_channels, mode=mode, use_cluster_rule=True,
        )
        if clips is not None:
            datasets.append((clips, labels))
            print(f'  {d.name}: {len(clips)} clips '
                  f'(pos={int((labels == 1).sum())}, neg={int((labels == 0).sum())})')

    print(f'[eeg_data_loader] Loaded {len(datasets)} CHB-MIT patients '
          f'for {mode} pretraining ({len(target_channels)}ch).')
    return datasets
