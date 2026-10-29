"""Diagrama fasorial no instante do cursor."""

from __future__ import annotations

from typing import Any

import numpy as np

from .. import dsp
from ..context import AnalysisContext, complex_to_dict
from ..registry import Analysis, AnalysisRequest, Param, register
from .common import estimator_param, window_param


@register
class PhasorDiagram(Analysis):
    id = "phasor_diagram"
    name = "Diagrama fasorial"
    description = (
        "Fasores RMS de tensão e corrente na janela que termina no cursor, "
        "com componentes simétricas e referência angular selecionável."
    )
    mode = "instant"
    requires = ("time",)
    params = [
        window_param(),
        estimator_param(),
        Param(
            "reference", "Referência angular", "select", "va",
            options=[
                {"value": "va", "label": "Va = 0°"},
                {"value": "v1", "label": "V1 = 0°"},
                {"value": "ia", "label": "Ia = 0°"},
                {"value": "abs", "label": "Absoluta (t = 0)"},
            ],
            section="Exibição",
        ),
        Param("show_sequence", "Componentes simétricas", "bool", True, section="Exibição"),
        Param("show_line", "Tensões de linha", "bool", False, section="Exibição"),
    ]

    def validate(self, req: AnalysisRequest) -> None:
        super().validate(req)
        if not (req.voltage_group or req.current_group or req.channels):
            raise ValueError("Selecione um grupo de tensão/corrente ou canais.")

    def run(self, ctx: AnalysisContext, req: AnalysisRequest) -> dict[str, Any]:
        wc = float(self.param(req, "window_cycles"))
        est = self.param(req, "estimator")
        k = ctx.time_to_index(float(req.time_s))
        n = dsp.window_length(ctx.fs, ctx.f0, wc)
        if k < n - 1:
            k = n - 1  # primeira janela completa

        raw: list[dict[str, Any]] = []

        def add(key, label, qty, phase, z, unit, group="", kind="phase"):
            raw.append({"key": key, "label": label, "quantity": qty, "phase": phase,
                        "z": z, "unit": unit, "group": group, "kind": kind})

        v = i = None
        if req.voltage_group:
            g = ctx.group(req.voltage_group, "V")
            v = [ctx.phasor_at(g[p], k, wc, est) for p in ("a", "b", "c")]
            for ph, z in zip("ABC", v):
                add(f"v{ph.lower()}", f"V{ph.lower()}", "V", ph, z, "V", g["label"])
            if self.param(req, "show_line"):
                for (p1, z1), (p2, z2) in (((0, v[0]), (1, v[1])), ((1, v[1]), (2, v[2])), ((2, v[2]), (0, v[0]))):
                    lbl = "abc"[p1] + "abc"[p2]
                    add(f"v{lbl}", f"V{lbl}", "V", "ABC"[p1], z1 - z2, "V", g["label"], "line")
        if req.current_group:
            g = ctx.group(req.current_group, "I")
            i = [ctx.phasor_at(g[p], k, wc, est) for p in ("a", "b", "c")]
            for ph, z in zip("ABC", i):
                add(f"i{ph.lower()}", f"I{ph.lower()}", "I", ph, z, "A", g["label"])

        for idx in req.channels:
            ch = ctx.channel(idx)
            unit = ctx.base_unit(idx)
            qty = "V" if unit.upper() == "V" else "I" if unit.upper() == "A" else "X"
            add(f"ch{idx}", ch.name, qty, "", ctx.phasor_at(idx, k, wc, est), unit, "canal", "channel")

        sequence: list[dict[str, Any]] = []
        seq_v = seq_i = None
        if v is not None:
            seq_v = dsp.sequence_components(*v)
        if i is not None:
            seq_i = dsp.sequence_components(*i)

        # Referência
        ref_opt = self.param(req, "reference")
        ref_z = None
        if ref_opt == "va" and v is not None:
            ref_z = v[0]
        elif ref_opt == "v1" and seq_v is not None:
            ref_z = seq_v[1]
        elif ref_opt == "ia" and i is not None:
            ref_z = i[0]
        elif ref_opt != "abs":
            # fallback: primeiro fasor disponível
            ref_z = v[0] if v is not None else (i[0] if i is not None else None)
        ref_ang = float(np.degrees(np.angle(ref_z))) if ref_z is not None and np.isfinite(ref_z) and abs(ref_z) > 0 else 0.0

        if self.param(req, "show_sequence"):
            for name, seq, qty, unit in (("V", seq_v, "V", "V"), ("I", seq_i, "I", "A")):
                if seq is None:
                    continue
                for n_seq, z in enumerate(seq):
                    sequence.append({"key": f"{name.lower()}{n_seq}", "label": f"{name}{n_seq}",
                                     "quantity": qty, "seq": n_seq, "unit": unit,
                                     **complex_to_dict(z, ref_ang)})

        phasors = []
        for p in raw:
            z = p.pop("z")
            phasors.append({**p, **complex_to_dict(z, ref_ang)})

        # Grandezas complementares
        extras: dict[str, Any] = {}
        if v is not None and i is not None:
            s = sum(vv * np.conj(ii) for vv, ii in zip(v, i))
            extras = {"p_w": float(s.real), "q_var": float(s.imag), "s_va": float(abs(s)),
                      "fp": float(s.real / abs(s)) if abs(s) > 0 else None}
        if seq_v is not None and abs(seq_v[1]) > 0:
            extras["v2_v1_pct"] = float(100 * abs(seq_v[2]) / abs(seq_v[1]))
            extras["v0_v1_pct"] = float(100 * abs(seq_v[0]) / abs(seq_v[1]))
        if seq_i is not None and abs(seq_i[1]) > 0:
            extras["i2_i1_pct"] = float(100 * abs(seq_i[2]) / abs(seq_i[1]))

        return {
            "time_s": float(ctx.time[k]),
            "sample": k,
            "window": {"samples": n, "t_start": float(ctx.time[k - n + 1]), "t_end": float(ctx.time[k])},
            "reference": {"option": ref_opt, "angle_abs_deg": ref_ang},
            "phasors": phasors,
            "sequence": sequence,
            "extras": extras,
        }
