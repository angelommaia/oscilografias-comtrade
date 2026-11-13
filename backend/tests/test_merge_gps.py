"""Juntar registros com GPS / horário absoluto como padrão (qualidade de tempo, incompatibilidade)."""

from __future__ import annotations

import sys
from datetime import datetime, timedelta
from pathlib import Path

import numpy as np
import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from analysis import AnalysisRequest, get_analysis  # noqa: E402
from comtrade_service import ComtradeStore  # noqa: E402
from merge import DEFAULT_MODE, MergeIncompatible, merge_records, preview_alignment  # noqa: E402
from timequality import parse_time_code, summary  # noqa: E402

F0 = 60.0
FS = 1920.0


def write_2013(folder: Path, name: str, start: datetime, fault_t: float, dur: float = 1.0,
               time_code: str | None = "-3", tmq: str = "0", rev: str = "2013") -> Path:
    """COMTRADE ASCII com Va/Vb/Vc e Ia/Ib/Ic; na falta Ia ×5 e Va ×0,5."""
    n = int(dur * FS)
    t = np.arange(n) / FS
    chans = [("VA LT", "A", "kV", 180.0, 0.0), ("VB LT", "B", "kV", 180.0, -120.0), ("VC LT", "C", "kV", 180.0, 120.0),
             ("IA LT", "A", "A", 1000.0, -30.0), ("IB LT", "B", "A", 1000.0, -150.0), ("IC LT", "C", "A", 1000.0, 90.0)]
    rows = []
    for nm, ph, unit, amp, ang in chans:
        x = amp * np.cos(2 * np.pi * F0 * t + np.radians(ang))
        if ph == "A":
            x = np.where(t >= fault_t, x * (5.0 if unit == "A" else 0.5), x)
        rows.append(np.round(x / 0.01).astype(np.int64))
    lines = [f"ST_{name},DEV_{name},{rev}", f"{len(chans)},{len(chans)}A,0D"]
    for i, (nm, ph, unit, _, _) in enumerate(chans, start=1):
        lines.append(f"{i},{nm},{ph},,{unit},0.01,0,0,-999999,999999,1,1,P")
    trig = start + timedelta(seconds=0.1)
    lines += [f"{F0:g}", "1", f"{FS:g},{n}", start.strftime("%d/%m/%Y,%H:%M:%S.%f"),
              trig.strftime("%d/%m/%Y,%H:%M:%S.%f"), "ASCII", "1"]
    if rev == "2013" and time_code is not None:
        lines += [f"{time_code},{time_code}", f"{tmq},0"]
    folder.mkdir(parents=True, exist_ok=True)
    cfg = folder / f"{name}.cfg"
    cfg.write_bytes(("\r\n".join(lines) + "\r\n").encode("ascii"))
    with (folder / f"{name}.dat").open("w", newline="\r\n") as fh:
        for k in range(n):
            fh.write(f"{k + 1},{int(round(k * 1e6 / FS))}," + ",".join(str(r[k]) for r in rows) + "\n")
    return cfg


T_LOCAL = datetime(2026, 11, 1, 10, 0, 0)  # local −3 = 13:00 UTC


def _pair(tmp_path, b_start=None, b_code="0", b_fault=0.3, b_tmq="0", b_rev="2013", a_code="-3"):
    store = ComtradeStore()
    a = store.load_from_path(write_2013(tmp_path / "a", "A", T_LOCAL, 0.5, time_code=a_code))
    # B grava em UTC e começou 200 ms depois de A: a mesma falta aparece em 0,3 s na escala de B
    b_start = b_start or (T_LOCAL + timedelta(hours=3, milliseconds=200))
    b = store.load_from_path(write_2013(tmp_path / "b", "B", b_start, b_fault, time_code=b_code, tmq=b_tmq, rev=b_rev))
    return store, a, b


def test_parse_time_code():
    assert parse_time_code("-3") == -3
    assert parse_time_code("+5h30") == 5.5
    assert parse_time_code("0") == 0
    assert parse_time_code("x") is None and parse_time_code("") is None


def test_time_quality_from_cfg(tmp_path):
    store, a, b = _pair(tmp_path, b_tmq="F")
    assert a.time_quality["informed"] and a.time_quality["utc_offset_h"] == -3 and a.time_quality["locked"] is True
    assert "UTC−3" in summary(a.time_quality) and "travado" in summary(a.time_quality)
    assert b.time_quality["locked"] is False and "falha" in summary(b.time_quality)


