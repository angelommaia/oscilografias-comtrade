"""Valor de um canal analógico no cursor: instantâneo, RMS verdadeiro ou RMS
da fundamental.

Convenções (as mesmas dos fasores, ver ``dsp``):

* Janela **causal** de 1 ciclo nominal terminando na amostra do cursor.
* N = fs/f0 pode não ser inteiro. RMS verdadeiro: as m = ⌊N⌋ amostras mais
  recentes têm peso 1 e a amostra anterior a elas tem peso (N − m), de modo
  que a soma dos pesos é exatamente N (regra do retângulo com borda
  fracionária). Para N inteiro isso se reduz à média simples.
* RMS fundamental: módulo do fasor RMS do estimador de mínimos quadrados
  (``dsp.phasor_at``), que é exato para N não inteiro.
* Janela incompleta (início do registro) ou com amostra inválida → ``None``
  (a interface mostra "—").

Limite conhecido: a janela é de 1 ciclo **nominal**. Se a frequência real se
afasta de f0, a janela deixa de conter um número inteiro de ciclos e o RMS
verdadeiro passa a ondular com o dobro da frequência (amplitude relativa da
ordem de ±|Δf|/(2·f0): ±0,8 % a 59/61 Hz, ±2,5 % a 57/63 Hz num sistema de 60 Hz).
O RMS fundamental (LS na frequência nominal) ondula na mesma ordem.
"""

from __future__ import annotations

import math
from typing import Sequence

import numpy as np

from . import dsp

MODES = ("true_rms", "fund", "inst")
DEFAULT_MODE = "true_rms"


def _window(signal: Sequence[float], end: int, n: float) -> tuple[np.ndarray, float] | None:
    """Amostras [end-m … end] (m+1 valores: a primeira é a de peso fracionário)."""
    if n <= 0 or end < 0 or end >= len(signal):
        return None
    m = int(math.floor(n + 1e-9))
    frac = n - m
    if frac < 1e-9:
        frac = 0.0
    first = end - m + (0 if frac > 0 else 1)
    if first < 0 or m < 1:
        return None
    seg = np.asarray(signal[first : end + 1], dtype=float)
    if not np.all(np.isfinite(seg)):
        return None
    return seg, frac


def true_rms_at(signal: Sequence[float], end: int, fs: float, f0: float) -> float | None:
    """RMS verdadeiro em 1 ciclo nominal terminando na amostra ``end``."""
    if not (fs > 0 and f0 > 0):
        return None
    n = fs / f0
    win = _window(signal, end, n)
    if win is None:
        return None
    seg, frac = win
    sq = seg * seg
    total = sq.sum() if frac == 0.0 else sq[1:].sum() + frac * sq[0]
    return float(math.sqrt(max(total, 0.0) / n))


def fund_rms_at(signal: Sequence[float], end: int, fs: float, f0: float, estimator: str = "ls") -> float | None:
    """|fasor RMS| da fundamental (mínimos quadrados, 1 ciclo, causal)."""
    if not (fs > 0 and f0 > 0):
        return None
    n = dsp.window_length(fs, f0, 1.0)
    start = end - n + 1
    if start < 0 or end >= len(signal):
        return None
    seg = np.asarray(signal[start : end + 1], dtype=float)
    if not np.all(np.isfinite(seg)):
        return None
    ph = dsp.phasor_at(seg, n - 1, fs, f0, 1.0, estimator)
    return float(abs(ph)) if np.isfinite(ph) else None


def value_at(signal: Sequence[float], index: int, fs: float, f0: float, mode: str = DEFAULT_MODE) -> float | None:
    if mode == "inst":
        if index < 0 or index >= len(signal):
            return None
        v = float(signal[index])
        return v if math.isfinite(v) else None
    if mode == "fund":
        return fund_rms_at(signal, index, fs, f0)
    if mode == "true_rms":
        return true_rms_at(signal, index, fs, f0)
    raise ValueError(f"Modo de valor desconhecido: {mode}")
