"""78 / 68 – Oscilação de potência (PSB) e perda de sincronismo (OOS).

Método de blinders concêntricos (genérico, comum a vários fabricantes):
impedância de sequência positiva Z1 = V1/I1; se o tempo para atravessar da
característica externa até a interna for ≥ ΔT, é oscilação (bloqueio PSB);
se for menor, é falta. OOS: após PSB, Z1 atravessa a característica interna
e sai pelo lado oposto (sinal de R invertido).
"""

from __future__ import annotations

from typing import Any

import numpy as np

from analysis.context import AnalysisContext, decimate_indices, finite_or_none
from analysis.dsp import sequence_components
from analysis.registry import Analysis, AnalysisRequest, register

from .common import Lane, box, clip_line_side, eval_range, first_time, p, points_in_polygon, poly_to_list, select


def blinder_polygon(r_right: float, r_left: float, x_top: float, x_bottom: float, angle: float) -> np.ndarray:
    poly = box(max(abs(r_right), abs(r_left), abs(x_top), abs(x_bottom)) * 50 + 1)
    poly = clip_line_side(poly, 1j * x_top, 0.0, keep_left=False)
    poly = clip_line_side(poly, -1j * x_bottom, 0.0, keep_left=True)
    poly = clip_line_side(poly, complex(r_right), angle, keep_left=True)
    poly = clip_line_side(poly, complex(-r_left), angle, keep_left=False)
    return poly


