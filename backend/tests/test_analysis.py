"""Testes das análises com sinais sintéticos (executar: cd backend && python -m pytest)."""

from __future__ import annotations

import sys
from pathlib import Path
from types import SimpleNamespace

import numpy as np
import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from analysis import AnalysisContext, AnalysisRequest, RecordData, get_analysis  # noqa: E402
from analysis import dsp  # noqa: E402
from analysis.groups import detect_three_phase_groups, make_group  # noqa: E402

FS, F0 = 1999.9999, 60.0  # nº NÃO inteiro de amostras/ciclo (caso real)


def _sine(rms, ang_deg, n=4000, fs=FS):
    t = np.arange(n) / fs
    return rms * np.sqrt(2) * np.cos(2 * np.pi * F0 * t + np.radians(ang_deg))


@pytest.mark.parametrize("est", ["ls", "ls_dc", "ls_dcexp"])
def test_ls_estimators_exact(est):
    ph = dsp.phasor_series(_sine(100, 30), FS, F0, 1.0, est)
    tail = ph[200:]
    assert np.allclose(np.abs(tail), 100, rtol=1e-9)
    assert np.allclose(np.degrees(np.angle(tail)), 30, atol=1e-7)


def test_ls_dc_rejects_offset():
    x = _sine(100, -45) + 37.0
    ph = dsp.phasor_series(x, FS, F0, 1.0, "ls_dc")
    assert np.allclose(np.abs(ph[100:]), 100, rtol=1e-9)


def test_sequence_balanced():
    a = 1.0 + 0j
    b = a * np.exp(-2j * np.pi / 3)
    c = a * np.exp(2j * np.pi / 3)
    x0, x1, x2 = dsp.sequence_components(a, b, c)
    assert abs(x0) < 1e-12 and abs(x2) < 1e-12 and abs(x1 - 1) < 1e-12


def _ctx(v_rms=100e3, z=complex(3, 30), n=3000):
    """Sistema equilibrado com carga de impedância z por fase."""
    i_rms = v_rms / abs(z)
    zang = np.degrees(np.angle(z))
    sigs = []
    for k in range(3):
        sigs.append(_sine(v_rms, -120 * k, n))
    for k in range(3):
        sigs.append(_sine(i_rms, -120 * k - zang, n))
    chans = [
        SimpleNamespace(index=i, name=nm, unit=u, kind="analog", phase="", primary=1.0, secondary=1.0)
        for i, (nm, u) in enumerate([("VA", "V"), ("VB", "V"), ("VC", "V"), ("IA", "A"), ("IB", "A"), ("IC", "A")])
    ]
    meta = SimpleNamespace(sample_rate_hz=FS, frequency_hz=F0, analog_channels=chans)
    data = RecordData(meta=meta, time=np.arange(n) / FS, analog=sigs, digital=[],
                      auto_groups=detect_three_phase_groups(chans))
    return AnalysisContext(data), data


def test_group_detection():
    _, data = _ctx()
    qty = sorted(g["quantity"] for g in data.auto_groups)
    assert qty == ["I", "V"]


def test_impedance_balanced_load():
    ctx, data = _ctx(z=complex(3, 30))
    vg = next(g for g in data.groups if g["quantity"] == "V")["id"]
    ig = next(g for g in data.groups if g["quantity"] == "I")["id"]
    res = get_analysis("impedance").run(ctx, AnalysisRequest(
        voltage_group=vg, current_group=ig, t_start=0.2, t_end=1.0, time_s=0.5,
        params={"k0_mode": "none", "min_current": 1}))
    for loop in ("AG", "BG", "CG", "AB", "BC", "CA"):
        r = res["cursor"]["loops"][loop]
        assert r["r"] == pytest.approx(3, rel=1e-6)
        assert r["x"] == pytest.approx(30, rel=1e-6)


def test_phasor_diagram_reference():
    ctx, data = _ctx()
    vg = next(g for g in data.groups if g["quantity"] == "V")["id"]
    res = get_analysis("phasor_diagram").run(ctx, AnalysisRequest(time_s=0.5, voltage_group=vg, params={}))
    angs = {p["label"]: p["ang"] for p in res["phasors"]}
    assert angs["Va"] == pytest.approx(0, abs=1e-6)
    assert angs["Vb"] == pytest.approx(-120, abs=1e-6)


def test_manual_group_ids():
    g = make_group("V", "LT 1", 0, 1, 2)
    assert g["id"].startswith("M:") and g["source"] == "manual"


def test_phasors_at_matches_full_series():
    x = _sine(100, 10, n=5000) + 3 * _sine(5, 0, n=5000) ** 2 / 100
    full = dsp.phasor_series(x, FS, F0, 1.0, "ls", first_sample=0)
    ends = np.arange(0, 5000, 37)
    sub = dsp.phasors_at(x, ends, FS, F0, 1.0, "ls", first_sample=0)
    ok = np.isfinite(full[ends])
    assert np.allclose(sub[ok], full[ends][ok])
    assert np.all(~np.isfinite(sub[~ok]))


def test_binary_reader_roundtrip(tmp_path):
    from comtrade_reader import read_record

    na, ns, n, fs = 3, 20, 500, 4000
    lines = ["SUB,IED,1999", f"{na + ns},{na}A,{ns}D"]
    for i in range(na):
        lines.append(f"{i + 1},CH{i},{'ABC'[i]},,V,0.5,1.0,0,-32767,32767,1000,1,S")
    for j in range(ns):
        lines.append(f"{j + 1},D{j},,,0")
    lines += ["60", "1", f"{fs},{n}", "01/01/2026,00:00:00.000000", "01/01/2026,00:00:00.000000", "BINARY", "1"]
    (tmp_path / "r.cfg").write_text("\r\n".join(lines) + "\r\n")
    dt = np.dtype([("n", "<u4"), ("ts", "<u4"), ("a", "<i2", (na,)), ("d", "<u2", (2,))])
    arr = np.zeros(n, dt)
    arr["n"] = np.arange(1, n + 1)
    arr["a"][:, 0] = np.arange(n)
    arr["a"][:, 1] = -32768  # amostra ausente
    arr["d"][:, 1] = 0b1000  # canal digital 16+3 = índice 19
    (tmp_path / "r.dat").write_bytes(arr.tobytes())

    rec = read_record(tmp_path / "r.cfg", tmp_path / "r.dat")
    assert len(rec.time) == n and rec.sample_rate == fs
    assert np.allclose(rec.time[:3], [0, 1 / fs, 2 / fs])
    assert np.allclose(np.asarray(rec.analog[0][:5]), np.arange(5) * 0.5 + 1.0)
    assert np.all(np.isnan(np.asarray(rec.analog[1][:10])))
    assert rec.status[19][:].tolist() == [1] * n and rec.status[18][:].sum() == 0
