"""Nomenclatura de fases (cores, ordem), verificação de rotação e registro combinado."""

from __future__ import annotations

import sys
from datetime import datetime, timedelta
from pathlib import Path

import numpy as np
import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from analysis import AnalysisRequest, get_analysis  # noqa: E402
from comtrade_service import ComtradeStore  # noqa: E402
from merge import detect_onset, merge_records  # noqa: E402

F0 = 60.0


def write_record(folder: Path, name: str, channels: list[tuple[str, str, str, float, float]],
                 start: datetime, fs: float = 1920.0, dur: float = 1.0, fault_t: float = 0.3,
                 pretrigger: float = 0.1) -> Path:
    """COMTRADE ASCII 1999. channels: (nome, campo ph, unidade, amplitude, ângulo°).
    Na falta (fault_t) correntes ×5 e tensões ×0,5 na primeira fase de cada grandeza."""
    n = int(dur * fs)
    t = np.arange(n) / fs
    rows = []
    for nm, ph, unit, amp, ang in channels:
        x = amp * np.cos(2 * np.pi * F0 * t + np.radians(ang))
        if ph in ("AZ", "A") or nm.lower().startswith(("vaz", "iaz")) or ang == 0.0 or ang == -30.0:
            gain = 5.0 if unit == "A" else 0.5
            x = np.where(t >= fault_t, x * gain, x)
        rows.append(np.round(x / 0.01).astype(np.int64))
    trip = (t >= fault_t + 0.02).astype(int)
    lines = [f"ST_{name},DEV_{name},1999", f"{len(channels) + 1},{len(channels)}A,1D"]
    for i, (nm, ph, unit, _, _) in enumerate(channels, start=1):
        lines.append(f"{i},{nm},{ph},,{unit},0.01,0,0,-999999,999999,1,1,P")
    lines.append("1,TRIP GERAL,,,0")
    trig = start + timedelta(seconds=pretrigger)
    lines += [f"{F0:g}", "1", f"{fs:g},{n}", start.strftime("%d/%m/%Y,%H:%M:%S.%f"),
              trig.strftime("%d/%m/%Y,%H:%M:%S.%f"), "ASCII", "1"]
    folder.mkdir(parents=True, exist_ok=True)
    cfg = folder / f"{name}.cfg"
    cfg.write_bytes(("\r\n".join(lines) + "\r\n").encode("ascii"))
    with (folder / f"{name}.dat").open("w", newline="\r\n") as fh:
        for k in range(n):
            vals = ",".join(str(r[k]) for r in rows)
            fh.write(f"{k + 1},{int(round(k * 1e6 / fs))},{vals},{trip[k]}\n")
    return cfg


def V(nm, ph, ang):
    return (nm, ph, "kV", 180.0, ang)


def I(nm, ph, ang):
    return (nm, ph, "A", 1000.0, ang)


COLORS = [V("Vaz LT X", "AZ", 0.0), V("Vbr LT X", "BR", -120.0), V("Vvr LT X", "VR", 120.0),
          I("Iaz LT X", "AZ", -30.0), I("Ibr LT X", "BR", -150.0), I("Ivr LT X", "VR", 90.0)]


def _load(path: Path):
    store = ComtradeStore()
    meta = store.load_from_path(path)
    return store, meta, store.get_data(meta.id)


def test_color_names(tmp_path):
    _, _, data = _load(write_record(tmp_path, "cores", COLORS, datetime(2024, 5, 1, 10)))
    groups = {g["quantity"]: g for g in data.groups}
    assert (groups["V"]["a"], groups["V"]["b"], groups["V"]["c"]) == (0, 1, 2)
    assert (groups["I"]["a"], groups["I"]["b"], groups["I"]["c"]) == (3, 4, 5)
    assert groups["V"]["rotation"] == "ABC" and groups["I"]["rotation"] == "ABC"


def test_color_names_out_of_order(tmp_path):
    chans = [V("Vvr LT X", "", 120.0), V("Vaz LT X", "", 0.0), V("Vbr LT X", "", -120.0)]
    _, _, data = _load(write_record(tmp_path, "fora", chans, datetime(2024, 5, 1, 10)))
    g = data.groups[0]
    assert (g["a"], g["b"], g["c"]) == (1, 2, 0)
    assert g["rotation"] == "ABC"


def test_phase_field_v_is_red(tmp_path):
    chans = [V("Tensao LT", "A", 0.0), V("Tensao LT", "B", -120.0), V("Tensao LT", "V", 120.0)]
    _, _, data = _load(write_record(tmp_path, "campo", chans, datetime(2024, 5, 1, 10)))
    g = data.groups[0]
    assert (g["a"], g["b"], g["c"]) == (0, 1, 2) and g["rotation"] == "ABC"


def test_same_name_inferred_and_corrected(tmp_path):
    # mesmos nomes, sem fase; ordem real no arquivo: A, C, B → rotação ACB → corrige
    chans = [V("V LT 230 kV", "", 0.0), V("V LT 230 kV", "", 120.0), V("V LT 230 kV", "", -120.0),
             V("V LT 230 kV N", "", 0.0)]
    _, _, data = _load(write_record(tmp_path, "ordem", chans, datetime(2024, 5, 1, 10)))
    g = data.groups[0]
    assert g["inferred"].startswith("ordem dos canais")
    assert (g["a"], g["b"], g["c"]) == (0, 2, 1)
    assert g["rotation"] == "ABC"


