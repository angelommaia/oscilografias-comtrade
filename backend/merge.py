"""Registro combinado: junta oscilografias de terminais/IEDs diferentes numa
única base de tempo, para ver e analisar tudo junto.

Alinhamento (deslocamento de cada registro em relação ao de referência):
* "absolute" – GPS / horário absoluto (padrão): horário de início gravado em
  cada .cfg, convertido para UTC quando o fuso é informado (COMTRADE 2013).
  Se os horários forem incompatíveis (sem sobreposição no tempo, início
  distante mais que a duração do maior registro ou data inválida) o modo NÃO
  é trocado sozinho: a junção é recusada com a explicação, e o usuário escolhe
  outro modo ou confirma "juntar mesmo assim" (force);
* "trigger"  – instantes de trigger coincidentes;
* "onset"    – início da perturbação detectado em cada registro (variação de
  1 ciclo nas tensões e correntes): alinha registros sem sincronismo;
mais um ajuste manual (ms) por registro.

Os sinais são reamostrados por interpolação linear na maior taxa entre os
registros; fora do trecho de cada registro os analógicos ficam sem valor
(NaN) e os digitais em 0. O resultado é um registro como outro qualquer:
todas as análises, cursores, eventos e o relatório funcionam sobre ele.
"""

from __future__ import annotations

import dataclasses
import uuid
from datetime import datetime, timedelta
from typing import Any

import numpy as np

from analysis import AnalysisContext, RecordData
from analysis.sequence import parse_timestamp, trigger_offset_s
from provenance import SourceRef
from timequality import summary as tq_summary
from timequality import to_utc

MAX_MERGED_VALUES = 120_000_000  # amostras × canais analógicos
MAX_FS = 50_000.0
MODES = ("absolute", "onset", "trigger")
DEFAULT_MODE = "absolute"


class MergeIncompatible(ValueError):
    """Horários absolutos incompatíveis para alinhar por GPS (sem troca automática de modo)."""

    def __init__(self, message: str, problems: list[dict[str, Any]]):
        super().__init__(message)
        self.problems = problems

_V_UNITS = {"v": 1.0, "kv": 1e3, "mv": 1e-3}
_I_UNITS = {"a": 1.0, "ka": 1e3, "ma": 1e-3}


def _sustained(mask: np.ndarray, need: int) -> int | None:
    if need <= 1:
        idx = np.flatnonzero(mask)
        return int(idx[0]) if len(idx) else None
    m = mask.astype(np.int32)
    if len(m) < need:
        return None
    run = np.convolve(m, np.ones(need, dtype=np.int32), mode="valid")
    idx = np.flatnonzero(run == need)
    return int(idx[0]) if len(idx) else None


def detect_onset(data: RecordData) -> dict[str, Any] | None:
    """Início da perturbação (s, na escala do registro) pela variação de um ciclo
    das tensões e correntes, cada canal normalizado pela própria amplitude.
    O resultado fica em cache no registro (a pré-visualização chama várias vezes)."""
    if "onset" in data.cache:
        return data.cache["onset"]
    data.cache["onset"] = _detect_onset(data)
    return data.cache["onset"]


