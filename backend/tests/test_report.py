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
from merge import merge_records  # noqa: E402
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


# ------------------------------------------------- informações de processamento
def _sha(data: bytes) -> str:
    import hashlib

    return hashlib.sha256(data).hexdigest()


def test_sha256_file_in_blocks(tmp_path):
    from provenance import SourceFile, sha256_file

    content = bytes(range(256)) * 5000 + b"\x00\x1a\r\n"  # > 1 bloco pequeno; bytes, não texto
    path = tmp_path / "x.dat"
    path.write_bytes(content)
    assert sha256_file(path, chunk=4096) == _sha(content)
    src = SourceFile(name=str(tmp_path / "x.cfg"), dat_path=path)
    assert src.name == "x.cfg"  # nunca o caminho
    assert src.sha256_short() == _sha(content)[:12]
    path.unlink()
    assert src.sha256_short() == _sha(content)[:12]  # guardado no registro: não relê


def test_store_keeps_source_and_hash():
    store = ComtradeStore()
    meta = store.load_from_path(SAMPLES / "demo_falta_transformador" / "registro.cfg")
    src = store.get_data(meta.id).sources[0].file
    dat = (SAMPLES / "demo_falta_transformador" / "registro.dat").read_bytes()
    assert src.name == "registro.cfg"
    assert src.revision == "2013" and src.data_format == "BINARY"
    assert src.sha256_short() == _sha(dat)[:12]


def _processing_text(data: bytes, fmt: str) -> str:
    if fmt == "docx":
        return zipfile.ZipFile(io.BytesIO(data)).read("word/document.xml").decode()
    return data.decode()


@pytest.mark.parametrize("fmt", ["docx", "html"])
@pytest.mark.parametrize("name", ["demo_falta_transformador", "demo_87t_exportacao",
                                  "demo_87t_diferencial", "demo_oscilacao_potencia"])
def test_report_processing_block(name, fmt):
    ctx = _ctx(name)
    opts = ReportOptions(source_name="registro.cfg", app_version="9.9.9", generated_at="08/11/2026 14:32",
                         estimator="ls", window_cycles=2.0,
                         impedance_params={"side": "secondary", "k0_mode": "k0", "k0_mag": 0.8, "k0_ang": -10})
    text = _processing_text(build_report(ctx, opts, fmt), fmt)
    dat = (SAMPLES / name / "registro.dat").read_bytes()
    assert "Informações de processamento" in text
    assert "Gerado pelo Oscilo v9.9.9 em 08/11/2026 14:32" in text
    assert _sha(dat)[:12] in text and _sha(dat)[:13] not in text
    assert "Mínimos quadrados" in text or "mínimos quadrados" in text.lower()
    assert "2,00 ciclo(s)" in text
    assert "ohms secundários" in text and "0,800 ∠ -10,0°" in text
    assert str(SAMPLES) not in text and str(SAMPLES).replace("\\", "/") not in text  # só nomes


def test_report_processing_merged(tmp_path):
    store = ComtradeStore()
    a = store.load_from_path(SAMPLES / "demo_falta_transformador" / "registro.cfg")
    b = store.load_from_path(SAMPLES / "demo_87t_exportacao" / "registro.cfg")
    meta = merge_records(store, [{"id": a.id, "label": "SE_A"}, {"id": b.id, "label": "SE_B", "offset_ms": 2.5}],
                         "trigger", a.id)
    html_text = build_report(store.context(meta.id), ReportOptions(app_version="t"), "html").decode()
    for sample in ("demo_falta_transformador", "demo_87t_exportacao"):
        assert _sha((SAMPLES / sample / "registro.dat").read_bytes())[:12] in html_text
    assert "SE_A" in html_text and "SE_B" in html_text
    assert "trigger" in html_text and "2,5 ms" in html_text
    assert "<th>Alinhamento</th>" in html_text


def test_report_endpoint_old_payload():
    """Payload sem os campos novos (versões anteriores da interface) continua válido."""
    import main

    meta = main.store.load_from_path(SAMPLES / "demo_falta_transformador" / "registro.cfg")
    old = {"format": "html", "title": "R", "sections": {"events": False}, "source_name": "C:/x/y/registro.cfg"}
    res = main.make_report(meta.id, main.ReportBody(**old))
    text = res.body.decode()
    assert "Informações de processamento" in text and f"Oscilo v{main.app.version}" in text
    assert "C:/x/y" not in text
    new = {**old, "estimator": "ls", "window_cycles": 1, "generated_at": "01/02/2026 03:04"}
    assert "01/02/2026 03:04" in main.make_report(meta.id, main.ReportBody(**new)).body.decode()


def test_upload_uses_precomputed_hash(tmp_path):
    """Upload web: o .dat temporário é apagado; o hash vem calculado da gravação."""
    import shutil

    for ext in ("cfg", "dat"):
        shutil.copyfile(SAMPLES / "demo_87t_exportacao" / f"registro.{ext}", tmp_path / f"upload.{ext}")
    store = ComtradeStore()
    meta = store.load_from_upload(tmp_path / "upload.cfg", tmp_path / "upload.dat", "minha_ocorrencia.cfg",
                                  dat_sha256="ab" * 32)
    src = store.get_data(meta.id).sources[0].file
    assert src.dat_path is None and src.name == "minha_ocorrencia.cfg"
    assert src.sha256_short() == "ab" * 6
