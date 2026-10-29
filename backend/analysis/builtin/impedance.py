"""Diagrama de impedância (plano R-X) com trajetória dos 6 laços."""

from __future__ import annotations

from typing import Any

import numpy as np

from ..context import AnalysisContext, decimate_indices, finite_or_none, plot_step
from ..registry import Analysis, AnalysisRequest, Param, register
from .common import estimator_param, window_param

LOOPS = ("AG", "BG", "CG", "AB", "BC", "CA")


@register
class ImpedanceDiagram(Analysis):
    id = "impedance"
    name = "Diagrama de impedância (R-X)"
    description = (
        "Impedância aparente vista pelos laços fase-terra (com compensação k0) e "
        "fase-fase. Trajetória ao longo da seleção/janela visível e ponto no cursor."
    )
    mode = "interval"
    requires = ("voltage_group", "current_group")
    params = [
        window_param(),
        estimator_param(),
        Param(
            "k0_mode", "Compensação de terra", "select", "z0z1",
            options=[
                {"value": "z0z1", "label": "Calcular de Z1/Z0 da linha"},
                {"value": "k0", "label": "Informar k0 (mód./âng.)"},
                {"value": "none", "label": "Sem compensação (k0 = 0)"},
            ],
            section="Linha / k0",
        ),
        Param("r1", "R1", "number", 0.0, unit="Ω", help="Resistência de seq. positiva da linha (mesma base do diagrama).", section="Linha / k0"),
        Param("x1", "X1", "number", 0.0, unit="Ω", section="Linha / k0"),
        Param("r0", "R0", "number", 0.0, unit="Ω", section="Linha / k0"),
        Param("x0", "X0", "number", 0.0, unit="Ω", section="Linha / k0"),
        Param("k0_mag", "|k0|", "number", 0.0, min=0, step=0.01, section="Linha / k0"),
        Param("k0_ang", "∠k0", "number", 0.0, unit="°", step=0.1, section="Linha / k0"),
        Param(
            "side", "Base", "select", "primary",
            options=[
                {"value": "primary", "label": "Ohms primários"},
                {"value": "secondary", "label": "Ohms secundários (RTC/RTP)"},
            ],
            section="Exibição",
        ),
        Param(
            "min_current", "Corrente mínima", "number", 0.0, unit="A", min=0,
            help="Abaixo deste valor (primário) o laço não é calculado. 0 = automático (1% do primário do TC).",
            section="Exibição",
        ),
    ]

    def _k0(self, req: AnalysisRequest) -> tuple[complex, complex | None, complex | None]:
        mode = self.param(req, "k0_mode")
        z1 = complex(self.param(req, "r1"), self.param(req, "x1"))
        z0 = complex(self.param(req, "r0"), self.param(req, "x0"))
        z1_out = z1 if abs(z1) > 0 else None
        z0_out = z0 if abs(z0) > 0 else None
        if mode == "z0z1":
            if abs(z1) == 0:
                return 0j, z1_out, z0_out
            return (z0 - z1) / (3 * z1), z1_out, z0_out
        if mode == "k0":
            return complex(self.param(req, "k0_mag") * np.exp(1j * np.radians(self.param(req, "k0_ang")))), z1_out, z0_out
        return 0j, z1_out, z0_out

    def run(self, ctx: AnalysisContext, req: AnalysisRequest) -> dict[str, Any]:
        wc = float(self.param(req, "window_cycles"))
        est = self.param(req, "estimator")
        vg = ctx.group(req.voltage_group, "V")
        ig = ctx.group(req.current_group, "I")
        k0, z1, z0 = self._k0(req)

        i0, i1 = ctx.range_indices(req.t_start, req.t_end)
        max_pts = max(200, min(req.max_points, 8000))
        step = plot_step(i1 - i0 + 1, max_pts)

        # Base secundária: Zsec = Zpri · RTC / RTP
        side = self.param(req, "side")
        ratio = 1.0
        if side == "secondary":
            rtc = ctx.transformer_ratio(ig["a"])
            rtp = ctx.transformer_ratio(vg["a"])
            if not rtc or not rtp:
                raise ValueError("Relações de TC/TP ausentes no CFG; use ohms primários.")
            ratio = rtc / rtp

        i_min = float(self.param(req, "min_current"))
        if i_min <= 0:
            ch = ctx.channel(ig["a"])
            prim = float(ch.primary or 0) * ctx.unit_scale(ig["a"])
            i_min = 0.01 * prim if prim > 0 else 1e-6

        def compute(a: int, b: int, st: int = 1) -> dict[str, np.ndarray]:
            return loop_impedances(ctx, vg["id"], ig["id"], a, b, wc, est, k0, i_min, ratio, st)

        zs = compute(i0, i1, step)
        times = ctx.time[i0 : i1 + 1 : step]
        sel = decimate_indices(len(times), max_pts)
        loops_out: dict[str, Any] = {}
        for name, z in zs.items():
            zz = z[sel]
            ok = np.isfinite(zz)
            loops_out[name] = {
                "times": times[sel][ok].round(9).tolist(),
                "r": zz.real[ok].round(6).tolist(),
                "x": zz.imag[ok].round(6).tolist(),
            }

        cursor = None
        if req.time_s is not None:
            k = ctx.time_to_index(float(req.time_s))
            in_range = i0 <= k <= i1 and step == 1
            zk = {n: z[k - i0] for n, z in zs.items()} if in_range else {n: z[0] for n, z in compute(k, k).items()}
            cursor = {"time_s": float(ctx.time[k]),
                      "loops": {n: {"r": finite_or_none(z.real), "x": finite_or_none(z.imag)} for n, z in zk.items()}}

        def cdict(z):
            return None if z is None else {"r": z.real, "x": z.imag}

        return {
            "t_start": float(ctx.time[i0]),
            "t_end": float(ctx.time[i1]),
            "side": side,
            "unit": "Ω" if side == "primary" else "Ω sec",
            "ratio": ratio,
            "k0": {"re": k0.real, "im": k0.imag, "mag": abs(k0), "ang": float(np.degrees(np.angle(k0)))},
            "min_current_a": i_min,
            "step_samples": step,
            "z1": cdict(z1),
            "z0": cdict(z0),
            "loops": loops_out,
            "cursor": cursor,
        }


def loop_impedances(
    ctx: AnalysisContext, vg_id: str, ig_id: str, i0: int, i1: int,
    wc: float, est: str, k0: complex, i_min: float, ratio: float = 1.0, step: int = 1,
) -> dict[str, np.ndarray]:
    """Impedâncias aparentes dos 6 laços (arrays complexos, NaN onde I < i_min)."""
    va, vb, vc = ctx.group_phasors(vg_id, "V", i0, i1, wc, est, step)
    ia, ib, ic = ctx.group_phasors(ig_id, "I", i0, i1, wc, est, step)
    ires = ia + ib + ic  # 3·I0

    def loop(v, i):
        with np.errstate(divide="ignore", invalid="ignore"):
            z = v / i
        z[~np.isfinite(z) | (np.abs(i) < i_min)] = np.nan
        return z * ratio

    return {
        "AG": loop(va, ia + k0 * ires),
        "BG": loop(vb, ib + k0 * ires),
        "CG": loop(vc, ic + k0 * ires),
        "AB": loop(va - vb, ia - ib),
        "BC": loop(vb - vc, ib - ic),
        "CA": loop(vc - va, ic - ia),
    }
