"""Medições com dois cursores (C1/C2): valores em cada um, diferenças e
estatísticas do trecho entre eles."""

from __future__ import annotations

from typing import Any

import numpy as np

from .. import dsp
from ..context import AnalysisContext
from ..registry import Analysis, AnalysisRequest, Param, register

MAX_INTERVAL_SAMPLES = 20_000_000


def _num(v) -> float | None:
    v = float(v)
    return v if np.isfinite(v) else None


@register
class CursorMeasurements(Analysis):
    id = "cursors"
    name = "Cursores"
    description = (
        "Valores instantâneos, RMS e fasor (fundamental) em C1 e C2, Δt e diferenças, "
        "e pico/RMS/média do trecho entre os cursores."
    )
    mode = "instant"
    params = [
        Param("t1", "C1", "number", None, unit="s"),
        Param("t2", "C2", "number", None, unit="s"),
        Param("window_cycles", "Janela RMS/fasor", "select", "1", options=[
            {"value": "0.5", "label": "½ ciclo"},
            {"value": "1", "label": "1 ciclo"},
            {"value": "2", "label": "2 ciclos"},
        ]),
    ]

    def validate(self, req: AnalysisRequest) -> None:
        if req.params.get("t1") in (None, "") and req.params.get("t2") in (None, ""):
            raise ValueError("Fixe ao menos um cursor (teclas 1 e 2 ou botões C1/C2).")

    def _times(self, req: AnalysisRequest) -> list[float | None]:
        out = []
        for key in ("t1", "t2"):
            v = req.params.get(key)
            try:
                out.append(None if v in (None, "") else float(v))
            except (TypeError, ValueError) as exc:
                raise ValueError(f"Cursor {key.upper()} inválido.") from exc
        return out

    def run(self, ctx: AnalysisContext, req: AnalysisRequest) -> dict[str, Any]:
        t1, t2 = self._times(req)
        wc = float(self.param(req, "window_cycles"))
        n_win = dsp.window_length(ctx.fs, ctx.f0, wc)
        ks = [None if t is None else int(np.clip(np.searchsorted(ctx.time, t), 0, ctx.n_samples - 1)) for t in (t1, t2)]
        for j, (t, k) in enumerate(zip((t1, t2), ks)):
            if k is not None and k > 0 and abs(ctx.time[k - 1] - t) < abs(ctx.time[k] - t):
                ks[j] = k - 1
        times = [None if k is None else float(ctx.time[k]) for k in ks]
        both = ks[0] is not None and ks[1] is not None
        lo, hi = (min(ks), max(ks)) if both else (None, None)
        if both and hi - lo > MAX_INTERVAL_SAMPLES:
            lo = hi = None  # trecho grande demais para estatística

        meta = ctx.data.meta
        n_analog = len(meta.analog_channels)
        indices = list(dict.fromkeys(int(i) for i in req.channels))[:64]
        ref_angle: list[float | None] = [None, None]
        rows: list[dict[str, Any]] = []
        for idx in indices:
            if 0 <= idx < n_analog:
                info = meta.analog_channels[idx]
                x = ctx.data.analog[idx]
                row: dict[str, Any] = {"index": idx, "name": info.name, "unit": info.unit, "kind": "analog",
                                       "at": []}
                for j, k in enumerate(ks):
                    if k is None:
                        row["at"].append(None)
                        continue
                    seg = np.asarray(x[max(0, k - n_win + 1):k + 1], dtype=np.float64)
                    full = len(seg) == n_win
                    ph = dsp.phasor_at(np.asarray(x[max(0, k - n_win + 1):k + 1], dtype=np.float64),
                                       len(seg) - 1, ctx.fs, ctx.f0, wc) if full else complex(np.nan, np.nan)
                    if full:  # phasor_at referenciou ao início do trecho: corrige para referência absoluta
                        w_ts = 2 * np.pi * ctx.f0 / ctx.fs
                        ph = ph * np.exp(-1j * w_ts * (k - n_win + 1))
                    ang = float(np.degrees(np.angle(ph))) if np.isfinite(ph) else None
                    if ang is not None and ref_angle[j] is None:
                        ref_angle[j] = ang
                    row["at"].append({
                        "value": _num(x[k]),
                        "rms": _num(np.sqrt(np.mean(seg * seg))) if full else None,
                        "mag": _num(abs(ph)) if np.isfinite(ph) else None,
                        "ang": ang,
                        "ang_rel": float(dsp.wrap_deg(ang - ref_angle[j])) if ang is not None else None,
                    })
                a, b = row["at"]
                if a and b:
                    row["delta"] = {k: (b[k] - a[k]) if (a[k] is not None and b[k] is not None) else None
                                    for k in ("value", "rms", "mag")}
                    if a["ang"] is not None and b["ang"] is not None:
                        row["delta"]["ang"] = float(dsp.wrap_deg(b["ang"] - a["ang"]))
                if lo is not None and hi > lo:
                    seg = np.asarray(x[lo:hi + 1], dtype=np.float64)
                    seg = seg[np.isfinite(seg)]
                    if len(seg):
                        kmax = int(np.argmax(np.abs(seg)))
                        row["interval"] = {
                            "peak": float(seg[kmax]),
                            "max": float(seg.max()),
                            "min": float(seg.min()),
                            "mean": float(seg.mean()),
                            "rms": float(np.sqrt(np.mean(seg * seg))),
                        }
                rows.append(row)
            else:
                d = idx - n_analog
                if not (0 <= d < len(meta.digital_channels)):
                    continue
                info = meta.digital_channels[d]
                bits = ctx.data.digital[d]
                row = {"index": idx, "name": info.name, "unit": "", "kind": "digital",
                       "at": [None if k is None else {"value": int(bits[k:k + 1][0])} for k in ks]}
                if lo is not None and hi > lo:
                    arr = np.asarray(bits[lo:hi + 1], dtype=np.int8)
                    ch = np.flatnonzero(np.diff(arr))
                    row["interval"] = {
                        "changes": int(len(ch)),
                        "first_change_t": float(ctx.time[lo + ch[0] + 1]) if len(ch) else None,
                    }
                rows.append(row)

        dt = (times[1] - times[0]) if both else None
        return {
            "t1": times[0],
            "t2": times[1],
            "dt": dt,
            "dt_cycles": dt * ctx.f0 if dt is not None else None,
            "freq_hz": (1.0 / abs(dt)) if dt else None,
            "window_cycles": wc,
            "f0": ctx.f0,
            "channels": rows,
        }
