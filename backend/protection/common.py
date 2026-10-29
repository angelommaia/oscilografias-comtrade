"""Ferramentas comuns das funções de proteção.

* Geometria no plano complexo: características viram POLÍGONOS. O mesmo
  polígono é usado para desenhar e para testar se o ponto está dentro, de
  modo que gráfico e simulação nunca divergem.
* Temporizadores: partida/trip a partir de máscaras booleanas no tempo.
* Curvas de tempo inverso (IEC 60255-151 / IEEE C37.112) com integração.
* Estimação multi-harmônica por mínimos quadrados (2ª/5ª para 87T).
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Any

import numpy as np
from numpy.lib.stride_tricks import sliding_window_view

from analysis.context import AnalysisContext, plot_step
from analysis.dsp import window_length
from analysis.registry import AnalysisRequest, Param

BIG = 1e9

# ---------------------------------------------------------------------------
# Entradas / intervalo de avaliação
# ---------------------------------------------------------------------------
EVAL_MAX_POINTS = 20_000  # resolução máxima da simulação em intervalos longos


def eval_range(ctx: AnalysisContext, req: AnalysisRequest) -> tuple[int, int, int]:
    """(i0, i1, passo) do intervalo de avaliação."""
    i0, i1 = ctx.range_indices(req.t_start, req.t_end)
    step = plot_step(i1 - i0 + 1, EVAL_MAX_POINTS)
    return i0, i1, step


def group_input(ctx: AnalysisContext, req: AnalysisRequest, key: str, quantity: str) -> dict[str, Any] | None:
    gid = req.inputs.get(key)
    return ctx.group(gid, quantity) if gid else None


def p(label: str, key: str, type_: str = "number", default: Any = 0.0, **kw) -> Param:
    """Atalho para declarar parâmetros."""
    return Param(key, label, type_, default, **kw)


def select(key: str, label: str, default: str, options: list[tuple[str, str]], **kw) -> Param:
    return Param(key, label, "select", default, options=[{"value": v, "label": l} for v, l in options], **kw)


# ---------------------------------------------------------------------------
# Geometria
# ---------------------------------------------------------------------------
def circle(center: complex, radius: float, n: int = 180) -> np.ndarray:
    ang = np.linspace(0, 2 * np.pi, n, endpoint=False)
    return center + radius * np.exp(1j * ang)


def clip_halfplane(poly: np.ndarray, a: float, b: float, c: float) -> np.ndarray:
    """Sutherland–Hodgman: mantém a parte com a·R + b·X ≤ c."""
    if len(poly) == 0:
        return poly
    out: list[complex] = []
    n = len(poly)
    for i in range(n):
        cur, nxt = poly[i], poly[(i + 1) % n]
        fc = a * cur.real + b * cur.imag - c
        fn = a * nxt.real + b * nxt.imag - c
        if fc <= 0:
            out.append(cur)
        if (fc <= 0) != (fn <= 0):
            t = fc / (fc - fn)
            out.append(cur + t * (nxt - cur))
    return np.array(out, dtype=complex)


def clip_line_side(poly: np.ndarray, p0: complex, direction_deg: float, keep_left: bool) -> np.ndarray:
    """Recorta pela reta que passa por p0 com o ângulo dado; mantém o lado
    esquerdo (anti-horário) ou direito da direção."""
    d = np.exp(1j * np.radians(direction_deg))
    # normal à esquerda de d: (-dy, dx); ponto q está à esquerda se n·(q-p0) ≥ 0
    nx, ny = -d.imag, d.real
    if keep_left:  # n·(q-p0) ≥ 0  →  -n·q ≤ -n·p0
        return clip_halfplane(poly, -nx, -ny, -(nx * p0.real + ny * p0.imag))
    return clip_halfplane(poly, nx, ny, nx * p0.real + ny * p0.imag)


def box(r: float) -> np.ndarray:
    return np.array([-r - 1j * r, r - 1j * r, r + 1j * r, -r + 1j * r], dtype=complex)


def wedge(theta_low: float, theta_high: float, radius: float) -> np.ndarray:
    """Setor a partir da origem entre dois ângulos (graus), usado como região
    direcional. Para abertura > 180° vira polígono côncavo — por isso a
    construção é por pontos e não por semiplanos."""
    span = (theta_high - theta_low) % 360 or 360
    ang = np.radians(theta_low + np.linspace(0, span, 64))
    return np.concatenate([[0j], radius * np.exp(1j * ang)])


def points_in_polygon(z: np.ndarray, poly: np.ndarray) -> np.ndarray:
    """Ray casting vetorizado. z: pontos complexos (NaN → False)."""
    z = np.asarray(z)
    inside = np.zeros(z.shape, dtype=bool)
    if len(poly) < 3:
        return inside
    x, y = z.real, z.imag
    px, py = poly.real, poly.imag
    j = len(poly) - 1
    for i in range(len(poly)):
        xi, yi, xj, yj = px[i], py[i], px[j], py[j]
        cond = (yi > y) != (yj > y)
        with np.errstate(divide="ignore", invalid="ignore"):
            xint = (xj - xi) * (y - yi) / (yj - yi) + xi
        inside ^= cond & (x < xint)
        j = i
    return inside & np.isfinite(z)


def poly_to_list(poly: np.ndarray) -> list[list[float]]:
    return [[round(float(v.real), 6), round(float(v.imag), 6)] for v in poly]


# ---------------------------------------------------------------------------
# Temporização
# ---------------------------------------------------------------------------
def runs(mask: np.ndarray) -> list[tuple[int, int]]:
    """Trechos [início, fim] (inclusive) onde mask é verdadeiro."""
    m = np.asarray(mask, dtype=bool)
    if not m.any():
        return []
    d = np.diff(np.concatenate([[0], m.view(np.int8), [0]]))
    starts = np.flatnonzero(d == 1)
    ends = np.flatnonzero(d == -1) - 1
    return list(zip(starts.tolist(), ends.tolist()))


def delayed(mask: np.ndarray, times: np.ndarray, delay: float) -> np.ndarray:
    """Máscara de trip: verdadeiro após `delay` s de partida contínua."""
    out = np.zeros(len(mask), dtype=bool)
    for s, e in runs(mask):
        t_trip = times[s] + max(delay, 0.0)
        k = int(np.searchsorted(times[s : e + 1], t_trip - 1e-12)) + s
        if k <= e:
            out[k : e + 1] = True
    return out


def intervals(mask: np.ndarray, times: np.ndarray) -> list[list[float]]:
    return [[float(times[s]), float(times[e])] for s, e in runs(mask)]


def first_time(mask: np.ndarray, times: np.ndarray) -> float | None:
    idx = np.flatnonzero(mask)
    return float(times[idx[0]]) if len(idx) else None


@dataclass
class Lane:
    """Uma faixa da linha do tempo (ex.: 'Z1 partida')."""

    id: str
    label: str
    kind: str  # "pickup" | "trip" | "block" | "info"
    mask: np.ndarray

    def to_dict(self, times: np.ndarray) -> dict[str, Any]:
        return {"id": self.id, "label": self.label, "kind": self.kind, "intervals": intervals(self.mask, times)}


def events_from_lanes(lanes: list[Lane], times: np.ndarray, element_of: dict[str, str] | None = None) -> list[dict]:
    ev = []
    for lane in lanes:
        for s, _ in runs(lane.mask):
            ev.append({"t": float(times[s]), "element": lane.label, "kind": lane.kind})
    ev.sort(key=lambda e: e["t"])
    return ev


# ---------------------------------------------------------------------------
# Curvas de tempo inverso
# ---------------------------------------------------------------------------
# t = TMS · ( A / (M^p − 1) + B )
CURVES: dict[str, tuple[str, float, float, float]] = {
    "IEC_SI": ("IEC Normal inversa (SI)", 0.14, 0.02, 0.0),
    "IEC_VI": ("IEC Muito inversa (VI)", 13.5, 1.0, 0.0),
    "IEC_EI": ("IEC Extremamente inversa (EI)", 80.0, 2.0, 0.0),
    "IEC_LTI": ("IEC Inversa longa (LTI)", 120.0, 1.0, 0.0),
    "IEEE_MI": ("IEEE Moderadamente inversa", 0.0515, 0.02, 0.114),
    "IEEE_VI": ("IEEE Muito inversa", 19.61, 2.0, 0.491),
    "IEEE_EI": ("IEEE Extremamente inversa", 28.2, 2.0, 0.1217),
    "US_CO8": ("US CO8 Inversa", 5.95, 2.0, 0.18),
    "US_CO2": ("US CO2 Inversa curta", 0.02394, 0.02, 0.01694),
}


def curve_time(curve: str, m: np.ndarray, tms: float) -> np.ndarray:
    """Tempo de operação (s) para múltiplos M = I/Is (inf para M ≤ 1)."""
    _, a, pexp, b = CURVES[curve]
    m = np.asarray(m, dtype=float)
    with np.errstate(divide="ignore", invalid="ignore"):
        t = tms * (a / (np.power(m, pexp) - 1.0) + b)
    return np.where(m > 1.0, t, np.inf)


def integrate_inverse(m: np.ndarray, times: np.ndarray, curve: str, tms: float, pickup_factor: float = 1.0):
    """Integração (IEC 60255-151): trip quando ∫ dt / t(M) ≥ 1. Reset instantâneo."""
    above = m >= pickup_factor
    t_op = curve_time(curve, np.maximum(m, 1.0 + 1e-9), tms)
    dt = np.diff(times, prepend=times[0])
    rate = np.where(above & np.isfinite(t_op) & (t_op > 0), dt / t_op, 0.0)
    acc = np.zeros(len(m))
    trip = np.zeros(len(m), dtype=bool)
    total = 0.0
    for k in range(len(m)):  # laço simples: número de pontos limitado (≤ EVAL_MAX_POINTS)
        if not above[k]:
            total = 0.0
        else:
            total += rate[k]
        acc[k] = total
        trip[k] = total >= 1.0
    return above, trip, acc


# ---------------------------------------------------------------------------
# Estimação multi-harmônica (LS)
# ---------------------------------------------------------------------------
def harmonic_phasors(
    signal: np.ndarray,
    ends: np.ndarray,
    fs: float,
    f0: float,
    harmonics: tuple[int, ...] = (1, 2, 5),
    window_cycles: float = 1.0,
    first_sample: int = 0,
) -> dict[int, np.ndarray]:
    """Fasores RMS de várias harmônicas ajustadas simultaneamente (+ DC)
    na janela que termina em cada índice de `ends` (relativo a `signal`)."""
    x = np.asarray(signal, dtype=float)
    n = window_length(fs, f0, window_cycles)
    ends = np.asarray(ends, dtype=np.int64)
    out = {h: np.full(len(ends), np.nan + 1j * np.nan) for h in harmonics}
    ok = (ends >= n - 1) & (ends < len(x))
    if not ok.any():
        return out
    t = np.arange(n, dtype=float)
    cols = [np.ones(n)]
    for h in harmonics:
        w = 2 * np.pi * h * f0 / fs
        cols += [np.cos(w * t), -np.sin(w * t)]
    pinv = np.linalg.pinv(np.column_stack(cols))
    rows = ends[ok] - (n - 1)
    win = sliding_window_view(x, n)[rows]
    coef = win @ pinv.T  # (k, 1+2H)
    for j, h in enumerate(harmonics):
        w = 2 * np.pi * h * f0 / fs
        local = (coef[:, 1 + 2 * j] + 1j * coef[:, 2 + 2 * j]) / np.sqrt(2)
        out[h][ok] = local * np.exp(-1j * w * (first_sample + rows))
    return out
