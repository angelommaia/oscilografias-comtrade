"""Serviço de leitura e processamento de arquivos COMTRADE (IEEE C37.111)."""

from __future__ import annotations

import logging
import os
import tempfile
import threading
import uuid
from collections import OrderedDict
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

import comtrade
import numpy as np

from comtrade_reader import read_record
from analysis import AnalysisContext, AnalysisRequest, RecordData, get_analysis
from analysis.dsp import list_estimators
from analysis.context import plot_step
from analysis.groups import detect_three_phase_groups, make_group
from phasor_analysis import METRIC_CATALOG, METRIC_GROUPS, compute_metrics, decimate_series

logger = logging.getLogger(__name__)

_CFG_ENCODINGS = ("utf-8", "latin-1", "cp1252")
MAX_RECORDS = int(os.environ.get("MAX_RECORDS_IN_MEMORY", "12"))


@dataclass
class ChannelInfo:
    index: int
    name: str
    unit: str
    kind: str  # "analog" | "digital"
    phase: str | None = None
    primary: float | None = None
    secondary: float | None = None
    multiplier: float | None = None
    offset: float | None = None
    cfg_min: float | None = None
    cfg_max: float | None = None
    ps: str | None = None


@dataclass
class RecordMeta:
    id: str
    station: str
    device: str
    revision: str
    start_time: str
    trigger_time: str
    sample_rate_hz: float
    total_samples: int
    duration_s: float
    frequency_hz: float = 60.0
    analog_channels: list[ChannelInfo] = field(default_factory=list)
    digital_channels: list[ChannelInfo] = field(default_factory=list)


