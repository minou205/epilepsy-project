import mne
import numpy as np
from typing import Tuple, List, Dict

CHUNK_SIZE: int = 16


class EEGDataHandler:

    def __init__(self) -> None:
        self.raw           = None
        self.data_uv       : np.ndarray = None
        self.channel_names : List[str]  = []
        self.sampling_rate : int        = 256
        self.n_samples     : int        = 0
        self.duration      : float      = 0.0

    def load_edf(self, filepath: str) -> Tuple[bool, str]:
        try:
            self.raw = mne.io.read_raw_edf(filepath, preload=True, verbose=False)

            self.sampling_rate = int(self.raw.info["sfreq"])
            self.channel_names = list(self.raw.ch_names)
            self.data_uv       = (self.raw.get_data() * 1e6).astype(np.float32)
            self.n_samples     = self.data_uv.shape[1]
            self.duration      = self.n_samples / self.sampling_rate

            return (
                True,
                f"Loaded {len(self.channel_names)} channels — "
                f"{self.duration:.1f} s @ {self.sampling_rate} Hz",
            )

        except Exception as exc:
            return False, f"Failed to load EDF: {exc}"

    def get_chunk(
        self,
        position  : int,
        channels  : List[str],
        chunk_size: int = CHUNK_SIZE,
    ) -> Tuple[int, Dict[str, List[float]], bool]:
        end     = position + chunk_size
        wrapped = False

        if end > self.n_samples:
            position = 0
            end      = chunk_size
            wrapped  = True

        chunk: Dict[str, List[float]] = {}
        for ch in channels:
            if ch in self.channel_names:
                idx = self.channel_names.index(ch)
                chunk[ch] = [round(float(v), 4)
                             for v in self.data_uv[idx, position:end]]

        return end, chunk, wrapped

    def get_display_window(
        self,
        position       : int,
        channels       : List[str],
        window_samples : int = 1280,
    ) -> Dict[str, np.ndarray]:
        start = max(0, position - window_samples)
        pad   = window_samples - (position - start)

        result: Dict[str, np.ndarray] = {}
        for ch in channels:
            if ch in self.channel_names:
                idx  = self.channel_names.index(ch)
                data = self.data_uv[idx, start:position]
                if pad > 0:
                    data = np.concatenate([np.zeros(pad, dtype=np.float32), data])
                result[ch] = data
        return result

    @property
    def is_loaded(self) -> bool:
        return self.data_uv is not None

    def second_to_sample(self, second: float) -> int:
        return max(0, min(int(second * self.sampling_rate), self.n_samples - CHUNK_SIZE))

    def sample_to_second(self, sample: int) -> float:
        return sample / self.sampling_rate
