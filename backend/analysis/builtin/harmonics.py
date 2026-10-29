"""Conteúdo harmônico de uma janela do sinal (ajuste por mínimos quadrados)."""

from __future__ import annotations

from typing import Any

import numpy as np

from ..context import AnalysisContext
from ..registry import Analysis, AnalysisRequest, Param, register


@register
class Harmonics(Analysis):
    id = "harmonics"
    name = "Harmônicos"
    description = (
        "Componente DC, fundamental e harmônicas (RMS e % da fundamental) e DHT "
        "na seleção ou, sem seleção, nos últimos ciclos antes do cursor."
    )
    mode = "interval"
    requires = ()
    params = [
        Param("max_harmonic", "Ordem máxima", "number", 15, min=2, max=50, step=1),
        Param("cycles_at_cursor", "Ciclos (sem seleção)", "number", 2, min=1, max=20, step=1,
              help="Usado quando não há seleção: janela que termina no cursor."),
    ]

    def validate(self, req: AnalysisRequest) -> None:
        if not (req.channels or req.voltage_group or req.current_group):
            raise ValueError("Selecione canais ou grupos para a análise harmônica.")

    def run(self, ctx: AnalysisContext, req: AnalysisRequest) -> dict[str, Any]:
        h_max = int(self.param(req, "max_harmonic"))
        if req.t_start is not None and req.t_end is not None:
            i0, i1 = ctx.range_indices(req.t_start, req.t_end)
        else:
            if req.time_s is None:
                raise ValueError("Posicione o cursor ou selecione um intervalo.")
            k = ctx.time_to_index(req.time_s)
            n = int(round(self.param(req, "cycles_at_cursor") * ctx.fs / ctx.f0))
            i0, i1 = max(0, k - n + 1), k
        n = i1 - i0 + 1
        if n < ctx.fs / ctx.f0:
            raise ValueError("Janela menor que 1 ciclo.")
        if n > 200_000:
            raise ValueError("Janela muito longa para análise harmônica.")
        nyquist = int((ctx.fs / 2) // ctx.f0) - 1
        h_max = max(1, min(h_max, nyquist))

        t = np.arange(n) / ctx.fs
        cols = [np.ones(n)]
        for h in range(1, h_max + 1):
            w = 2 * np.pi * h * ctx.f0 * t
            cols += [np.cos(w), np.sin(w)]
        basis = np.column_stack(cols)

        indices = list(req.channels)
        for gid, qty in ((req.voltage_group, "V"), (req.current_group, "I")):
            if gid:
                g = ctx.group(gid, qty)
                indices += [g["a"], g["b"], g["c"]]
        indices = list(dict.fromkeys(indices))[:12]

        signals = np.column_stack([ctx.signal(idx, i0, i1 + 1) for idx in indices])
        coef, *_ = np.linalg.lstsq(basis, signals, rcond=None)

        channels = []
        for j, idx in enumerate(indices):
            c = coef[:, j]
            dc = float(c[0])
            mags = [float(np.hypot(c[2 * h - 1], c[2 * h]) / np.sqrt(2)) for h in range(1, h_max + 1)]
            fund = mags[0]
            thd = float(np.sqrt(sum(m * m for m in mags[1:])) / fund * 100) if fund > 0 else None
            channels.append({
                "index": idx,
                "name": ctx.channel(idx).name,
                "unit": ctx.base_unit(idx),
                "dc": dc,
                "thd_pct": thd,
                "harmonics": [
                    {"h": h, "freq_hz": h * ctx.f0, "rms": m, "pct": (m / fund * 100) if fund > 0 else None}
                    for h, m in enumerate(mags, start=1)
                ],
            })

        return {
            "t_start": float(ctx.time[i0]),
            "t_end": float(ctx.time[i1]),
            "samples": n,
            "f0": ctx.f0,
            "channels": channels,
        }
