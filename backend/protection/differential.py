"""87T – Diferencial de transformador (2 ou 3 enrolamentos).

* Adequação de módulo: corrente em pu da nominal do trafo (S, V) por
  enrolamento — ou do primário do TC.
* Adequação de fase (grupo vetorial) e eliminação de sequência zero por
  componentes simétricas: I1' = I1·e^{+jk·30°}, I2' = I2·e^{−jk·30°},
  I0' = 0 (se eliminada). A matriz resultante é real e é aplicada às amostras
  instantâneas, de modo que harmônicas também são compensadas.
* Restrição selecionável (convenções de fabricantes): Σ|I|, Σ|I|/2, máx|I|, k·Σ|I|.
* Característica com pickup, slope 1 (base própria), slope 2 contínuo a partir
  do ponto de quebra OU com base própria, e estágio sem restrição.
* Bloqueio por 2ª e 5ª harmônica (por fase ou cruzado).
"""

from __future__ import annotations

from typing import Any

import numpy as np

from analysis.context import AnalysisContext, decimate_indices, finite_or_none
from analysis.dsp import window_length
from analysis.registry import Analysis, AnalysisRequest, register

from .common import Lane, delayed, eval_range, first_time, harmonic_phasors, p, select

A_OP = np.exp(2j * np.pi / 3)
A_MAT = np.array([[1, 1, 1], [1, A_OP**2, A_OP], [1, A_OP, A_OP**2]])  # fase = A · seq
A_INV = np.linalg.inv(A_MAT)
MAX_SAMPLES = 1_500_000


def compensation_matrix(clock: int, remove_zero: bool) -> np.ndarray:
    rot = np.exp(1j * np.pi / 6 * clock)
    m = A_MAT @ np.diag([0.0 if remove_zero else 1.0, rot, np.conj(rot)]) @ A_INV
    return np.real_if_close(m, tol=1e6).real


CLOCKS = [(str(k), f"{k} ({k * 30}°)") for k in range(12)]
WIND = {1: "Enrolamento 1 (referência)", 2: "Enrolamento 2", 3: "Enrolamento 3"}


def _winding_params(w: int) -> list:
    sec = "Transformador"
    vis = {"has_w3": True} if w == 3 else None
    out = [p(f"V nominal W{w}", f"v{w}_kv", "number", {1: 500.0, 2: 230.0, 3: 13.8}[w], unit="kV", min=0, section=sec, visible_if=vis)]
    if w > 1:
        out.append(select(f"clock{w}", f"Grupo vetorial W{w} (índice horário)", "1" if w == 2 else "11", CLOCKS, section=sec, visible_if=vis))
    out += [
        p(f"Eliminar I0 em W{w}", f"rem{w}", "bool", True, section=sec, visible_if=vis),
        p(f"Inverter polaridade W{w}", f"inv{w}", "bool", False, section=sec, visible_if=vis,
          help="Use se o TC deste enrolamento aponta para fora do trafo."),
    ]
    return out