class ComtradeStore:
    """Registros COMTRADE carregados em memória (LRU, thread-safe).

    Os sinais são convertidos UMA vez para numpy em valores primários no
    carregamento; todas as consultas e análises trabalham sobre esses arrays.
    """

    def __init__(self, max_records: int = MAX_RECORDS) -> None:
        self._data: "OrderedDict[str, RecordData]" = OrderedDict()
        self._lock = threading.Lock()
        self._max_records = max(1, max_records)

    # ------------------------------------------------------------ carga
    def load_from_path(self, cfg_path: Path) -> RecordMeta:
        cfg_path = cfg_path.resolve()
        if not cfg_path.exists():
            raise FileNotFoundError(f"Arquivo CFG não encontrado: {cfg_path}")

        dat_path = self._find_dat_file(cfg_path)
        if dat_path is None:
            raise ValueError("Arquivo .dat não encontrado. Envie o .cfg e o .dat com o mesmo nome base.")

        record_id = str(uuid.uuid4())
        try:
            rec = read_record(cfg_path, dat_path)
            analog_raw = rec.analog
            status = rec.status
        except (ValueError, OSError) as exc:
            # Arquivos fora do padrão: tenta a biblioteca `comtrade` (lenta, porém tolerante)
            logger.warning("Leitor rápido falhou (%s); usando biblioteca comtrade.", exc)
            rec, _ = self._load_comtrade(cfg_path, dat_path)
            analog_raw = [np.asarray(rec.analog[i], dtype=np.float32) for i in range(len(rec.analog_channel_ids))]
            status = [np.asarray(rec.status[i], dtype=np.int8) for i in range(len(rec.status_channel_ids))]
        logger.info("COMTRADE carregado: %s (%d amostras)", cfg_path.name, rec.total_samples)

        meta = self._build_meta(record_id, rec)
        analog = [self._to_primary(analog_raw[i], info) for i, info in enumerate(meta.analog_channels)]
        data = RecordData(
            meta=meta,
            time=np.asarray(rec.time, dtype=np.float64),
            analog=analog,
            digital=status,
            auto_groups=detect_three_phase_groups(meta.analog_channels),
        )
        with self._lock:
            self._data[record_id] = data
            while len(self._data) > self._max_records:
                evicted, _ = self._data.popitem(last=False)
                logger.info("Registro removido da memória (LRU): %s", evicted)
        return meta

    def _get(self, record_id: str) -> RecordData:
        with self._lock:
            data = self._data.get(record_id)
            if data is None:
                raise KeyError(f"Registro não encontrado: {record_id}")
            self._data.move_to_end(record_id)
            return data

    def context(self, record_id: str) -> AnalysisContext:
        return AnalysisContext(self._get(record_id))

    def load_from_upload(self, cfg_file: Path, dat_file: Path) -> RecordMeta:
        """Carrega arquivos já gravados em disco (o upload é transmitido em
        blocos para um diretório temporário, sem passar inteiro pela RAM)."""
        return self.load_from_path(cfg_file)

    @staticmethod
    def _find_dat_file(cfg_path: Path) -> Path | None:
        stem = cfg_path.with_suffix("")
        for ext in (".dat", ".DAT", ".Dat", ".dAt"):
            candidate = stem.with_suffix(ext)
            if candidate.is_file():
                return candidate
        return None

    @staticmethod
    def _load_comtrade(cfg_path: Path, dat_path: Path | None = None) -> tuple[comtrade.Comtrade, str]:
        last_error: Exception | None = None

        for encoding in _CFG_ENCODINGS:
            try:
                rec = comtrade.Comtrade()
                if dat_path is not None:
                    rec.load(str(cfg_path), dat_file=str(dat_path), encoding=encoding)
                else:
                    rec.load(str(cfg_path), encoding=encoding)
                return rec, encoding
            except UnicodeDecodeError as exc:
                last_error = exc
                continue
            except FileNotFoundError as exc:
                raise ValueError(
                    "Arquivo .dat não encontrado. Envie o .cfg e o .dat com o mesmo nome base."
                ) from exc
            except Exception:
                raise

        raise ValueError(
            "Não foi possível ler o arquivo .cfg (codificação de texto não suportada)."
        ) from last_error

    def get_meta(self, record_id: str) -> RecordMeta:
        return self._get(record_id).meta

    # ------------------------------------------------------------ formas de onda
    def get_waveform(
        self,
        record_id: str,
        channel_indices: list[int],
        start_sample: int = 0,
        end_sample: int | None = None,
        max_points: int = 4000,
    ) -> dict[str, Any]:
        data = self._get(record_id)
        meta = data.meta
        total = len(data.time)

        start = max(0, start_sample)
        end = min(total, end_sample if end_sample is not None else total)
        if start >= end:
            raise ValueError("Intervalo de amostras inválido")

        time_full = data.time[start:end]
        channels: list[dict[str, Any]] = []

        for idx in channel_indices:
            info, pos = self._locate(meta, idx)
            if info is None:
                continue
            if info.kind == "analog":
                raw = np.asarray(data.analog[pos][start:end])
            else:
                raw = np.asarray(data.digital[pos][start:end], dtype=float)

            times, values = self._decimate_minmax(time_full, raw, max_points)
            y_min, y_max = self._channel_y_limits(info, raw)
            cfg_min = self._to_primary_scalar(info.cfg_min, info) if info.cfg_min is not None else None
            cfg_max = self._to_primary_scalar(info.cfg_max, info) if info.cfg_max is not None else None

            channels.append(
                {
                    "index": idx,
                    "name": info.name,
                    "unit": info.unit,
                    "kind": info.kind,
                    "times": times.tolist(),
                    "values": values.tolist(),
                    "min": y_min,
                    "max": y_max,
                    "cfg_min": cfg_min,
                    "cfg_max": cfg_max,
                    "ps": info.ps,
                }
            )

        return {
            "start_sample": start,
            "end_sample": end,
            "sample_rate_hz": meta.sample_rate_hz,
            "time_start_s": float(time_full[0]) if len(time_full) else 0.0,
            "time_end_s": float(time_full[-1]) if len(time_full) else 0.0,
            "channels": channels,
        }

    def get_value_at_time(self, record_id: str, channel_indices: list[int], time_s: float) -> dict[str, Any]:
        data = self._get(record_id)
        meta = data.meta
        sample_idx = int(np.clip(np.searchsorted(data.time, time_s), 0, len(data.time) - 1))
        if sample_idx > 0 and abs(data.time[sample_idx - 1] - time_s) < abs(data.time[sample_idx] - time_s):
            sample_idx -= 1
        actual_time = float(data.time[sample_idx])
        channels: list[dict[str, Any]] = []

        for idx in channel_indices:
            info, pos = self._locate(meta, idx)
            if info is None:
                continue
            if info.kind == "analog":
                value = float(data.analog[pos][sample_idx])
            else:
                value = float(data.digital[pos][sample_idx])
            channels.append(
                {"index": idx, "value": value, "time_s": actual_time, "unit": info.unit, "kind": info.kind}
            )
        return {"time_s": actual_time, "channels": channels}

    # ------------------------------------------------------------ grupos trifásicos
    def get_phasor_config(self, record_id: str) -> dict[str, Any]:
        data = self._get(record_id)
        meta = data.meta
        voltage_groups = [g for g in data.groups if g["quantity"] == "V"]
        current_groups = [g for g in data.groups if g["quantity"] == "I"]
        return {
            "frequency_hz": meta.frequency_hz,
            "sample_rate_hz": meta.sample_rate_hz,
            "voltage_groups": voltage_groups,
            "current_groups": current_groups,
            "default_voltage_group": voltage_groups[0]["id"] if voltage_groups else None,
            "default_current_group": current_groups[0]["id"] if current_groups else None,
            "metrics": METRIC_CATALOG,
            "metric_groups": METRIC_GROUPS,
            "estimators": list_estimators(),
        }

    def add_group(self, record_id: str, quantity: str, label: str, a: int, b: int, c: int) -> dict[str, Any]:
        data = self._get(record_id)
        valid = {ch.index for ch in data.meta.analog_channels}
        if not {a, b, c} <= valid or len({a, b, c}) != 3:
            raise ValueError("Selecione três canais analógicos distintos.")
        label = (label or "").strip()[:60] or f"Grupo {len(data.manual_groups) + 1}"
        group = make_group(quantity, label, a, b, c, source="manual")
        with self._lock:
            data.manual_groups = [g for g in data.manual_groups if g["id"] != group["id"]] + [group]
        return group

    def remove_group(self, record_id: str, group_id: str) -> None:
        data = self._get(record_id)
        with self._lock:
            before = len(data.manual_groups)
            data.manual_groups = [g for g in data.manual_groups if g["id"] != group_id]
            if len(data.manual_groups) == before:
                raise ValueError("Somente grupos manuais podem ser removidos.")

    # ------------------------------------------------------------ grandezas derivadas
    def _group_phasors(self, ctx: AnalysisContext, vg: str, cg: str, i0: int, i1: int,
                       window_cycles: float, estimator: str, step: int = 1) -> dict[str, np.ndarray]:
        va, vb, vc = ctx.group_phasors(vg, "V", i0, i1, window_cycles, estimator, step)
        ia, ib, ic = ctx.group_phasors(cg, "I", i0, i1, window_cycles, estimator, step)
        return {"va": va, "vb": vb, "vc": vc, "ia": ia, "ib": ib, "ic": ic}

    def get_derived_waveform(
        self,
        record_id: str,
        voltage_group_id: str,
        current_group_id: str,
        metrics: list[str],
        start_sample: int = 0,
        end_sample: int | None = None,
        window_cycles: float = 1.0,
        max_points: int = 4000,
        estimator: str = "ls",
    ) -> dict[str, Any]:
        ctx = self.context(record_id)
        start = max(0, start_sample)
        end = min(ctx.n_samples, end_sample if end_sample is not None else ctx.n_samples)
        if start >= end:
            raise ValueError("Intervalo de amostras inválido")

        # registros longos: fasores só em ~2×max_points instantes (o resto não seria visível)
        step = plot_step(end - start, 2 * max_points)
        phasors = self._group_phasors(ctx, voltage_group_id, current_group_id, start, end - 1,
                                      window_cycles, estimator, step)
        values = compute_metrics(phasors, metrics)
        times = ctx.time[start:end:step]

        channels: list[dict[str, Any]] = []
        for key in metrics:
            if key not in values:
                continue
            info = METRIC_CATALOG[key]
            t_dec, v_dec = decimate_series(times, values[key], max_points)
            finite = v_dec[np.isfinite(v_dec)]
            channels.append(
                {
                    "key": key,
                    "name": info["name"],
                    "unit": info["unit"],
                    "kind": "derived",
                    "index": f"derived:{key}",
                    "times": t_dec.tolist(),
                    "values": [None if not np.isfinite(v) else float(v) for v in v_dec],
                    "min": float(finite.min()) if len(finite) else 0.0,
                    "max": float(finite.max()) if len(finite) else 0.0,
                }
            )

        return {
            "start_sample": start,
            "end_sample": end,
            "window_cycles": window_cycles,
            "frequency_hz": ctx.f0,
            "voltage_group_id": voltage_group_id,
            "current_group_id": current_group_id,
            "channels": channels,
        }

    def get_derived_at_time(
        self,
        record_id: str,
        voltage_group_id: str,
        current_group_id: str,
        time_s: float,
        window_cycles: float = 1.0,
        estimator: str = "ls",
    ) -> dict[str, Any]:
        ctx = self.context(record_id)
        k = ctx.time_to_index(time_s)
        phasors = self._group_phasors(ctx, voltage_group_id, current_group_id, k, k, window_cycles, estimator)
        values = compute_metrics(phasors)
        metrics = []
        for key, arr in values.items():
            val = float(arr[0])
            info = METRIC_CATALOG[key]
            metrics.append({"key": key, "name": info["name"], "unit": info["unit"],
                            "value": val if np.isfinite(val) else None})
        return {"time_s": float(ctx.time[k]), "window_cycles": window_cycles, "metrics": metrics}

    # ------------------------------------------------------------ análises plugáveis
    def run_analysis(self, record_id: str, analysis_id: str, req: AnalysisRequest) -> dict[str, Any]:
        analysis = get_analysis(analysis_id)
        analysis.validate(req)
        ctx = self.context(record_id)
        result = analysis.run(ctx, req)
        return {"analysis": analysis_id, **result}

    @staticmethod
    def _locate(meta: RecordMeta, index: int) -> tuple[ChannelInfo | None, int]:
        n_analog = len(meta.analog_channels)
        if 0 <= index < n_analog:
            return meta.analog_channels[index], index
        d = index - n_analog
        if 0 <= d < len(meta.digital_channels):
            return meta.digital_channels[d], d
        return None, -1

    def _build_meta(self, record_id: str, rec: comtrade.Comtrade) -> RecordMeta:
        sample_rate = getattr(rec, "sample_rate", None) or (
            1.0 / (rec.time[1] - rec.time[0]) if len(rec.time) > 1 else 0.0
        )
        duration = float(rec.time[-1] - rec.time[0]) if len(rec.time) > 1 else 0.0

        analog_channels: list[ChannelInfo] = []
        for i, name in enumerate(rec.analog_channel_ids):
            unit = primary = secondary = phase = ps = None
            multiplier = offset = cfg_min = cfg_max = None
            try:
                ch_cfg = rec.cfg.analog_channels[i]
                unit = str(ch_cfg.uu) if ch_cfg.uu else ""
                multiplier = float(ch_cfg.a)
                offset = float(ch_cfg.b)
                cfg_min = float(ch_cfg.a * ch_cfg.cmin + ch_cfg.b)
                cfg_max = float(ch_cfg.a * ch_cfg.cmax + ch_cfg.b)
                primary = float(ch_cfg.primary)
                secondary = float(ch_cfg.secondary)
                phase = str(ch_cfg.ph) if ch_cfg.ph else None
                ps = str(ch_cfg.pors) if hasattr(ch_cfg, "pors") else None
            except (IndexError, AttributeError, TypeError, ValueError):
                unit = unit or ""

            analog_channels.append(
                ChannelInfo(
                    index=i,
                    name=str(name),
                    unit=unit or "",
                    kind="analog",
                    phase=phase,
                    primary=primary,
                    secondary=secondary,
                    multiplier=multiplier,
                    offset=offset,
                    cfg_min=cfg_min,
                    cfg_max=cfg_max,
                    ps=ps,
                )
            )

        digital_channels: list[ChannelInfo] = []
        for i, name in enumerate(rec.status_channel_ids):
            digital_channels.append(
                ChannelInfo(
                    index=len(analog_channels) + i,
                    name=str(name),
                    unit="",
                    kind="digital",
                )
            )

        start_time = str(rec.start_timestamp) if rec.start_timestamp else ""
        trigger_time = str(rec.trigger_timestamp) if rec.trigger_timestamp else ""

        station = device = revision = ""
        frequency_hz = 60.0
        try:
            station = rec.cfg.station_name
            device = rec.cfg.rec_dev_id
            revision = str(rec.cfg.rev_year)
            frequency_hz = float(rec.cfg.frequency)
        except AttributeError:
            pass

        return RecordMeta(
            id=record_id,
            station=station,
            device=device,
            revision=revision,
            start_time=start_time,
            trigger_time=trigger_time,
            sample_rate_hz=sample_rate,
            total_samples=rec.total_samples,
            duration_s=duration,
            frequency_hz=frequency_hz,
            analog_channels=analog_channels,
            digital_channels=digital_channels,
        )

    @staticmethod
    def _find_channel(meta: RecordMeta, index: int) -> ChannelInfo | None:
        for ch in meta.analog_channels + meta.digital_channels:
            if ch.index == index:
                return ch
        return None

    @staticmethod
    def _channel_y_limits(info: ChannelInfo, raw: np.ndarray) -> tuple[float, float]:
        data_min = float(np.min(raw)) if len(raw) else 0.0
        data_max = float(np.max(raw)) if len(raw) else 0.0

        if info.kind == "analog" and info.cfg_min is not None and info.cfg_max is not None:
            lo = min(info.cfg_min, info.cfg_max, data_min)
            hi = max(info.cfg_min, info.cfg_max, data_max)
            if hi - lo < 1e-12:
                pad = abs(hi) * 0.1 or 1.0
                return lo - pad, hi + pad
            return float(lo), float(hi)

        return data_min, data_max

    @staticmethod
    def _primary_ratio(info: ChannelInfo) -> float:
        """Converte secundário → primário quando PS='S' (IEEE C37.111)."""
        if info.kind != "analog":
            return 1.0
        if info.ps and info.ps.upper() == "S":
            if info.primary and info.secondary and info.secondary != 0:
                return float(info.primary) / float(info.secondary)
        return 1.0

    @classmethod
    def _to_primary(cls, values, info: ChannelInfo):
        ratio = cls._primary_ratio(info)
        if ratio == 1.0:
            return values
        if hasattr(values, "scaled"):  # ScaledChannel: só ajusta ganho/offset
            return values.scaled(ratio)
        return values * ratio

    @classmethod
    def _to_primary_scalar(cls, value: float | None, info: ChannelInfo) -> float | None:
        if value is None:
            return None
        return float(value) * cls._primary_ratio(info)

    @staticmethod
    def _decimate_minmax(times: np.ndarray, values: np.ndarray, max_points: int) -> tuple[np.ndarray, np.ndarray]:
        return decimate_series(times, np.asarray(values, dtype=float), max_points)

    @staticmethod
    def _upload_filename(filename: str, default: str) -> str:
        name = Path(filename.replace("\\", "/")).name
        if not name or name in (".", ".."):
            return default
        return name


store = ComtradeStore()
