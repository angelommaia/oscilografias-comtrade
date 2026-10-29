"""Contexto de dados entregue às análises (acesso uniforme ao registro)."""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any

import numpy as np

from . import dsp

_UNIT_SCALE = {"kv": 1e3, "ka": 1e3, "mv": 1e-3, "ma": 1e-3}


@dataclass
class RecordData:
    """Dados numéricos de um registro, já em valores primários (numpy)."""

    meta: Any  # RecordMeta
    time: np.ndarray
    analog: list[np.ndarray]  # valores primários, unidade do CFG
    digital: list[np.ndarray]
    manual_groups: list[dict[str, Any]] = field(default_factory=list)
    auto_groups: list[dict[str, Any]] = field(default_factory=list)

    @property
    def groups(self) -> list[dict[str, Any]]:
        return self.auto_groups + self.manual_groups


class AnalysisContext:
    """Fachada usada pelas análises: tempo↔amostra, sinais, fasores, grupos."""

    def __init__(self, data: RecordData):
        self.data = data
        self.meta = data.meta
        self.fs: float = float(data.meta.sample_rate_hz)
        self.f0: float = float(data.meta.frequency_hz or 60.0)
        self.time = data.time
        self.n_samples = len(data.time)
        self._channels = {ch.index: ch for ch in data.meta.analog_channels}
        self._analog_pos = {ch.index: i for i, ch in enumerate(data.meta.analog_channels)}

    # ---------------------------------------------------------------- tempo
    def time_to_index(self, t: float) -> int:
        idx = int(np.searchsorted(self.time, t, side="right") - 1)
        return int(min(max(idx, 0), self.n_samples - 1))

    def range_indices(self, t_start: float | None, t_end: float | None) -> tuple[int, int]:
        i0 = 0 if t_start is None else self.time_to_index(t_start)
        i1 = self.n_samples - 1 if t_end is None else self.time_to_index(t_end)
        if i1 < i0:
            i0, i1 = i1, i0
        return i0, i1

    # ---------------------------------------------------------------- canais
    def channel(self, index: int):
        ch = self._channels.get(int(index))
        if ch is None:
            raise ValueError(f"Canal analógico inválido: {index}")
        return ch

    def unit_scale(self, index: int) -> float:
        return _UNIT_SCALE.get((self.channel(index).unit or "").strip().lower(), 1.0)

    def base_unit(self, index: int) -> str:
        unit = (self.channel(index).unit or "").strip()
        if unit.lower() in _UNIT_SCALE:
            return unit[1:].upper()
        return unit

    def signal(self, index: int, start: int = 0, end: int | None = None) -> np.ndarray:
        """Sinal primário em unidade base (V, A) para amostras [start, end)."""
        pos = self._analog_pos.get(int(index))
        if pos is None:
            raise ValueError(f"Canal analógico inválido: {index}")
        arr = np.asarray(self.data.analog[pos][start:end])
        scale = self.unit_scale(index)
        return arr * scale if scale != 1.0 else arr

    def transformer_ratio(self, index: int) -> float | None:
        ch = self.channel(index)
        if ch.primary and ch.secondary:
            return float(ch.primary) / float(ch.secondary)
        return None

    # ---------------------------------------------------------------- fasores
    def phasors(
        self,
        index: int,
        i0: int,
        i1: int,
        window_cycles: float = 1.0,
        estimator: str = "ls",
        step: int = 1,
    ) -> np.ndarray:
        """Fasores RMS (unidade base) nas amostras i0, i0+step, … ≤ i1."""
        n = dsp.window_length(self.fs, self.f0, window_cycles)
        lead = max(0, i0 - n + 1)
        sig = self.signal(index, lead, i1 + 1)
        if step <= 1:
            ph = dsp.phasor_series(sig, self.fs, self.f0, window_cycles, estimator, first_sample=lead)
            return ph[i0 - lead :]
        ends = np.arange(i0, i1 + 1, step) - lead
        return dsp.phasors_at(sig, ends, self.fs, self.f0, window_cycles, estimator, first_sample=lead)

    def phasor_at(self, index: int, sample: int, window_cycles: float = 1.0, estimator: str = "ls") -> complex:
        return complex(self.phasors(index, sample, sample, window_cycles, estimator)[0])

    # ---------------------------------------------------------------- grupos
    def group(self, group_id: str | None, quantity: str | None = None) -> dict[str, Any]:
        if not group_id:
            raise ValueError("Grupo não informado.")
        for g in self.data.groups:
            if g["id"] == group_id and (quantity is None or g["quantity"] == quantity):
                return g
        raise ValueError(f"Grupo não encontrado: {group_id}")

    def group_phasors(
        self, group_id: str, quantity: str, i0: int, i1: int, window_cycles: float, estimator: str,
        step: int = 1,
    ) -> tuple[np.ndarray, np.ndarray, np.ndarray]:
        g = self.group(group_id, quantity)
        return tuple(self.phasors(g[p], i0, i1, window_cycles, estimator, step) for p in ("a", "b", "c"))  # type: ignore[return-value]


# Acima deste nº de amostras os fasores são calculados só nos pontos exibidos.
FULL_RESOLUTION_LIMIT = 200_000


def plot_step(n_samples: int, max_points: int) -> int:
    """Passo entre amostras para séries longas (1 = resolução total)."""
    if n_samples <= FULL_RESOLUTION_LIMIT:
        return 1
    return max(1, int(np.ceil(n_samples / max(max_points, 100))))


def decimate_indices(n: int, max_points: int) -> np.ndarray:
    if n <= max_points:
        return np.arange(n)
    return np.unique(np.linspace(0, n - 1, max_points).round().astype(int))


def finite_or_none(value: float) -> float | None:
    value = float(value)
    return value if np.isfinite(value) else None


def complex_to_dict(z: complex, ref_angle_deg: float = 0.0) -> dict[str, float | None]:
    if not np.isfinite(z):
        return {"mag": None, "ang": None, "re": None, "im": None}
    zr = z * np.exp(-1j * np.radians(ref_angle_deg))
    return {
        "mag": float(abs(zr)),
        "ang": float(dsp.wrap_deg(np.degrees(np.angle(zr)))),
        "re": float(zr.real),
        "im": float(zr.imag),
    }
