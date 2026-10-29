"""As oscilografias de exemplo (sintéticas) devem continuar demonstrando o que prometem."""

from __future__ import annotations

import sys
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

import protection  # noqa: E402,F401
from analysis import AnalysisRequest, get_analysis  # noqa: E402
from comtrade_service import ComtradeStore  # noqa: E402

SAMPLES = Path(__file__).resolve().parents[2] / "samples"
P87 = {"s_mva": 150, "v1_kv": 500, "v2_kv": 34.5, "clock2": "1"}


def _ctx(name: str):
    store = ComtradeStore()
    meta = store.load_from_path(SAMPLES / name / "registro.cfg")
    ctx = store.context(meta.id)
    return ctx, {g["a"]: g["id"] for g in ctx.data.groups}


def _trips(result) -> list:
    return [row["trip_t"] for row in result["summary"] if row["trip_t"] is not None]


@pytest.mark.parametrize("name,analogs,digitals", [
    ("demo_falta_transformador", 42, 128),
    ("demo_87t_exportacao", 25, 115),
    ("demo_87t_diferencial", 41, 45),
    ("demo_oscilacao_potencia", 8, 16),
])
def test_structure(name, analogs, digitals):
    ctx, groups = _ctx(name)
    assert len(ctx.meta.analog_channels) == analogs
    assert len(ctx.meta.digital_channels) == digitals
    assert groups, "grupos trifásicos devem ser detectados automaticamente"


def test_internal_fault_trips():
    ctx, g = _ctx("demo_falta_transformador")
    res = get_analysis("prot_differential").run(ctx, AnalysisRequest(inputs={"w1": g[7], "w2": g[14]}, params=P87, t_start=2.8, t_end=3.4))
    assert min(_trips(res)) == pytest.approx(3.01, abs=0.02)


def test_external_fault_is_stable():
    ctx, g = _ctx("demo_87t_exportacao")
    res = get_analysis("prot_differential").run(ctx, AnalysisRequest(inputs={"w1": g[8], "w2": g[15]}, params=P87, t_start=2.8, t_end=3.4))
    assert _trips(res) == []


def test_inrush_blocked_then_fault_trips():
    ctx, g = _ctx("demo_87t_diferencial")
    res = get_analysis("prot_differential").run(ctx, AnalysisRequest(inputs={"w1": g[8], "w2": g[12]}, params={"base": "tc"}))
    trips = _trips(res)
    assert trips and min(trips) > 1.8  # nada durante a energização (0,3 s)
    lanes = {ln["id"]: ln["intervals"] for ln in res["lanes"]}
    assert lanes["b2_A"] and lanes["b2_A"][0][0] < 0.35


def test_power_swing_then_out_of_step():
    ctx, g = _ctx("demo_oscilacao_potencia")
    res = get_analysis("prot_power_swing").run(ctx, AnalysisRequest(inputs={"v": g[0], "i": g[3]}, params={}))
    kinds = [c["kind"] for c in res["crossings"]]
    assert "oscilação" in kinds and "perda de sincronismo" in kinds
