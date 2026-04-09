import math, os, re, warnings, time
import numpy as np
from scipy.signal import butter, sosfiltfilt
from collections import deque
import matplotlib.pyplot as plt
import mne
import torch
import torch.nn as nn
import torch.nn.functional as F
from torch.utils.data import DataLoader, Dataset, ConcatDataset, TensorDataset
from pathlib import Path

torch.manual_seed(42)
np.random.seed(42)

device = torch.device('cuda' if torch.cuda.is_available() else 'cpu')
print(f'Device: {device} | PyTorch {torch.__version__}')


import hashlib as _hl

N_CH          = 18
FS            = 256
CLIP_S        = 5
CLEN          = FS * CLIP_S
INTER_H       = 2
POSTICTAL_H   = 2
MA_S          = 15
THRESHOLD_W   = 0.6
PREICTAL_MIN  = 15
NORM_VERSION  = 3

ROOT = Path("data/chb_mit")

CH18 = [
    'FP1-F7', 'F7-T7', 'T7-P7', 'P7-O1',
    'FP2-F8', 'F8-T8', 'T8-P8', 'P8-O2',
    'FP1-F3', 'F3-C3', 'C3-P3', 'P3-O1',
    'FP2-F4', 'F4-C4', 'C4-P4', 'P4-O2',
    'FZ-CZ',  'CZ-PZ'
]

L = int(math.floor(math.log2(FS))) - 3

DELTA0_S      = 30    # 15
DISC_GATE_S   = 30
DISC_INT_THRESH = 0.2
SKIP_START_S  = 120

WGAN_EPOCHS      = 100
WGAN_LR          = 4e-5
LAMBDA_GP        = 10.0
DISC_FEATURE_DIM = 256
WGAN_SEQ_LEN     = 3

FOCAL_GAMMA     = 2.0
FOCAL_ALPHA_INT = 1.5
FOCAL_ALPHA_PRE = 1.0

HARD_NEG_FACTOR = 2.5
HARD_NEG_SIM_THRESH = 0.7

AUG_NOISE_STD = 0.05
AUG_CH_DROP   = 0.10

TRAIN_CONFIG = dict(INTER_H=INTER_H, POSTICTAL_H=POSTICTAL_H,
                    PREICTAL_MIN=PREICTAL_MIN, MA_S=MA_S,
                    THRESHOLD_W=THRESHOLD_W, NORM_VERSION=NORM_VERSION)
TRAIN_CONFIG_SIG = _hl.md5(str(sorted(TRAIN_CONFIG.items())).encode()).hexdigest()[:8]

print(f'Channels={N_CH} | Clip={CLIP_S}s | L={L}')
print(f'Classifier gate={DELTA0_S}s | Discriminator gate={DISC_GATE_S}s | Disc thresh={DISC_INT_THRESH}')
print(f'WGAN seq_len={WGAN_SEQ_LEN} | HardNeg factor={HARD_NEG_FACTOR}')
print(f'Config sig: {TRAIN_CONFIG_SIG}')


class EEGDataset(Dataset):
    def __init__(self, clips: np.ndarray, labels: np.ndarray):
        self.clips  = torch.tensor(clips,  dtype=torch.float32)
        self.labels = torch.tensor(labels, dtype=torch.long)
    def __len__(self): return len(self.labels)
    def __getitem__(self, idx): return self.clips[idx], self.labels[idx]


class EEGAugDataset(Dataset):
    def __init__(self, clips, labels, noise_std=0.05, ch_drop_p=0.10):
        self.clips     = torch.tensor(clips,  dtype=torch.float32)
        self.labels    = torch.tensor(labels, dtype=torch.long)
        self.noise_std = noise_std
        self.ch_drop_p = ch_drop_p

    def __len__(self): return len(self.labels)

    def __getitem__(self, idx):
        x = self.clips[idx].clone()
        x = x + torch.randn_like(x) * self.noise_std
        mask = (torch.rand(x.shape[0]) > self.ch_drop_p).float().unsqueeze(1)
        return x * mask, self.labels[idx]

print('EEGDataset + EEGAugDataset ready')


mne.set_log_level('ERROR')
MNE_OK = True


def apply_clep_filter(data, sfreq=256):
    nyq  = 0.5 * sfreq
    sos  = butter(5, [0.5 / nyq, 50.0 / nyq], btype='bandpass', output='sos')
    return sosfiltfilt(sos, data, axis=1).astype(np.float32)


def global_zscore(data, fit_minutes=5):
    fit_samples = min(data.shape[1], int(fit_minutes * 60 * FS))
    fit_data = data[:, :fit_samples]
    mu  = fit_data.mean()
    std = fit_data.std() + 1e-8
    return (data - mu) / std, mu, std


def parse_summary(path):
    out, cur = {}, None
    with open(path) as f:
        for line in f:
            m  = re.match(r'File Name:\s+(\S+)', line)
            mo = re.match(r'Seizure.*Start.*:\s+(\d+)', line)
            me = re.match(r'Seizure.*End.*:\s+(\d+)', line)
            if m:  cur = m.group(1);  out.setdefault(cur, [])
            if mo and cur: out[cur].append([int(mo.group(1)), None])
            if me and cur and out.get(cur): out[cur][-1][1] = int(me.group(1))
    return {k: [tuple(v) for v in vs if v[1]] for k, vs in out.items() if vs}


def _dedup_channels(raw):
    import re as _re
    raw.rename_channels({c: c.upper().replace(' ', '-') for c in raw.ch_names})
    rename_map, used = {}, set()
    for target in CH18:
        if target in raw.ch_names and target not in used:
            used.add(target); continue
        cands = [c for c in raw.ch_names
                 if _re.match(rf'^{_re.escape(target)}-\d+$', c) and c not in used]
        if cands: rename_map[cands[0]] = target; used.add(target)
    if rename_map: raw.rename_channels(rename_map)
    return raw


def load_edf_raw(path):
    if not MNE_OK: return None
    with warnings.catch_warnings():
        warnings.simplefilter('ignore')
        raw = mne.io.read_raw_edf(str(path), preload=True, verbose=False)
    raw = _dedup_channels(raw)
    avail = [c for c in CH18 if c in raw.ch_names]
    if not avail: return None
    raw.pick_channels(avail)
    if raw.info['sfreq'] != FS: raw.resample(FS, verbose=False)
    data, _ = raw[:]
    if len(avail) < N_CH:
        full = np.zeros((N_CH, data.shape[1]), dtype=np.float32)
        for si, ch in enumerate(avail):
            full[CH18.index(ch)] = data[si].astype(np.float32)
        return full
    return data.astype(np.float32)

load_edf = load_edf_raw