@register
class TransformerDifferential(Analysis):
    id = "prot_differential"
    code = "87T"
    name = "Diferencial de transformador"
    category = "protection"
    mode = "interval"
    description = "Plano Idiff × Irest com pickup, slopes, Idiff>>, compensação de grupo vetorial e bloqueio por 2ª/5ª harmônica."
    inputs = [
        {"key": "w1", "label": "Corrente W1", "quantity": "I", "required": True},
        {"key": "w2", "label": "Corrente W2", "quantity": "I", "required": True},
        {"key": "w3", "label": "Corrente W3 (opcional)", "quantity": "I", "required": False},
    ]
    params = [
        p("Potência nominal", "s_mva", "number", 300.0, unit="MVA", min=0, section="Transformador"),
        select("base", "Base de corrente (pu)", "trafo", [("trafo", "Nominal do trafo (S, V)"), ("tc", "Primário do TC de cada enrolamento")], section="Transformador"),
        p("Tem 3º enrolamento", "has_w3", "bool", False, section="Transformador"),
        *[prm for w in (1, 2, 3) for prm in _winding_params(w)],
        select("restraint", "Corrente de restrição", "sum", [
            ("sum", "Σ|I| (soma dos módulos)"),
            ("half", "Σ|I| / 2 (média)"),
            ("max", "máx |I|"),
            ("ksum", "k · Σ|I|"),
        ], section="Característica"),
        p("k (restrição)", "k_rest", "number", 0.5, min=0, step=0.05, section="Característica", visible_if={"restraint": "ksum"}),
        p("Idiff> (pickup)", "pickup", "number", 0.3, unit="pu", min=0, step=0.01, section="Característica"),
        p("Slope 1", "s1", "number", 25.0, unit="%", min=0, step=1, section="Característica"),
        p("Base do slope 1", "b1", "number", 0.0, unit="pu Irest", min=0, step=0.1, section="Característica",
          help="Ponto do eixo de restrição onde a reta do slope 1 cruza zero."),
        select("s2_mode", "Slope 2", "cont", [("cont", "Contínuo a partir do ponto de quebra"), ("base", "Reta com base própria")], section="Característica"),
        p("Ponto de quebra", "ir_break", "number", 2.0, unit="pu Irest", min=0, step=0.1, section="Característica", visible_if={"s2_mode": "cont"}),
        p("Base do slope 2", "b2", "number", 2.5, unit="pu Irest", min=0, step=0.1, section="Característica", visible_if={"s2_mode": "base"}),
        p("Slope 2", "s2", "number", 60.0, unit="%", min=0, step=1, section="Característica"),
        p("Idiff>> (sem restrição)", "unr", "number", 8.0, unit="pu", min=0, step=0.1, section="Característica"),
        p("Temporização", "delay", "number", 0.0, unit="s", min=0, step=0.005, section="Característica"),
        p("Bloqueio 2ª harmônica", "h2_on", "bool", True, section="Harmônicas"),
        p("Limiar 2ª", "h2", "number", 15.0, unit="% fund.", min=0, step=0.5, section="Harmônicas", visible_if={"h2_on": True}),
        p("Bloqueio 5ª harmônica", "h5_on", "bool", True, section="Harmônicas"),
        p("Limiar 5ª", "h5", "number", 35.0, unit="% fund.", min=0, step=0.5, section="Harmônicas", visible_if={"h5_on": True}),
        select("block_mode", "Modo de bloqueio", "phase", [("phase", "Por fase"), ("cross", "Cruzado (uma fase bloqueia todas)")], section="Harmônicas"),
    ]

    # ------------------------------------------------------------------
    def threshold(self, req: AnalysisRequest, ir: np.ndarray) -> np.ndarray:
        g = lambda k: float(self.param(req, k))  # noqa: E731
        pick, s1, s2, b1 = g("pickup"), g("s1") / 100, g("s2") / 100, g("b1")
        thr = np.maximum(pick, s1 * (ir - b1))
        if self.param(req, "s2_mode") == "cont":
            irb = g("ir_break")
            thr = np.where(ir > irb, np.maximum(pick, s1 * (irb - b1) + s2 * (ir - irb)), thr)
        else:
            thr = np.maximum(thr, s2 * (ir - g("b2")))
        return thr

    def run(self, ctx: AnalysisContext, req: AnalysisRequest) -> dict[str, Any]:
        windings = [w for w in (1, 2, 3) if req.inputs.get(f"w{w}") and (w < 3 or self.param(req, "has_w3"))]
        if len(windings) < 2:
            raise ValueError("Selecione as correntes de pelo menos dois enrolamentos.")
        i0, i1, step = eval_range(ctx, req)
        if i1 - i0 > MAX_SAMPLES:
            raise ValueError("Intervalo longo demais para a diferencial; selecione um trecho menor do registro.")
        n_win = window_length(ctx.fs, ctx.f0, 1.0)
        lead = max(0, i0 - n_win + 1)
        ends = np.arange(i0, i1 + 1, step) - lead
        times = ctx.time[i0 : i1 + 1 : step]
        s_va = float(self.param(req, "s_mva")) * 1e6
        warnings: list[str] = []

        comp_w: dict[int, np.ndarray] = {}  # amostras compensadas (3, n) em pu
        info_w: dict[int, dict[str, float]] = {}
        for w in windings:
            g = ctx.group(req.inputs[f"w{w}"], "I")
            raw = np.vstack([ctx.signal(g[ph], lead, i1 + 1) for ph in ("a", "b", "c")]).astype(float)
            if self.param(req, "base") == "trafo":
                v_kv = float(self.param(req, f"v{w}_kv"))
                if s_va <= 0 or v_kv <= 0:
                    raise ValueError("Informe potência e tensões nominais do transformador.")
                inom = s_va / (np.sqrt(3) * v_kv * 1e3)
            else:
                inom = float(ctx.channel(g["a"]).primary or 0) * ctx.unit_scale(g["a"])
                if inom <= 0:
                    raise ValueError("Primário do TC ausente no CFG; use a base do transformador.")
            clock = int(self.param(req, f"clock{w}")) if w > 1 else 0
            m = compensation_matrix(clock, bool(self.param(req, f"rem{w}")))
            sign = -1.0 if self.param(req, f"inv{w}") else 1.0
            comp_w[w] = sign * (m @ raw) / inom
            info_w[w] = {"inom_a": inom, "clock": clock}

        # fasores fundamentais compensados por enrolamento/fase
        mags = {}
        diff_inst = sum(comp_w.values())
        ph_sum = None
        for w in windings:
            phs = [harmonic_phasors(comp_w[w][k], ends, ctx.fs, ctx.f0, (1,), first_sample=lead)[1] for k in range(3)]
            mags[w] = np.abs(np.vstack(phs))
            ph_sum = np.vstack(phs) if ph_sum is None else ph_sum + np.vstack(phs)
        idiff = np.abs(ph_sum)  # (3, k)
        stack = np.stack([mags[w] for w in windings])  # (W, 3, k)
        mode = self.param(req, "restraint")
        if mode == "sum":
            irest = stack.sum(axis=0)
        elif mode == "half":
            irest = stack.sum(axis=0) / 2
        elif mode == "max":
            irest = stack.max(axis=0)
        else:
            irest = float(self.param(req, "k_rest")) * stack.sum(axis=0)

        # harmônicas da corrente diferencial – só com Idiff relevante (≥ ½ pickup);
        # abaixo disso a razão é ruído/ruído e o relé não a avalia
        i_h_min = 0.5 * float(self.param(req, "pickup"))
        r2 = np.full_like(idiff, np.nan)
        r5 = np.full_like(idiff, np.nan)
        for k in range(3):
            hp = harmonic_phasors(diff_inst[k], ends, ctx.fs, ctx.f0, (1, 2, 5), first_sample=lead)
            fund = np.abs(hp[1])
            valid = fund >= i_h_min
            with np.errstate(divide="ignore", invalid="ignore"):
                r2[k] = np.where(valid, 100 * np.abs(hp[2]) / fund, np.nan)
                r5[k] = np.where(valid, 100 * np.abs(hp[5]) / fund, np.nan)

        thr = self.threshold(req, irest)
        op = idiff > thr
        unr = idiff > float(self.param(req, "unr"))
        with np.errstate(invalid="ignore"):
            blk2 = (r2 >= float(self.param(req, "h2"))) & op if self.param(req, "h2_on") else np.zeros_like(op)
            blk5 = (r5 >= float(self.param(req, "h5"))) & op if self.param(req, "h5_on") else np.zeros_like(op)
        blk = blk2 | blk5
        if self.param(req, "block_mode") == "cross":
            blk = np.broadcast_to(blk.any(axis=0), blk.shape)
        delay = float(self.param(req, "delay"))
        trip_ph = np.vstack([delayed(op[k] & ~blk[k], times, delay) for k in range(3)])
        trip_unr = unr.any(axis=0)
        trip = trip_ph.any(axis=0) | trip_unr

        lanes: list[Lane] = []
        for k, ph in enumerate("ABC"):
            lanes.append(Lane(f"op_{ph}", f"87 {ph} operação", "pickup", op[k]))
        for k, ph in enumerate("ABC"):
            if self.param(req, "h2_on"):
                lanes.append(Lane(f"b2_{ph}", f"Bloq. 2ª {ph}", "block", blk2[k]))
        for k, ph in enumerate("ABC"):
            if self.param(req, "h5_on"):
                lanes.append(Lane(f"b5_{ph}", f"Bloq. 5ª {ph}", "block", blk5[k]))
        lanes += [Lane("unr", "87 >> (sem restr.)", "trip", trip_unr), Lane("trip", "87T trip", "trip", trip)]

        summary = []
        for k, ph in enumerate("ABC"):
            summary.append({"element": f"87 fase {ph}", "pickup_t": first_time(op[k], times),
                            "trip_t": first_time(trip_ph[k], times), "delay": delay,
                            "detail": _h2_detail(op[k], r2[k])})
        summary.append({"element": "87 >> sem restrição", "pickup_t": first_time(trip_unr, times), "trip_t": first_time(trip_unr, times), "delay": 0.0, "detail": ""})

        # característica
        ir_max = float(np.nanmax(irest)) if np.isfinite(irest).any() else 5.0
        x_max = max(5.0, min(ir_max * 1.3, 60.0))
        ir_axis = np.linspace(0, x_max, 400)
        thr_axis = self.threshold(req, ir_axis)
        y_top = max(float(self.param(req, "unr")) * 1.2, float(np.nanmax(idiff)) * 1.2 if np.isfinite(idiff).any() else 1.0)
        operate = [[0.0, y_top]] + [[float(a), float(b)] for a, b in zip(ir_axis, thr_axis)] + [[x_max, y_top]]

        sel = decimate_indices(len(times), max(200, min(req.max_points, 6000)))
        traj = {}
        for k, ph in enumerate("ABC"):
            ok = np.isfinite(idiff[k][sel]) & np.isfinite(irest[k][sel])
            traj[ph] = {"times": times[sel][ok].round(9).tolist(), "r": irest[k][sel][ok].round(5).tolist(), "x": idiff[k][sel][ok].round(5).tolist()}

        cursor = None
        if req.time_s is not None:
            j = int(np.argmin(np.abs(times - req.time_s)))
            cursor = {"time_s": float(times[j]), "loops": {ph: {"r": finite_or_none(irest[k][j]), "x": finite_or_none(idiff[k][j]),
                                                                "h2": finite_or_none(r2[k][j]), "h5": finite_or_none(r5[k][j])} for k, ph in enumerate("ABC")}}

        def series(arr, key, label, unit):
            return [{"id": f"{key}_{ph}", "label": f"{label} {ph}", "unit": unit, "phase": ph,
                     "times": times[sel].round(9).tolist(), "values": [finite_or_none(v) for v in arr[k][sel]]} for k, ph in enumerate("ABC")]

        return {
            "t_start": float(times[0]), "t_end": float(times[-1]), "resolution_s": float(step / ctx.fs),
            "plane": {"x": "I restrição", "y": "I diferencial", "unit": "pu", "equal": False, "origin": True},
            "geometry": [
                {"id": "operate", "label": "Região de operação", "kind": "operate", "polygon": operate},
                {"id": "unr", "label": "Idiff>>", "kind": "line", "polygon": [[0.0, float(self.param(req, "unr"))], [x_max, float(self.param(req, "unr"))]]},
            ],
            "trajectories": traj,
            "trajectory_style": "phases",
            "cursor": cursor,
            "lanes": [ln.to_dict(times) for ln in lanes],
            "summary": summary,
            "series": series(r2, "h2", "2ª harm.", "%") + series(r5, "h5", "5ª harm.", "%"),
            "info": {**{f"I nom. W{w}": info_w[w]["inom_a"] for w in windings},
                     **{f"Grupo W{w}": f"{info_w[w]['clock']} ({info_w[w]['clock'] * 30}°)" for w in windings if w > 1}},
            "warnings": warnings,
        }


def _h2_detail(op: np.ndarray, r2: np.ndarray) -> str:
    vals = r2[op & np.isfinite(r2)]
    return f"2ª harm. máx. {vals.max():.1f}% durante operação" if len(vals) else ""
