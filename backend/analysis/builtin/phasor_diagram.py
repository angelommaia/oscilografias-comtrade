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

    @staticmethod
    def _terminal_name(ctx: AnalysisContext, label: str, fallback: str) -> str:
        """Rótulo do terminal: prefixo "RÓTULO: …" dos registros combinados."""
        if getattr(ctx.meta, "merge", None) and ": " in label:
            return label.split(": ", 1)[0]
        return fallback

    def run(self, ctx: AnalysisContext, req: AnalysisRequest) -> dict[str, Any]:
        wc = float(self.param(req, "window_cycles"))
        est = self.param(req, "estimator")
        k = ctx.time_to_index(float(req.time_s))
        n = dsp.window_length(ctx.fs, ctx.f0, wc)
        if k < n - 1:
            k = n - 1  # primeira janela completa

        raw: list[dict[str, Any]] = []

        def add(key, label, qty, phase, z, unit, group="", kind="phase", terminal=1):
            raw.append({"key": key, "label": label, "quantity": qty, "phase": phase,
                        "z": z, "unit": unit, "group": group, "kind": kind, "terminal": terminal})

        def terminal_set(vg_id, ig_id, term: int, suffix: str):
            v = i = None
            if vg_id:
                g = ctx.group(vg_id, "V")
                v = [ctx.phasor_at(g[p], k, wc, est) for p in ("a", "b", "c")]
                for ph, z in zip("ABC", v):
                    add(f"v{ph.lower()}{suffix}", f"V{ph.lower()}{suffix and '′'}", "V", ph, z, "V", g["label"], "phase", term)
                if self.param(req, "show_line"):
                    for (p1, z1), (p2, z2) in (((0, v[0]), (1, v[1])), ((1, v[1]), (2, v[2])), ((2, v[2]), (0, v[0]))):
                        lbl = "abc"[p1] + "abc"[p2]
                        add(f"v{lbl}{suffix}", f"V{lbl}{suffix and '′'}", "V", "ABC"[p1], z1 - z2, "V", g["label"], "line", term)
            if ig_id:
                g = ctx.group(ig_id, "I")
                i = [ctx.phasor_at(g[p], k, wc, est) for p in ("a", "b", "c")]
                for ph, z in zip("ABC", i):
                    add(f"i{ph.lower()}{suffix}", f"I{ph.lower()}{suffix and '′'}", "I", ph, z, "A", g["label"], "phase", term)
            return v, i

        v, i = terminal_set(req.voltage_group, req.current_group, 1, "")
        v2_id = req.inputs.get("v2") or None
        i2_id = req.inputs.get("i2") or None
        two = bool(v2_id or i2_id)
        v2 = i2 = None
        if two:
            v2, i2 = terminal_set(v2_id, i2_id, 2, "2")

        for idx in req.channels:
            ch = ctx.channel(idx)
            unit = ctx.base_unit(idx)
            qty = "V" if unit.upper() == "V" else "I" if unit.upper() == "A" else "X"
            add(f"ch{idx}", ch.name, qty, "", ctx.phasor_at(idx, k, wc, est), unit, "canal", "channel")

        sequence: list[dict[str, Any]] = []
        seq_v = dsp.sequence_components(*v) if v is not None else None
        seq_i = dsp.sequence_components(*i) if i is not None else None
        seq_v2 = dsp.sequence_components(*v2) if v2 is not None else None
        seq_i2 = dsp.sequence_components(*i2) if i2 is not None else None

        # Referência (sempre do terminal 1; o 2 usa a mesma, para comparar ângulos)
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
            ref_z = next((z for z in (v[0] if v else None, i[0] if i else None,
                                      v2[0] if v2 else None, i2[0] if i2 else None) if z is not None), None)
        ref_ang = float(np.degrees(np.angle(ref_z))) if ref_z is not None and np.isfinite(ref_z) and abs(ref_z) > 0 else 0.0

        if self.param(req, "show_sequence"):
            for name, seq, qty, unit, term, suf in (
                ("V", seq_v, "V", "V", 1, ""), ("I", seq_i, "I", "A", 1, ""),
                ("V", seq_v2, "V", "V", 2, "2"), ("I", seq_i2, "I", "A", 2, "2"),
            ):
                if seq is None:
                    continue
                for n_seq, z in enumerate(seq):
                    sequence.append({"key": f"{name.lower()}{n_seq}{suf}", "label": f"{name}{n_seq}{suf and '′'}",
                                     "quantity": qty, "seq": n_seq, "unit": unit, "terminal": term,
                                     **complex_to_dict(z, ref_ang)})

        phasors = []
        for p in raw:
            z = p.pop("z")
            phasors.append({**p, **complex_to_dict(z, ref_ang)})

        # Grandezas complementares
        def power(vv, ii):
            s = sum(a * np.conj(b) for a, b in zip(vv, ii))
            return {"p_w": float(s.real), "q_var": float(s.imag), "s_va": float(abs(s)),
                    "fp": float(s.real / abs(s)) if abs(s) > 0 else None}

        extras: dict[str, Any] = {}
        if v is not None and i is not None:
            extras = power(v, i)
        if seq_v is not None and abs(seq_v[1]) > 0:
            extras["v2_v1_pct"] = float(100 * abs(seq_v[2]) / abs(seq_v[1]))
            extras["v0_v1_pct"] = float(100 * abs(seq_v[0]) / abs(seq_v[1]))
        if seq_i is not None and abs(seq_i[1]) > 0:
            extras["i2_i1_pct"] = float(100 * abs(seq_i[2]) / abs(seq_i[1]))

        terminals = None
        notes: list[str] = []
        if two:
            def tname(gid, qty, default):
                return self._terminal_name(ctx, ctx.group(gid, qty)["label"], default) if gid else default
            t1 = tname(req.voltage_group, "V", None) or tname(req.current_group, "I", "Terminal 1")
            t2 = tname(v2_id, "V", None) or tname(i2_id, "I", "Terminal 2")
            if t1 == t2:
                t1, t2 = f"{t1} (1)", f"{t2} (2)"
            terminals = {"1": t1, "2": t2}
            if v2 is not None and i2 is not None:
                extras["terminal2"] = power(v2, i2)
            # diferenças entre terminais (mesmo instante da base de tempo comum)
            diffs = []
            for name, a_set, b_set in (("V", v, v2), ("I", i, i2)):
                if a_set is None or b_set is None:
                    continue
                for ph, za, zb in zip("abc", a_set, b_set):
                    if np.isfinite(za) and np.isfinite(zb) and abs(za) > 0 and abs(zb) > 0:
                        diffs.append({"label": f"{name}{ph}′ − {name}{ph}",
                                      "ratio": float(abs(zb) / abs(za)),
                                      "dang": float(dsp.wrap_deg(np.degrees(np.angle(zb) - np.angle(za))))})
            for name, sa, sb in (("V1", seq_v, seq_v2), ("I1", seq_i, seq_i2)):
                if sa is not None and sb is not None and abs(sa[1]) > 0 and abs(sb[1]) > 0:
                    diffs.append({"label": f"{name}′ − {name}", "ratio": float(abs(sb[1]) / abs(sa[1])),
                                  "dang": float(dsp.wrap_deg(np.degrees(np.angle(sb[1]) - np.angle(sa[1]))))})
            extras["diffs"] = diffs
            spec = getattr(ctx.meta, "merge", None)
            if spec:
                per_ms = f"{360 * ctx.f0 / 1000:.1f}° por milissegundo"
                recs = spec.get("records", [])
                modes = {r.get("mode_used") for r in recs if r.get("id") != spec.get("reference")}
                unlocked = [r["label"] for r in recs
                            if (r.get("time_quality") or {}).get("locked") is False]
                if modes - {"absolute"}:
                    notes.append(
                        "Os terminais foram alinhados por trigger/início da perturbação, não por GPS: a diferença "
                        f"angular entre eles tem incerteza de {per_ms} de erro "
                        "no alinhamento. Compare módulos e formas com segurança; ângulos, com cautela.")
                elif spec.get("forced"):
                    notes.append(
                        "Alinhado por GPS mesmo com horários incompatíveis (opção “juntar mesmo assim”): a diferença "
                        f"angular entre terminais não é confiável ({per_ms} de erro).")
                elif unlocked:
                    notes.append(
                        f"Alinhado por GPS, mas o .cfg indica relógio não sincronizado em {', '.join(unlocked)}: "
                        f"a diferença angular tem incerteza de {per_ms} de erro do relógio.")
            else:
                notes.append("Os dois conjuntos são do mesmo registro.")

        return {
            "time_s": float(ctx.time[k]),
            "sample": k,
            "window": {"samples": n, "t_start": float(ctx.time[k - n + 1]), "t_end": float(ctx.time[k])},
            "reference": {"option": ref_opt, "angle_abs_deg": ref_ang},
            "phasors": phasors,
            "sequence": sequence,
            "extras": extras,
            "terminals": terminals,
            "notes": notes,
        }
