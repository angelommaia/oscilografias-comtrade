"""Leitor COMTRADE (IEEE C37.111) vetorizado com numpy.

Motivação: a biblioteca `comtrade` decodifica amostra por amostra em Python
(listas de floats). Para registros grandes isso custa ~1 min e vários GB de
RAM. Aqui o .dat binário é mapeado em memória (np.memmap) e decodificado por
coluna, e os sinais ficam em float32 (suficiente para conversores de 16/24
bits). O .cfg continua sendo interpretado pela biblioteca `comtrade`.

Formatos: BINARY, BINARY32, FLOAT32 e ASCII. Em caso de falha no ASCII
(arquivos fora do padrão) o chamador pode recorrer à biblioteca original.
"""

from __future__ import annotations

import logging
import math
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

import comtrade
import numpy as np

logger = logging.getLogger(__name__)

CFG_ENCODINGS = ("utf-8", "latin-1", "cp1252")


class PackedBits:
    """Canal digital armazenado compactado (palavra de 16 bits + nº do bit).

    Comporta-se como um array para fatiamento: `bits[a:b]` → np.int8.
    """

    __slots__ = ("_words", "_bit")

    def __init__(self, words: np.ndarray, bit: int):
        self._words = words
        self._bit = bit

    def __len__(self) -> int:
        return len(self._words)

    def __getitem__(self, key):
        return ((self._words[key] >> self._bit) & 1).astype(np.int8)

    def astype(self, dtype):
        return self[:].astype(dtype)


class ScaledChannel:
    """Canal analógico guardado como inteiro bruto do .dat (2 ou 4 bytes por
    amostra) e convertido para float32 só no trecho pedido:
        valor = bruto · ganho + offset   (bruto == ausente → NaN)
    Para BINARY isso usa metade da RAM de um array float32.
    """

    __slots__ = ("raw", "gain", "offset", "missing")

    def __init__(self, raw: np.ndarray, gain: float, offset: float, missing: int | None):
        self.raw = raw
        self.gain = float(gain)
        self.offset = float(offset)
        self.missing = missing

    def __len__(self) -> int:
        return len(self.raw)

    def __getitem__(self, key):
        raw = self.raw[key]
        vals = np.asarray(raw, dtype=np.float32) * np.float32(self.gain) + np.float32(self.offset)
        if self.missing is not None:
            bad = raw == self.missing
            if np.any(bad):
                if np.ndim(vals) == 0:
                    return np.float32(np.nan)
                vals[bad] = np.nan
        return vals

    def __array__(self, dtype=None, copy=None):
        arr = self[:]
        return arr if dtype is None else arr.astype(dtype)

    def scaled(self, factor: float) -> "ScaledChannel":
        return ScaledChannel(self.raw, self.gain * factor, self.offset * factor, self.missing)


@dataclass
class ParsedRecord:
    """Estrutura com a mesma "cara" usada por ComtradeStore._build_meta."""

    cfg: Any
    time: np.ndarray
    analog: list[np.ndarray]
    status: list[Any]
    sample_rate: float
    encoding: str = "utf-8"
    warnings: list[str] = field(default_factory=list)

    @property
    def analog_channel_ids(self) -> list[str]:
        return [ch.name for ch in self.cfg.analog_channels]

    @property
    def status_channel_ids(self) -> list[str]:
        return [ch.name for ch in self.cfg.status_channels]

    @property
    def start_timestamp(self):
        return self.cfg.start_timestamp

    @property
    def trigger_timestamp(self):
        return self.cfg.trigger_timestamp

    @property
    def total_samples(self) -> int:
        return len(self.time)


def load_cfg(cfg_path: Path) -> tuple[Any, str]:
    last: Exception | None = None
    for enc in CFG_ENCODINGS:
        try:
            cfg = comtrade.Cfg()
            cfg.load(str(cfg_path), encoding=enc)
            return cfg, enc
        except UnicodeDecodeError as exc:
            last = exc
    raise ValueError("Não foi possível ler o arquivo .cfg (codificação de texto não suportada).") from last


def read_record(cfg_path: Path, dat_path: Path) -> ParsedRecord:
    cfg, enc = load_cfg(cfg_path)
    ft = (cfg.ft or "").strip().upper()
    if ft in ("BINARY", "BINARY32", "FLOAT32"):
        rec = _read_binary(cfg, dat_path, ft)
    elif ft == "ASCII":
        rec = _read_ascii(cfg, dat_path)
    else:
        raise ValueError(f"Formato de dados não suportado: {cfg.ft}")
    rec.encoding = enc
    for w in rec.warnings:
        logger.warning("%s: %s", cfg_path.name, w)
    return rec


