"""Estimação fasorial vetorizada (numpy) com estimadores plugáveis.

Convenção adotada em todo o sistema
-----------------------------------
* Fasores em **valor eficaz (RMS)**: x(t) = √2·|X|·cos(ωt + ∠X).
* Janela **causal**: o fasor no instante k usa as amostras [k-N+1 … k]
  (o mesmo que um relé enxergaria naquele instante).
* Referência angular **absoluta** (t = 0 do registro). Com isso um sinal
  senoidal na frequência nominal produz um fasor parado; o ângulo relativo
  entre grandezas é obtido subtraindo a referência escolhida (ex.: Va).

Para adicionar um estimador novo basta registrar uma função que receba
(N, ω·Ts) e devolva os filtros FIR (h_cos, h_sin) de comprimento N:

    @register_estimator("meu_filtro", "Descrição")
    def _meu(n, w_ts):
        ...
        return h_re, h_im
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Callable

import numpy as np
from numpy.lib.stride_tricks import sliding_window_view

FilterBuilder = Callable[[int, float], tuple[np.ndarray, np.ndarray]]


@dataclass(frozen=True)
class Estimator:
    id: str
    name: str
    description: str
    build: FilterBuilder


_ESTIMATORS: dict[str, Estimator] = {}


def register_estimator(estimator_id: str, name: str, description: str = ""):
    def deco(fn: FilterBuilder) -> FilterBuilder:
        _ESTIMATORS[estimator_id] = Estimator(estimator_id, name, description, fn)
        return fn

    return deco


def list_estimators() -> list[dict[str, str]]:
    return [{"id": e.id, "name": e.name, "description": e.description} for e in _ESTIMATORS.values()]


def get_estimator(estimator_id: str) -> Estimator:
    try:
        return _ESTIMATORS[estimator_id]
    except KeyError as exc:
        raise ValueError(f"Estimador desconhecido: {estimator_id}") from exc


def _ls_filters(n: int, w_ts: float, extra_cols: list[np.ndarray]) -> tuple[np.ndarray, np.ndarray]:
    t = np.arange(n, dtype=float)
    cols = [np.cos(w_ts * t), -np.sin(w_ts * t), *extra_cols]
    a = np.column_stack(cols)
    pinv = np.linalg.pinv(a)  # (k, n)
    # x(n) ≈ √2·Re(X·e^{jωn}) = √2·(Xr·cos − Xi·sin)  → coeficientes/√2
    return pinv[0] / np.sqrt(2.0), pinv[1] / np.sqrt(2.0)


@register_estimator(
    "ls",
    "Mínimos quadrados (cos/sen)",
    "Ajuste senoidal na frequência nominal. Exato mesmo com nº não inteiro de amostras por ciclo.",
)
def _ls(n: int, w_ts: float):
    return _ls_filters(n, w_ts, [])


@register_estimator(
    "ls_dc",
    "Mínimos quadrados + DC",
    "Inclui termo constante no ajuste: rejeita offset DC (componente aperiódica lenta).",
)
def _ls_dc(n: int, w_ts: float):
    return _ls_filters(n, w_ts, [np.ones(n)])


@register_estimator(
    "ls_dcexp",
    "Mínimos quadrados + DC + rampa",
    "Ajuste com termo constante e linear: aproxima a componente DC decrescente de faltas.",
)
def _ls_dcexp(n: int, w_ts: float):
    t = np.arange(n, dtype=float)
    return _ls_filters(n, w_ts, [np.ones(n), t / max(n - 1, 1)])


@register_estimator(
    "dft",
    "DFT de Fourier (clássica)",
    "DFT de 1 componente sobre N = round(ciclos·fs/f0) amostras. Pode ter erro de vazamento se fs/f0 não for inteiro.",
)
def _dft(n: int, w_ts: float):
    t = np.arange(n, dtype=float)
    k = np.sqrt(2.0) / n
    return k * np.cos(w_ts * t), -k * np.sin(w_ts * t)


def window_length(fs: float, f0: float, window_cycles: float) -> int:
    return max(int(round(window_cycles * fs / f0)), 3)


def phasor_series(
    signal: np.ndarray,
    fs: float,
    f0: float,
    window_cycles: float = 1.0,
    estimator: str = "ls",
    first_sample: int = 0,
) -> np.ndarray:
    """Série de fasores RMS (complexo) para cada amostra do sinal.

    `first_sample` é o índice absoluto da primeira amostra de `signal` no
    registro, usado para manter a referência angular absoluta.
    Amostras sem janela completa recebem NaN.
    """
    x = np.asarray(signal, dtype=float)
    n = window_length(fs, f0, window_cycles)
    out = np.full(len(x), np.nan + 1j * np.nan, dtype=complex)
    if len(x) < n:
        return out

    w_ts = 2.0 * np.pi * f0 / fs
    h_re, h_im = get_estimator(estimator).build(n, w_ts)
    windows = sliding_window_view(x, n)  # (L-n+1, n) – sem cópia
    local = windows @ h_re + 1j * (windows @ h_im)

    # Fasor local referido ao início da janela → referência absoluta
    starts = first_sample + np.arange(len(local), dtype=float)
    out[n - 1 :] = local * np.exp(-1j * w_ts * starts)
    return out


def phasors_at(
    signal: np.ndarray,
    ends: np.ndarray,
    fs: float,
    f0: float,
    window_cycles: float = 1.0,
    estimator: str = "ls",
    first_sample: int = 0,
) -> np.ndarray:
    """Fasores RMS apenas nas amostras `ends` (índices relativos a `signal`,
    fim de janela). Usado quando o intervalo é longo e só alguns pontos serão
    desenhados – custo proporcional ao nº de pontos, não ao de amostras."""
    x = np.asarray(signal)
    n = window_length(fs, f0, window_cycles)
    ends = np.asarray(ends, dtype=np.int64)
    out = np.full(len(ends), np.nan + 1j * np.nan, dtype=complex)
    ok = (ends >= n - 1) & (ends < len(x))
    if not ok.any() or len(x) < n:
        return out
    w_ts = 2.0 * np.pi * f0 / fs
    h_re, h_im = get_estimator(estimator).build(n, w_ts)
    rows = ends[ok] - (n - 1)
    windows = sliding_window_view(x, n)[rows].astype(float)
    local = windows @ h_re + 1j * (windows @ h_im)
    out[ok] = local * np.exp(-1j * w_ts * (first_sample + rows))
    return out


def phasor_at(
    signal: np.ndarray,
    end_index: int,
    fs: float,
    f0: float,
    window_cycles: float = 1.0,
    estimator: str = "ls",
) -> complex:
    """Fasor RMS para a janela que termina em `end_index` (inclusive)."""
    n = window_length(fs, f0, window_cycles)
    start = end_index - n + 1
    if start < 0 or end_index >= len(signal):
        return complex(np.nan, np.nan)
    seg = np.asarray(signal[start : end_index + 1], dtype=float)
    w_ts = 2.0 * np.pi * f0 / fs
    h_re, h_im = get_estimator(estimator).build(n, w_ts)
    local = seg @ h_re + 1j * (seg @ h_im)
    return complex(local * np.exp(-1j * w_ts * start))


# --------------------------------------------------------------------------
# Componentes simétricas
# --------------------------------------------------------------------------
A_OP = np.exp(1j * 2.0 * np.pi / 3.0)


def sequence_components(xa, xb, xc):
    """Retorna (X0, X1, X2) – aceita escalares ou arrays complexos."""
    x0 = (xa + xb + xc) / 3.0
    x1 = (xa + A_OP * xb + A_OP**2 * xc) / 3.0
    x2 = (xa + A_OP**2 * xb + A_OP * xc) / 3.0
    return x0, x1, x2


def wrap_deg(angle):
    return (np.asarray(angle) + 180.0) % 360.0 - 180.0