def test_gps_is_default_and_converts_to_utc(tmp_path):
    store, a, b = _pair(tmp_path)
    assert DEFAULT_MODE == "absolute"
    meta = merge_records(store, [{"id": a.id, "label": "A"}, {"id": b.id, "label": "B"}], reference=a.id)
    rec = {r["label"]: r for r in meta.merge["records"]}
    assert meta.merge["mode"] == "absolute" and rec["B"]["mode_used"] == "absolute"
    assert rec["B"]["absolute_utc"] is True
    assert rec["B"]["shift_ms"] == pytest.approx(200, abs=0.01)
    # a falta cai no mesmo instante nos dois terminais
    data = store.get_data(meta.id)
    ia_a = np.abs(np.nan_to_num(np.asarray(data.analog[3][:])))
    ia_b = np.abs(np.nan_to_num(np.asarray(data.analog[9][:])))
    assert abs(int(np.flatnonzero(ia_a > 1500)[0]) - int(np.flatnonzero(ia_b > 1500)[0])) <= 2


def test_no_overlap_warns_without_switching(tmp_path):
    store, a, b = _pair(tmp_path, b_start=T_LOCAL + timedelta(hours=3, seconds=7.9))
    items = [{"id": a.id, "label": "A"}, {"id": b.id, "label": "B"}]
    prev = preview_alignment(store, [dict(x) for x in items], "absolute", a.id)
    assert prev["absolute_ok"] is False and prev["absolute_forceable"] is True
    assert prev["absolute_problems"][0]["status"] in ("no_overlap", "too_far")
    assert prev["records"][1]["candidates_ms"]["onset"] == pytest.approx(200, abs=1.5)  # sugestão: perturbação
    with pytest.raises(MergeIncompatible) as err:
        merge_records(store, [dict(x) for x in items], "absolute", a.id)
    assert "Início da perturbação" in str(err.value)
    # modos onset/trigger continuam funcionando com o mesmo par
    meta = merge_records(store, [dict(x) for x in items], "onset", a.id)
    assert {r["label"]: r for r in meta.merge["records"]}["B"]["shift_ms"] == pytest.approx(200, abs=1.5)
    assert merge_records(store, [dict(x) for x in items], "trigger", a.id).merge["mode"] == "trigger"
    # "juntar mesmo assim": GPS mantido, com aviso no registro e no fasorial de 2 terminais
    forced = merge_records(store, [dict(x) for x in items], "absolute", a.id, force=True)
    assert forced.merge["forced"] is True and any("incompatíveis" in n for n in forced.merge["notes"])
    ctx = store.context(forced.id)
    gid = {g["id"].split("|")[0] + g["quantity"]: g["id"] for g in ctx.data.groups}
    res = get_analysis("phasor_diagram").run(ctx, AnalysisRequest(
        time_s=0.6, voltage_group=gid["AV"], current_group=gid["AI"], inputs={"v2": gid["BV"], "i2": gid["BI"]}))
    assert any("incompatíveis" in n for n in res["notes"])


def test_invalid_date_cannot_force(tmp_path):
    store, a, b = _pair(tmp_path, b_start=datetime(23, 8, 15, 8, 30, 0))
    items = [{"id": a.id, "label": "A"}, {"id": b.id, "label": "B"}]
    prev = preview_alignment(store, [dict(x) for x in items], "absolute", a.id)
    assert prev["absolute_problems"][0]["status"] == "invalid" and prev["absolute_forceable"] is False
    with pytest.raises(MergeIncompatible):
        merge_records(store, [dict(x) for x in items], "absolute", a.id, force=True)


def test_unlocked_clock_noted_in_phasor(tmp_path):
    store, a, b = _pair(tmp_path, b_tmq="F")
    meta = merge_records(store, [{"id": a.id, "label": "A"}, {"id": b.id, "label": "B"}], reference=a.id)
    ctx = store.context(meta.id)
    gid = {g["id"].split("|")[0] + g["quantity"]: g["id"] for g in ctx.data.groups}
    res = get_analysis("phasor_diagram").run(ctx, AnalysisRequest(
        time_s=0.6, voltage_group=gid["AV"], current_group=gid["AI"], inputs={"v2": gid["BV"], "i2": gid["BI"]}))
    assert any("não sincronizado" in n and "B" in n for n in res["notes"])


def test_api_conflict_and_preview(tmp_path):
    """Endpoints chamados diretamente (sem TestClient: o ambiente de build não tem httpx)."""
    from fastapi import HTTPException

    import main

    main.store._data.clear()
    a = main.store.load_from_path(write_2013(tmp_path / "a", "A", T_LOCAL, 0.5))
    b = main.store.load_from_path(write_2013(tmp_path / "b", "B", T_LOCAL + timedelta(hours=3, seconds=9), 0.3, time_code="0"))

    def body(**kw):
        return main.MergeBody(records=[{"id": a.id}, {"id": b.id}], reference=a.id, **kw)

    pv = main.merge_preview(body())
    assert pv["mode"] == "absolute" and pv["absolute_ok"] is False
    assert "UTC−3" in pv["records"][0]["time_summary"]
    with pytest.raises(HTTPException) as err:
        main.merge(body())
    assert err.value.status_code == 409 and err.value.detail["forceable"] is True
    assert main.merge(body(force=True))["merge"]["forced"] is True
    assert main.merge(body(mode="onset"))["merge"]["mode"] == "onset"