def BPatDataset(patient_dir, use_cluster_rule=True, normalize=True):
    patient_dir = Path(patient_dir)
    sumf = list(patient_dir.glob('*-summary.txt'))
    if not sumf: return None, None
    szmap = parse_summary(sumf[0])
    edfs  = sorted(patient_dir.glob('*.edf'))
    file_starts, all_sz = {}, []
    cursor = 0.0
    for edf in edfs:
        try:
            with warnings.catch_warnings():
                warnings.simplefilter('ignore')
                raw = mne.io.read_raw_edf(str(edf), preload=False, verbose=False)
            dur = raw.n_times / raw.info['sfreq']
        except Exception as e:
            print(f"\n  [WARNING] Failed to read {edf.name}: {e}")
            print(f"  [WARNING] Cursor timing for subsequent files in {patient_dir.name} may be shifted!")
            dur = 0.0
        file_starts[edf.name] = (cursor, dur)
        for onset, _ in szmap.get(edf.name, []):
            all_sz.append(cursor + onset)
        cursor += dur

    if len(all_sz) < 2:
        print(f'  Skip {patient_dir.name}: <2 seizures'); return None, None

    if use_cluster_rule:
        used_sz = []
        for t in sorted(all_sz):
            if not used_sz or t - used_sz[-1] > INTER_H * 3600:
                used_sz.append(t)
    else:
        used_sz = sorted(all_sz)
    print(f'  {patient_dir.name}: {len(all_sz)} sz → {len(used_sz)} used')

    all_pre, all_int = [], []
    for edf in edfs:
        abs_start, dur = file_starts.get(edf.name, (0, 0))
        if dur == 0: continue
        raw_data = load_edf_raw(edf)
        if raw_data is None: continue
        filtered  = apply_clep_filter(raw_data, sfreq=FS)
        norm_data = global_zscore(filtered)[0] if normalize else filtered

        for onset_r, _ in szmap.get(edf.name, []):
            if (abs_start + onset_r) not in used_sz: continue
            t0 = max(0, onset_r - PREICTAL_MIN * 60)
            for s in range(int(t0 * FS), int(onset_r * FS) - CLEN + 1, CLEN):
                c = norm_data[:, s:s + CLEN]
                if c.shape[1] == CLEN: all_pre.append(c[None])

        for s in range(0, norm_data.shape[1] - CLEN, CLEN):
            t_abs = abs_start + s / FS
            if all(abs(t_abs - sz) > INTER_H * 3600 for sz in all_sz):
                c = norm_data[:, s:s + CLEN]
                if c.shape[1] == CLEN: all_int.append(c[None])

    if not all_pre: return None, None
    pre  = np.concatenate(all_pre)

    if not all_int:
        for edf in edfs:
            abs_start, dur = file_starts.get(edf.name, (0, 0))
            if dur == 0: continue
            raw_data = load_edf_raw(edf)
            if raw_data is None: continue
            filtered  = apply_clep_filter(raw_data, sfreq=FS)
            norm_data = global_zscore(filtered)[0] if normalize else filtered
            for s in range(0, norm_data.shape[1] - CLEN, CLEN):
                t_abs = abs_start + s / FS
                if all(abs(t_abs - sz) > 30 * 60 for sz in all_sz):
                    c = norm_data[:, s:s + CLEN]
                    if c.shape[1] == CLEN: all_int.append(c[None])
        if not all_int: return None, None

    int_ = np.concatenate(all_int)
    if len(int_) > len(pre):
        idx  = np.round(np.linspace(0, len(int_) - 1, len(pre))).astype(int)
        int_ = int_[idx]

    clips  = np.concatenate([pre, int_])
    labels = np.array([1] * len(pre) + [0] * len(int_))
    print(f'    preictal={len(pre)} | interictal={len(int_)}')
    return clips, labels

print('Data loading ready')


