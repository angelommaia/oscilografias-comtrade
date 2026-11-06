"""Resumo automático, sequência de eventos, cursores e relatório."""

from __future__ import annotations

import base64
import io
import struct
import sys
import zipfile
import zlib
from pathlib import Path
from xml.etree import ElementTree as ET

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from analysis import AnalysisRequest, get_analysis  # noqa: E402
from analysis.sequence import classify_channel  # noqa: E402
from comtrade_service import ComtradeStore  # noqa: E402
from report import ReportOptions, build_report  # noqa: E402

SAMPLES = Path(__file__).resolve().parents[2] / "samples"


def _ctx(name: str):
    store = ComtradeStore()
    meta = store.load_from_path(SAMPLES / name / "registro.cfg")
    return store.context(meta.id)


def _png(w=40, h=20) -> str:
    raw = b"".join(b"\x00" + b"\xff\xff\xff" * w for _ in range(h))

    def chunk(t, d):
        return struct.pack(">I", len(d)) + t + d + struct.pack(">I", zlib.crc32(t + d) & 0xFFFFFFFF)

    png = (b"\x89PNG\r\n\x1a\n" + chunk(b"IHDR", struct.pack(">IIBBBBB", w, h, 8, 2, 0, 0, 0))
           + chunk(b"IDAT", zlib.compress(raw)) + chunk(b"IEND", b""))
    return base64.b64encode(png).decode()


@pytest.mark.parametrize("name,category,meaning", [
    ("87T OPERADO", "trip", None),
    ("TRIP GERAL", "trip", None),
    ("50/51 ALIMENTADOR TRIP", "trip", None),
    ("87T PARTIDA", "pickup", None),
    ("DJ LINHA ABERTO", "breaker", "open"),
    ("DJ TRAFO FECHADO", "breaker", "closed"),
    ("52a LT", "breaker", "closed"),
    ("86T BLOQUEIO", "block", None),
    ("68 PSB ATIVO", "block", None),
    ("79 RELIGAMENTO", "reclose", None),
    ("EST_012", "other", None),
])
def test_classify_channel(name, category, meaning):
    cls = classify_channel(name)
    assert cls["category"] == category
    assert cls["meaning"] == meaning


def test_events_transformer_fault():
    ctx = _ctx("demo_falta_transformador")
    res = get_analysis("events").run(ctx, AnalysisRequest())
    names = [(e["name"], e["action"]) for e in res["events"]]
    assert names[0] == ("87T PARTIDA", "ativou")
    assert ("DJ BT ABERTO", "abriu") in names
    assert res["trigger_s"] == pytest.approx(3.004167, abs=1e-6)
    times = [e["time_s"] for e in res["events"]]
    assert times == sorted(times)


def test_summary_internal_fault():
    ctx = _ctx("demo_falta_transformador")
    res = get_analysis("summary").run(ctx, AnalysisRequest())
    f = res["fault"]
    assert f["type"] == "AT"
    assert f["start_t"] == pytest.approx(3.004, abs=0.002)
    assert 50 <= f["duration_ms"] <= 75
    prot = res["protection"]
    assert prot["trip"]["channel"] == "87T OPERADO"
    assert prot["trip_time_ms"] == pytest.approx(20, abs=3)
    assert prot["breaker_time_ms"] == pytest.approx(42, abs=3)


def test_summary_external_phase_fault():
    res = get_analysis("summary").run(_ctx("demo_87t_exportacao"), AnalysisRequest())
    assert res["fault"]["type"] == "BC"
    assert res["fault"]["ground"] is False


def test_summary_inrush_is_energization():
    res = get_analysis("summary").run(_ctx("demo_87t_diferencial"), AnalysisRequest())
    assert res["fault"]["energization"] is True
    assert res["fault"]["second_harmonic_pct"] > 15


def test_summary_power_swing_note():
    res = get_analysis("summary").run(_ctx("demo_oscilacao_potencia"), AnalysisRequest())
    assert any("oscilação" in n for n in res["notes"])
    assert res["protection"]["trip"]["channel"] == "78 OOS TRIP"


def test_cursors():
    ctx = _ctx("demo_oscilacao_potencia")
    f0 = ctx.f0
    res = get_analysis("cursors").run(ctx, AnalysisRequest(
        channels=[0, 1, 2, 8 + 5], params={"t1": 1.0, "t2": 1.0 + 6 / f0, "window_cycles": "1"}))
    assert res["dt_cycles"] == pytest.approx(6, abs=0.05)
    va, vb = res["channels"][0], res["channels"][1]
    assert va["at"][0]["ang_rel"] == pytest.approx(0, abs=1e-6)
    assert vb["at"][0]["ang_rel"] == pytest.approx(-120, abs=2)
    assert va["at"][0]["rms"] == pytest.approx(va["at"][0]["mag"], rel=0.02)
    assert res["channels"][-1]["kind"] == "digital"


@pytest.mark.parametrize("fmt", ["docx", "html"])
def test_report(fmt):
    ctx = _ctx("demo_falta_transformador")
    opts = ReportOptions(analyst="Analista", comments="Texto & <marcação>", conclusion="OK",
                         cursors={"t1": 3.0, "t2": 3.05, "channels": [0, 1, 2, 43]},
                         images=[{"caption": "Figura", "data": _png()}], source_name="registro.cfg",
                         app_version="teste")
    data = build_report(ctx, opts, fmt)
    if fmt == "docx":
        z = zipfile.ZipFile(io.BytesIO(data))
        for n in z.namelist():
            if n.endswith((".xml", ".rels")):
                ET.fromstring(z.read(n))
        doc = z.read("word/document.xml").decode()
        assert "87T OPERADO" in doc and "Texto &amp; &lt;marcação&gt;" in doc
        assert "word/media/image1.png" in z.namelist()
    else:
        text = data.decode()
        assert "<h2>4. Sequência de eventos" in text and "Texto &amp; &lt;marcação&gt;" in text


def test_report_rejects_non_png():
    ctx = _ctx("demo_oscilacao_potencia")
    opts = ReportOptions(images=[{"caption": "x", "data": base64.b64encode(b"nao-e-png").decode()}])
    with pytest.raises(ValueError):
        build_report(ctx, opts, "docx")