def _detect_onset(data: RecordData) -> dict[str, Any] | None:
    ctx = AnalysisContext(data)
    n = max(int(round(ctx.fs / ctx.f0)), 4)
    total = ctx.n_samples
    if total < 4 * n:
        return None
    trig = trigger_offset_s(ctx)
    limit = total
    if trig is not None:
        limit = min(total, ctx.time_to_index(trig) + int(3 * ctx.fs))
    limit = min(limit, 4_000_000)
    pre_end = min(limit, 6 * n)
    found: list[tuple[int, float, str]] = []
    for ch in data.meta.analog_channels:
        unit = (ch.unit or "").strip().lower()
        if unit not in _V_UNITS and unit not in _I_UNITS:
            continue
        x = np.nan_to_num(np.asarray(data.analog[ch.index][:limit], dtype=np.float64))
        if len(x) <= 2 * n:
            continue
        pre = x[:pre_end]
        amp_pre = np.sqrt(2.0 * np.mean(pre * pre)) if len(pre) else 0.0
        peak = float(np.max(np.abs(x))) if len(x) else 0.0
        if peak <= 0:
            continue
        scale = max(amp_pre, 0.05 * peak)
        d = np.abs(x[n:] - x[:-n]) / scale
        noise = float(np.percentile(d[: max(1, pre_end - n)], 99.5)) if pre_end > n else 0.0
        thr = max(0.15, 5.0 * noise)
        # a variação precisa mudar o valor eficaz (descarta ruído e picos isolados):
        # RMS do ciclo seguinte × RMS do ciclo anterior ao instante candidato
        c = np.concatenate(([0.0], np.cumsum(x * x)))
        rms_prev = np.sqrt(np.maximum(c[n:len(x) + 1 - n] - c[:len(x) + 1 - 2 * n], 0) / n)  # [k-n, k)
        rms_next = np.sqrt(np.maximum(c[2 * n:] - c[n:len(x) + 1 - n], 0) / n)  # [k, k+n)
        rms_ref = max(float(np.sqrt(np.mean(x * x))) * 0.05, amp_pre / np.sqrt(2) * 0.05, 1e-12)
        change = np.abs(rms_next - rms_prev) / np.maximum(rms_prev, 20 * rms_ref) > 0.2
        mask = np.zeros(len(d), dtype=bool)
        m = min(len(d), len(change))
        mask[:m] = (d[:m] > thr) & change[:m]
        k = _sustained(mask, max(2, n // 16))
        if k is None:
            continue
        # recua até onde a variação começou (≥ 30% do limiar), no máximo 1 ciclo
        j = k
        while j > max(0, k - n) and d[j - 1] > 0.3 * thr:
            j -= 1
        found.append((j + n, float(d.max() / thr), ch.name))
    if not found:
        return None
    found.sort()
    # primeiro instante confirmado por outro canal dentro de 1 ciclo (ou o único canal)
    for i, (k, _, name) in enumerate(found):
        others = sum(1 for k2, _, _ in found[i + 1:] if k2 - k <= n)
        if others >= 1 or len(found) == 1:
            return {"t": float(ctx.time[k]), "channel": name, "channels": len(found)}
    k, _, name = found[0]
    return {"t": float(ctx.time[k]), "channel": name, "channels": len(found)}


def _abs_start(data: RecordData) -> datetime | None:
    start = parse_timestamp(data.meta.start_time)
    if start is None or start.year < 1990:
        return None
    return start


def _record_info(data: RecordData) -> dict[str, Any]:
    tq = getattr(data.meta, "time_quality", None)
    start = _abs_start(data)
    t0, t1 = float(data.time[0]), float(data.time[-1])
    return {
        "trigger": trigger_offset_s(AnalysisContext(data)),
        "onset": detect_onset(data),
        "start": start,
        "start_utc": to_utc(start, tq),
        "tq": tq,
        "t0": t0,
        "t1": t1,
        "duration": t1 - t0,
    }


def _absolute_shift(inf: dict[str, Any], ref: dict[str, Any]) -> tuple[float | None, bool]:
    """Deslocamento pelo horário absoluto e se a conversão para UTC foi usada."""
    if inf["start"] is None or ref["start"] is None:
        return None, False
    if inf["start_utc"] is not None and ref["start_utc"] is not None:
        a, b, utc = inf["start_utc"], ref["start_utc"], True
    else:
        a, b, utc = inf["start"], ref["start"], False
    return (a - b).total_seconds() - inf["t0"] + ref["t0"], utc


def _absolute_status(inf: dict[str, Any], ref: dict[str, Any], shift: float | None,
                     longest: float) -> tuple[str, str]:
    """Compatibilidade dos horários absolutos com a referência."""
    if inf["start"] is None:
        return "invalid", "data/hora de início ausente ou inválida no .cfg"
    if shift is None:
        return "invalid", "a referência não tem data/hora válida no .cfg"
    a0, a1 = inf["t0"] + shift, inf["t1"] + shift
    overlap = min(a1, ref["t1"]) - max(a0, ref["t0"])
    start_gap = abs(a0 - ref["t0"])
    if start_gap > longest:
        return "too_far", (f"os inícios diferem {start_gap:.3f} s, mais que a duração do maior registro "
                           f"({longest:.3f} s)")
    if overlap <= 0:
        return "no_overlap", f"sem sobreposição no tempo com a referência (intervalo de {-overlap:.3f} s entre eles)"
    return "ok", ""


def compute_alignment(items: list[dict[str, Any]], datas: list[RecordData], mode: str,
                      ref_index: int, force: bool = False, check: bool = True,
                      ) -> tuple[list[dict[str, Any]], list[str]]:
    """Deslocamento (s) somado ao tempo de cada registro para a escala comum.

    Calcula os três candidatos (GPS/horário, trigger, perturbação) para cada
    registro – a interface mostra todos – e usa o do modo escolhido.
    GPS incompatível → MergeIncompatible (com `check`), salvo `force` quando os
    horários existem; data inválida nunca alinha por GPS. Perturbação não
    encontrada → trigger, com nota (comportamento anterior). `check=False`
    (pré-visualização) não levanta erro."""
    if mode not in MODES:
        raise ValueError(f"Modo de alinhamento inválido: {mode}")
    notes: list[str] = []
    info = [_record_info(d) for d in datas]
    ref = info[ref_index]
    longest = max(x["duration"] for x in info)

    zones = {x["tq"].get("utc_offset_h") if x["tq"] else None for x in info}
    if mode == "absolute" and None in zones and len(zones) > 1:
        notes.append("Fuso horário informado só em parte dos arquivos: os horários foram comparados sem "
                     "conversão para UTC (confira se todos usam o mesmo fuso).")

    rows = []
    problems = []
    for i, (item, inf) in enumerate(zip(items, info)):
        abs_shift, utc = _absolute_shift(inf, ref)
        status, why = ("ok", "") if i == ref_index else _absolute_status(inf, ref, abs_shift, longest)
        if i == ref_index and inf["start"] is None:
            status, why = "invalid", "data/hora de início ausente ou inválida no .cfg"
        a = inf["trigger"] if inf["trigger"] is not None else inf["t0"]
        b = ref["trigger"] if ref["trigger"] is not None else ref["t0"]
        cand = {
            "absolute": abs_shift,
            "trigger": b - a,
            "onset": (ref["onset"]["t"] - inf["onset"]["t"]) if (inf["onset"] and ref["onset"]) else None,
        }
        if status != "ok":
            problems.append({"label": item["label"], "status": status, "message": why})
        rows.append((item, inf, cand, status, why, utc))

    if mode == "absolute" and problems:
        hard = [p for p in problems if p["status"] == "invalid"]
        lines = "; ".join(f"{p['label']}: {p['message']}" for p in problems)
        if check and (hard or not force):
            hint = ("Escolha “Início da perturbação” (registros sem sincronismo) ou “Trigger”."
                    if hard else "Use “Início da perturbação” ou confirme “Juntar mesmo assim”.")
            raise MergeIncompatible(f"Horários absolutos (GPS) incompatíveis – {lines}. {hint}", problems)
        if check:
            notes.append(f"Alinhado por GPS mesmo com horários incompatíveis ({lines}): ângulos e tempos "
                         "entre terminais não são confiáveis.")

    result = []
    for i, (item, inf, cand, status, why, utc) in enumerate(rows):
        used = mode
        if cand[used] is None:
            if mode == "onset" and i != ref_index:
                notes.append(f"{item['label']}: início da perturbação não encontrado – alinhado pelo trigger.")
            used = "trigger"  # (GPS sem horário só chega aqui na pré-visualização)
        shift = float(cand[used]) + float(item.get("offset_ms") or 0.0) / 1e3
        if i != ref_index and cand["trigger"] is not None and cand["onset"] is not None \
                and abs(cand["trigger"] - cand["onset"]) > 0.05:
            notes.append(
                f"{item['label']}: trigger e início da perturbação indicam alinhamentos {abs(cand['trigger'] - cand['onset']) * 1e3:.0f} ms "
                "diferentes – cada terminal pode ter visto um evento diferente primeiro (ex.: aberturas em instantes "
                "distintos). Confira e ajuste manualmente.")
        clock = None
        if i != ref_index and cand["absolute"] is not None:
            clock = (cand["absolute"] - (shift - float(item.get("offset_ms") or 0.0) / 1e3)) * 1e3
        result.append({
            "shift_s": shift,
            "mode_used": used,
            "candidates_ms": {k: (v * 1e3 if v is not None else None) for k, v in cand.items()},
            "onset_s": inf["onset"]["t"] if inf["onset"] else None,
            "onset_channel": inf["onset"]["channel"] if inf["onset"] else None,
            "trigger_s": inf["trigger"],
            "clock_error_ms": clock,
            "absolute_status": status,
            "absolute_message": why,
            "absolute_utc": utc,
            "time_quality": inf["tq"],
            "time_summary": tq_summary(inf["tq"]),
            "start_time": inf["start"].isoformat(sep=" ", timespec="microseconds") if inf["start"] else None,
            "forced": bool(mode == "absolute" and status != "ok" and force),
        })
    return result, notes


def preview_alignment(store, items: list[dict[str, Any]], mode: str = DEFAULT_MODE,
                      reference: str | None = None) -> dict[str, Any]:
    """Candidatos de alinhamento, compatibilidade do GPS e qualidade de tempo de
    cada registro – sem criar o registro combinado (diálogo "Juntar registros")."""
    ids = [it["id"] for it in items]
    datas = [store.get_data(i) for i in ids]
    _unique_labels(items, datas)
    ref_index = ids.index(reference) if reference in ids else 0
    align, notes = compute_alignment(items, datas, mode, ref_index, check=False)
    problems = [{"label": it["label"], "status": a["absolute_status"], "message": a["absolute_message"]}
                for it, a in zip(items, align) if a["absolute_status"] != "ok"]
    return {
        "mode": mode,
        "reference": ids[ref_index],
        "absolute_ok": not problems,
        "absolute_problems": problems,
        "absolute_forceable": bool(problems) and all(p["status"] != "invalid" for p in problems),
        "records": [{"id": i, "label": it["label"], **a} for i, it, a in zip(ids, items, align)],
        "notes": notes,
    }


def _unique_labels(items: list[dict[str, Any]], datas: list[RecordData]) -> None:
    seen: dict[str, int] = {}
    for item, data in zip(items, datas):
        base = (item.get("label") or data.meta.station or data.meta.device or "Registro").strip()[:40]
        n = seen.get(base, 0)
        seen[base] = n + 1
        item["label"] = base if n == 0 else f"{base} ({n + 1})"


def merge_records(store, items: list[dict[str, Any]], mode: str = DEFAULT_MODE, reference: str | None = None,
                  force: bool = False):
    """Cria e registra no `store` o registro combinado. Retorna o RecordMeta.
    GPS incompatível levanta MergeIncompatible (salvo `force`)."""
    from comtrade_service import ComtradeStore, RecordMeta  # import tardio (evita ciclo)

    if not 2 <= len(items) <= 6:
        raise ValueError("Selecione de 2 a 6 registros para juntar.")
    ids = [it["id"] for it in items]
    if len(set(ids)) != len(ids):
        raise ValueError("O mesmo registro foi escolhido duas vezes.")
    datas = [store.get_data(i) for i in ids]
    if any(d.meta.merge for d in datas):
        raise ValueError("Junte os registros originais (não um registro já combinado).")
    _unique_labels(items, datas)
    ref_index = ids.index(reference) if reference in ids else 0
    align, notes = compute_alignment(items, datas, mode, ref_index, force=force)

    fs = min(max(float(d.meta.sample_rate_hz) for d in datas), MAX_FS)
    starts = [float(d.time[0]) + a["shift_s"] for d, a in zip(datas, align)]
    ends = [float(d.time[-1]) + a["shift_s"] for d, a in zip(datas, align)]
    t0, t1 = min(starts), max(ends)
    n = int(np.floor((t1 - t0) * fs)) + 1
    n_analog = sum(len(d.meta.analog_channels) for d in datas)
    if n * n_analog > MAX_MERGED_VALUES:
        raise ValueError(
            f"Registro combinado grande demais ({n} amostras × {n_analog} canais). "
            "Ajuste o alinhamento (registros muito distantes no tempo) ou junte menos registros.")
    time = np.arange(n, dtype=np.float64) / fs

    analog: list[np.ndarray] = []
    digital: list[np.ndarray] = []
    a_infos, d_infos, groups = [], [], []
    for item, data, al in zip(items, datas, align):
        label = item["label"]
        src_t = np.asarray(data.time, dtype=np.float64)
        ts = time + t0 - al["shift_s"]  # tempo de cada amostra combinada na escala do registro
        inside = (ts >= src_t[0]) & (ts <= src_t[-1])
        first = int(np.argmax(inside)) if inside.any() else 0
        last = int(len(inside) - np.argmax(inside[::-1])) if inside.any() else 0
        seg = ts[first:last]
        base_a = len(a_infos)
        for ch in data.meta.analog_channels:
            vals = np.full(n, np.nan, dtype=np.float32)
            if len(seg):
                src = np.asarray(data.analog[ch.index][:], dtype=np.float64)
                vals[first:last] = np.interp(seg, src_t, src).astype(np.float32)
            analog.append(vals)
            a_infos.append(dataclasses.replace(
                ch,
                index=len(a_infos),
                name=f"{label}: {ch.name}",
                ps="P",
                cfg_min=ComtradeStore._to_primary_scalar(ch.cfg_min, ch),
                cfg_max=ComtradeStore._to_primary_scalar(ch.cfg_max, ch),
            ))
        if len(seg):
            pos = np.clip(np.searchsorted(src_t, seg, side="left"), 0, len(src_t) - 1)
            prev = np.clip(pos - 1, 0, len(src_t) - 1)
            pos = np.where(np.abs(src_t[prev] - seg) < np.abs(src_t[pos] - seg), prev, pos)
        for j, ch in enumerate(data.meta.digital_channels):
            vals = np.zeros(n, dtype=np.int8)
            if len(seg):
                vals[first:last] = np.asarray(data.digital[j][:], dtype=np.int8)[pos]
                vals[:first] = vals[first]  # fora do registro mantém o estado da borda
                vals[last:] = vals[last - 1]  # (evita falsas transições no início/fim)
            digital.append(vals)
            d_infos.append(dataclasses.replace(ch, name=f"{label}: {ch.name}"))
        for g in data.groups:
            ng = dict(g)
            for k in ("a", "b", "c"):
                ng[k] = g[k] + base_a
            ng["va"], ng["vb"], ng["vc"] = ng["a"], ng["b"], ng["c"]
            ng["label"] = f"{label}: {g['label']}"
            ng["id"] = f"{label}|{g['id']}"
            ng["source"] = "auto"
            groups.append(ng)
    for i, ch in enumerate(d_infos):
        d_infos[i] = dataclasses.replace(ch, index=len(a_infos) + i)

    # data/hora do t = 0 combinado e trigger da referência
    ref = datas[ref_index]
    ref_start = parse_timestamp(ref.meta.start_time)
    start_text = trig_text = ""
    if ref_start is not None:
        zero = ref_start + timedelta(seconds=t0 - align[ref_index]["shift_s"] - float(ref.time[0]))
        start_text = zero.isoformat(sep=" ", timespec="microseconds")
        trig = trigger_offset_s(AnalysisContext(ref))
        if trig is not None:
            trig_text = (ref_start + timedelta(seconds=trig - float(ref.time[0]))).isoformat(sep=" ", timespec="microseconds")

    record_id = str(uuid.uuid4())
    labels = [it["label"] for it in items]
    spec = {
        "mode": mode,
        "forced": bool(force and any(a.get("forced") for a in align)),
        "reference": ids[ref_index],
        "fs": fs,
        "records": [
            {"id": i, "label": it["label"], "offset_ms": float(it.get("offset_ms") or 0.0),
             "source_name": d.meta.source_name, "station": d.meta.station, "device": d.meta.device,
             "sample_rate_hz": d.meta.sample_rate_hz,
             **{k: v for k, v in al.items()}, "shift_ms": al["shift_s"] * 1e3,
             "start_s": float(d.time[0]) + al["shift_s"] - t0}
            for i, it, d, al in zip(ids, items, datas, align)
        ],
        "notes": notes,
    }
    meta = RecordMeta(
        id=record_id,
        station=" + ".join(labels),
        device="Registro combinado",
        revision="",
        start_time=start_text,
        trigger_time=trig_text,
        sample_rate_hz=fs,
        total_samples=n,
        duration_s=float(time[-1]) if n > 1 else 0.0,
        frequency_hz=float(ref.meta.frequency_hz or 60.0),
        analog_channels=a_infos,
        digital_channels=d_infos,
        source_name=" + ".join(labels),
        merge=spec,
    )
    data = RecordData(meta=meta, time=time, analog=analog, digital=digital, auto_groups=groups)
    # rastreabilidade: os mesmos objetos SourceFile dos registros de origem (hash em cache
    # compartilhado), válidos mesmo que um registro de origem saia da memória
    for item, d, al in zip(items, datas, align):
        for src in d.sources[:1]:
            data.sources.append(SourceRef(src.file, label=item["label"], align_mode=al.get("mode_used", mode),
                                          offset_ms=float(item.get("offset_ms") or 0.0)))
    store._register(data)
    return meta
