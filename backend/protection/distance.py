"""21 – Proteção de distância (mho / quadrilateral, 5 zonas, load encroachment).

Convenções multifabricante disponíveis:
* Compensação de terra: k0 = (Z0−Z1)/(3·Z1) complexo (SEL, GE, ABB…), k0 em
  módulo/ângulo, ou fatores separados RE/RL e XE/XL (Siemens).
* Alcances em Ω (primário ou secundário) ou em % de Z1 da linha.
* Quadrilateral: reatância com inclinação (tilt), blinders resistivos
  paralelos ao ângulo da linha (R de terra e de fase separados) e região
  direcional definida por duas retas.
"""

from __future__ import annotations

from typing import Any

import numpy as np

from analysis.context import AnalysisContext, decimate_indices, finite_or_none
from analysis.registry import Analysis, AnalysisRequest, register

from .common import (
    BIG,
    Lane,
    box,
    circle,
    clip_line_side,
    delayed,
    eval_range,
    first_time,
    p,
    points_in_polygon,
    poly_to_list,
    select,
)

LOOPS = ("AG", "BG", "CG", "AB", "BC", "CA")
GROUND = ("AG", "BG", "CG")
N_ZONES = 5

_ZONE_DEFAULTS = {
    1: dict(on=True, dir="fwd", reach=80.0, delay=0.0),
    2: dict(on=True, dir="fwd", reach=120.0, delay=0.4),
    3: dict(on=True, dir="fwd", reach=200.0, delay=1.0),
    4: dict(on=False, dir="rev", reach=20.0, delay=1.5),
    5: dict(on=False, dir="nondir", reach=250.0, delay=2.0),
}


def _zone_params(i: int) -> list:
    d = _ZONE_DEFAULTS[i]
    sec = f"Zona {i}"
    on = {f"z{i}_on": True}
    quad = {f"z{i}_on": True, f"z{i}_shape": "quad"}
    mho = {f"z{i}_on": True, f"z{i}_shape": "mho"}
    return [
        p("Habilitada", f"z{i}_on", "bool", d["on"], section=sec),
        select(f"z{i}_shape", "Característica", "mho", [("mho", "Mho"), ("quad", "Quadrilateral")], section=sec, visible_if=on),
        select(f"z{i}_dir", "Direção", d["dir"], [("fwd", "Direta (frente)"), ("rev", "Reversa"), ("nondir", "Não direcional")], section=sec, visible_if=on),
        select(f"z{i}_loops", "Laços", "all", [("all", "Terra e fase"), ("ground", "Só terra"), ("phase", "Só fase")], section=sec, visible_if=on),
        p("Alcance (mho) / X (quad)", f"z{i}_reach", "number", d["reach"], min=0, step=0.1, section=sec, visible_if=on,
          help="Unidade conforme 'Alcances em' (Ω ou % de Z1 da linha)."),
        p("Ângulo do alcance (MTA)", f"z{i}_mta", "number", 0.0, unit="°", step=0.5, section=sec, visible_if=on,
          help="0 = ângulo da linha."),
        p("Offset reverso (mho)", f"z{i}_offset", "number", 0.0, min=0, step=0.1, section=sec, visible_if=mho),
        p("Blinder R (mho)", f"z{i}_blinder", "number", 0.0, unit="Ω", min=0, step=0.1, section=sec, visible_if=mho,
          help="Limita a mho entre ±R por retas paralelas à linha. 0 = desativado."),
        p("R terra (quad)", f"z{i}_rg", "number", 10.0 * i, unit="Ω", min=0, step=0.1, section=sec, visible_if=quad),
        p("R fase (quad)", f"z{i}_rp", "number", 5.0 * i, unit="Ω", min=0, step=0.1, section=sec, visible_if=quad),
        p("Inclinação da reatância", f"z{i}_tilt", "number", 0.0, unit="°", step=0.5, section=sec, visible_if=quad,
          help="Positivo inclina a reta de reatância para baixo à direita (evita sobrealcance com carga exportadora)."),
        p("Bloqueio por carga", f"z{i}_le", "bool", True, section=sec, visible_if=on),
        p("Temporização", f"z{i}_delay", "number", d["delay"], unit="s", min=0, step=0.01, section=sec, visible_if=on),
    ]