def test_named_acb_is_flagged_not_changed(tmp_path):
    chans = [V("VA LT", "A", 0.0), V("VB LT", "B", 120.0), V("VC LT", "C", -120.0)]
    _, _, data = _load(write_record(tmp_path, "acb", chans, datetime(2024, 5, 1, 10)))
    g = data.groups[0]
    assert g["rotation"] == "ACB" and (g["a"], g["b"], g["c"]) == (0, 1, 2)


def test_merge_alignment(tmp_path):
    t_a = datetime(2024, 5, 1, 10, 0, 0)
    # terminal B: relógio 1,3 s adiantado e falta vista 100 ms mais tarde na escala dele
    a = write_record(tmp_path / "a", "A", COLORS, t_a, fault_t=0.30)
    b = write_record(tmp_path / "b", "B", COLORS, t_a + timedelta(seconds=1.3 - 0.1), fault_t=0.40, fs=3840.0)
    store = ComtradeStore()
    ma, mb = store.load_from_path(a), store.load_from_path(b)
    assert detect_onset(store.get_data(ma.id))["t"] == pytest.approx(0.30, abs=1.5e-3)
    assert detect_onset(store.get_data(mb.id))["t"] == pytest.approx(0.40, abs=1.5e-3)

    meta = merge_records(store, [{"id": ma.id, "label": "A"}, {"id": mb.id, "label": "B"}], "onset", ma.id)
    spec = {r["label"]: r for r in meta.merge["records"]}
    assert spec["B"]["shift_ms"] == pytest.approx(-100, abs=1.5)
    assert spec["B"]["candidates_ms"]["absolute"] == pytest.approx(1200, abs=0.1)
    assert spec["B"]["clock_error_ms"] == pytest.approx(1300, abs=2)
    assert meta.sample_rate_hz == 3840.0
    data = store.get_data(meta.id)
    assert len(data.meta.analog_channels) == 12 and len(data.groups) == 4
    assert data.meta.analog_channels[6].name.startswith("B: ")
    # o início da falta coincide nos dois terminais do registro combinado
    a_on = np.flatnonzero(np.abs(np.asarray(data.analog[3][:])) > 1500)[0]
    b_on = np.flatnonzero(np.abs(np.nan_to_num(np.asarray(data.analog[9][:]))) > 1500)[0]
    assert abs(int(a_on) - int(b_on)) <= 40  # ≤ ~10 ms (mesmo semiciclo)

    # manual soma ao alinhamento; modo horário usa o .cfg
    # (estes dois registros de 1 s começam 1,2 s afastados: GPS só com "juntar mesmo assim")
    meta2 = merge_records(store, [{"id": ma.id, "label": "A"}, {"id": mb.id, "label": "B", "offset_ms": 5}],
                          "absolute", ma.id, force=True)
    assert {r["label"]: r for r in meta2.merge["records"]}["B"]["shift_ms"] == pytest.approx(1205, abs=0.2)

    # análises funcionam no combinado
    res = get_analysis("summary").run(store.context(meta.id), AnalysisRequest())
    assert res["fault"]["type"] in ("AT", "A")
    ev = get_analysis("events").run(store.context(meta.id), AnalysisRequest())
    assert [e["name"] for e in ev["events"]] == ["A: TRIP GERAL", "B: TRIP GERAL"] or len(ev["events"]) == 2

    with pytest.raises(ValueError):
        merge_records(store, [{"id": meta.id}, {"id": ma.id}], "onset")


def test_phasor_two_terminals(tmp_path):
    t_a = datetime(2024, 5, 1, 10, 0, 0)
    a = write_record(tmp_path / "a", "A", COLORS, t_a)
    b = write_record(tmp_path / "b", "B", COLORS, t_a)
    store = ComtradeStore()
    ma, mb = store.load_from_path(a), store.load_from_path(b)
    meta = merge_records(store, [{"id": ma.id, "label": "A"}, {"id": mb.id, "label": "B"}], "absolute", ma.id)
    ctx = store.context(meta.id)
    gid = {g["id"].split("|")[0] + g["quantity"]: g["id"] for g in ctx.data.groups}
    res = get_analysis("phasor_diagram").run(ctx, AnalysisRequest(
        time_s=0.2, voltage_group=gid["AV"], current_group=gid["AI"], inputs={"v2": gid["BV"], "i2": gid["BI"]}))
    assert res["terminals"] == {"1": "A", "2": "B"}
    second = [p for p in res["phasors"] if p["terminal"] == 2]
    assert {p["label"] for p in second} == {"Va′", "Vb′", "Vc′", "Ia′", "Ib′", "Ic′"}
    diffs = {d["label"]: d for d in res["extras"]["diffs"]}
    assert diffs["Va′ − Va"]["ratio"] == pytest.approx(1, abs=1e-3)
    assert diffs["Va′ − Va"]["dang"] == pytest.approx(0, abs=0.1)
    assert res["notes"] == []  # alinhado por horário (GPS)
