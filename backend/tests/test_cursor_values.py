"""Valor no cursor: RMS verdadeiro, RMS fundamental e instantâneo (janela causal de 1 ciclo)."""

from __future__ import annotations

import sys
from pathlib import Path

import numpy as np
import pytest
from fastapi import HTTPException

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from analysis.cursor_values import fund_rms_at, true_rms_at, value_at  # noqa: E402
from comtrade_service import ComtradeStore  # noqa: E402

F0 = 60.0
A1 = 100.0  # RMS da fundamental
A3 = 20.0   # RMS do 3º harmônico
TRUE = float(np.hypot(A1, A3))


def _signal(fs: float, phase: float = 0.3, seconds: float = 0.5) -> np.ndarray:
    t = np.arange(int(fs * seconds)) / fs
    return (A1 * np.sqrt(2) * np.sin(2 * np.pi * F0 * t + phase)
            + A3 * np.sqrt(2) * np.sin(2 * np.pi * 3 * F0 * t + 2 * phase))


@pytest.mark.parametrize("phase", np.linspace(0, 2 * np.pi, 7))
def test_integer_samples_per_cycle_is_exact(phase):
    fs = 1920.0  # 32 amostras/ciclo
    x = _signal(fs, phase)
    assert true_rms_at(x, 400, fs, F0) == pytest.approx(TRUE, rel=1e-9)
    assert fund_rms_at(x, 400, fs, F0) == pytest.approx(A1, rel=1e-9)
    assert value_at(x, 400, fs, F0, "inst") == pytest.approx(x[400])


@pytest.mark.parametrize("fs", [2000.0, 1000.0, 15360.0 / 7])  # fs/f0 = 33,33 / 16,67 / 36,57
def test_non_integer_samples_per_cycle(fs):
    for phase in np.linspace(0, 2 * np.pi, 9):
        x = _signal(fs, phase)
        k = len(x) - 7
        assert true_rms_at(x, k, fs, F0) == pytest.approx(TRUE, rel=5e-3)
        # LS na frequência nominal: exato para senoide pura, pequeno vazamento do harmônico
        assert fund_rms_at(x, k, fs, F0) == pytest.approx(A1, rel=1e-2)
        pure = A1 * np.sqrt(2) * np.sin(2 * np.pi * F0 * np.arange(len(x)) / fs + phase)
        assert fund_rms_at(pure, k, fs, F0) == pytest.approx(A1, rel=1e-9)
        assert true_rms_at(pure, k, fs, F0) == pytest.approx(A1, rel=5e-3)


def test_fractional_weight_uses_previous_sample():
    # fs/f0 = 2,5 → pesos 0,5·x[k-2]² + x[k-1]² + x[k]², dividido por 2,5
    x = np.array([10.0, 2.0, 3.0, 4.0])
    expected = np.sqrt((0.5 * 2.0**2 + 3.0**2 + 4.0**2) / 2.5)
    assert true_rms_at(x, 3, 150.0, 60.0) == pytest.approx(expected)


def test_incomplete_window_and_nan_return_none():
    fs = 2000.0
    x = _signal(fs)
    assert true_rms_at(x, 10, fs, F0) is None
    assert fund_rms_at(x, 10, fs, F0) is None
    assert true_rms_at(x, 33, fs, F0) == pytest.approx(TRUE, rel=1e-2)  # primeira janela completa (m+1 = 34 amostras)
    y = x.copy()
    y[100] = np.nan
    assert true_rms_at(y, 110, fs, F0) is None
    assert value_at(y, 100, fs, F0, "inst") is None
    with pytest.raises(ValueError):
        value_at(x, 100, fs, F0, "bogus")


def _write_record(folder: Path, fs: float = 2000.0) -> Path:
    """COMTRADE ASCII com 1 analógico (fundamental + 3º harmônico) e 1 digital."""
    x = _signal(fs, seconds=0.2)
    n = len(x)
    lines = ["ST_X,DEV_X,1999", "2,1A,1D", "1,IA LT,A,,A,0.001,0,0,-999999,999999,1,1,P",
             "1,TRIP,,,0", f"{F0:g}", "1", f"{fs:g},{n}", "01/11/2026,10:00:00.000000",
             "01/11/2026,10:00:00.050000", "ASCII", "1"]
    folder.mkdir(parents=True, exist_ok=True)
    (folder / "X.cfg").write_bytes(("\r\n".join(lines) + "\r\n").encode("ascii"))
    with (folder / "X.dat").open("w", newline="\r\n") as fh:
        for k in range(n):
            fh.write(f"{k + 1},{int(round(k * 1e6 / fs))},{int(round(x[k] / 0.001))},{1 if k >= n // 2 else 0}\n")
    return folder / "X.cfg"


def test_store_modes_and_multiple_times(tmp_path):
    store = ComtradeStore()
    meta = store.load_from_path(_write_record(tmp_path))
    dig = meta.digital_channels[0].index
    res = store.get_value_at_time(meta.id, [0, dig], times=[0.001, 0.15], mode="true_rms")
    assert res["mode"] == "true_rms" and len(res["points"]) == 2
    early, late = res["points"]
    assert early["channels"][0]["value"] is None  # janela incompleta → "—"
    assert late["channels"][0]["value"] == pytest.approx(TRUE, rel=1e-2)
    assert late["channels"][1]["kind"] == "digital" and late["channels"][1]["value"] == 1.0
    fund = store.get_value_at_time(meta.id, [0], times=[0.15], mode="fund")
    assert fund["points"][0]["channels"][0]["value"] == pytest.approx(A1, rel=1e-2)
    inst = store.get_value_at_time(meta.id, [0], 0.15)  # compatível: time_s e modo instantâneo
    assert inst["channels"][0]["value"] == pytest.approx(_signal(2000.0)[300], abs=2e-3)
    with pytest.raises(ValueError):
        store.get_value_at_time(meta.id, [0], 0.1, mode="peak")


def test_endpoint_mode_param(tmp_path):
    import main

    meta = main.store.load_from_path(_write_record(tmp_path))
    res = main.get_value_at_time(meta.id, channels="0", time_s=None, times="0.1,0.15", mode="fund")
    assert [p["time_s"] for p in res["points"]] == pytest.approx([0.1, 0.15])
    with pytest.raises(HTTPException) as exc:
        main.get_value_at_time(meta.id, channels="0", time_s=0.1, times=None, mode="peak")
    assert exc.value.status_code == 400