@register
class PowerSwing(Analysis):
    id = "prot_power_swing"
    code = "78"
    name = "Oscilação de potência / blinders"
    category = "protection"
    mode = "interval"
    description = "Blinders interno/externo, detecção de oscilação (PSB) por ΔT, perda de sincronismo (OOS) e taxa dZ/dt."
    inputs = [
        {"key": "v", "label": "Tensão (TP)", "quantity": "V", "required": True},
        {"key": "i", "label": "Corrente (TC)", "quantity": "I", "required": True},
    ]
    params = [
        select("side", "Base das impedâncias", "secondary", [("secondary", "Ohms secundários"), ("primary", "Ohms primários")], section="Geral"),
        p("Ângulo dos blinders", "angle", "number", 85.0, unit="°", min=1, max=90, section="Geral",
          help="Blinders resistivos paralelos a este ângulo (normalmente o da linha). 90 = verticais."),
        p("Corrente mínima I1", "imin", "number", 0.0, unit="A prim.", min=0, section="Geral", help="0 = 10% do primário do TC."),
        p("R direita", "ri_r", "number", 20.0, unit="Ω", min=0, section="Característica interna"),
        p("R esquerda", "ri_l", "number", 20.0, unit="Ω", min=0, section="Característica interna"),
        p("X superior", "xi_t", "number", 40.0, unit="Ω", min=0, section="Característica interna"),
        p("X inferior", "xi_b", "number", 20.0, unit="Ω", min=0, section="Característica interna"),
        p("R direita", "ro_r", "number", 30.0, unit="Ω", min=0, section="Característica externa"),
        p("R esquerda", "ro_l", "number", 30.0, unit="Ω", min=0, section="Característica externa"),
        p("X superior", "xo_t", "number", 50.0, unit="Ω", min=0, section="Característica externa"),
        p("X inferior", "xo_b", "number", 30.0, unit="Ω", min=0, section="Característica externa"),
        p("ΔT de detecção", "dt", "number", 0.030, unit="s", min=0, step=0.001, section="Lógica",
          help="Tempo mínimo entre entrar na externa e na interna para ser oscilação."),
        p("Retenção do PSB", "hold", "number", 0.5, unit="s", min=0, step=0.01, section="Lógica",
          help="O bloqueio permanece este tempo após Z1 sair da característica externa."),
        p("Detectar OOS", "oos", "bool", True, section="Lógica"),
    ]

    def run(self, ctx: AnalysisContext, req: AnalysisRequest) -> dict[str, Any]:
        vg = ctx.group(req.inputs["v"], "V")
        ig = ctx.group(req.inputs["i"], "I")
        side = self.param(req, "side")
        ratio = 1.0
        if side == "secondary":
            rtc, rtp = ctx.transformer_ratio(ig["a"]), ctx.transformer_ratio(vg["a"])
            if not rtc or not rtp:
                raise ValueError("Relações de TC/TP ausentes no CFG; use ohms primários.")
            ratio = rtc / rtp

        i0, i1, step = eval_range(ctx, req)
        va, vb, vc = ctx.group_phasors(vg["id"], "V", i0, i1, 1.0, "ls", step)
        ia, ib, ic = ctx.group_phasors(ig["id"], "I", i0, i1, 1.0, "ls", step)
        times = ctx.time[i0 : i1 + 1 : step]
        v1 = sequence_components(va, vb, vc)[1]
        i1s = sequence_components(ia, ib, ic)[1]
        ct_prim = float(ctx.channel(ig["a"]).primary or 0) * ctx.unit_scale(ig["a"])
        imin = float(self.param(req, "imin")) or 0.1 * ct_prim
        with np.errstate(divide="ignore", invalid="ignore"):
            z = v1 / i1s * ratio
        z[np.abs(i1s) < imin] = np.nan

        ang = float(self.param(req, "angle"))
        g = lambda k: float(self.param(req, k))  # noqa: E731
        inner = blinder_polygon(g("ri_r"), g("ri_l"), g("xi_t"), g("xi_b"), ang)
        outer = blinder_polygon(g("ro_r"), g("ro_l"), g("xo_t"), g("xo_b"), ang)
        in_i = points_in_polygon(z, inner)
        in_o = points_in_polygon(z, outer) | in_i

        dt_set, hold = g("dt"), g("hold")
        psb = np.zeros(len(times), bool)
        oos = np.zeros(len(times), bool)
        fault = np.zeros(len(times), bool)
        crossings: list[dict[str, Any]] = []
        t_enter_outer = None
        side_enter = 0.0
        psb_active = False
        psb_until = -np.inf
        was_inner = False
        for k in range(len(times)):
            t = times[k]
            if in_o[k] and not in_i[k] and t_enter_outer is None:
                t_enter_outer = t
                side_enter = np.sign(z[k].real)
            if in_i[k] and not was_inner:  # entrou na interna
                if t_enter_outer is not None:
                    dtt = t - t_enter_outer
                    if dtt >= dt_set:
                        psb_active = True
                        crossings.append({"t": float(t), "dt": float(dtt), "kind": "oscilação"})
                    else:
                        fault[k] = True
                        crossings.append({"t": float(t), "dt": float(dtt), "kind": "falta"})
                else:
                    fault[k] = True  # surgiu já dentro (falta)
            if was_inner and not in_i[k] and psb_active and self.param(req, "oos"):
                if np.isfinite(z[k]) and side_enter and np.sign(z[k].real) == -side_enter:
                    oos[k] = True
                    crossings.append({"t": float(t), "dt": None, "kind": "perda de sincronismo"})
            if not in_o[k]:
                t_enter_outer = None
                if psb_active:
                    psb_until = t + hold
                    psb_active = False
            psb[k] = psb_active or t <= psb_until
            was_inner = bool(in_i[k])

        # taxa de variação |dZ/dt|
        dz = np.abs(np.diff(z, prepend=np.nan)) / np.maximum(np.diff(times, prepend=times[0] - 1e-9), 1e-9)

        sel = decimate_indices(len(times), max(200, min(req.max_points, 6000)))
        zz = z[sel]
        ok = np.isfinite(zz)
        lanes = [
            Lane("outer", "Z1 na externa", "info", in_o),
            Lane("inner", "Z1 na interna", "pickup", in_i),
            Lane("psb", "PSB (bloqueio)", "block", psb),
            Lane("oos", "OOS", "trip", oos),
        ]
        cursor = None
        if req.time_s is not None:
            k = int(np.argmin(np.abs(times - req.time_s)))
            cursor = {"time_s": float(times[k]), "loops": {"Z1": {"r": finite_or_none(z[k].real), "x": finite_or_none(z[k].imag)}},
                      "dzdt": finite_or_none(dz[k])}
        return {
            "t_start": float(times[0]), "t_end": float(times[-1]), "resolution_s": float(step / ctx.fs),
            "plane": {"x": "R", "y": "X", "unit": "Ω" if side == "primary" else "Ω sec", "equal": True},
            "geometry": [
                {"id": "outer", "label": "Externa", "kind": "blinder_outer", "polygon": poly_to_list(outer)},
                {"id": "inner", "label": "Interna", "kind": "blinder_inner", "polygon": poly_to_list(inner)},
            ],
            "trajectories": {"Z1": {"times": times[sel][ok].round(9).tolist(), "r": zz.real[ok].round(5).tolist(), "x": zz.imag[ok].round(5).tolist()}},
            "trajectory_style": "single",
            "cursor": cursor,
            "lanes": [ln.to_dict(times) for ln in lanes],
            "summary": [
                {"element": "PSB", "pickup_t": first_time(psb, times), "trip_t": None, "delay": dt_set,
                 "detail": f"{sum(c['kind'] == 'oscilação' for c in crossings)} travessia(s) lenta(s)"},
                {"element": "OOS", "pickup_t": None, "trip_t": first_time(oos, times), "delay": None,
                 "detail": f"{int(oos.sum() > 0)} evento(s)"},
                {"element": "Falta (travessia rápida)", "pickup_t": first_time(fault, times), "trip_t": None, "delay": None, "detail": ""},
            ],
            "crossings": crossings,
            "series": [{"id": "dzdt", "label": "|dZ1/dt|", "unit": "Ω/s",
                        "times": times[sel].round(9).tolist(), "values": [finite_or_none(v) for v in dz[sel]]}],
            "info": {"I1 mín.": imin, "RTC/RTP": ratio},
            "warnings": [],
        }
