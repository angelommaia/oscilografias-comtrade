"""Grandezas derivadas (séries temporais) calculadas a partir de fasores.

Fonte única de verdade: cada métrica é declarada UMA vez em `_METRICS`
(nome, unidade, grupo e função de cálculo). Para adicionar uma grandeza
nova basta acrescentar uma entrada — o catálogo enviado ao frontend, a série
temporal e o valor no cursor passam a incluí-la automaticamente.

Os fasores são RMS (ver analysis/dsp.py), portanto S = Σ V·I*.
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Any, Callable

import numpy as np

from analysis.dsp import sequence_components, wrap_deg

Ph = dict[str, np.ndarray]  # chaves: va, vb, vc, ia, ib, ic (arrays complexos)


def _ang(z: np.ndarray) -> np.ndarray:
    return np.degrees(np.angle(z))


def _s(p: Ph) -> np.ndarray:
    return p["va"] * np.conj(p["ia"]) + p["vb"] * np.conj(p["ib"]) + p["vc"] * np.conj(p["ic"])


@dataclass(frozen=True)
class Metric:
    key: str
    name: str
    unit: str
    group: str
    fn: Callable[[Ph], np.ndarray]


_METRICS: list[Metric] = [
    Metric("rms_va", "RMS Va", "V", "RMS", lambda p: np.abs(p["va"])),
    Metric("rms_vb", "RMS Vb", "V", "RMS", lambda p: np.abs(p["vb"])),
    Metric("rms_vc", "RMS Vc", "V", "RMS", lambda p: np.abs(p["vc"])),
    Metric("rms_ia", "RMS Ia", "A", "RMS", lambda p: np.abs(p["ia"])),
    Metric("rms_ib", "RMS Ib", "A", "RMS", lambda p: np.abs(p["ib"])),
    Metric("rms_ic", "RMS Ic", "A", "RMS", lambda p: np.abs(p["ic"])),
    # Ângulos relativos a Va (ângulos absolutos não têm significado físico isolado)
    Metric("ang_va", "∠Va", "°", "Fase", lambda p: np.where(np.isfinite(p["va"]), 0.0, np.nan)),
    Metric("ang_vb", "∠Vb (ref. Va)", "°", "Fase", lambda p: wrap_deg(_ang(p["vb"]) - _ang(p["va"]))),
    Metric("ang_vc", "∠Vc (ref. Va)", "°", "Fase", lambda p: wrap_deg(_ang(p["vc"]) - _ang(p["va"]))),
    Metric("ang_ia", "∠Ia (ref. Va)", "°", "Fase", lambda p: wrap_deg(_ang(p["ia"]) - _ang(p["va"]))),
    Metric("ang_ib", "∠Ib (ref. Va)", "°", "Fase", lambda p: wrap_deg(_ang(p["ib"]) - _ang(p["va"]))),
    Metric("ang_ic", "∠Ic (ref. Va)", "°", "Fase", lambda p: wrap_deg(_ang(p["ic"]) - _ang(p["va"]))),
    Metric("ang_vi_a", "∠(Va-Ia)", "°", "Fase", lambda p: wrap_deg(_ang(p["va"]) - _ang(p["ia"]))),
    Metric("ang_vi_b", "∠(Vb-Ib)", "°", "Fase", lambda p: wrap_deg(_ang(p["vb"]) - _ang(p["ib"]))),
    Metric("ang_vi_c", "∠(Vc-Ic)", "°", "Fase", lambda p: wrap_deg(_ang(p["vc"]) - _ang(p["ic"]))),
    Metric("p_total", "P total", "W", "Potência", lambda p: _s(p).real),
    Metric("q_total", "Q total", "VAr", "Potência", lambda p: _s(p).imag),
    Metric("s_total", "S total", "VA", "Potência", lambda p: np.abs(_s(p))),
    Metric("v0", "|V0|", "V", "Sequência", lambda p: np.abs(sequence_components(p["va"], p["vb"], p["vc"])[0])),
    Metric("v1", "|V1|", "V", "Sequência", lambda p: np.abs(sequence_components(p["va"], p["vb"], p["vc"])[1])),
    Metric("v2", "|V2|", "V", "Sequência", lambda p: np.abs(sequence_components(p["va"], p["vb"], p["vc"])[2])),
    Metric("i0", "|I0|", "A", "Sequência", lambda p: np.abs(sequence_components(p["ia"], p["ib"], p["ic"])[0])),
    Metric("i1", "|I1|", "A", "Sequência", lambda p: np.abs(sequence_components(p["ia"], p["ib"], p["ic"])[1])),
    Metric("i2", "|I2|", "A", "Sequência", lambda p: np.abs(sequence_components(p["ia"], p["ib"], p["ic"])[2])),
    Metric("vab", "|Vab|", "V", "Linha", lambda p: np.abs(p["va"] - p["vb"])),
    Metric("vbc", "|Vbc|", "V", "Linha", lambda p: np.abs(p["vb"] - p["vc"])),
    Metric("vca", "|Vca|", "V", "Linha", lambda p: np.abs(p["vc"] - p["va"])),
]

_BY_KEY = {m.key: m for m in _METRICS}

METRIC_CATALOG: dict[str, dict[str, str]] = {
    m.key: {"name": m.name, "unit": m.unit, "group": m.group} for m in _METRICS
}
METRIC_GROUPS: list[dict[str, Any]] = []
for _m in _METRICS:
    if not METRIC_GROUPS or METRIC_GROUPS[-1]["id"] != _m.group:
        METRIC_GROUPS.append({"id": _m.group, "keys": []})
    METRIC_GROUPS[-1]["keys"].append(_m.key)


def compute_metrics(phasors: Ph, keys: list[str] | None = None) -> dict[str, np.ndarray]:
    keys = keys or list(_BY_KEY)
    out: dict[str, np.ndarray] = {}
    with np.errstate(invalid="ignore", divide="ignore"):
        for key in keys:
            metric = _BY_KEY.get(key)
            if metric is not None:
                out[key] = np.asarray(metric.fn(phasors), dtype=float)
    return out


def decimate_series(times: np.ndarray, values: np.ndarray, max_points: int) -> tuple[np.ndarray, np.ndarray]:
    """Decimação min/máx vetorizada (ignora NaN)."""
    n = len(values)
    if n <= max_points:
        return times, values
    bucket = int(np.ceil(n / max(max_points // 2, 1)))
    pad = (-n) % bucket
    v = np.concatenate([values, np.full(pad, np.nan)]).reshape(-1, bucket)
    t = np.concatenate([times, np.full(pad, times[-1])]).reshape(-1, bucket)
    valid = np.isfinite(v).any(axis=1)
    v, t = v[valid], t[valid]
    vmin = np.where(np.isfinite(v), v, np.inf)
    vmax = np.where(np.isfinite(v), v, -np.inf)
    imin = vmin.argmin(axis=1)
    imax = vmax.argmax(axis=1)
    rows = np.arange(len(v))
    first = np.minimum(imin, imax)
    second = np.maximum(imin, imax)
    out_t = np.column_stack([t[rows, first], t[rows, second]]).ravel()
    out_v = np.column_stack([v[rows, first], v[rows, second]]).ravel()
    return out_t, out_v
