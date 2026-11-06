"""Resumo automático da perturbação.

Etapas (todas sobre o grupo de corrente escolhido, ou o mais perturbado):
1. Início: primeira amostra em que a corrente superposta Δi(k) = i(k) − i(k−N)
   (N = 1 ciclo) supera um limiar ligado ao ruído e à carga pré-falta.
2. Fim: corrente (RMS de 1 ciclo) volta ao nível pré-falta ou é interrompida.
3. Tipo: fases com corrente superposta (fasor de falta − fasor pré-falta)
   relevante; terra quando 3·I0 superposta é significativa.
4. Máximos (pico e RMS), tensões mínimas, interrupção por polo.
5. Tempos de proteção a partir dos canais digitais (partida, trip, disjuntor)
   e religamento (pela corrente ou pelo disjuntor).
O resultado é uma estimativa para orientar a análise – sempre confira.
"""

from __future__ import annotations

import dataclasses
import re
from typing import Any

import numpy as np

from .. import dsp
from ..context import AnalysisContext, RecordData
from ..registry import Analysis, AnalysisRequest, Param, register
from ..sequence import absolute_time, digital_events, first_event, trigger_offset_s

PHASES = ("a", "b", "c")
MAX_SAMPLES_FULL = 4_000_000  # acima disso o RMS é avaliado com passo


def _cycle_rms(x: np.ndarray, n: int) -> np.ndarray:
    """RMS de janela causal de n amostras (NaN antes de completar a janela)."""
    x = np.nan_to_num(np.asarray(x, dtype=np.float64))
    c = np.concatenate(([0.0], np.cumsum(x * x)))
    out = np.full(len(x), np.nan)
    if len(x) >= n:
        out[n - 1:] = np.sqrt(np.maximum(c[n:] - c[:-n], 0.0) / n)
    return out


def _valid_span(ctx: AnalysisContext, group: dict[str, Any]) -> tuple[int, int]:
    """Trecho em que as três fases do grupo têm amostras (registro combinado)."""
    ok = None
    for p in PHASES:
        x = np.asarray(ctx.data.analog[group[p]][:])
        f = np.isfinite(x)
        ok = f if ok is None else ok & f
    idx = np.flatnonzero(ok) if ok is not None else np.array([], dtype=int)
    if not len(idx):
        return 0, -1
    return int(idx[0]), int(idx[-1])


def _sustained(mask: np.ndarray, start: int, need: int) -> int | None:
    """Primeiro índice ≥ start em que mask fica verdadeira por `need` amostras."""
    if need <= 1:
        idx = np.flatnonzero(mask[start:])
        return int(start + idx[0]) if len(idx) else None
    m = mask[start:].astype(np.int32)
    if len(m) < need:
        return None
    run = np.convolve(m, np.ones(need, dtype=np.int32), mode="valid")
    idx = np.flatnonzero(run == need)
    return int(start + idx[0]) if len(idx) else None