class WaveConv(nn.Module):
    DB4_LO = [ 0.23037781330885523,  0.71484657055291570,
               0.63088076792985890, -0.02798376941685985,
              -0.18703481171909309,  0.03084138183556076,
               0.03288301166688520, -0.01059740178506903]
    DB4_HI = [-0.01059740178506903, -0.03288301166688520,
               0.03084138183556076,  0.18703481171909309,
              -0.02798376941685985, -0.63088076792985890,
               0.71484657055291570, -0.23037781330885523]

    def __init__(self, in_ch):
        super().__init__()
        lo = torch.tensor(self.DB4_LO, dtype=torch.float32)
        hi = torch.tensor(self.DB4_HI, dtype=torch.float32)
        self.register_buffer('lo', lo.unsqueeze(0).unsqueeze(0).repeat(in_ch, 1, 1))
        self.register_buffer('hi', hi.unsqueeze(0).unsqueeze(0).repeat(in_ch, 1, 1))
        self.stride = 2
        self.pad    = 7
        self.C      = in_ch

    def forward(self, x):
        T  = x.shape[-1]
        xp = F.pad(x, (self.pad, self.pad), mode='reflect')
        xA = F.conv1d(xp, self.lo, stride=self.stride, groups=self.C)
        xD = F.conv1d(xp, self.hi, stride=self.stride, groups=self.C)
        return xA[..., :T // 2], xD[..., :T // 2]


class SpectralPyramid(nn.Module):
    def __init__(self, in_ch, fs):
        super().__init__()
        self.L   = int(math.floor(math.log2(fs))) - 3
        self.wcs = nn.ModuleList([WaveConv(in_ch) for _ in range(self.L)])

    def forward(self, x):
        details, a = [], x
        for wc in self.wcs:
            a, d = wc(a)
            details.append(d)
        return details


class TemporalPyramid(nn.Module):
    def __init__(self, in_ch, out_ch, fs):
        super().__init__()
        L  = int(math.floor(math.log2(fs))) - 3
        k  = 2 ** L
        ks = [max(1, k // 8), max(1, k // 4), max(1, k // 2), k, k]
        st = [2 ** (i + 1) for i in range(5)]
        self.convs = nn.ModuleList([
            nn.Sequential(
                nn.Conv1d(in_ch, out_ch, kernel_size=k_, stride=s_,
                          padding=k_ // 2, bias=False),
                nn.BatchNorm1d(out_ch), nn.ELU())
            for k_, s_ in zip(ks, st)])
    
    def forward(self, x):
        out = []
        T = x.shape[-1]
        for i, c in enumerate(self.convs):
            target_len = T // (2 ** (i + 1))
            h = c(x)
            out.append(h[..., :target_len])
        return out


class PyramidConvNet(nn.Module):
    def __init__(self, in_ch, temp_out_ch, fs):
        super().__init__()
        self.spec = SpectralPyramid(in_ch, fs)
        self.temp = TemporalPyramid(in_ch, temp_out_ch, fs)

    def forward(self, x):
        sf = self.spec(x)
        tf = self.temp(x)
        return [torch.cat([s, t], dim=1) for s, t in zip(sf, tf)]

print('Spectral/Temporal Pyramid ready')


class TripleAttentionLayer(nn.Module):
    def __init__(self, in_ch):
        super().__init__()
        self.gconv = nn.Conv2d(in_ch, in_ch, kernel_size=(1, 3),
                               padding=(0, 1), groups=2, bias=False)
        kw = dict(kernel_size=7, padding=3, bias=False)
        self.b1 = nn.Conv2d(2, 1, **kw)
        self.b2 = nn.Conv2d(2, 1, **kw)
        self.b3 = nn.Conv2d(2, 1, **kw)

    @staticmethod
    def _attn(x, conv):
        pool = torch.cat([x.amax(1, keepdim=True), x.mean(1, keepdim=True)], 1)
        return x * torch.sigmoid(conv(pool))

    def forward(self, x):
        x  = self.gconv(x)
        o1 = self._attn(x,                  self.b1)
        o2 = self._attn(x.permute(0,2,1,3), self.b2).permute(0,2,1,3)
        o3 = self._attn(x.permute(0,3,2,1), self.b3).permute(0,3,2,1)
        return (o1 + o2 + o3) / 3.0


class TripleAttentionFusionNet(nn.Module):
    def __init__(self, in_ch, F_len, n_tal=2):
        super().__init__()
        self.nets = nn.ModuleList([
            nn.Sequential(*[TripleAttentionLayer(in_ch) for _ in range(n_tal)])
            for _ in range(5)])
        self.pool = nn.AdaptiveAvgPool2d((1, F_len))

    def forward(self, groups):
        out = []
        for net, f in zip(self.nets, groups):
            h = net(f.unsqueeze(2))
            out.append(self.pool(h).squeeze(2))
        return out

print('TripleAttentionFusionNet ready')


def build_adjacency(pos3d):
    E   = pos3d.shape[0]
    dis = np.linalg.norm(pos3d[:, None] - pos3d[None, :], axis=-1)
    np.fill_diagonal(dis, 0)
    M   = dis[dis > 0].mean()
    A   = np.zeros((E, E), dtype=np.float32)
    for i in range(E):
        nbrs = [dis[i, j] for j in range(E)
                if i != j and dis[i, j] < M and dis[i, j] > 1e-8]
        for j in range(E):
            if i != j and dis[i, j] < M and dis[i, j] > 1e-8:
                A[i, j] = 1.0 / dis[i, j]
        A[i, i] = 1.0 / np.mean(nbrs) if nbrs else 1.0
    return torch.tensor(A, dtype=torch.float32)


CHB_MIT_POS3D = np.array([
    [-0.559,  0.770,  0.000], [-0.905,  0.294,  0.000],
    [-0.905, -0.294,  0.000], [-0.559, -0.770,  0.000],
    [ 0.559,  0.770,  0.000], [ 0.905,  0.294,  0.000],
    [ 0.905, -0.294,  0.000], [ 0.559, -0.770,  0.000],
    [-0.382,  0.860,  0.227], [-0.521,  0.385,  0.632],
    [-0.521, -0.385,  0.632], [-0.382, -0.860,  0.227],
    [ 0.382,  0.860,  0.227], [ 0.521,  0.385,  0.632],
    [ 0.521, -0.385,  0.632], [ 0.382, -0.860,  0.227],
    [ 0.000,  0.500,  0.866], [ 0.000, -0.500,  0.866],
], dtype=np.float32)

A_static = build_adjacency(CHB_MIT_POS3D)


class SpatioDynamicGCN(nn.Module):
    def __init__(self, E, F_len, A, r=16):
        super().__init__()
        self.E = E
        E2     = E * E
        self.register_buffer('A', A)
        self.W1 = nn.Linear(E2, max(1, E2 // r), bias=False)
        self.W2 = nn.Linear(max(1, E2 // r), E2, bias=False)
        self.T1 = nn.Parameter(torch.randn(5, F_len, F_len) * 0.01)
        self.T2 = nn.Parameter(torch.randn(5, F_len, F_len) * 0.01)

    def _dynamic_adj(self):
        h  = F.elu(self.W1(self.A.reshape(-1)))
        Ad = F.relu(self.W2(h))
        return Ad.reshape(self.E, self.E)

    def forward(self, mu):
        Ad     = self._dynamic_adj()
        D_invA = torch.diag(1.0 / Ad.sum(1).clamp(min=1e-6)) @ Ad
        out = []
        for i, m in enumerate(mu):
            h = F.elu(m @ self.T1[i])
            out.append(F.elu((D_invA @ h) @ self.T2[i]))
        return out

print(f'SpatioDynamicGCN ready  |  A shape={A_static.shape}')


class MSTemporalBridge(nn.Module):
    def __init__(self, E=18, F_len=16, feature_dim=256):
        super().__init__()
        in_ch     = E * F_len
        branch_ch = feature_dim // 4
        self.branches = nn.ModuleList([
            nn.Sequential(
                nn.Conv1d(in_ch, branch_ch, kernel_size=k, padding=k // 2),
                nn.BatchNorm1d(branch_ch), nn.ELU())
            for k in [1, 2, 3, 5]])
        self.pool = nn.AdaptiveAvgPool1d(1)
        self.norm = nn.LayerNorm(feature_dim)

    def forward(self, gcn_outputs):
        x     = torch.stack([g.reshape(g.size(0), -1) for g in gcn_outputs], dim=2)
        parts = [self.pool(b(x)).squeeze(-1) for b in self.branches]
        return self.norm(torch.cat(parts, dim=1))

print('MSTemporalBridge ready')


class HybridSTSNet(nn.Module):
    def __init__(self, E=18, fs=256, A=None, temp_ch=18, F_len=16,
                 r=16, n_tal=2, feature_dim=DISC_FEATURE_DIM, n_cls=2):
        super().__init__()
        if A is None:
            A = build_adjacency(CHB_MIT_POS3D[:E])
        fused        = E + temp_ch
        self.pyramid = PyramidConvNet(E, temp_ch, fs)
        self.tal     = TripleAttentionFusionNet(fused, F_len, n_tal)
        self.proj    = nn.Conv1d(fused, E, 1, bias=False)
        self.sdgcn   = SpatioDynamicGCN(E, F_len, A, r)
        self.ms_tcn  = MSTemporalBridge(E=E, F_len=F_len, feature_dim=feature_dim)
        self.fc      = nn.Sequential(nn.Dropout(0.5), nn.Linear(feature_dim, n_cls))

    def encode(self, x):
        g  = self.pyramid(x)
        mu = self.tal(g)
        mu = [self.proj(m) for m in mu]
        return self.ms_tcn(self.sdgcn(mu))

    def forward(self, x):
        return self.fc(self.encode(x))


def build_model(E=18, fs=256, pos=None, temp_ch=18, F_len=16, r=16, n_tal=2):
    A = build_adjacency((pos if pos is not None else CHB_MIT_POS3D)[:E])
    return HybridSTSNet(E=E, fs=fs, A=A, temp_ch=temp_ch, F_len=F_len, r=r, n_tal=n_tal)


_m = build_model()
_p = sum(p.numel() for p in _m.parameters())
_x = torch.randn(2, N_CH, CLEN)
print(f'HybridSTSNet: {_p:,} params | encode={_m.encode(_x).shape} | forward={_m(_x).shape}')
del _m, _x


class SequenceWGANDiscriminator(nn.Module):
    
    def __init__(self, feature_dim=DISC_FEATURE_DIM, seq_len=WGAN_SEQ_LEN, hidden=128):
        super().__init__()
        self.seq_len = seq_len
        self.lstm    = nn.LSTM(feature_dim, hidden, num_layers=1,
                               batch_first=True, bidirectional=False)
        self.fc = nn.Sequential(
            nn.Linear(hidden, 64),
            nn.LeakyReLU(0.2),
            nn.Dropout(0.3),
            nn.Linear(64, 1)
        )

    def forward(self, x):
        if x.dim() == 2:
            x = x.unsqueeze(1)
        _, (h_n, _) = self.lstm(x)
        return self.fc(h_n.squeeze(0)).squeeze(-1)

    def forward_no_cudnn(self, x):
        with torch.backends.cudnn.flags(enabled=False):
            return self.forward(x)


def compute_gradient_penalty(discriminator, pre_feats, int_feats, dev):
    B     = min(len(pre_feats), len(int_feats))
    pre_f = pre_feats[:B].detach()
    int_f = int_feats[:B].detach()
    alpha = torch.rand(B, 1, 1, device=dev) if pre_f.dim() == 3 else torch.rand(B, 1, device=dev)
    f_hat = (alpha * int_f + (1 - alpha) * pre_f).requires_grad_(True)

    d_hat = discriminator.forward_no_cudnn(f_hat)

    grads = torch.autograd.grad(
        outputs=d_hat, inputs=f_hat,
        grad_outputs=torch.ones_like(d_hat),
        create_graph=True, retain_graph=True)[0]

    gp = ((grads.reshape(B, -1).norm(2, dim=1) - 1) ** 2).mean()
    return gp

print('SequenceWGANDiscriminator ready  (LSTM seq_len=%d, Dropout(0.3), cuDNN-safe GP)' % WGAN_SEQ_LEN)


def _display_loss(x):
    return float(x) / (float(x) + 1.0)


def compute_metrics(probs, preds, labels):
    from sklearn.metrics import roc_auc_score
    acc  = float((preds == labels).mean())
    sens = float(preds[labels == 1].mean()) if (labels == 1).any() else 0.0
    spec = float((1 - preds[labels == 0]).mean()) if (labels == 0).any() else 0.0
    tp   = int(((preds == 1) & (labels == 1)).sum())
    fp   = int(((preds == 1) & (labels == 0)).sum())
    prec = tp / max(tp + fp, 1)
    try:
        auc = float(roc_auc_score(labels, probs))
    except Exception:
        auc = 0.5
    return dict(acc=acc, sens=sens, spec=spec, prec=prec, auc=auc)


class ECLoss(nn.Module):
    def __init__(self, init_tau=0.07, hard_neg_factor=HARD_NEG_FACTOR,
                 hard_neg_thresh=HARD_NEG_SIM_THRESH):
        super().__init__()
        self.log_tau        = nn.Parameter(torch.tensor(math.log(init_tau)))
        self.hard_neg_factor = hard_neg_factor
        self.hard_neg_thresh = hard_neg_thresh

    @property
    def tau(self): return self.log_tau.exp().clamp(min=0.01, max=1.0)

    def forward(self, X, y):
        N    = X.shape[0]
        Xn   = F.normalize(X, dim=1)
        tau  = self.tau
        eye  = torch.eye(N, device=X.device)

        y_col    = y.view(-1, 1)
        pos_mask = (y_col == y_col.t()).float() * (1.0 - eye)
        n_pos    = pos_mask.sum(1).clamp(min=1.0)

        sim      = Xn @ Xn.t() / tau - eye * 1e9
        log_denom = torch.logsumexp(sim, dim=1)
        log_probs = sim - log_denom.unsqueeze(1)
        loss_per  = -(log_probs * pos_mask).sum(1) / n_pos

        with torch.no_grad():
            pre_mask = (y_col == 1).float()
            int_mask = (y_col.t() == 0).float()
            raw_sim  = Xn @ Xn.t()
            cross    = raw_sim * pre_mask * int_mask
            is_hard  = (cross.max(0).values >= self.hard_neg_thresh).float()

        hard_weight = torch.ones(N, device=X.device)
        int_indices = (y == 0).nonzero(as_tuple=True)[0]
        if len(int_indices) > 0:
            hard_weight[int_indices] = (
                1.0 + (self.hard_neg_factor - 1.0) * is_hard[int_indices])

        has_pos = pos_mask.sum(1) > 0
        if not has_pos.any():
            return X.new_zeros(1).squeeze()

        weighted = (loss_per * hard_weight)[has_pos]
        return weighted.mean()


class CLEPLoss(nn.Module):
    def __init__(self, alpha=0.5):
        super().__init__()
        self.alpha = alpha
        self.ec    = ECLoss()
        self.ce    = nn.CrossEntropyLoss()

    def forward(self, reps, logits, labels):
        ec_raw = self.ec(reps, labels)
        ce_raw = self.ce(logits, labels)
        loss   = self.alpha * ec_raw + (1 - self.alpha) * ce_raw
        return loss, ec_raw, ce_raw


class FocalLoss(nn.Module):
    def __init__(self, gamma=2.0, alpha_weights=None, label_smoothing=0.05):
        super().__init__()
        self.gamma         = gamma
        self.alpha_weights = alpha_weights
        self.ls            = label_smoothing

    def forward(self, logits, targets):
        n_cls  = logits.size(1)
        log_p  = F.log_softmax(logits, dim=1)
        p_t    = log_p.exp().gather(1, targets.view(-1, 1)).squeeze(1)
        focal  = (1.0 - p_t) ** self.gamma

        smooth = torch.full_like(log_p, self.ls / n_cls)
        smooth.scatter_(1, targets.view(-1, 1),
                        1.0 - self.ls + self.ls / n_cls)
        ce = -(smooth * log_p).sum(dim=1)

        if self.alpha_weights is not None:
            ce = self.alpha_weights.to(targets.device)[targets] * ce

        return (focal * ce).mean()


print('ECLoss (hard-neg mining) + CLEPLoss + FocalLoss + metrics ready')


def pretrain_clep(encoder, source_datasets, epochs=50, batch_size=64,
                  lr=1e-3, dev=None, weight_decay=1e-4):
    
    if dev is None:
        dev = torch.device('cuda' if torch.cuda.is_available() else 'cpu')
    encoder = encoder.to(dev)

    aug_sets = []
    for ds in source_datasets:
        clips_np = ds.clips.numpy()
        clips_np = (clips_np - clips_np.mean()) / (clips_np.std() + 1e-8)
        aug_sets.append(EEGAugDataset(clips_np, ds.labels.numpy(),
                                      AUG_NOISE_STD, AUG_CH_DROP))
    loader = DataLoader(ConcatDataset(aug_sets), batch_size=batch_size,
                        shuffle=True, drop_last=True)

    crit = CLEPLoss(alpha=0.5).to(dev)
    opt  = torch.optim.AdamW(
        list(encoder.parameters()) + list(crit.parameters()),
        lr=lr, weight_decay=weight_decay)

    scheduler = torch.optim.lr_scheduler.CosineAnnealingLR(opt, T_max=epochs, eta_min=1e-5)

    n_clips = len(loader.dataset)
    print(f'[Pretrain] {len(source_datasets)} source patients | {n_clips} clips | {epochs} epochs')
    print(f'  Note: EC loss starts at ~ln(batch/2)≈{math.log(batch_size/2):.2f}, ')
    print(f'        CE starts at ~ln(2)≈0.693 → combined epoch-1 ≈ ')
    print(f'        0.5×{math.log(batch_size/2):.2f} + 0.5×0.693 = {0.5*math.log(batch_size/2)+0.5*0.693:.2f} (expected)')

    best_loss  = float('inf')
    best_state = None

    encoder.train()
    for ep in range(1, epochs + 1):
        total_loss = ec_total = ce_total = 0.0
        for clips, labels in loader:
            clips, labels = clips.to(dev), labels.to(dev)
            opt.zero_grad()
            reps   = encoder.encode(clips)
            logits = encoder.fc(reps)
            loss, ec_l, ce_l = crit(reps, logits, labels)
            loss.backward()
            torch.nn.utils.clip_grad_norm_(encoder.parameters(), max_norm=1.0)
            opt.step()
            total_loss += loss.item()
            ec_total   += ec_l.item()
            ce_total   += ce_l.item()

        scheduler.step()
        avg    = total_loss / len(loader)
        ec_avg = ec_total  / len(loader)
        ce_avg = ce_total  / len(loader)

        if ep == 1 or ep % 10 == 0:
            lr_now = scheduler.get_last_lr()[0]
            print(f'  Epoch {ep:3d}/{epochs}  '
                  f'Loss={avg:.4f}  EC={ec_avg:.4f}  CE={ce_avg:.4f}  '
                  f'tau={crit.ec.tau.item():.4f}  lr={lr_now:.2e}')

        if avg < best_loss:
            best_loss  = avg
            best_state = {k: v.cpu().clone() for k, v in encoder.state_dict().items()}

    if best_state is not None:
        encoder.load_state_dict(best_state)
        print(f'[Pretrain] Done  (best_loss={best_loss:.4f}, best weights restored)')
    else:
        print('[Pretrain] Done')
    return encoder


def finetune_best(encoder, train_dataset, val_dataset=None,
                  epochs=60, batch_size=32, lr=5e-4, dev=None,
                  weight_decay=1e-4, patience=10):
    from torch.utils.data import WeightedRandomSampler
    if dev is None:
        dev = torch.device('cuda' if torch.cuda.is_available() else 'cpu')
    encoder = encoder.to(dev)

    labels_np = train_dataset.labels.numpy()
    n0 = max(int((labels_np == 0).sum()), 1)
    n1 = max(int((labels_np == 1).sum()), 1)
    sample_weights = torch.tensor(
        [1.0 / n0 if l == 0 else 1.0 / n1 for l in labels_np], dtype=torch.float32)
    sampler = WeightedRandomSampler(sample_weights, len(sample_weights), replacement=True)
    loader  = DataLoader(train_dataset, batch_size=batch_size, sampler=sampler)

    val_loader = (DataLoader(val_dataset, batch_size=batch_size, shuffle=False)
                  if val_dataset else None)

    _alpha = torch.tensor([FOCAL_ALPHA_INT, FOCAL_ALPHA_PRE], dtype=torch.float32)
    crit   = FocalLoss(gamma=FOCAL_GAMMA, alpha_weights=_alpha, label_smoothing=0.05)
    opt    = torch.optim.AdamW(encoder.parameters(), lr=lr, weight_decay=weight_decay)
    sched  = torch.optim.lr_scheduler.ReduceLROnPlateau(
        opt, mode='max', patience=5, factor=0.5, min_lr=1e-6)

    best_val_acc = -1.0
    best_state   = {k: v.cpu().clone() for k, v in encoder.state_dict().items()}
    no_improve   = 0
    best_epoch   = 0

    print(f'[Finetune] {len(train_dataset)} clips (n0={n0}, n1={n1}) | max {epochs} epochs')

    for ep in range(1, epochs + 1):
        encoder.train()
        total = 0.0
        for clips, labels in loader:
            clips, labels = clips.to(dev), labels.to(dev)
            opt.zero_grad()
            loss = crit(encoder(clips), labels)
            loss.backward()
            torch.nn.utils.clip_grad_norm_(encoder.parameters(), max_norm=1.0)
            opt.step()
            total += loss.item()
        train_loss = total / len(loader)

        val_msg = ''
        val_acc = 0.0
        if val_loader:
            encoder.eval()
            all_probs, all_preds, all_true = [], [], []
            vtotal = 0.0
            with torch.no_grad():
                for vc, vl in val_loader:
                    vc, vl = vc.to(dev), vl.to(dev)
                    vout   = encoder(vc)
                    vtotal += crit(vout, vl).item()
                    probs_b = F.softmax(vout, dim=1)[:, 1].cpu().numpy()
                    preds_b = (probs_b >= 0.5).astype(int)
                    all_probs.extend(probs_b.tolist())
                    all_preds.extend(preds_b.tolist())
                    all_true.extend(vl.cpu().numpy().tolist())

            all_probs = np.array(all_probs)
            all_preds = np.array(all_preds)
            all_true  = np.array(all_true)
            m         = compute_metrics(all_probs, all_preds, all_true)
            val_acc   = m['acc']
            val_msg   = (f'  Val Loss={_display_loss(vtotal / len(val_loader)):.4f}  '
                         f'Acc={m["acc"]*100:.1f}%  '
                         f'Sens={m["sens"]*100:.1f}%  '
                         f'Prec={m["prec"]*100:.1f}%  '
                         f'AUC={m["auc"]:.3f}')
            sched.step(val_acc)

            if val_acc > best_val_acc + 1e-4:
                best_val_acc = val_acc
                best_state   = {k: v.cpu().clone() for k, v in encoder.state_dict().items()}
                best_epoch   = ep
                no_improve   = 0
            else:
                no_improve += 1

        if ep == 1 or ep % 5 == 0:
            print(f'  Epoch {ep:3d}/{epochs}  Loss={_display_loss(train_loss):.4f}{val_msg}')

        if no_improve >= patience:
            print(f'  Early stop at epoch {ep}  (best={best_epoch}, val_acc={best_val_acc:.3f})')
            break

    encoder.load_state_dict(best_state)
    print(f'[Finetune] Done. Best epoch={best_epoch}  val_acc={best_val_acc:.3f}')
    return encoder


def calibrate_threshold(encoder, val_dataset, dev=None):
    if dev is None:
        dev = torch.device('cuda' if torch.cuda.is_available() else 'cpu')
    if val_dataset is None or len(val_dataset) == 0:
        print(f'  No val set — default threshold {THRESHOLD_W}')
        return THRESHOLD_W

    encoder.eval()
    all_probs, all_labels = [], []
    with torch.no_grad():
        for clips, labels in DataLoader(val_dataset, batch_size=64, shuffle=False):
            p = F.softmax(encoder(clips.to(dev)), dim=1)[:, 1].cpu().numpy()
            all_probs.append(p)
            all_labels.append(labels.numpy())
    probs  = np.concatenate(all_probs)
    labels = np.concatenate(all_labels)

    try:
        from sklearn.metrics import roc_curve, roc_auc_score
        auc       = roc_auc_score(labels, probs)
        fpr, tpr, thresholds = roc_curve(labels, probs)
        j         = tpr - fpr
        best_idx  = j.argmax()
        thresh    = float(np.clip(thresholds[best_idx], 0.40, 0.70))
        preds     = (probs >= thresh).astype(int)
        m         = compute_metrics(probs, preds, labels)
        print(f'  Youden-J threshold={thresh:.3f}  AUC={auc:.3f}  '
              f'Sens={m["sens"]*100:.1f}%  Spec={m["spec"]*100:.1f}%  Prec={m["prec"]*100:.1f}%')
        return thresh
    except Exception as e:
        print(f'  Calibration failed ({e}) — default {THRESHOLD_W}')
        return THRESHOLD_W

print('calibrate_threshold ready')


def _make_sequences(clips, seq_len=WGAN_SEQ_LEN):
    N = len(clips)
    if N < seq_len:
        pad = np.tile(clips[[0]], (seq_len - N, 1, 1))
        clips = np.concatenate([pad, clips], axis=0)
        N = seq_len
    seqs = np.stack([clips[i:i + seq_len] for i in range(N - seq_len + 1)])
    return seqs

def train_discriminator_wgan(encoder, discriminator, train_dataset,
                              epochs=60, batch_size=32, lr=4e-5,
                              lambda_gp=10.0, dev=None, patience=15):
    
    if dev is None:
        dev = torch.device('cuda' if torch.cuda.is_available() else 'cpu')

    encoder = encoder.to(dev).eval()
    discriminator = discriminator.to(dev)
    for p in encoder.parameters():
        p.requires_grad = False

    all_clips = train_dataset.clips.numpy()
    all_labels = train_dataset.labels.numpy()
    pre_clips = all_clips[all_labels == 1]
    int_clips = all_clips[all_labels == 0]

    if len(pre_clips) == 0 or len(int_clips) == 0:
        raise ValueError('Need both classes for WGAN training')

    pre_seqs = _make_sequences(pre_clips)
    int_seqs = _make_sequences(int_clips)
    n = min(len(pre_seqs), len(int_seqs))
    
    pre_seqs = pre_seqs[np.random.choice(len(pre_seqs), n, replace=False)]
    int_seqs = int_seqs[np.random.choice(len(int_seqs), n, replace=False)]

    pre_t = torch.as_tensor(pre_seqs, dtype=torch.float32)
    int_t = torch.as_tensor(int_seqs, dtype=torch.float32)
    
    pre_ld = DataLoader(TensorDataset(pre_t), batch_size=batch_size, shuffle=True, drop_last=True)
    int_ld = DataLoader(TensorDataset(int_t), batch_size=batch_size, shuffle=True, drop_last=True)

    optimizer = torch.optim.Adam(discriminator.parameters(), lr=lr, betas=(0.5, 0.9))
    
    best_w_dist = -float('inf')
    best_disc_state = None
    no_improve = 0
    CHECK_EVERY = 5

    discriminator.train()
    for ep in range(1, epochs + 1):
        d_pre_last = d_int_last = gp_last = None

        for (pb,), (ib,) in zip(pre_ld, int_ld):
            pb, ib = pb.to(dev), ib.to(dev)
            optimizer.zero_grad()
            
            with torch.no_grad():
                B, S, C, T = pb.shape
                pre_feats = encoder.encode(pb.reshape(B * S, C, T)).reshape(B, S, -1)
                int_feats = encoder.encode(ib.reshape(B * S, C, T)).reshape(B, S, -1)
            
            d_pre = discriminator(pre_feats)
            d_int = discriminator(int_feats)
            gp = compute_gradient_penalty(discriminator, pre_feats, int_feats, dev)
            
            loss = d_pre.mean() - d_int.mean() + lambda_gp * gp
            loss.backward()
            optimizer.step()
            
            d_pre_last = d_pre.mean().item()
            d_int_last = d_int.mean().item()
            gp_last = gp.item()

        if ep % CHECK_EVERY == 0 or ep == 1:
            w_dist = d_int_last - d_pre_last
            print(f'  Epoch {ep:3d}/{epochs}  W-dist={w_dist:.4f}  GP={gp_last:.4f}')

            if w_dist > best_w_dist + 1.0:
                best_w_dist = w_dist
                no_improve = 0
                best_disc_state = {k: v.cpu().clone() for k, v in discriminator.state_dict().items()}
            else:
                no_improve += 1
                if no_improve >= patience:
                    break

    if best_disc_state is not None:
        discriminator.load_state_dict(best_disc_state)

    discriminator.eval()
    pre_scores_list, int_scores_list = [], []
    
    eval_pre_ld = DataLoader(TensorDataset(pre_t), batch_size=batch_size, shuffle=False)
    eval_int_ld = DataLoader(TensorDataset(int_t), batch_size=batch_size, shuffle=False)

    with torch.no_grad():
        for (pb,) in eval_pre_ld:
            B, S, C, T = pb.shape
            feats = encoder.encode(pb.to(dev).reshape(B * S, C, T)).reshape(B, S, -1)
            pre_scores_list.append(discriminator(feats).cpu().numpy())
            
        for (ib,) in eval_int_ld:
            B, S, C, T = ib.shape
            feats = encoder.encode(ib.to(dev).reshape(B * S, C, T)).reshape(B, S, -1)
            int_scores_list.append(discriminator(feats).cpu().numpy())

    pre_scores = np.concatenate(pre_scores_list)
    int_scores = np.concatenate(int_scores_list)

    disc_calibration = float((pre_scores.mean() + int_scores.mean()) / 2.0)
    sep = int_scores.mean() - pre_scores.mean()
    
    print(f'[WGAN-GP] Done | separation={sep:.2f} | offset={disc_calibration:.3f}')
    
    for p in encoder.parameters():
        p.requires_grad = True

    return discriminator, disc_calibration

def find_hard_interictal(encoder, interictal_clips, threshold, dev, batch_size=64):
    encoder.eval()
    hard_idxs = []
    
    data_tensor = torch.as_tensor(interictal_clips, dtype=torch.float32)
    ds     = TensorDataset(data_tensor)
    loader = DataLoader(ds, batch_size=batch_size, shuffle=False)
    
    offset = 0
    with torch.no_grad():
        for (batch,) in loader:
            probs = F.softmax(encoder(batch.to(dev)), dim=1)[:, 1].cpu().numpy()
            hard  = np.where(probs >= threshold * 0.8)[0] + offset
            hard_idxs.extend(hard.tolist())
            offset += len(batch)
            
    return np.array(hard_idxs)

def save_patient_brain(model, discriminator, patient_id, disc_calibration=0.0,
                        calib_thresh=0.6, train_ref_mu=0.0, train_ref_std=1.0,
                        folder='patient_predictor'):
    os.makedirs(folder, exist_ok=True)
    path = os.path.join(folder, f'{patient_id}_predictor.pt')
    
    has_disc = discriminator is not None
    
    torch.save({
        'state_dict'       : model.state_dict(),
        'disc_state_dict'  : discriminator.state_dict() if has_disc else None,
        'has_discriminator': has_disc,
        'disc_calibration' : float(disc_calibration),
        'train_config_sig' : TRAIN_CONFIG_SIG,
        'train_config'     : TRAIN_CONFIG,
        'calib_thresh'     : calib_thresh,
        'train_ref_mu'     : float(train_ref_mu),
        'train_ref_std'    : float(train_ref_std),
        'model_type'       : 'hybrid_sts_stan_v2',
    }, path)
    
    print(f'Model saved → {path} (thresh={calib_thresh:.3f}, has_disc={has_disc})')
    return path


# ── Public training API (called by training_service.py) ──────────────────────

def train_predictor(patient_id, patient_data_dir, chb_mit_dir, output_dir, tier):
    """
    Train a personal seizure prediction model for one patient.

    Parameters
    ----------
    patient_id       : str   – Supabase user UUID
    patient_data_dir : str|Path – directory with preictal_*.csv, normal_*.csv, etc.
    chb_mit_dir      : str|Path – CHB-MIT dataset root (for source-patient pretraining)
    output_dir       : str|Path – where to save the .pt file
    tier             : str   – version label, e.g. 'v1'

    Returns
    -------
    (pt_path, meta_dict)
    """
    import glob
    patient_data_dir = Path(patient_data_dir)
    chb_mit_dir      = Path(chb_mit_dir)
    output_dir       = str(output_dir)
    dev = torch.device('cuda' if torch.cuda.is_available() else 'cpu')

    PRETRAIN_EPOCHS = 50
    FINETUNE_EPOCHS = 60

    # ── 1. Load patient data from uploaded CSVs ──────────────────────────────
    preictal_files = sorted(glob.glob(str(patient_data_dir / "preictal_*.csv")))
    ictal_files    = sorted(glob.glob(str(patient_data_dir / "ictal_*.csv")))
    normal_files   = sorted(glob.glob(str(patient_data_dir / "normal_*.csv")))
    fp_files       = sorted(glob.glob(str(patient_data_dir / "false_positives" / "false_positive_*.csv")))

    def load_csv_clips(file_list):
        """Load EEG clips from CSV files. Each file → [N_clips, N_CH, CLEN] array."""
        all_clips = []
        for fp in file_list:
            try:
                data = np.loadtxt(fp, delimiter=',', skiprows=1)  # skip header
                # data shape: [samples, channels] → reshape to clips
                n_samples = data.shape[0]
                n_clips = n_samples // CLEN
                if n_clips == 0:
                    continue
                trimmed = data[:n_clips * CLEN]
                # Reshape: [n_clips, CLEN, channels] → [n_clips, channels, CLEN]
                clips = trimmed.reshape(n_clips, CLEN, -1).transpose(0, 2, 1)
                # Ensure 18 channels (pad or trim)
                if clips.shape[1] < N_CH:
                    pad = np.zeros((clips.shape[0], N_CH - clips.shape[1], CLEN))
                    clips = np.concatenate([clips, pad], axis=1)
                elif clips.shape[1] > N_CH:
                    clips = clips[:, :N_CH, :]
                all_clips.append(clips.astype(np.float32))
            except Exception as e:
                print(f'[train_predictor] Warning: skipping {fp}: {e}')
        if not all_clips:
            return np.empty((0, N_CH, CLEN), dtype=np.float32)
        return np.concatenate(all_clips, axis=0)

    pre_clips    = load_csv_clips(preictal_files)
    normal_clips = load_csv_clips(normal_files + fp_files)

    if len(pre_clips) < 2:
        raise ValueError(f'Not enough preictal data for {patient_id}: {len(pre_clips)} clips')
    if len(normal_clips) < 2:
        raise ValueError(f'Not enough normal data for {patient_id}: {len(normal_clips)} clips')

    print(f'[train_predictor] {patient_id}: {len(pre_clips)} preictal, {len(normal_clips)} normal clips')

    # ── 2. Load CHB-MIT source patients for pretraining ──────────────────────
    source_dss = []
    if chb_mit_dir.exists():
        for d in sorted(chb_mit_dir.glob('chb*')):
            if not d.is_dir():
                continue
            try:
                c, l = BPatDataset(d, use_cluster_rule=True)
                if c is not None:
                    source_dss.append(EEGDataset(c, l))
            except Exception:
                continue
        print(f'[train_predictor] {len(source_dss)} source patients for pretraining')

    # ── 3. Split train/val ───────────────────────────────────────────────────
    np.random.shuffle(normal_clips)
    split = max(1, int(len(pre_clips) * 0.8))
    train_pre, val_pre = pre_clips[:split], pre_clips[split:]
    split_n = max(1, int(len(normal_clips) * 0.8))
    train_int, val_int = normal_clips[:split_n], normal_clips[split_n:]

    if len(val_pre) == 0:
        val_pre = train_pre[-1:]
    if len(val_int) == 0:
        val_int = train_int[-1:]

    train_ref_mu  = float(train_int.mean())
    train_ref_std = float(train_int.std()) + 1e-8

    train_pre = (train_pre - train_ref_mu) / train_ref_std
    train_int = (train_int - train_ref_mu) / train_ref_std
    val_pre   = (val_pre - train_ref_mu) / train_ref_std
    val_int   = (val_int - train_ref_mu) / train_ref_std

    train_clips  = np.concatenate([train_pre, train_int])
    train_labels = np.array([1] * len(train_pre) + [0] * len(train_int))
    val_clips    = np.concatenate([val_pre, val_int])
    val_labels   = np.array([1] * len(val_pre) + [0] * len(val_int))

    train_ds = EEGDataset(train_clips, train_labels)
    val_ds   = EEGDataset(val_clips, val_labels)

    # ── 4. Build + pretrain + finetune ───────────────────────────────────────
    enc = build_model(E=N_CH).to(dev)

    if source_dss:
        enc = pretrain_clep(enc, source_dss, epochs=PRETRAIN_EPOCHS, dev=dev)

    hard_int_idxs = find_hard_interictal(enc, train_int, THRESHOLD_W, dev)
    if len(hard_int_idxs) > 10:
        extra_int = train_int[hard_int_idxs]
        adv_clips  = np.concatenate([train_pre, extra_int, train_int])
        adv_labels = np.array([1]*len(train_pre) + [0]*len(extra_int) + [0]*len(train_int))
        adv_ds = EEGAugDataset(adv_clips, adv_labels, AUG_NOISE_STD, AUG_CH_DROP)
        enc = finetune_best(enc, adv_ds, val_dataset=val_ds, epochs=FINETUNE_EPOCHS, batch_size=16, dev=dev)
    else:
        aug_ds = EEGAugDataset(train_clips, train_labels, AUG_NOISE_STD, AUG_CH_DROP)
        enc = finetune_best(enc, aug_ds, val_dataset=val_ds, epochs=FINETUNE_EPOCHS, batch_size=16, dev=dev)

    calib_thresh = calibrate_threshold(enc, val_ds, dev=dev)

    # ── 5. WGAN discriminator ────────────────────────────────────────────────
    disc = SequenceWGANDiscriminator(DISC_FEATURE_DIM, WGAN_SEQ_LEN).to(dev)
    disc, disc_cal = train_discriminator_wgan(
        enc, disc, train_ds,
        epochs=WGAN_EPOCHS, batch_size=32, lr=WGAN_LR, lambda_gp=LAMBDA_GP, dev=dev,
    )

    # ── 6. Save ──────────────────────────────────────────────────────────────
    pt_path = save_patient_brain(
        enc, disc, patient_id,
        disc_calibration=disc_cal,
        calib_thresh=calib_thresh,
        train_ref_mu=train_ref_mu,
        train_ref_std=train_ref_std,
        folder=output_dir,
    )

    meta = {
        'tier': tier,
        'preictal_clips': len(pre_clips),
        'normal_clips': len(normal_clips),
        'calib_thresh': calib_thresh,
    }
    return pt_path, meta


if __name__ == '__main__':

  TARGET_PATIENT  = "chb12"
  PRETRAIN_EPOCHS = 50
  FINETUNE_EPOCHS = 60

  print(f'Loading {TARGET_PATIENT}...')
  target_clips, target_labels = BPatDataset(
      ROOT / TARGET_PATIENT, use_cluster_rule=False, normalize=False)

  if target_clips is None:
      raise RuntimeError(f'Could not load {TARGET_PATIENT}. Check ROOT.')

  print('Loading source patients...')
  source_dss = []
  for _d in sorted(ROOT.glob('chb*')):
      if not _d.is_dir() or _d.name == TARGET_PATIENT: continue
      _c, _l = BPatDataset(_d, use_cluster_rule=True)
      if _c is not None: source_dss.append(EEGDataset(_c, _l))
  print(f'  {len(source_dss)} source patients loaded')

  all_c = target_clips
  all_l = target_labels
  pre   = all_c[all_l == 1]
  inte  = all_c[all_l == 0]

  inte = inte[np.random.permutation(len(inte))]

  clips_per_sz = PREICTAL_MIN * 60 // CLIP_S
  n_sz         = max(1, len(pre) // clips_per_sz)
  sz_groups    = [s for s in np.array_split(pre, n_sz) if len(s) > 0]
  n_total      = len(sz_groups)

  if n_total < 2:
      raise ValueError(f'Need ≥2 seizure groups. Got {n_total}.')

  train_pre  = np.concatenate(sz_groups[:-1])
  val_pre    = sz_groups[-1]
  split_idx  = int(len(inte) * (n_total - 1) / n_total)
  train_inte = inte[:split_idx]
  val_inte   = inte[split_idx:]

  train_ref_mu  = float(train_inte.mean())
  train_ref_std = float(train_inte.std()) + 1e-8

  train_pre  = (train_pre - train_ref_mu) / train_ref_std
  train_inte = (train_inte - train_ref_mu) / train_ref_std
  val_pre    = (val_pre - train_ref_mu) / train_ref_std
  val_inte   = (val_inte - train_ref_mu) / train_ref_std

  val_clips  = np.concatenate([val_pre, val_inte])
  val_labels = np.array([1] * len(val_pre) + [0] * len(val_inte))

  train_clips  = np.concatenate([train_pre, train_inte])
  train_labels = np.array([1] * len(train_pre) + [0] * len(train_inte))

  train_ds = EEGDataset(train_clips, train_labels)
  val_ds   = EEGDataset(val_clips,   val_labels)

  print(f'   Train: {len(train_pre)} pre + {len(train_inte)} int')
  print(f'   Val:   {len(val_pre)} pre + {len(val_inte)} int (unbalanced)')

  t0  = time.time()
  enc = build_model(E=N_CH).to(device)

  enc = pretrain_clep(enc, source_dss, epochs=PRETRAIN_EPOCHS, dev=device)

  print('\n[Adversarial Loader] Scanning interictal for hard negatives...')
  hard_int_idxs = find_hard_interictal(enc, train_inte, THRESHOLD_W, device)
  if len(hard_int_idxs) > 10:
      extra_int = train_inte[hard_int_idxs]
      adv_clips  = np.concatenate([train_pre, extra_int, train_inte])
      adv_labels = np.array([1]*len(train_pre) + [0]*len(extra_int) + [0]*len(train_inte))
      adv_ds     = EEGAugDataset(adv_clips, adv_labels, AUG_NOISE_STD, AUG_CH_DROP)
      print(f'   Found {len(hard_int_idxs)} hard interictal clips')
      enc = finetune_best(enc, adv_ds, val_dataset=val_ds, epochs=FINETUNE_EPOCHS, batch_size=16, dev=device)
  else:
      print('   Standard fine-tuning')
      aug_ds = EEGAugDataset(train_clips, train_labels, AUG_NOISE_STD, AUG_CH_DROP)
      enc = finetune_best(enc, aug_ds, val_dataset=val_ds, epochs=FINETUNE_EPOCHS, batch_size=16, dev=device)

  calib_thresh = calibrate_threshold(enc, val_ds, dev=device)
  print(f'   Calibrated threshold: {calib_thresh:.3f}')

  print('\n[WGAN-GP] Training sequence discriminator...')
  disc = SequenceWGANDiscriminator(DISC_FEATURE_DIM, WGAN_SEQ_LEN).to(device)
  disc, disc_cal = train_discriminator_wgan(
      enc, disc, train_ds,
      epochs=WGAN_EPOCHS, batch_size=32, lr=WGAN_LR, lambda_gp=LAMBDA_GP, dev=device)

  save_patient_brain(enc, disc, TARGET_PATIENT,
                     disc_calibration=disc_cal,
                     calib_thresh=calib_thresh,
                     train_ref_mu=train_ref_mu,
                     train_ref_std=train_ref_std)

  print(f'\nTotal training time: {(time.time() - t0) / 60:.1f} min')

  def seizure_alarm_system(edf_file_path, patient_id, brain_folder='patient_predictor', plot=True):
      dev = torch.device('cuda' if torch.cuda.is_available() else 'cpu')
      brain_path = os.path.join(brain_folder, f'{patient_id}_brain.pt')

      if not os.path.exists(brain_path):
          raise FileNotFoundError(f'No model found for {patient_id}.')

      # 1. Load Model and Calibration Stats
      _ckpt = torch.load(brain_path, map_location=dev, weights_only=False)
      alarm_thresh     = float(_ckpt['calib_thresh'])
      train_ref_mu     = float(_ckpt['train_ref_mu'])
      train_ref_std    = float(_ckpt['train_ref_std'])
      disc_calibration = float(_ckpt.get('disc_calibration', 0.0))

      model = build_model(E=N_CH).to(dev)
      model.load_state_dict(_ckpt['state_dict'])
      model.eval()

      # Load Discriminator as a safety valve (Sequence-based)
      discriminator = None
      if _ckpt.get('disc_state_dict') is not None:
          discriminator = SequenceWGANDiscriminator(DISC_FEATURE_DIM, WGAN_SEQ_LEN).to(dev)
          discriminator.load_state_dict(_ckpt['disc_state_dict'])
          discriminator.eval()

      # 2. Data Preparation and Global Normalization
      raw_data = load_edf_raw(edf_file_path)
      filtered_data = apply_clep_filter(raw_data, sfreq=FS)
      norm_data = (filtered_data - train_ref_mu) / (train_ref_std + 1e-8)
      T_total = norm_data.shape[1]

      # 3. Inference Loop with Active Suppression (Multiplicative Fusion)
      fused_probs = []
      emb_buffer  = deque(maxlen=WGAN_SEQ_LEN)

      with torch.no_grad():
          for start in range(0, T_total - CLEN + 1, FS):
              window = norm_data[:, start:start + CLEN]
              win_t  = torch.from_numpy(window).float().unsqueeze(0).to(dev)

              # Extract Classifier features
              feats = model.encode(win_t)
              p_pre = F.softmax(model.fc(feats), dim=1)[0, 1].item()

              # Apply Discriminator Suppression (to kill false positives)
              suppression = 1.0
              if discriminator is not None:
                  emb_buffer.append(feats.squeeze(0).cpu())
                  if len(emb_buffer) == WGAN_SEQ_LEN:
                      seq = torch.stack(list(emb_buffer)).unsqueeze(0).to(dev)
                      raw_d = discriminator(seq).item()
                      # Probability that the state is "Normal" (Interictal)
                      disc_int_p = float(torch.sigmoid(torch.tensor(raw_d - disc_calibration)).item())
                      # Suppression factor: the more certain the disc is of 'normal', the lower the probability
                      suppression = (1.0 - disc_int_p)

              # Final fused probability: collapses if the discriminator objects
              fused_probs.append(p_pre * suppression)

      fused_probs = np.array(fused_probs)
      smoothed = np.convolve(fused_probs, np.ones(MA_S) / MA_S, mode='same')

      # 4. Search for the "First Alarm" only
      first_alarm_sec = None
      consec = 0

      for idx, p_val in enumerate(smoothed):
          # NO SKIP_START_S: Analysis starts from second 0
          if p_val >= alarm_thresh:
              consec += 1
              if consec >= DELTA0_S:
                  first_alarm_sec = idx - DELTA0_S + 1
                  break # Exit loop immediately after the first hit
          else:
              consec = 0

      # 5. Final Report and Rendering
      print('\n' + '=' * 60)
      if first_alarm_sec is not None:
          a_min = first_alarm_sec / 60
          print(f'  FIRST SEIZURE ALARM DETECTED')
          print(f'     Time: {first_alarm_sec}s ({a_min:.2f} minutes)')
          print(f'     Status: Analysis stopped at first valid detection.')
      else:
          print(f'  STATUS: NO SEIZURE ACTIVITY DETECTED')
          print(f'     Threshold w={alarm_thresh:.3f} was never sustained for {DELTA0_S}s.')
      print('=' * 60 + '\n')

      if plot:
          render_single_alarm_plot(fused_probs, smoothed, alarm_thresh, first_alarm_sec, patient_id)

      return smoothed

  def render_single_alarm_plot(raw, smooth, thresh, alarm_sec, pid):
      t_min = np.arange(len(raw)) / 60.0
      plt.figure(figsize=(15, 5))
      plt.plot(t_min, raw, alpha=0.15, color='gray', label='Fused Raw')
      plt.plot(t_min, smooth, color='navy', lw=2, label='Smoothed Prediction')
      plt.axhline(thresh, color='red', ls='--', label=f'Threshold (w={thresh:.2f})')

      if alarm_sec is not None:
          plt.axvline(alarm_sec/60, color='orange', lw=3, ls='-.', label='FIRST ALARM')
          plt.fill_between(t_min, 0, 1, where=(t_min >= alarm_sec/60) & (t_min <= alarm_sec/60 + PREICTAL_MIN),
                           color='green', alpha=0.1, label='Prediction Window')

      plt.title(f'Single-Hit Seizure Alarm - Patient {pid}')
      plt.xlabel('Time (min)')
      plt.ylabel('Confidence Score')
      plt.legend(loc='upper right')
      plt.grid(alpha=0.2)
      plt.tight_layout()
      plt.show()

  smoothed = seizure_alarm_system('data/secret/chb12_38.edf', 'chb12')

  smoothed = seizure_alarm_system('data/secret/chb12_39.edf', 'chb12')

  smoothed = seizure_alarm_system('data/secret/chb12_41.edf', 'chb12')
