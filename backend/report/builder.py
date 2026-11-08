"""Monta o relatório a partir do resumo automático, da sequência de eventos,
das medições de cursores, das figuras enviadas pela interface e dos
comentários do analista. O conteúdo é descrito como uma lista de blocos e
renderizado em DOCX (Word) ou HTML (impressão/PDF)."""

from __future__ import annotations

import base64
import html
import math
from dataclasses import dataclass, field
from datetime import datetime
from typing import Any

from analysis import AnalysisRequest, get_analysis
from analysis.dsp import get_estimator
from analysis.sequence import CATEGORIES

from .docx import DocxBuilder, png_size

MAX_IMAGES = 12
MAX_IMAGE_BYTES = 6 * 1024 * 1024
MAX_EVENT_ROWS = 400


@dataclass
class ReportOptions:
    title: str = "Relatório de análise de perturbação"
    analyst: str = ""
    occurrence: str = ""  # identificação da ocorrência (nº, equipamento…)
    comments: str = ""
    conclusion: str = ""
    sections: dict[str, bool] = field(default_factory=dict)
    voltage_group: str | None = None
    current_group: str | None = None
    summary_params: dict[str, Any] = field(default_factory=dict)
    cursors: dict[str, Any] | None = None  # {t1, t2, channels, window_cycles}
    images: list[dict[str, str]] = field(default_factory=list)  # [{caption, data(base64 PNG)}]
    source_name: str = ""
    app_version: str = ""
    # rastreabilidade (bloco "Informações de processamento"); todos opcionais
    generated_at: str = ""  # data/hora local do analista, já formatada pela interface
    estimator: str | None = None  # estimador fasorial em uso na interface
    window_cycles: float | None = None  # janela fasorial em ciclos
    impedance_params: dict[str, Any] | None = None  # parâmetros da aba R-X, quando a figura dela vai no relatório

    def want(self, key: str) -> bool:
        return self.sections.get(key, True) is not False


# --------------------------------------------------------------------- números
def _si(value: float, unit: str) -> tuple[float, str]:
    if unit in ("V", "A", "W", "VA", "var", "Ω") or unit == "":
        a = abs(value)
        for f, p in ((1e9, "G"), (1e6, "M"), (1e3, "k")):
            if a >= f:
                return value / f, p + unit
    return value, unit


def fnum(value: Any, unit: str = "", decimals: int | None = None, si: bool = True) -> str:
    if value is None:
        return "—"
    try:
        v = float(value)
    except (TypeError, ValueError):
        return str(value)
    if not math.isfinite(v):
        return "—"
    u = unit
    if si and unit:
        v, u = _si(v, unit)
    a = abs(v)
    d = decimals if decimals is not None else (0 if a >= 1000 else 1 if a >= 100 else 2 if a >= 10 else 3)
    text = f"{v:,.{d}f}".replace(",", "X").replace(".", ",").replace("X", ".")
    return f"{text} {u}".rstrip()


def fms(value: Any) -> str:
    return fnum(value, "ms", decimals=1, si=False)


def fsec(value: Any) -> str:
    return fnum(value, "s", decimals=4, si=False)


def _rel(t: float | None, trig: float | None) -> str:
    if t is None:
        return "—"
    if trig is None:
        return fsec(t)
    return f"{fsec(t)}  ({fnum((t - trig) * 1e3, 'ms', 1, si=False)} do trigger)"


# --------------------------------------------------------------------- blocos
# Tipos de bloco: h, p, note, kv, table, img e, no fim, o bloco de processamento em
# fonte menor: ph (título), pp (parágrafo), pkv (chave/valor), ptable (tabela).
class Blocks(list):
    def h(self, text, level=1):
        self.append(("h", level, text))

    def p(self, text, kind="p"):
        self.append((kind, text))

    def kv(self, rows):
        rows = [(k, v) for k, v in rows if v not in (None, "")]
        if rows:
            self.append(("kv", rows))

    def table(self, header, rows, widths=None):
        if rows:
            self.append(("table", header, rows, widths))

    def img(self, png, caption):
        self.append(("img", png, caption))

    def small_kv(self, rows):
        rows = [(k, v) for k, v in rows if v not in (None, "")]
        if rows:
            self.append(("pkv", rows))