@register
class DisturbanceSummary(Analysis):
    id = "summary"
    name = "Resumo da perturbação"
    description = (
        "Início e duração da falta, fases envolvidas, máximos de corrente, tensões mínimas, "
        "tempos de partida/trip/abertura e religamento – calculados automaticamente."
    )
    mode = "interval"
    params = [
        Param("sensitivity", "Sensibilidade do início", "number", 1.0, min=0.2, max=5, step=0.1,
              help="Multiplica o limiar de detecção (maior = menos sensível)."),
        Param("auto_group", "Escolher grupo de corrente", "select", "auto", options=[
            {"value": "auto", "label": "O mais perturbado"},
            {"value": "selected", "label": "O selecionado no painel"},
        ]),
    ]

    def validate(self, req: AnalysisRequest) -> None:
        return None

    # ------------------------------------------------------------------ util
    def _phase_signals(self, ctx: AnalysisContext, group: dict[str, Any]) -> list[np.ndarray]:
        return [np.asarray(ctx.signal(group[p]), dtype=np.float64) for p in PHASES]

    def _pick_current_group(self, ctx: AnalysisContext, req: AnalysisRequest, n: int) -> dict | None:
        groups = [g for g in ctx.data.groups if g["quantity"] == "I"]
        if not groups:
            return None
        if req.current_group and self.param(req, "auto_group") == "selected":
            return ctx.group(req.current_group, "I")
        best, best_score = None, -1.0
        for g in groups:
            score = 0.0
            v0, v1 = _valid_span(ctx, g)
            if v1 - v0 < 8 * n:
                continue
            pre_end = min(v1, v0 + 6 * n)
            for p in PHASES:
                rms = _cycle_rms(ctx.signal(g[p], v0, v1 + 1), n)
                pre = np.nanmedian(rms[n - 1:pre_end - v0]) if pre_end - v0 > n else np.nan
                peak = np.nanmax(rms) if np.isfinite(rms).any() else 0.0
                base = max(pre if np.isfinite(pre) else 0.0, 0.02 * peak, 1e-9)
                score = max(score, peak / base)
            if score > best_score:
                best, best_score = g, score
        return best or groups[0]

    # ------------------------------------------------------------------ run
    def run(self, ctx: AnalysisContext, req: AnalysisRequest) -> dict[str, Any]:
        if getattr(ctx.meta, "merge", None):
            return self._run_merged(ctx, req)
        return self._run_single(ctx, req)

    def _run_merged(self, ctx: AnalysisContext, req: AnalysisRequest) -> dict[str, Any]:
        """Registro combinado: resume o terminal do grupo de corrente escolhido
        (ou o mais perturbado), no trecho em que esse terminal tem dados."""
        n = dsp.window_length(ctx.fs, ctx.f0, 1.0)
        group = self._pick_current_group(ctx, req, n)
        if group is None:
            return self._run_single(ctx, req)
        v0, v1 = _valid_span(ctx, group)
        prefix = group["id"].split("|", 1)[0] + "|"
        vgroups = [g for g in ctx.data.groups if g["quantity"] == "V" and g["id"].startswith(prefix)]
        vg = req.voltage_group if (req.voltage_group or "").startswith(prefix) else (vgroups[0]["id"] if vgroups else None)
        data = ctx.data
        # só os digitais do mesmo terminal (tempos de proteção coerentes)
        label = prefix[:-1] + ": "
        keep = [i for i, ch in enumerate(data.meta.digital_channels) if ch.name.startswith(label)]
        meta = dataclasses.replace(
            data.meta,
            start_time=absolute_time(ctx, float(ctx.time[v0])) or data.meta.start_time,
            digital_channels=[data.meta.digital_channels[i] for i in keep],
        )
        sub = RecordData(
            meta=meta,
            time=ctx.time[v0:v1 + 1],
            analog=[a[v0:v1 + 1] for a in data.analog],
            digital=[data.digital[i][v0:v1 + 1] for i in keep],
            auto_groups=data.auto_groups,
            manual_groups=data.manual_groups,
        )
        req2 = dataclasses.replace(req, current_group=group["id"], voltage_group=vg,
                                   params={**req.params, "auto_group": "selected"})
        out = self._run_single(AnalysisContext(sub), req2)
        out["notes"].insert(0, f"Registro combinado: resumo do terminal {prefix[:-1]} "
                               f"({float(ctx.time[v0]):.3f} s a {float(ctx.time[v1]):.3f} s).")
        return out

    def _run_single(self, ctx: AnalysisContext, req: AnalysisRequest) -> dict[str, Any]:
        n = dsp.window_length(ctx.fs, ctx.f0, 1.0)
        notes: list[str] = []
        trig = trigger_offset_s(ctx)
        ev = digital_events(ctx)
        events = ev["events"]

        out: dict[str, Any] = {
            "trigger_s": trig,
            "trigger_abs": ctx.meta.trigger_time or None,
            "current_group": None,
            "voltage_group": None,
            "fault": None,
            "currents": [],
            "voltages": [],
            "protection": {},
            "events_used": [],
            "notes": notes,
        }

        group = self._pick_current_group(ctx, req, n)
        if group is None:
            notes.append("Nenhum grupo trifásico de corrente: defina um grupo para obter início, tipo e máximos.")
        if ctx.n_samples < 8 * n:
            notes.append("Registro curto (menos de 8 ciclos): resultados limitados.")
            group = None

        inc = end = None
        if group is not None:
            out["current_group"] = {"id": group["id"], "label": group["label"]}
            sig = self._phase_signals(ctx, group)
            rms = [_cycle_rms(s, n) for s in sig]
            pre_end = min(ctx.n_samples, n + 4 * n)
            pre_rms = np.array([float(np.nanmedian(r[n - 1:pre_end])) for r in rms])
            peak_rms = max(float(np.nanmax(r)) for r in rms)
            scale = max(float(pre_rms.max()), 0.05 * peak_rms, 1e-9)

            # 1. início: corrente superposta (variação de 1 ciclo)
            delta = np.zeros(ctx.n_samples)
            noise = 0.0
            for s in sig:
                d = np.zeros_like(s)
                d[n:] = np.abs(s[n:] - s[:-n])
                delta = np.maximum(delta, d)
                seg = d[n:pre_end]
                if len(seg):
                    noise = max(noise, float(np.percentile(seg, 99)))
            thr = max(5.0 * noise, 0.1 * np.sqrt(2) * scale) * float(self.param(req, "sensitivity"))
            inc = _sustained(delta > thr, n, max(2, n // 8))
            if inc is None:
                notes.append("Nenhuma variação significativa de corrente encontrada (registro sem falta?).")
            else:
                # recua até onde a variação começou a crescer (≥ 30% do limiar)
                k = inc
                while k > max(n, inc - n) and delta[k - 1] > 0.3 * thr:
                    k -= 1
                inc = k

            if inc is not None:
                # 2. fim: RMS volta ao pré-falta (+30%) ou some (interrupção), por 2 ciclos
                low_lvl = 0.05 * peak_rms
                ok_mask = np.ones(ctx.n_samples, dtype=bool)
                for r, pre in zip(rms, pre_rms):
                    back = (np.abs(r - pre) <= 0.3 * pre) | (r <= low_lvl)
                    ok_mask &= np.nan_to_num(back, nan=0).astype(bool)
                end = _sustained(ok_mask, inc + n, 2 * n)
                if end is not None:
                    end = max(inc, end - n)  # RMS de 1 ciclo atrasa ~1 ciclo
                else:
                    notes.append("A corrente não voltou ao nível pré-falta até o fim do registro.")

                out["fault"] = self._fault_info(ctx, group, sig, inc, end, n, pre_rms, peak_rms, req)
                if out["fault"].get("energization"):
                    notes.append("Corrente pré-evento praticamente nula: provável energização (inrush), não falta.")

                stop = end if end is not None else ctx.n_samples - 1
                win_end = min(ctx.n_samples - 1, stop + n)
                trip_ev = first_event(events, "trip", action="ativou", after=float(ctx.time[inc]) - 0.5)
                k_search = ctx.time_to_index(trip_ev["time_s"]) if trip_ev else inc
                group_peak = max(float(np.nanmax(np.abs(s[inc:win_end + 1]))) for s in sig)
                for p, s, r, pre in zip(PHASES, sig, rms, pre_rms):
                    seg = np.abs(s[inc:win_end + 1])
                    kp = inc + int(np.argmax(seg)) if len(seg) else inc
                    rseg = r[inc:win_end + 1]
                    kr = inc + int(np.nanargmax(rseg)) if np.isfinite(rseg).any() else inc
                    out["currents"].append({
                        "phase": p.upper(),
                        "channel": ctx.channel(group[p]).name,
                        "unit": ctx.base_unit(group[p]),
                        "pre_rms": float(pre),
                        "max_rms": float(r[kr]) if np.isfinite(r[kr]) else None,
                        "max_rms_t": float(ctx.time[kr]),
                        "peak": float(s[kp]),
                        "peak_t": float(ctx.time[kp]),
                        "interruption_t": self._interruption(ctx, s, k_search, n, group_peak),
                    })
                level = 0.5 * float(pre_rms.max()) if pre_rms.max() > 0.02 * peak_rms else 0.1 * peak_rms
                reclose = self._current_return(ctx, sig, out["currents"], n, level)
                if reclose is not None:
                    out["protection"]["reclose_current_t"] = reclose

        # tensões
        vgroup = None
        vgroups = [g for g in ctx.data.groups if g["quantity"] == "V"]
        if req.voltage_group:
            try:
                vgroup = ctx.group(req.voltage_group, "V")
            except ValueError:
                vgroup = None
        if vgroup is None and vgroups:
            vgroup = vgroups[0]
        if vgroup is not None:
            out["voltage_group"] = {"id": vgroup["id"], "label": vgroup["label"]}
            if inc is not None:
                stop = end if end is not None else ctx.n_samples - 1
                for p in PHASES:
                    s = ctx.signal(vgroup[p])
                    r = _cycle_rms(s, n)
                    pre = float(np.nanmedian(r[n - 1:max(n, min(inc, 5 * n))])) if inc > n else float("nan")
                    seg = r[inc + n // 2: stop + 1]
                    if len(seg) and np.isfinite(seg).any():
                        km = inc + n // 2 + int(np.nanargmin(seg))
                        vmin = float(r[km])
                    else:
                        km, vmin = inc, None
                    out["voltages"].append({
                        "phase": p.upper(),
                        "channel": ctx.channel(vgroup[p]).name,
                        "unit": ctx.base_unit(vgroup[p]),
                        "pre_rms": pre if np.isfinite(pre) else None,
                        "min_rms": vmin,
                        "min_rms_t": float(ctx.time[km]),
                        "sag_pct": (100.0 * (1 - vmin / pre)) if (vmin is not None and pre and np.isfinite(pre)) else None,
                    })

        # 5. tempos de proteção (digitais)
        t_inc = float(ctx.time[inc]) if inc is not None else None
        ref = (t_inc - 0.5) if t_inc is not None else None
        pickup = first_event(events, "pickup", action="ativou", after=ref)
        trip = first_event(events, "trip", action="ativou", after=ref)
        opened = first_event(events, "breaker", action="abriu", after=trip["time_s"] if trip else ref)
        closed = first_event(events, "breaker", action="fechou", after=opened["time_s"]) if opened else None
        reclose_cmd = first_event(events, "reclose", action="ativou", after=opened["time_s"] if opened else ref)
        prot = out["protection"]
        for key, e in (("pickup", pickup), ("trip", trip), ("breaker_open", opened),
                       ("breaker_close", closed), ("reclose_cmd", reclose_cmd)):
            if e:
                prot[key] = {"t": e["time_s"], "channel": e["name"], "index": e["index"]}
                out["events_used"].append(e)
        if t_inc is not None and pickup:
            prot["pickup_delay_ms"] = (pickup["time_s"] - t_inc) * 1e3
        if t_inc is not None and trip:
            prot["trip_time_ms"] = (trip["time_s"] - t_inc) * 1e3
        if trip and opened:
            prot["breaker_time_ms"] = (opened["time_s"] - trip["time_s"]) * 1e3
        if trip and out["currents"]:
            poles = [c["interruption_t"] for c in out["currents"] if c["interruption_t"] is not None]
            if poles:
                prot["interruption_after_trip_ms"] = {
                    c["phase"]: (c["interruption_t"] - trip["time_s"]) * 1e3
                    for c in out["currents"] if c["interruption_t"] is not None
                }
        if opened and closed:
            prot["dead_time_ms"] = (closed["time_s"] - opened["time_s"]) * 1e3
        elif "reclose_current_t" in prot and out["currents"]:
            poles = [c["interruption_t"] for c in out["currents"] if c["interruption_t"] is not None]
            if poles:
                prot["dead_time_ms"] = (prot["reclose_current_t"] - max(poles)) * 1e3
        if any(re.search(r"\b(PSB|68|OOS|78)\b", e["name"], re.I) for e in events):
            notes.append("Há canais de oscilação de potência (68/PSB/78) que mudaram de estado: "
                         "verifique se a perturbação é oscilação e não falta (veja a aba Proteção → 78).")
        if not events:
            notes.append("Nenhum canal digital mudou de estado no registro.")
        elif not trip:
            notes.append("Nenhum canal digital reconhecido como trip (nomes com TRIP, OPER, ATUA, 94…).")

        # instantes absolutos (data/hora) para o relatório
        for item in (out["fault"] or {}, ):
            for key in ("start_t", "end_t"):
                if item.get(key) is not None:
                    item[key.replace("_t", "_abs")] = absolute_time(ctx, item[key])
        return out

    # ------------------------------------------------------------------ partes
    def _fault_info(self, ctx, group, sig, inc, end, n, pre_rms, peak_rms, req) -> dict[str, Any]:
        t_inc = float(ctx.time[inc])
        info: dict[str, Any] = {
            "start_t": t_inc,
            "end_t": float(ctx.time[end]) if end is not None else None,
            "duration_ms": (float(ctx.time[end]) - t_inc) * 1e3 if end is not None else None,
        }
        # razão de 2ª harmônica nos dois primeiros ciclos (energização × falta)
        k2 = min(inc + 2 * n, ctx.n_samples - 1)
        ratios = []
        for s in sig:
            seg = s[k2 - 2 * n + 1:k2 + 1]
            if len(seg) < 2 * n or np.max(np.abs(seg)) < 0.05 * np.sqrt(2) * peak_rms:
                continue
            t = np.arange(len(seg)) / ctx.fs
            cols = [np.ones(len(seg))]
            for h in (1, 2):
                w = 2 * np.pi * h * ctx.f0 * t
                cols += [np.cos(w), np.sin(w)]
            c, *_ = np.linalg.lstsq(np.column_stack(cols), seg, rcond=None)
            f1, f2 = np.hypot(c[1], c[2]), np.hypot(c[3], c[4])
            if f1 > 0:
                ratios.append(f2 / f1 * 100)
        h2 = float(max(ratios)) if ratios else None
        info["second_harmonic_pct"] = h2
        pre_ratio = float(pre_rms.max()) / max(peak_rms, 1e-12)
        energization = pre_ratio < 0.003 or (pre_ratio < 0.02 and h2 is not None and h2 > 15.0)
        info["energization"] = bool(energization)

        # fasores pré-falta (janela termina antes do início) e de falta (1,5 ciclo após)
        k_pre = max(n - 1, inc - 1 - n // 4)
        limit = end if end is not None else ctx.n_samples - 1
        k_f = min(inc + n + n // 2, max(inc + n - 1, limit))
        k_f = min(k_f, ctx.n_samples - 1)
        info["phasor_t"] = float(ctx.time[k_f])
        pre = np.array([dsp.phasor_at(s, k_pre, ctx.fs, ctx.f0) for s in sig])
        flt = np.array([dsp.phasor_at(s, k_f, ctx.fs, ctx.f0) for s in sig])
        if energization:
            pre = np.zeros(3, dtype=complex)
        d = flt - pre
        mags = np.abs(d)
        if not np.isfinite(mags).all() or mags.max() <= 0:
            info["type"] = None
            return info
        i0 = abs(d.sum()) / 3.0
        involved = [p.upper() for p, m in zip(PHASES, mags) if m >= 0.5 * mags.max()]
        ground = 3 * i0 >= 0.25 * mags.max()
        if len(involved) == 3 and 3 * i0 < 0.1 * mags.max():
            ground = False
        label = "".join(involved) + ("T" if ground else "")
        if len(involved) == 1 and not ground:
            label = involved[0] + "T"  # monofásica sem 3I0 detectado (ex.: neutro não medido)
            ground = True
        info.update({
            "type": label,
            "phases": involved,
            "ground": bool(ground),
            "delta_rms": {p.upper(): float(m) for p, m in zip(PHASES, mags)},
            "i0_rms": float(i0),
            "unit": ctx.base_unit(group["a"]),
        })
        if energization:
            info["type"] = "Energização"
        return info

    @staticmethod
    def _interruption(ctx, s: np.ndarray, k0: int, n: int, group_peak: float) -> float | None:
        """Instante em que a corrente da fase é interrompida a partir de k0 (o trip,
        quando existe): |i| fica abaixo de 5% do valor do último ciclo antes de k0
        (e de 2% do pico do grupo) por 2 ciclos."""
        before = np.abs(s[max(0, k0 - n):k0 + 1])
        ref = float(before.max()) if len(before) else 0.0
        if ref < 0.02 * group_peak or ref <= 0:
            return None  # fase já sem corrente relevante
        seg = np.abs(s[k0:])
        small = seg < max(0.05 * ref, 0.01 * group_peak)
        k = _sustained(small, 0, 2 * n)
        if k is None:
            return None
        return float(ctx.time[k0 + k])

    @staticmethod
    def _current_return(ctx, sig, currents, n, level) -> float | None:
        """Religamento: corrente volta (|i| > √2·level por ¼ de ciclo) após a interrupção."""
        poles = [c["interruption_t"] for c in currents if c["interruption_t"] is not None]
        if len(poles) < 1:
            return None
        k0 = ctx.time_to_index(max(poles)) + 2 * n
        if k0 >= ctx.n_samples:
            return None
        mask = np.zeros(ctx.n_samples - k0, dtype=bool)
        for s in sig:
            mask |= np.abs(s[k0:]) > np.sqrt(2) * level
        k = _sustained(mask, 0, max(2, n // 4))
        return float(ctx.time[k0 + k]) if k is not None else None