# ---------------------------------------------------------------------------
# Binário
# ---------------------------------------------------------------------------
def _read_binary(cfg, dat_path: Path, ft: str) -> ParsedRecord:
    na = int(cfg.analog_count)
    ns = int(cfg.status_count)
    nwords = math.ceil(ns / 16)
    a_type = {"BINARY": "<i2", "BINARY32": "<i4", "FLOAT32": "<f4"}[ft]
    fields = [("n", "<u4"), ("ts", "<u4")]
    if na:
        fields.append(("a", a_type, (na,)))
    if nwords:
        fields.append(("d", "<u2", (nwords,)))
    dtype = np.dtype(fields)

    size = dat_path.stat().st_size
    n_file = size // dtype.itemsize
    if n_file == 0:
        raise ValueError("Arquivo .dat vazio ou incompatível com o .cfg.")
    warnings: list[str] = []
    if size % dtype.itemsize:
        warnings.append(f"{size % dtype.itemsize} bytes extras no fim do .dat ignorados")

    n_cfg = _cfg_total_samples(cfg)
    n = min(n_file, n_cfg) if n_cfg > 0 else n_file
    if n_cfg > 0 and n_file < n_cfg:
        warnings.append(f".dat tem {n_file} amostras, .cfg declara {n_cfg}")

    mm = np.memmap(dat_path, dtype=dtype, mode="r", shape=(n,))
    try:
        if ft == "BINARY":
            missing = -1 if str(cfg.rev_year).strip() == "1991" else -32768
        elif ft == "BINARY32":
            missing = -(2**31)
        else:
            missing = None

        analog: list[Any] = []
        for i, ch in enumerate(cfg.analog_channels):
            col = mm["a"][:, i]
            if ft == "BINARY":
                # mantém o inteiro de 16 bits (cópia contígua) e escala sob demanda
                analog.append(ScaledChannel(np.array(col, dtype=np.int16), ch.a, ch.b or 0.0, missing))
            else:
                vals = np.array(col, dtype=np.float32)
                vals *= np.float32(ch.a)
                vals += np.float32(ch.b or 0.0)
                if missing is not None:
                    vals[np.asarray(col) == missing] = np.nan
                analog.append(vals)

        status: list[Any] = []
        for w in range(nwords):
            words = np.array(mm["d"][:, w])  # cópia compacta (2 bytes/amostra)
            for bit in range(16):
                if w * 16 + bit < ns:
                    status.append(PackedBits(words, bit))

        ts = np.asarray(mm["ts"], dtype=np.float64)
    finally:
        del mm  # libera o arquivo (importante no Windows antes de apagar temporários)

    time, rate = _build_time(cfg, n, ts, warnings)
    return ParsedRecord(cfg=cfg, time=time, analog=analog, status=status, sample_rate=rate, warnings=warnings)


# ---------------------------------------------------------------------------
# ASCII
# ---------------------------------------------------------------------------
def _read_ascii(cfg, dat_path: Path) -> ParsedRecord:
    na = int(cfg.analog_count)
    ns = int(cfg.status_count)
    data = np.loadtxt(dat_path, delimiter=",", dtype=np.float64, ndmin=2, encoding="latin-1")
    if data.shape[1] < 2 + na + ns:
        raise ValueError("Número de colunas do .dat ASCII incompatível com o .cfg.")
    warnings: list[str] = []
    n_cfg = _cfg_total_samples(cfg)
    n = min(len(data), n_cfg) if n_cfg > 0 else len(data)
    data = data[:n]

    analog = []
    for i, ch in enumerate(cfg.analog_channels):
        col = data[:, 2 + i]
        vals = (col * ch.a + (ch.b or 0.0)).astype(np.float32)
        vals[col == 99999] = np.nan
        analog.append(vals)
    status = [data[:, 2 + na + j].astype(np.int8) for j in range(ns)]
    time, rate = _build_time(cfg, n, data[:, 1].copy(), warnings)
    return ParsedRecord(cfg=cfg, time=time, analog=analog, status=status, sample_rate=rate, warnings=warnings)


# ---------------------------------------------------------------------------
# Base de tempo
# ---------------------------------------------------------------------------
def _cfg_total_samples(cfg) -> int:
    try:
        return int(cfg.sample_rates[-1][1]) if cfg.sample_rates else 0
    except (TypeError, ValueError, IndexError):
        return 0


def _build_time(cfg, n: int, ts: np.ndarray, warnings: list[str]) -> tuple[np.ndarray, float]:
    """Tempo em segundos (float64) a partir das taxas do .cfg; se a taxa for
    0 (ou o formato exigir), usa os carimbos de tempo do .dat."""
    rates = [(float(s), int(e)) for s, e in (cfg.sample_rates or []) if e]
    use_ts = not rates or any(s <= 0 for s, _ in rates)

    if use_ts:
        mult = float(cfg.timemult or 1.0)
        base = float(cfg.time_base or 1e-6)
        time = ts[:n] * mult * base
        time -= time[0]
        dt = np.diff(time[: min(n, 10001)])
        dt = dt[dt > 0]
        rate = float(1.0 / np.median(dt)) if len(dt) else 0.0
        return time, rate

    time = np.empty(n, dtype=np.float64)
    start_idx = 0
    t0 = 0.0
    best_rate, best_len = rates[0][0], 0
    for samp, endsamp in rates:
        end_idx = min(endsamp, n)
        if end_idx <= start_idx:
            continue
        k = np.arange(end_idx - start_idx, dtype=np.float64)
        time[start_idx:end_idx] = t0 + k / samp
        t0 = time[end_idx - 1] + 1.0 / samp
        if end_idx - start_idx > best_len:
            best_rate, best_len = samp, end_idx - start_idx
        start_idx = end_idx
    if start_idx < n:  # .cfg declara menos amostras que o .dat
        k = np.arange(n - start_idx, dtype=np.float64)
        time[start_idx:] = t0 + k / rates[-1][0]
    if len(rates) > 1:
        warnings.append(
            f"registro com {len(rates)} taxas de amostragem; análises usam {best_rate:g} Hz (trecho mais longo)"
        )
    return time, best_rate