def _decode_image(item: dict[str, str]) -> bytes:
    data = item.get("data", "")
    if data.startswith("data:"):
        data = data.split(",", 1)[-1]
    raw = base64.b64decode(data, validate=False)
    if len(raw) > MAX_IMAGE_BYTES:
        raise ValueError("Figura grande demais para o relatório.")
    png_size(raw)
    return raw


def collect(ctx, opts: ReportOptions) -> Blocks:
    meta = ctx.meta
    b = Blocks()
    summary = get_analysis("summary").run(ctx, AnalysisRequest(
        voltage_group=opts.voltage_group, current_group=opts.current_group, params=opts.summary_params))
    trig = summary["trigger_s"]

    # 1. identificação
    b.h("1. Identificação")
    b.kv([
        ("Ocorrência", opts.occurrence),
        ("Instalação", meta.station),
        ("Equipamento / IED", meta.device),
        ("Arquivo", opts.source_name),
        ("Início do registro", meta.start_time),
        ("Trigger", meta.trigger_time),
        ("Amostragem", f"{fnum(meta.sample_rate_hz, 'Hz', 0, si=False)} · {meta.total_samples} amostras · "
                       f"{fnum(meta.duration_s, 's', 3, si=False)}"),
        ("Frequência nominal", fnum(meta.frequency_hz, "Hz", 0, si=False)),
        ("Canais", f"{len(meta.analog_channels)} analógicos, {len(meta.digital_channels)} digitais"
                   + (f" · COMTRADE {meta.revision}" if meta.revision else "")),
        ("Analista", opts.analyst),
        ("Data do relatório", datetime.now().strftime("%d/%m/%Y %H:%M")),
    ])

    # 2. resumo
    if opts.want("summary"):
        b.h("2. Resumo da perturbação")
        f = summary.get("fault") or {}
        if f:
            tipo = f.get("type") or "indeterminado"
            if f.get("energization"):
                tipo = "Energização (corrente pré-evento nula)"
                if f.get("second_harmonic_pct") is not None:
                    tipo += f" – 2ª harmônica {fnum(f['second_harmonic_pct'], '%', 1, si=False)}"
            b.kv([
                ("Início", _rel(f.get("start_t"), trig) + (f"  ·  {f['start_abs']}" if f.get("start_abs") else "")),
                ("Fim", _rel(f.get("end_t"), trig) if f.get("end_t") is not None else "após o fim do registro"),
                ("Duração", fms(f.get("duration_ms"))),
                ("Tipo / fases", tipo),
                ("Grupo de corrente analisado", (summary.get("current_group") or {}).get("label")),
                ("Grupo de tensão", (summary.get("voltage_group") or {}).get("label")),
            ])
        cur = summary.get("currents") or []
        if cur:
            b.h("Correntes", 2)
            b.table(["Fase", "Canal", "Pré-falta (RMS)", "Máx. RMS", "Instante", "Pico", "Interrupção"], [
                [c["phase"], c["channel"], fnum(c["pre_rms"], c["unit"]), fnum(c["max_rms"], c["unit"]),
                 fsec(c["max_rms_t"]), fnum(c["peak"], c["unit"]), fsec(c["interruption_t"])]
                for c in cur
            ], [0.6, 2, 1.3, 1.3, 1.1, 1.3, 1.1])
        vol = summary.get("voltages") or []
        if vol:
            b.h("Tensões", 2)
            b.table(["Fase", "Canal", "Pré-falta (RMS)", "Mín. RMS", "Instante", "Afundamento"], [
                [v["phase"], v["channel"], fnum(v["pre_rms"], v["unit"]), fnum(v["min_rms"], v["unit"]),
                 fsec(v["min_rms_t"]), fnum(v["sag_pct"], "%", 1, si=False)]
                for v in vol
            ], [0.6, 2, 1.4, 1.4, 1.1, 1.1])

    # 3. proteção
    if opts.want("protection"):
        pr = summary.get("protection") or {}
        b.h("3. Atuação da proteção")
        rows = []
        for key, label in (("pickup", "Primeira partida"), ("trip", "Primeiro trip"),
                           ("breaker_open", "Abertura do disjuntor (estado)"),
                           ("reclose_cmd", "Comando de religamento"),
                           ("breaker_close", "Fechamento do disjuntor")):
            if key in pr:
                rows.append((label, f"{_rel(pr[key]['t'], trig)} – {pr[key]['channel']}"))
        rows += [
            ("Tempo início → partida", fms(pr.get("pickup_delay_ms")) if "pickup_delay_ms" in pr else None),
            ("Tempo de atuação (início → trip)", fms(pr.get("trip_time_ms")) if "trip_time_ms" in pr else None),
            ("Tempo do disjuntor (trip → estado aberto)", fms(pr.get("breaker_time_ms")) if "breaker_time_ms" in pr else None),
        ]
        poles = pr.get("interruption_after_trip_ms")
        if poles:
            rows.append(("Interrupção da corrente após o trip",
                         " · ".join(f"{ph}: {fms(v)}" for ph, v in poles.items())))
        if "reclose_current_t" in pr:
            rows.append(("Retorno da corrente (religamento)", _rel(pr["reclose_current_t"], trig)))
        if "dead_time_ms" in pr:
            rows.append(("Tempo morto", fms(pr["dead_time_ms"])))
        if any(v for _, v in rows):
            b.kv(rows)
        else:
            b.p("Nenhum evento de proteção identificado nos canais digitais.")

    if summary.get("notes"):
        for note in summary["notes"]:
            b.p(f"Observação: {note}", "note")

    # 4. eventos
    if opts.want("events"):
        ev = get_analysis("events").run(ctx, AnalysisRequest())
        events = ev["events"]
        b.h("4. Sequência de eventos (canais digitais)")
        if not events:
            b.p("Nenhum canal digital mudou de estado no registro.")
        else:
            rows = []
            for e in events[:MAX_EVENT_ROWS]:
                rows.append([
                    fms(e["rel_trigger_ms"]) if e["rel_trigger_ms"] is not None else fsec(e["time_s"]),
                    (e.get("absolute") or "")[11:],
                    e["name"],
                    f"{e['action']} ({e['from']}→{e['to']})",
                    CATEGORIES.get(e["category"], e["category"]),
                ])
            head = "t − trigger" if ev["trigger_s"] is not None else "t (registro)"
            b.table([head, "Hora", "Canal", "Mudança", "Categoria"], rows, [1.1, 1.4, 3, 1.5, 1.3])
            if len(events) > MAX_EVENT_ROWS:
                b.p(f"(Exibidos {MAX_EVENT_ROWS} de {len(events)} eventos.)", "note")
            initial_on = [c["name"] for c in ev["channels"] if c["initial"] == 1 and c["changes"] == 0]
            if initial_on:
                b.p("Canais em nível 1 durante todo o registro: " + ", ".join(initial_on[:40])
                    + (" …" if len(initial_on) > 40 else ""), "note")

    # 5. cursores
    cur_opts = opts.cursors or {}
    if opts.want("cursors") and (cur_opts.get("t1") is not None or cur_opts.get("t2") is not None) and cur_opts.get("channels"):
        res = get_analysis("cursors").run(ctx, AnalysisRequest(
            channels=[int(c) for c in cur_opts["channels"]][:64],
            params={"t1": cur_opts.get("t1"), "t2": cur_opts.get("t2"),
                    "window_cycles": str(cur_opts.get("window_cycles", "1"))}))
        b.h("5. Medições com cursores")
        b.kv([
            ("C1", _rel(res["t1"], trig) if res["t1"] is not None else None),
            ("C2", _rel(res["t2"], trig) if res["t2"] is not None else None),
            ("Δt (C2 − C1)", (f"{fms(res['dt'] * 1e3)}  ·  {fnum(res['dt_cycles'], 'ciclos', 2, si=False)}")
             if res["dt"] is not None else None),
        ])
        rows = []
        for r in res["channels"]:
            a, c = (r["at"] + [None, None])[:2]
            if r["kind"] == "digital":
                rows.append([r["name"], str(a["value"]) if a else "—", str(c["value"]) if c else "—", "—", "—",
                             f"{r['interval']['changes']} mudança(s)" if r.get("interval") else "—"])
                continue
            u = r["unit"]
            rms = lambda x: fnum(x["rms"], u) if x else "—"  # noqa: E731
            ph = lambda x: (f"{fnum(x['mag'], u)} ∠ {fnum(x['ang_rel'], '°', 1, si=False)}" if x and x["mag"] is not None else "—")  # noqa: E731
            iv = r.get("interval")
            rows.append([r["name"], rms(a), rms(c), ph(a), ph(c),
                         f"pico {fnum(iv['peak'], u)} · RMS {fnum(iv['rms'], u)}" if iv else "—"])
        b.table(["Canal", "RMS em C1", "RMS em C2", "Fasor em C1", "Fasor em C2", "Entre C1 e C2"],
                rows, [2, 1.2, 1.2, 1.6, 1.6, 2])
        b.p(f"RMS e fasores com janela de {fnum(res['window_cycles'], 'ciclo(s)', 1, si=False)} terminando no cursor; "
            "ângulos relativos ao primeiro canal analógico da tabela.", "note")

    # 6. figuras
    imgs = opts.images[:MAX_IMAGES]
    if opts.want("figures") and imgs:
        b.h("6. Figuras")
        for i, item in enumerate(imgs, start=1):
            b.img(_decode_image(item), f"Figura {i} – {item.get('caption') or 'Oscilografia'}")

    # 7. análise
    if opts.comments.strip() or opts.conclusion.strip():
        b.h("7. Análise do especialista")
        if opts.comments.strip():
            b.h("Comentários", 2)
            for par in opts.comments.strip().split("\n\n"):
                b.p(par.strip())
        if opts.conclusion.strip():
            b.h("Conclusão", 2)
            for par in opts.conclusion.strip().split("\n\n"):
                b.p(par.strip())

    b.p(f"Valores calculados automaticamente pelo Oscilo {opts.app_version} a partir do registro COMTRADE; "
        "confira os instantes e grandezas na oscilografia antes de concluir.", "note")
    processing_block(b, ctx, opts, summary)
    return b