@register
class DistanceProtection(Analysis):
    id = "prot_distance"
    code = "21"
    name = "Distância"
    category = "protection"
    mode = "interval"
    description = "Zonas mho/quadrilaterais por laço, direcionalidade, load encroachment e simulação de partida/trip."
    inputs = [
        {"key": "v", "label": "Tensão (TP)", "quantity": "V", "required": True},
        {"key": "i", "label": "Corrente (TC)", "quantity": "I", "required": True},
    ]
    params = [
        select("side", "Base das impedâncias", "secondary", [("secondary", "Ohms secundários"), ("primary", "Ohms primários")], section="Linha"),
        p("R1 da linha", "r1", "number", 0.0, unit="Ω", step=0.01, section="Linha"),
        p("X1 da linha", "x1", "number", 0.0, unit="Ω", step=0.01, section="Linha"),
        p("R0 da linha", "r0", "number", 0.0, unit="Ω", step=0.01, section="Linha"),
        p("X0 da linha", "x0", "number", 0.0, unit="Ω", step=0.01, section="Linha"),
        select("reach_unit", "Alcances em", "pct", [("pct", "% de Z1 da linha"), ("ohm", "Ω")], section="Linha"),
        select("k0_mode", "Compensação de terra", "z0z1", [
            ("z0z1", "k0 = (Z0−Z1)/3Z1 (da linha)"),
            ("k0", "k0 módulo/ângulo"),
            ("krkx", "RE/RL e XE/XL separados"),
            ("none", "Sem compensação"),
        ], section="Compensação de terra"),
        p("|k0|", "k0_mag", "number", 0.0, min=0, step=0.01, section="Compensação de terra", visible_if={"k0_mode": "k0"}),
        p("∠k0", "k0_ang", "number", 0.0, unit="°", step=0.1, section="Compensação de terra", visible_if={"k0_mode": "k0"}),
        p("RE/RL", "kr", "number", 0.0, step=0.01, section="Compensação de terra", visible_if={"k0_mode": "krkx"}),
        p("XE/XL", "kx", "number", 0.0, step=0.01, section="Compensação de terra", visible_if={"k0_mode": "krkx"}),
        p("Reta direcional inferior", "dir_low", "number", -30.0, unit="°", step=1, section="Direcional / liberação",
          help="Região 'frente' entre as duas retas (usada pelas quadrilaterais)."),
        p("Reta direcional superior", "dir_high", "number", 120.0, unit="°", step=1, section="Direcional / liberação"),
        p("Corrente mínima de fase", "imin", "number", 0.0, unit="A prim.", min=0, section="Direcional / liberação",
          help="0 = 10% do primário do TC."),
        p("3I0 mínimo (laços de terra)", "i0min", "number", 0.0, unit="A prim.", min=0, section="Direcional / liberação",
          help="Laços de terra só são liberados com 3I0 acima deste valor. 0 = 10% do primário do TC."),
        p("Load encroachment", "le_on", "bool", False, section="Load encroachment (blinders de carga)"),
        p("R carga – exportação", "le_rf", "number", 50.0, unit="Ω", min=0, section="Load encroachment (blinders de carga)", visible_if={"le_on": True}),
        p("Ângulo carga – exportação", "le_af", "number", 30.0, unit="°", min=0, max=89, section="Load encroachment (blinders de carga)", visible_if={"le_on": True}),
        p("R carga – importação", "le_rr", "number", 50.0, unit="Ω", min=0, section="Load encroachment (blinders de carga)", visible_if={"le_on": True}),
        p("Ângulo carga – importação", "le_ar", "number", 30.0, unit="°", min=0, max=89, section="Load encroachment (blinders de carga)", visible_if={"le_on": True}),
        *[prm for i in range(1, N_ZONES + 1) for prm in _zone_params(i)],
    ]

    # ------------------------------------------------------------------ util
    def _ratio(self, ctx: AnalysisContext, vg: dict, ig: dict, side: str) -> float:
        if side != "secondary":
            return 1.0
        rtc, rtp = ctx.transformer_ratio(ig["a"]), ctx.transformer_ratio(vg["a"])
        if not rtc or not rtp:
            raise ValueError("Relações de TC/TP ausentes no CFG; use ohms primários.")
        return rtc / rtp

    def _ground_factors(self, req: AnalysisRequest, z1: complex, z0: complex) -> tuple[complex, complex, str]:
        mode = self.param(req, "k0_mode")
        if mode == "z0z1":
            k = (z0 - z1) / (3 * z1) if abs(z1) > 0 and abs(z0) > 0 else 0j
            return k, k, f"k0 = {abs(k):.3f} ∠ {np.degrees(np.angle(k)):.1f}°"
        if mode == "k0":
            k = self.param(req, "k0_mag") * np.exp(1j * np.radians(self.param(req, "k0_ang")))
            return k, k, f"k0 = {abs(k):.3f} ∠ {np.degrees(np.angle(k)):.1f}°"
        if mode == "krkx":
            kr, kx = float(self.param(req, "kr")), float(self.param(req, "kx"))
            return complex(kr), complex(kx), f"RE/RL = {kr:.3f}, XE/XL = {kx:.3f}"
        return 0j, 0j, "sem compensação"

    # ------------------------------------------------------------------ geometria
    def zone_polygons(self, req: AnalysisRequest, z1_line: complex, line_ang: float, i: int, scale: float) -> dict[str, np.ndarray]:
        g = lambda k: self.param(req, f"z{i}_{k}")  # noqa: E731
        unit_pct = self.param(req, "reach_unit") == "pct"
        to_ohm = (lambda v: v / 100.0 * abs(z1_line)) if unit_pct else (lambda v: v)
        reach = to_ohm(float(g("reach")))
        if reach <= 0:
            return {}
        theta = float(g("mta")) or line_ang
        direction = g("dir")
        big = scale * 20

        if g("shape") == "mho":
            offset = to_ohm(float(g("offset")))
            if direction == "nondir" and offset == 0:
                offset = reach
            th = theta + (180.0 if direction == "rev" else 0.0)
            u = np.exp(1j * np.radians(th))
            poly = circle((reach - offset) / 2 * u, (reach + offset) / 2)
            rb = float(g("blinder"))
            if rb > 0:
                poly = clip_line_side(poly, complex(rb), line_ang, keep_left=True)
                poly = clip_line_side(poly, complex(-rb), line_ang, keep_left=False)
            return {"ground": poly, "phase": poly}

        out = {}
        tilt = float(g("tilt"))
        for kind, rkey in (("ground", "rg"), ("phase", "rp")):
            r = float(g(rkey))
            poly = box(big)
            poly = clip_line_side(poly, 1j * reach, -tilt, keep_left=False)  # abaixo da reatância
            poly = clip_line_side(poly, complex(r), line_ang, keep_left=True)  # à esquerda do blinder direito
            poly = clip_line_side(poly, complex(-r), line_ang, keep_left=False)  # à direita do blinder esquerdo
            if direction == "nondir":
                poly = clip_line_side(poly, -1j * reach, 0.0, keep_left=True)  # acima de −X
            else:
                lo, hi = float(self.param(req, "dir_low")), float(self.param(req, "dir_high"))
                poly = clip_line_side(poly, 0j, lo, keep_left=True)
                poly = clip_line_side(poly, 0j, hi, keep_left=False)
                if direction == "rev":
                    poly = -poly
            out[kind] = poly
        return out

    def load_polygons(self, req: AnalysisRequest, scale: float) -> list[tuple[str, np.ndarray]]:
        if not self.param(req, "le_on"):
            return []
        big = scale * 20
        res = []
        for key, sign, rk, ak in (("export", 1, "le_rf", "le_af"), ("import", -1, "le_rr", "le_ar")):
            r = float(self.param(req, rk))
            t = np.tan(np.radians(float(self.param(req, ak))))
            if r <= 0:
                continue
            poly = sign * np.array([r - 1j * r * t, big - 1j * big * t, big + 1j * big * t, r + 1j * r * t])
            res.append((key, poly))
        return res

    # ------------------------------------------------------------------ execução
    def run(self, ctx: AnalysisContext, req: AnalysisRequest) -> dict[str, Any]:
        vg = ctx.group(req.inputs["v"], "V")
        ig = ctx.group(req.inputs["i"], "I")
        side = self.param(req, "side")
        ratio = self._ratio(ctx, vg, ig, side)
        warnings: list[str] = []

        z1_line = complex(self.param(req, "r1"), self.param(req, "x1"))
        z0_line = complex(self.param(req, "r0"), self.param(req, "x0"))
        line_ang = float(np.degrees(np.angle(z1_line))) if abs(z1_line) > 0 else 85.0
        if abs(z1_line) == 0:
            warnings.append("Informe R1/X1 da linha: ângulo da linha assumido 85°" +
                            (" e alcances em % ficam nulos." if self.param(req, "reach_unit") == "pct" else "."))
        kr, kx, kdesc = self._ground_factors(req, z1_line, z0_line)

        # ---------------- fasores e impedâncias dos laços
        i0, i1, step = eval_range(ctx, req)
        wc, est = 1.0, "ls"
        va, vb, vc = ctx.group_phasors(vg["id"], "V", i0, i1, wc, est, step)
        ia, ib, ic = ctx.group_phasors(ig["id"], "I", i0, i1, wc, est, step)
        times = ctx.time[i0 : i1 + 1 : step]
        ires = ia + ib + ic

        ct_prim = float(ctx.channel(ig["a"]).primary or 0) * ctx.unit_scale(ig["a"])
        imin = float(self.param(req, "imin")) or 0.1 * ct_prim
        i0min = float(self.param(req, "i0min")) or 0.1 * ct_prim

        def ground_loop(v, i):
            a = i + kr * ires
            b = i + kx * ires
            den = a.real * b.real + a.imag * b.imag
            with np.errstate(divide="ignore", invalid="ignore"):
                r = (v.real * b.real + v.imag * b.imag) / den
                x = (v.imag * a.real - v.real * a.imag) / den
            return (r + 1j * x) * ratio

        def phase_loop(v, i):
            with np.errstate(divide="ignore", invalid="ignore"):
                return (v / i) * ratio

        zs = {
            "AG": ground_loop(va, ia), "BG": ground_loop(vb, ib), "CG": ground_loop(vc, ic),
            "AB": phase_loop(va - vb, ia - ib), "BC": phase_loop(vb - vc, ib - ic), "CA": phase_loop(vc - va, ic - ia),
        }
        i0_ok = np.abs(ires) >= i0min
        release = {
            "AG": (np.abs(ia) >= imin) & i0_ok, "BG": (np.abs(ib) >= imin) & i0_ok, "CG": (np.abs(ic) >= imin) & i0_ok,
            "AB": np.abs(ia - ib) >= imin, "BC": np.abs(ib - ic) >= imin, "CA": np.abs(ic - ia) >= imin,
        }

        # ---------------- características
        scale = max([abs(z1_line), 1.0] + [float(self.param(req, f"z{i}_reach")) for i in range(1, 6)])
        if self.param(req, "reach_unit") == "pct":
            scale = max(abs(z1_line) * 3, 1.0)
        load = self.load_polygons(req, scale)
        in_load = {n: np.zeros(len(times), bool) for n in LOOPS}
        for _, poly in load:
            for n in LOOPS:
                in_load[n] |= points_in_polygon(zs[n], poly)

        geometry: list[dict[str, Any]] = []
        lanes: list[Lane] = []
        summary: list[dict[str, Any]] = []
        for i in range(1, N_ZONES + 1):
            if not self.param(req, f"z{i}_on"):
                continue
            polys = self.zone_polygons(req, z1_line, line_ang, i, scale)
            if not polys:
                summary.append({"element": f"Z{i}", "pickup_t": None, "trip_t": None, "delay": None,
                                "detail": "alcance nulo – informe Z1 da linha ou o alcance em Ω"})
                continue
            loops_sel = self.param(req, f"z{i}_loops")
            use_le = self.param(req, f"z{i}_le")
            delay = float(self.param(req, f"z{i}_delay"))
            same = polys["ground"] is polys["phase"]
            for kind, poly in polys.items():
                if same and kind == "phase":
                    continue
                geometry.append({
                    "id": f"Z{i}", "label": f"Z{i}" + ("" if same else (" (terra)" if kind == "ground" else " (fase)")),
                    "kind": "zone", "zone": i, "loop_type": "both" if same else kind,
                    "dir": self.param(req, f"z{i}_dir"), "delay": delay, "polygon": poly_to_list(poly),
                })
            pickup = np.zeros(len(times), bool)
            loops_hit: list[str] = []
            for n in LOOPS:
                is_ground = n in GROUND
                if (loops_sel == "ground" and not is_ground) or (loops_sel == "phase" and is_ground):
                    continue
                inside = points_in_polygon(zs[n], polys["ground" if is_ground else "phase"]) & release[n]
                if use_le:
                    inside &= ~in_load[n]
                if inside.any():
                    loops_hit.append(n)
                pickup |= inside
            trip = delayed(pickup, times, delay)
            lanes += [Lane(f"z{i}_pu", f"Z{i} partida", "pickup", pickup), Lane(f"z{i}_trip", f"Z{i} trip", "trip", trip)]
            summary.append({"element": f"Z{i}", "pickup_t": first_time(pickup, times), "trip_t": first_time(trip, times),
                            "delay": delay, "detail": ", ".join(loops_hit) or "—"})

        for key, poly in load:
            geometry.append({"id": f"LE_{key}", "label": "Carga " + ("exp." if key == "export" else "imp."),
                             "kind": "load", "polygon": poly_to_list(poly)})
        if self.param(req, "le_on"):
            lanes.append(Lane("le", "Carga (LE)", "block", np.logical_or.reduce([in_load[n] for n in LOOPS])))

        # ---------------- saída
        sel = decimate_indices(len(times), max(200, min(req.max_points, 6000)))
        traj = {}
        for n, z in zs.items():
            zz = np.where(release[n], z, np.nan)[sel]
            ok = np.isfinite(zz)
            traj[n] = {"times": times[sel][ok].round(9).tolist(), "r": zz.real[ok].round(5).tolist(), "x": zz.imag[ok].round(5).tolist()}

        cursor = None
        if req.time_s is not None:
            k = int(np.argmin(np.abs(times - req.time_s)))
            cursor = {"time_s": float(times[k]), "loops": {n: {"r": finite_or_none(zs[n][k].real) if release[n][k] else None,
                                                               "x": finite_or_none(zs[n][k].imag) if release[n][k] else None} for n in LOOPS}}
        return {
            "t_start": float(times[0]), "t_end": float(times[-1]), "resolution_s": float(step / ctx.fs),
            "plane": {"x": "R", "y": "X", "unit": "Ω" if side == "primary" else "Ω sec", "equal": True},
            "line": {"r": z1_line.real, "x": z1_line.imag, "angle": line_ang} if abs(z1_line) > 0 else None,
            "ground_comp": kdesc,
            "geometry": geometry,
            "trajectories": traj,
            "trajectory_style": "loops",
            "cursor": cursor,
            "lanes": [ln.to_dict(times) for ln in lanes],
            "summary": summary,
            "info": {"I mín.": imin, "3I0 mín.": i0min, "Compensação": kdesc, "RTC/RTP": ratio},
            "warnings": warnings,
        }
