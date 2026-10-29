"""Validação das funções de proteção com sinais sintéticos de resposta conhecida."""

from __future__ import annotations

import sys
from pathlib import Path
from types import SimpleNamespace

import numpy as np
import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

import protection  # noqa: E402,F401
from analysis import AnalysisContext, AnalysisRequest, RecordData, get_analysis  # noqa: E402
from analysis.groups import make_group  # noqa: E402
from protection.common import curve_time, points_in_polygon  # noqa: E402
from protection.differential import compensation_matrix  # noqa: E402

FS, F0 = 4000.0, 60.0
A = np.exp(2j * np.pi / 3)


def _wave(ph: np.ndarray, t: np.ndarray) -> np.ndarray:
    """Fasor RMS (array por amostra) → sinal instantâneo."""
    return np.real(np.sqrt(2) * ph * np.exp(1j * 2 * np.pi * F0 * t))


def _make_ctx(signals: dict[str, np.ndarray], groups: dict[str, tuple[str, list[str]]], ratios=None):
    names = list(signals)
    chans = []
    for i, nm in enumerate(names):
        prim, sec = (ratios or {}).get(nm, (1000.0, 1.0))
        unit = "V" if nm.startswith("v") else "A"
        chans.append(SimpleNamespace(index=i, name=nm, unit=unit, kind="analog", phase="", primary=prim, secondary=sec))
    n = len(next(iter(signals.values())))
    meta = SimpleNamespace(sample_rate_hz=FS, frequency_hz=F0, analog_channels=chans)
    gl = [make_group(q, label, *[names.index(c) for c in cols], source="auto") for label, (q, cols) in groups.items()]
    data = RecordData(meta=meta, time=np.arange(n) / FS, analog=[signals[k] for k in names], digital=[], auto_groups=gl)
    ids = {g["label"]: g["id"] for g in gl}
    return AnalysisContext(data), ids


# ---------------------------------------------------------------------------
def test_point_in_polygon_square():
    sq = np.array([0, 1, 1 + 1j, 1j])
    z = np.array([0.5 + 0.5j, 1.5 + 0.5j, np.nan])
    assert points_in_polygon(z, sq).tolist() == [True, False, False]


def test_iec_curve_value():
    # IEC SI, TMS 0.2, M = 5 → 0.2·0.14/(5^0.02 − 1)
    assert curve_time("IEC_SI", np.array([5.0]), 0.2)[0] == pytest.approx(0.2 * 0.14 / (5**0.02 - 1))


# ---------------------------------------------------------------------------
def _ground_fault_case(m=0.5, t_fault=0.2, dur=0.6):
    """Falta AG a m·Z1 da linha (k0 da linha), carga pré-falta."""
    z1, z0 = complex(2, 20), complex(6, 65)
    k0 = (z0 - z1) / (3 * z1)
    t = np.arange(int(dur * FS)) / FS
    vn = 100e3
    fault = t >= t_fault
    ia = np.where(fault, 2000 * np.exp(-1j * np.radians(80)), 300 * np.exp(-1j * np.radians(10)))
    ib = np.where(fault, 0, 300 * A**2 * np.exp(-1j * np.radians(10)))
    ic = np.where(fault, 0, 300 * A * np.exp(-1j * np.radians(10)))
    ires = ia + ib + ic
    va = np.where(fault, m * z1 * (ia + k0 * ires), vn)
    vb = np.full(len(t), vn * A**2, dtype=complex)
    vc = np.full(len(t), vn * A, dtype=complex)
    sig = {k: _wave(v, t) for k, v in dict(va=va, vb=vb, vc=vc, ia=ia, ib=ib, ic=ic).items()}
    ctx, ids = _make_ctx(sig, {"V": ("V", ["va", "vb", "vc"]), "I": ("I", ["ia", "ib", "ic"])})
    return ctx, ids, z1, z0


def test_distance_ground_fault_zone1():
    ctx, ids, z1, z0 = _ground_fault_case(m=0.5)
    params = {"side": "primary", "r1": z1.real, "x1": z1.imag, "r0": z0.real, "x0": z0.imag, "reach_unit": "pct"}
    res = get_analysis("prot_distance").run(ctx, AnalysisRequest(inputs={"v": ids["V"], "i": ids["I"]}, params=params, time_s=0.5))
    zag = res["cursor"]["loops"]["AG"]
    assert zag["r"] == pytest.approx(0.5 * z1.real, rel=1e-3)
    assert zag["x"] == pytest.approx(0.5 * z1.imag, rel=1e-3)
    s = {row["element"]: row for row in res["summary"]}
    assert s["Z1"]["trip_t"] == pytest.approx(0.2, abs=1 / F0 + 1e-3)  # 1 ciclo de janela
    assert s["Z1"]["detail"] == "AG"
    assert s["Z2"]["trip_t"] == pytest.approx(0.2 + 0.4, abs=1 / F0 + 1e-3) or s["Z2"]["trip_t"] is None