# ------------------------------------------------- informações de processamento
ALIGN_LABELS = {
    "onset": "onset (início da perturbação)",
    "trigger": "trigger",
    "absolute": "absolute (horário do .cfg)",
}


def _hash_text(src) -> str:
    h = src.sha256_short()
    return f"{h}…" if h else "indisponível"


def _comtrade_text(src) -> str:
    parts = [f"COMTRADE {src.revision}" if src.revision else "", src.data_format]
    return " · ".join(p for p in parts if p) or "—"


def _estimator_text(estimator: str | None) -> str | None:
    if not estimator:
        return None
    try:
        return get_estimator(estimator).name
    except ValueError:
        return estimator


def _k0_text(ctx, params: dict[str, Any]) -> tuple[str | None, str | None]:
    """Base (primário/secundário) e k0 em uso na aba R-X."""
    imp = get_analysis("impedance")
    req = AnalysisRequest(params=params or {})
    side = imp.param(req, "side")
    base = "ohms secundários (RTC/RTP)" if side == "secondary" else "ohms primários"
    mode = imp.param(req, "k0_mode")
    k0, _, _ = imp._k0(req)
    how = {"z0z1": "calculado de Z1/Z0 da linha", "k0": "informado", "none": "sem compensação"}.get(mode, mode)
    return base, f"{fnum(abs(k0), '', 3, si=False)} ∠ {fnum(math.degrees(math.atan2(k0.imag, k0.real)), '', 1, si=False)}° ({how})"


