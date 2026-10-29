"""50/51 + 67/67N – Sobrecorrente de fase, residual e sequência negativa.

* Até 4 estágios independentes: tempo definido (50) ou curva inversa (51) –
  IEC 60255-151, IEEE C37.112 e US CO.
* Integração do tempo inverso (∫dt/t(M) ≥ 1) – correntes variáveis no tempo.
* Direcional:
  - fase (67): conexão em quadratura (Ia × Vbc, Ib × Vca, Ic × Vab) e MTA;
  - residual (67N): polarização por −3V0 ou por sequência negativa, com RCA.
"""

from __future__ import annotations

from typing import Any

import numpy as np

from analysis.context import AnalysisContext, decimate_indices, finite_or_none
from analysis.dsp import sequence_components, wrap_deg
from analysis.registry import Analysis, AnalysisRequest, register

from .common import CURVES, Lane, curve_time, delayed, eval_range, first_time, integrate_inverse, p, select

N_STAGES = 4
_DEF = {
    1: dict(on=True, qty="phase", kind="IEC_SI", pick=1.2, tms=0.2, dt=0.0, dir="nondir"),
    2: dict(on=True, qty="phase", kind="dt", pick=6.0, tms=0.1, dt=0.05, dir="nondir"),
    3: dict(on=True, qty="residual", kind="IEC_SI", pick=0.2, tms=0.3, dt=0.0, dir="fwd"),
    4: dict(on=False, qty="neg", kind="dt", pick=0.3, tms=0.1, dt=1.0, dir="nondir"),
}
KINDS = [("dt", "Tempo definido (50)")] + [(k, v[0]) for k, v in CURVES.items()]


def _stage_params(s: int) -> list:
    d = _DEF[s]
    sec = f"Estágio {s}"
    on = {f"s{s}_on": True}
    return [
        p("Habilitado", f"s{s}_on", "bool", d["on"], section=sec),
        select(f"s{s}_qty", "Grandeza", d["qty"], [("phase", "Fase (máx. Ia, Ib, Ic)"), ("residual", "Residual 3I0"), ("neg", "Sequência negativa I2")], section=sec, visible_if=on),
        select(f"s{s}_kind", "Tipo / curva", d["kind"], KINDS, section=sec, visible_if=on),
        p("Pickup", f"s{s}_pick", "number", d["pick"], unit="× In TC", min=0, step=0.01, section=sec, visible_if=on,
          help="Em múltiplos do primário do TC (In). Ver 'Unidade do pickup'."),
        p("TMS / TD", f"s{s}_tms", "number", d["tms"], min=0, step=0.01, section=sec, visible_if=on),
        p("Tempo definido / adicional", f"s{s}_dt", "number", d["dt"], unit="s", min=0, step=0.01, section=sec, visible_if=on,
          help="Para tempo definido: temporização. Para curvas: tempo somado à curva."),
        select(f"s{s}_dir", "Direção", d["dir"], [("nondir", "Não direcional"), ("fwd", "Direta"), ("rev", "Reversa")], section=sec, visible_if=on),
    ]