def test_distance_fault_beyond_zone1_quad():
    ctx, ids, z1, z0 = _ground_fault_case(m=1.0)  # no fim da linha: fora da Z1 (80%)
    params = {"side": "primary", "r1": z1.real, "x1": z1.imag, "r0": z0.real, "x0": z0.imag,
              "reach_unit": "pct", "z1_shape": "quad", "z2_shape": "quad", "z1_rg": 5, "z2_rg": 5}
    res = get_analysis("prot_distance").run(ctx, AnalysisRequest(inputs={"v": ids["V"], "i": ids["I"]}, params=params))
    s = {row["element"]: row for row in res["summary"]}
    assert s["Z1"]["pickup_t"] is None
    assert s["Z2"]["pickup_t"] == pytest.approx(0.2, abs=1 / F0 + 1e-3)


def test_distance_krkx_equivalent_when_angles_equal():
    # Z0 com mesmo ângulo de Z1 → k0 real e RE/RL = XE/XL = k0
    ctx, ids, z1, _ = _ground_fault_case(m=0.5)
    z0 = 3 * z1
    k = ((z0 - z1) / (3 * z1)).real
    base = {"side": "primary", "r1": z1.real, "x1": z1.imag, "r0": z0.real, "x0": z0.imag}
    a = get_analysis("prot_distance").run(ctx, AnalysisRequest(inputs={"v": ids["V"], "i": ids["I"]}, params=base, time_s=0.5))
    b = get_analysis("prot_distance").run(ctx, AnalysisRequest(inputs={"v": ids["V"], "i": ids["I"]},
                                                               params={**base, "k0_mode": "krkx", "kr": k, "kx": k}, time_s=0.5))
    assert a["cursor"]["loops"]["AG"]["x"] == pytest.approx(b["cursor"]["loops"]["AG"]["x"], rel=1e-9)


# ---------------------------------------------------------------------------
def test_compensation_matrix_dy1_matches_standard():
    # matrizes padrão (IEEE C37.91 / CTC(k))
    assert np.allclose(compensation_matrix(1, True), np.array([[1, -1, 0], [0, 1, -1], [-1, 0, 1]]) / np.sqrt(3))
    assert np.allclose(compensation_matrix(0, True), np.array([[2, -1, -1], [-1, 2, -1], [-1, -1, 2]]) / 3)
    assert np.allclose(compensation_matrix(0, False), np.eye(3))


def _transformer_case(kind: str):
    """Dy1 300 MVA 500/230 kV. kind: 'through' | 'internal' | 'inrush'."""
    t = np.arange(int(0.5 * FS)) / FS
    s, v1, v2 = 300e6, 500e3, 230e3
    in1, in2 = s / (np.sqrt(3) * v1), s / (np.sqrt(3) * v2)
    i1pu = 1.0 * np.exp(-1j * np.radians(20))
    w1 = np.array([i1pu, i1pu * A**2, i1pu * A]) * in1
    # W2 (lado delta, Dy1 → atrasa 30°), saindo do trafo; TC apontando para o trafo → sinal −
    w2 = -np.array([i1pu, i1pu * A**2, i1pu * A]) * np.exp(-1j * np.pi / 6) * in2
    sig = {}
    for k, ph in enumerate("abc"):
        x1 = np.full(len(t), w1[k])
        x2 = np.full(len(t), w2[k])
        if kind == "internal":
            x1 = np.where(t >= 0.2, x1 * 6, x1)
        sig[f"i1{ph}"] = _wave(x1, t)
        sig[f"i2{ph}"] = _wave(x2, t)
        if kind == "inrush":
            # 2ª harmônica com defasagem por fase (não é seq. zero, sobrevive à eliminação de I0)
            h2 = np.real(np.sqrt(2) * 0.4 * 3 * in1 * A ** (k) * np.exp(1j * 2 * 2 * np.pi * F0 * t))
            sig[f"i1{ph}"] = np.where(t >= 0.2, _wave(np.full(len(t), 3 * in1 * A ** (-k)), t) + h2, sig[f"i1{ph}"])
    ctx, ids = _make_ctx(sig, {"W1": ("I", ["i1a", "i1b", "i1c"]), "W2": ("I", ["i2a", "i2b", "i2c"])})
    return ctx, ids