def processing_block(b: Blocks, ctx, opts: ReportOptions, summary: dict[str, Any]) -> None:
    """Bloco final discreto: versão, data/hora, arquivos de origem (com hash do
    .dat) e parâmetros de cálculo. Só nomes de arquivo – nunca caminhos."""
    when = opts.generated_at.strip() or datetime.now().strftime("%d/%m/%Y %H:%M")
    b.append(("ph", "Informações de processamento"))
    b.append(("pp", f"Gerado pelo Oscilo v{opts.app_version} em {when}"))

    sources = list(getattr(ctx.data, "sources", []) or [])
    if ctx.meta.merge and sources:
        b.append(("ptable", ["Rótulo", "Arquivo", "Formato", "SHA-256 do .dat", "Alinhamento", "Ajuste"], [
            [s.label, s.file.name, _comtrade_text(s.file), _hash_text(s.file),
             ALIGN_LABELS.get(s.align_mode or "", s.align_mode or "—"),
             fnum(s.offset_ms or 0.0, "ms", 1, si=False)]
            for s in sources
        ], [1.2, 2, 1.4, 1.5, 1.7, 0.9]))
    elif sources:
        s = sources[0]
        b.small_kv([
            ("Arquivo analisado", s.file.name),
            ("Formato", _comtrade_text(s.file)),
            ("SHA-256 do .dat", _hash_text(s.file)),
        ])

    vg = (summary.get("voltage_group") or {}).get("label")
    cg = (summary.get("current_group") or {}).get("label")
    rows = [
        ("Estimador fasorial", _estimator_text(opts.estimator)),
        ("Janela", fnum(opts.window_cycles, "ciclo(s)", 2, si=False) if opts.window_cycles else None),
        ("Grupo de tensão", (vg + ("" if opts.voltage_group else " (automático)")) if vg else None),
        ("Grupo de corrente", (cg + ("" if opts.current_group else " (automático)")) if cg else None),
    ]
    if opts.impedance_params is not None:
        try:
            base, k0 = _k0_text(ctx, opts.impedance_params)
        except ValueError:
            base, k0 = None, "parâmetros inválidos"
        rows += [("R-X: base", base), ("R-X: k0", k0)]
    b.small_kv(rows)