@register
class Overcurrent(Analysis):
    id = "prot_overcurrent"
    code = "50/51/67"
    name = "Sobrecorrente / direcional"
    category = "protection"
    mode = "interval"
    description = "Estágios de tempo definido e inverso (IEC/IEEE/US), fase, 3I0 e I2, com direcionalidade 67/67N."
    inputs = [
        {"key": "i", "label": "Corrente (TC)", "quantity": "I", "required": True},
        {"key": "v", "label": "Tensão (direcional)", "quantity": "V", "required": False},
    ]
    params = [
        select("pick_unit", "Unidade do pickup", "in", [("in", "× In (primário do TC)"), ("a", "A primários")], section="Geral"),
        p("In (nominal do TC)", "inom", "number", 0.0, unit="A prim.", min=0, section="Geral", help="0 = primário do TC no CFG."),
        p("Fator de partida", "pu_factor", "number", 1.0, min=1, max=1.3, step=0.01, section="Geral",
          help="Partida em fator × pickup (alguns fabricantes usam 1,05–1,1 para curvas IEC)."),
        p("MTA de fase (67)", "mta", "number", 45.0, unit="°", step=1, section="Direcional",
          help="Ângulo de máximo torque na conexão em quadratura (corrente adiantada da tensão polarizante)."),
        select("pol_n", "Polarização 67N", "zero", [("zero", "Tensão de seq. zero (−3V0)"), ("neg", "Sequência negativa (−V2, I2)")], section="Direcional"),
        p("RCA 67N", "rca", "number", -60.0, unit="°", step=1, section="Direcional",
          help="Ângulo característico: negativo = corrente atrasada da polarizante."),
        p("Tensão polarizante mínima", "vmin", "number", 1.0, unit="% Vn", min=0, step=0.1, section="Direcional",
          help="Abaixo disso a direção é indeterminada e estágios direcionais não operam."),
        *[prm for s in range(1, N_STAGES + 1) for prm in _stage_params(s)],
    ]

    def run(self, ctx: AnalysisContext, req: AnalysisRequest) -> dict[str, Any]:
        ig = ctx.group(req.inputs["i"], "I")
        vg = ctx.group(req.inputs["v"], "V") if req.inputs.get("v") else None
        i0, i1, step = eval_range(ctx, req)
        ia, ib, ic = ctx.group_phasors(ig["id"], "I", i0, i1, 1.0, "ls", step)
        times = ctx.time[i0 : i1 + 1 : step]
        warnings: list[str] = []

        inom = float(self.param(req, "inom")) or float(ctx.channel(ig["a"]).primary or 0) * ctx.unit_scale(ig["a"])
        if inom <= 0:
            inom = 1.0
            warnings.append("In não informado e ausente no CFG: pickups em × In assumem In = 1 A.")
        scale = inom if self.param(req, "pick_unit") == "in" else 1.0
        x0, x1, x2 = sequence_components(ia, ib, ic)
        mags = {"phase": np.vstack([np.abs(ia), np.abs(ib), np.abs(ic)]), "residual": np.abs(3 * x0)[None, :], "neg": np.abs(x2)[None, :]}

        # ---------------- direcional
        dir_ok: dict[str, dict[str, np.ndarray]] = {}
        polar_info: dict[str, Any] = {}
        if vg is not None:
            va, vb, vc = ctx.group_phasors(vg["id"], "V", i0, i1, 1.0, "ls", step)
            vn = float(np.nanmedian(np.abs(va))) or 1.0
            vmin = float(self.param(req, "vmin")) / 100 * vn
            mta = np.radians(float(self.param(req, "mta")))
            rca = np.radians(float(self.param(req, "rca")))
            v0, v1s, v2 = sequence_components(va, vb, vc)

            def torque(i_op, v_pol, angle):
                t = np.cos(np.angle(i_op) - np.angle(v_pol) - angle)
                valid = np.abs(v_pol) >= vmin
                return np.where(valid, t, np.nan)

            t_ph = np.vstack([torque(ia, vb - vc, mta), torque(ib, vc - va, mta), torque(ic, va - vb, mta)])
            if self.param(req, "pol_n") == "zero":
                t_n = torque(3 * x0, -3 * v0, rca)[None, :]
                pol_n = (3 * x0, -3 * v0)
            else:
                t_n = torque(x2, -v2, rca)[None, :]
                pol_n = (x2, -v2)
            t_neg = torque(x2, -v2, rca)[None, :]
            for q, t in (("phase", t_ph), ("residual", t_n), ("neg", t_neg)):
                dir_ok[q] = {"fwd": t > 0, "rev": t < 0}
            polar_info = {"mta": float(self.param(req, "mta")), "rca": float(self.param(req, "rca")),
                          "_ph": (ia, vb - vc), "_n": pol_n}

        lanes: list[Lane] = []
        summary: list[dict[str, Any]] = []
        curves_out: list[dict[str, Any]] = []
        points: list[dict[str, Any]] = []
        for s in range(1, N_STAGES + 1):
            if not self.param(req, f"s{s}_on"):
                continue
            q = self.param(req, f"s{s}_qty")
            kind = self.param(req, f"s{s}_kind")
            is_a = float(self.param(req, f"s{s}_pick")) * scale
            tms = float(self.param(req, f"s{s}_tms"))
            t_add = float(self.param(req, f"s{s}_dt"))
            direction = self.param(req, f"s{s}_dir")
            pf = float(self.param(req, "pu_factor"))
            if is_a <= 0:
                continue
            m = mags[q] / is_a  # (fases, k)
            m = np.where(np.isfinite(m), m, 0.0)
            if direction != "nondir":
                if q not in dir_ok:
                    warnings.append(f"Estágio {s}: direcional sem tensão selecionada – estágio bloqueado.")
                    m = np.zeros_like(m)
                else:
                    ok = dir_ok[q][direction]
                    m = np.where(ok, m, 0.0)
            m_max = m.max(axis=0)
            if kind == "dt":
                pickup = m_max >= pf
                trip = delayed(pickup, times, t_add)
            else:
                pickup, trip_curve, _ = integrate_inverse(m_max, times, kind, tms, pf)
                trip = delayed(trip_curve, times, t_add) if t_add > 0 else trip_curve
            label = {"phase": "fase", "residual": "3I0", "neg": "I2"}[q]
            suffix = {"phase": "", "residual": "N", "neg": "Q"}[q]
            code = ("67" if direction != "nondir" else ("50" if kind == "dt" else "51")) + suffix
            name = f"E{s} {code} ({label})"
            lanes += [Lane(f"s{s}_pu", f"{name} partida", "pickup", pickup), Lane(f"s{s}_trip", f"{name} trip", "trip", trip)]
            t_pu, t_tr = first_time(pickup, times), first_time(trip, times)
            mmax = float(np.nanmax(m_max)) if len(m_max) else 0.0
            summary.append({"element": name, "pickup_t": t_pu, "trip_t": t_tr,
                            "delay": (t_tr - t_pu) if (t_pu is not None and t_tr is not None) else None,
                            "detail": f"máx. {mmax:.2f}× pickup ({mmax * is_a:.0f} A)"})

            # curva tempo-corrente em A primários
            mult = np.logspace(np.log10(1.02), np.log10(40), 160)
            if kind == "dt":
                tt = np.full_like(mult, t_add)
                pts = [[is_a * pf, 1e4], [is_a * pf, max(t_add, 1e-3)], [is_a * 40, max(t_add, 1e-3)]]
            else:
                tt = curve_time(kind, mult, tms) + t_add
                pts = [[float(is_a * mm), float(t)] for mm, t in zip(mult, tt) if np.isfinite(t)]
            curves_out.append({"id": f"S{s}", "label": name, "quantity": q, "pickup_a": is_a, "points": pts})
            if mmax > pf:
                t_static = float(t_add if kind == "dt" else curve_time(kind, np.array([mmax]), tms)[0] + t_add)
                points.append({"stage": f"S{s}", "label": name, "i_a": mmax * is_a, "t_curve": t_static,
                               "t_sim": (t_tr - t_pu) if (t_pu is not None and t_tr is not None) else None})

        # pontos de operação no cursor (diagrama direcional)
        cursor = None
        if req.time_s is not None:
            j = int(np.argmin(np.abs(times - req.time_s)))
            cursor = {"time_s": float(times[j]),
                      "currents": {"Ia": finite_or_none(abs(ia[j])), "Ib": finite_or_none(abs(ib[j])), "Ic": finite_or_none(abs(ic[j])),
                                   "3I0": finite_or_none(abs(3 * x0[j])), "I2": finite_or_none(abs(x2[j]))}}
            if polar_info:
                ip, vp = polar_info["_ph"]
                inn, vnn = polar_info["_n"]
                cursor["directional"] = {
                    "phase_angle": finite_or_none(wrap_deg(np.degrees(np.angle(ip[j]) - np.angle(vp[j])))),
                    "ground_angle": finite_or_none(wrap_deg(np.degrees(np.angle(inn[j]) - np.angle(vnn[j])))),
                    "mta": polar_info["mta"], "rca": polar_info["rca"],
                }

        sel = decimate_indices(len(times), max(200, min(req.max_points, 6000)))
        series = [
            {"id": "ia", "label": "|Ia|", "unit": "A", "phase": "A", "times": times[sel].round(9).tolist(), "values": [finite_or_none(v) for v in np.abs(ia)[sel]]},
            {"id": "ib", "label": "|Ib|", "unit": "A", "phase": "B", "times": times[sel].round(9).tolist(), "values": [finite_or_none(v) for v in np.abs(ib)[sel]]},
            {"id": "ic", "label": "|Ic|", "unit": "A", "phase": "C", "times": times[sel].round(9).tolist(), "values": [finite_or_none(v) for v in np.abs(ic)[sel]]},
            {"id": "i0", "label": "|3I0|", "unit": "A", "times": times[sel].round(9).tolist(), "values": [finite_or_none(v) for v in np.abs(3 * x0)[sel]]},
        ]
        return {
            "t_start": float(times[0]), "t_end": float(times[-1]), "resolution_s": float(step / ctx.fs),
            "plane": {"x": "I", "y": "t", "unit": "A prim.", "log": True},
            "curves": curves_out,
            "points": points,
            "cursor": cursor,
            "lanes": [ln.to_dict(times) for ln in lanes],
            "summary": summary,
            "series": series,
            "info": {"In": inom},
            "warnings": warnings,
        }