@pytest.mark.parametrize("clock_ok", [True])
def test_differential_through_load_is_balanced(clock_ok):
    ctx, ids = _transformer_case("through")
    res = get_analysis("prot_differential").run(ctx, AnalysisRequest(
        inputs={"w1": ids["W1"], "w2": ids["W2"]}, params={"v1_kv": 500, "v2_kv": 230, "clock2": "1"}, time_s=0.3))
    for ph in "ABC":
        assert res["cursor"]["loops"][ph]["x"] < 0.02  # Idiff ≈ 0 pu
        assert res["cursor"]["loops"][ph]["r"] == pytest.approx(2.0, rel=0.02)  # Σ|I| = 2 pu
    assert all(row["trip_t"] is None for row in res["summary"])


def test_differential_wrong_clock_trips():
    ctx, ids = _transformer_case("through")
    res = get_analysis("prot_differential").run(ctx, AnalysisRequest(
        inputs={"w1": ids["W1"], "w2": ids["W2"]}, params={"v1_kv": 500, "v2_kv": 230, "clock2": "0"}))
    assert any(row["trip_t"] is not None for row in res["summary"])  # 30° de erro → Idiff ≈ 0,52 pu


def test_differential_internal_fault_trips():
    ctx, ids = _transformer_case("internal")
    res = get_analysis("prot_differential").run(ctx, AnalysisRequest(
        inputs={"w1": ids["W1"], "w2": ids["W2"]}, params={"v1_kv": 500, "v2_kv": 230, "clock2": "1"}))
    s = {row["element"]: row for row in res["summary"]}
    assert s["87 fase A"]["trip_t"] == pytest.approx(0.2, abs=1 / F0 + 1e-3)


def test_differential_inrush_blocked_by_2nd_harmonic():
    ctx, ids = _transformer_case("inrush")
    req = AnalysisRequest(inputs={"w1": ids["W1"], "w2": ids["W2"]}, params={"v1_kv": 500, "v2_kv": 230, "clock2": "1"})
    res = get_analysis("prot_differential").run(ctx, req)
    lanes = {ln["id"]: ln for ln in res["lanes"]}
    assert lanes["op_A"]["intervals"] and lanes["b2_A"]["intervals"]
    assert not lanes["trip"]["intervals"]
    res_off = get_analysis("prot_differential").run(ctx, AnalysisRequest(
        inputs=req.inputs, params={**req.params, "h2_on": False}))
    assert {ln["id"]: ln for ln in res_off["lanes"]}["trip"]["intervals"]


# ---------------------------------------------------------------------------
def test_overcurrent_inverse_time():
    t = np.arange(int(2.0 * FS)) / FS
    i_rms = np.where(t >= 0.2, 5 * 1.2 * 1000, 200.0)  # 5× pickup (pickup = 1,2 × In, In = 1000 A)
    sig = {"ia": _wave(i_rms + 0j, t), "ib": _wave(i_rms * A**2, t), "ic": _wave(i_rms * A, t)}
    ctx, ids = _make_ctx(sig, {"I": ("I", ["ia", "ib", "ic"])})
    res = get_analysis("prot_overcurrent").run(ctx, AnalysisRequest(inputs={"i": ids["I"]}, params={"s2_on": False, "s3_on": False}))
    row = res["summary"][0]
    expected = 0.2 * 0.14 / (5**0.02 - 1)
    assert row["trip_t"] - 0.2 == pytest.approx(expected, abs=0.03)


def test_power_swing_slow_vs_fast():
    t = np.arange(int(2.0 * FS)) / FS
    v = 100e3
    # trajetória lenta de R = +80 Ω a −80 Ω em 1 s, X = 10 Ω (oscilação); corrente 1 kA
    zt = np.interp(t, [0, 0.5, 1.5, 2.0], [80, 80, -80, -80]) + 10j
    i = np.full(len(t), 1000.0 + 0j)
    va = zt * i
    sig = {"va": _wave(va, t), "vb": _wave(va * A**2, t), "vc": _wave(va * A, t),
           "ia": _wave(i, t), "ib": _wave(i * A**2, t), "ic": _wave(i * A, t)}
    ctx, ids = _make_ctx(sig, {"V": ("V", ["va", "vb", "vc"]), "I": ("I", ["ia", "ib", "ic"])})
    res = get_analysis("prot_power_swing").run(ctx, AnalysisRequest(inputs={"v": ids["V"], "i": ids["I"]}, params={"side": "primary"}))
    kinds = [c["kind"] for c in res["crossings"]]
    assert "oscilação" in kinds and "perda de sincronismo" in kinds
    del v