# --------------------------------------------------------------------- render
def render_docx(blocks: Blocks, opts: ReportOptions, meta) -> bytes:
    doc = DocxBuilder(opts.title, opts.analyst)
    doc.heading(opts.title, 0)
    sub = " · ".join(x for x in (meta.station, meta.device, meta.trigger_time) if x)
    if sub:
        doc.paragraph(sub, style="Subtitle")
    for blk in blocks:
        kind = blk[0]
        if kind == "h":
            doc.heading(blk[2], blk[1])
        elif kind == "p":
            doc.paragraph(blk[1])
        elif kind == "note":
            doc.paragraph(blk[1], style="Note")
        elif kind == "kv":
            doc.table(None, [[k, v] for k, v in blk[1]], [1, 2.6], first_col_bold=True)
        elif kind == "table":
            doc.table(blk[1], blk[2], blk[3], font_size=17)
        elif kind == "img":
            doc.image(blk[1], blk[2])
        elif kind == "ph":
            doc.paragraph(blk[1], style="Heading2")
        elif kind == "pp":
            doc.paragraph(blk[1], size=16, color="595959")
        elif kind == "pkv":
            doc.table(None, [[k, v] for k, v in blk[1]], [1, 2.6], first_col_bold=True, font_size=15)
        elif kind == "ptable":
            doc.table(blk[1], blk[2], blk[3], font_size=15)
    return doc.to_bytes()


_CSS = """
@page { size: A4; margin: 18mm 16mm 18mm 20mm; }
body { font-family: Calibri, 'Segoe UI', Arial, sans-serif; color: #222; font-size: 10.5pt; line-height: 1.35;
       max-width: 180mm; margin: 0 auto; padding: 12px; background: #fff; }
h1.title { color: #1f3864; font-size: 21pt; margin: 0 0 2px; }
.subtitle { color: #595959; font-size: 12pt; margin: 0 0 18px; }
h2 { color: #1f3864; font-size: 14pt; margin: 20px 0 6px; border-bottom: 1px solid #c9d3e6; padding-bottom: 2px;
     break-after: avoid; }
h3 { color: #2e5496; font-size: 11.5pt; margin: 12px 0 4px; break-after: avoid; }
table { border-collapse: collapse; width: 100%; margin: 4px 0 12px; font-size: 9pt; }
th, td { border: 1px solid #a0a0a0; padding: 2px 5px; vertical-align: top; text-align: left; }
th { background: #dce6f2; }
tr { break-inside: avoid; }
table.kv td:first-child { font-weight: 600; width: 32%; }
.note { color: #7f6000; font-style: italic; font-size: 9pt; }
figure { margin: 10px 0 16px; text-align: center; break-inside: avoid; }
figure img { max-width: 100%; border: 1px solid #ddd; }
figcaption { font-style: italic; font-size: 9pt; color: #404040; margin-top: 4px; }
.processing { margin-top: 24px; color: #595959; font-size: 8pt; break-inside: avoid; }
.processing h3 { color: #595959; font-size: 10pt; border-top: 1px solid #c9d3e6; padding-top: 6px; }
.processing p { margin: 2px 0 6px; }
.processing table { font-size: 7.5pt; margin: 2px 0 8px; }
"""


def render_html(blocks: Blocks, opts: ReportOptions, meta) -> bytes:
    e = html.escape
    out = [f'<!DOCTYPE html><html lang="pt-BR"><head><meta charset="utf-8"><title>{e(opts.title)}</title>'
           f"<style>{_CSS}</style></head><body>"]
    out.append(f'<h1 class="title">{e(opts.title)}</h1>')
    sub = " · ".join(x for x in (meta.station, meta.device, meta.trigger_time) if x)
    if sub:
        out.append(f'<p class="subtitle">{e(sub)}</p>')
    in_proc = False
    for blk in blocks:
        kind = blk[0]
        if kind == "h":
            tag = "h2" if blk[1] <= 1 else "h3"
            out.append(f"<{tag}>{e(blk[2])}</{tag}>")
        elif kind in ("p", "note"):
            cls = ' class="note"' if kind == "note" else ""
            out.append(f"<p{cls}>{e(blk[1]).replace(chr(10), '<br>')}</p>")
        elif kind == "kv":
            rows = "".join(f"<tr><td>{e(k)}</td><td>{e(v)}</td></tr>" for k, v in blk[1])
            out.append(f'<table class="kv">{rows}</table>')
        elif kind == "table":
            head = "".join(f"<th>{e(h)}</th>" for h in blk[1])
            rows = "".join("<tr>" + "".join(f"<td>{e(c)}</td>" for c in r) + "</tr>" for r in blk[2])
            out.append(f"<table><thead><tr>{head}</tr></thead><tbody>{rows}</tbody></table>")
        elif kind == "img":
            b64 = base64.b64encode(blk[1]).decode("ascii")
            out.append(f'<figure><img src="data:image/png;base64,{b64}" alt=""><figcaption>{e(blk[2])}</figcaption></figure>')
        elif kind == "ph":
            out.append(f'<section class="processing"><h3>{e(blk[1])}</h3>')
            in_proc = True
        elif kind == "pp":
            out.append(f"<p>{e(blk[1])}</p>")
        elif kind == "pkv":
            rows = "".join(f"<tr><td>{e(k)}</td><td>{e(v)}</td></tr>" for k, v in blk[1])
            out.append(f'<table class="kv">{rows}</table>')
        elif kind == "ptable":
            head = "".join(f"<th>{e(h)}</th>" for h in blk[1])
            rows = "".join("<tr>" + "".join(f"<td>{e(c)}</td>" for c in r) + "</tr>" for r in blk[2])
            out.append(f"<table><thead><tr>{head}</tr></thead><tbody>{rows}</tbody></table>")
    if in_proc:
        out.append("</section>")
    out.append("</body></html>")
    return "".join(out).encode("utf-8")


def build_report(ctx, opts: ReportOptions, fmt: str = "docx") -> bytes:
    blocks = collect(ctx, opts)
    if fmt == "html":
        return render_html(blocks, opts, ctx.meta)
    if fmt == "docx":
        return render_docx(blocks, opts, ctx.meta)
    raise ValueError("Formato de relatório inválido (use docx ou html).")
