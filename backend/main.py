"""API FastAPI para visualização de oscilografias COMTRADE."""

from __future__ import annotations

import tempfile
from pathlib import Path

from fastapi import FastAPI, File, HTTPException, Query, Request, UploadFile
from fastapi.middleware.cors import CORSMiddleware
from fastapi.middleware.trustedhost import TrustedHostMiddleware
from fastapi.responses import FileResponse
from fastapi.staticfiles import StaticFiles
from starlette.concurrency import run_in_threadpool
from pydantic import BaseModel, Field

from analysis import AnalysisRequest, list_analyses
import protection  # noqa: F401  (registra as funções de proteção)
from comtrade_service import store
import hmac

from config import (
    ALLOWED_HOSTS,
    ALLOWED_ORIGINS,
    DESKTOP_TOKEN,
    IS_DESKTOP,
    IS_PRODUCTION,
    MAX_UPLOAD_BYTES,
    ROOT,
    SAMPLES_DIR,
)
from sample_catalog import get_sample_cfg_path, list_samples

STATIC_DIR = ROOT / "static"

app = FastAPI(
    title="Oscilografias COMTRADE",
    version="0.6.1",
    docs_url=None if IS_PRODUCTION else "/docs",
    redoc_url=None if IS_PRODUCTION else "/redoc",
    openapi_url=None if IS_PRODUCTION else "/openapi.json",
)

if ALLOWED_HOSTS != ["*"]:
    app.add_middleware(TrustedHostMiddleware, allowed_hosts=ALLOWED_HOSTS)

app.add_middleware(
    CORSMiddleware,
    allow_origins=ALLOWED_ORIGINS,
    allow_credentials=False,
    allow_methods=["GET", "POST", "DELETE", "OPTIONS"],
    allow_headers=["*"],
)


class LoadPathRequest(BaseModel):
    path: str = Field(..., min_length=1, max_length=4096)


class LoadSampleRequest(BaseModel):
    sample_id: str = Field(..., min_length=1, max_length=260)


class GroupRequest(BaseModel):
    quantity: str = Field(..., pattern="^[VIvi]$")
    label: str = Field("", max_length=60)
    a: int = Field(..., ge=0)
    b: int = Field(..., ge=0)
    c: int = Field(..., ge=0)


class AnalysisBody(BaseModel):
    time_s: float | None = None
    t_start: float | None = None
    t_end: float | None = None
    voltage_group: str | None = Field(None, max_length=200)
    current_group: str | None = Field(None, max_length=200)
    channels: list[int] = Field(default_factory=list, max_length=64)
    params: dict = Field(default_factory=dict)
    max_points: int = Field(3000, ge=50, le=20000)
    inputs: dict[str, str] = Field(default_factory=dict)


def _meta_to_dict(meta) -> dict:
    return {
        "id": meta.id,
        "station": meta.station,
        "device": meta.device,
        "revision": meta.revision,
        "start_time": meta.start_time,
        "trigger_time": meta.trigger_time,
        "sample_rate_hz": meta.sample_rate_hz,
        "total_samples": meta.total_samples,
        "duration_s": meta.duration_s,
        "frequency_hz": meta.frequency_hz,
        "analog_channels": [
            {
                "index": ch.index,
                "name": ch.name,
                "unit": ch.unit,
                "kind": ch.kind,
                "phase": ch.phase,
                "cfg_min": ch.cfg_min,
                "cfg_max": ch.cfg_max,
                "primary": ch.primary,
                "secondary": ch.secondary,
            }
            for ch in meta.analog_channels
        ],
        "digital_channels": [
            {
                "index": ch.index,
                "name": ch.name,
                "unit": ch.unit,
                "kind": ch.kind,
            }
            for ch in meta.digital_channels
        ],
    }


def _error_detail(exc: Exception) -> str:
    if isinstance(exc, ValueError):
        return str(exc)
    if IS_PRODUCTION:
        return "Não foi possível processar a solicitação."
    return str(exc)


async def _save_upload_limited(upload: UploadFile, dest: Path, label: str) -> None:
    """Grava o upload em disco em blocos de 4 MB, respeitando o limite."""
    total = 0
    with dest.open("wb") as fh:
        while True:
            chunk = await upload.read(4 * 1024 * 1024)
            if not chunk:
                break
            total += len(chunk)
            if total > MAX_UPLOAD_BYTES:
                raise HTTPException(
                    status_code=413,
                    detail=f"Arquivo {label} excede o limite de {MAX_UPLOAD_BYTES // (1024 * 1024)} MB "
                    "(ajuste a variável MAX_UPLOAD_BYTES).",
                )
            fh.write(chunk)


@app.middleware("http")
async def security_headers(request: Request, call_next):
    if IS_DESKTOP and request.url.path.startswith("/api/"):
        # Na versão desktop toda chamada de API precisa do token da sessão:
        # impede que outras páginas abertas no navegador usem o servidor local.
        sent = request.headers.get("x-oscilo-token", "")
        if not hmac.compare_digest(sent, DESKTOP_TOKEN):
            from fastapi.responses import JSONResponse

            return JSONResponse({"detail": "Não autorizado."}, status_code=403)
    response = await call_next(request)
    response.headers["X-Content-Type-Options"] = "nosniff"
    response.headers["X-Frame-Options"] = "DENY"
    response.headers["Referrer-Policy"] = "strict-origin-when-cross-origin"
    response.headers["Permissions-Policy"] = "camera=(), microphone=(), geolocation=()"
    if IS_PRODUCTION:
        response.headers["Strict-Transport-Security"] = "max-age=31536000; includeSubDomains"
    path = request.url.path
    if path == "/" or path.startswith("/static/"):
        # sempre revalida HTML/JS/CSS: evita o navegador usar a interface antiga após atualizar
        response.headers["Cache-Control"] = "no-cache"
    return response


@app.get("/api/health")
def health():
    return {"status": "ok", "version": app.version, "desktop": IS_DESKTOP}


@app.post("/api/load/path")
def load_from_local_path(body: LoadPathRequest):
    """Abre um .cfg direto do disco (somente na versão desktop)."""
    if not IS_DESKTOP:
        raise HTTPException(status_code=404, detail="Disponível apenas na versão desktop.")
    cfg_path = Path(body.path).expanduser()
    if cfg_path.suffix.lower() != ".cfg":
        raise HTTPException(status_code=400, detail="Selecione um arquivo .cfg.")
    if not cfg_path.is_file():
        raise HTTPException(status_code=404, detail="Arquivo não encontrado.")
    try:
        meta = store.load_from_path(cfg_path)
        return {**_meta_to_dict(meta), "source_path": str(cfg_path.resolve())}
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=_error_detail(exc)) from exc
    except Exception as exc:
        raise HTTPException(status_code=400, detail=_error_detail(exc)) from exc


@app.post("/api/load/sample")
def load_sample(body: LoadSampleRequest):
    try:
        cfg_path = get_sample_cfg_path(SAMPLES_DIR, body.sample_id.strip())
        meta = store.load_from_path(cfg_path)
        return _meta_to_dict(meta)
    except FileNotFoundError as exc:
        raise HTTPException(status_code=404, detail="Exemplo não encontrado.") from exc
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=_error_detail(exc)) from exc
    except Exception as exc:
        raise HTTPException(status_code=400, detail=_error_detail(exc)) from exc


@app.post("/api/load/upload")
async def load_from_upload(
    cfg: UploadFile = File(...),
    dat: UploadFile | None = File(None),
):
    if not cfg.filename or not cfg.filename.lower().endswith(".cfg"):
        raise HTTPException(status_code=400, detail="Envie um arquivo .cfg válido.")

    if dat and dat.filename and not dat.filename.lower().endswith(".dat"):
        raise HTTPException(status_code=400, detail="O arquivo complementar deve ser .dat.")

    if dat is None:
        raise HTTPException(status_code=400, detail="Arquivo .dat não enviado. Selecione o .cfg e o .dat juntos.")

    try:
        with tempfile.TemporaryDirectory(prefix="oscilo_") as tmp:
            cfg_path = Path(tmp) / "upload.cfg"
            dat_path = Path(tmp) / "upload.dat"
            await _save_upload_limited(cfg, cfg_path, "CFG")
            await _save_upload_limited(dat, dat_path, "DAT")
            # decodificação é CPU-bound: roda fora do loop de eventos
            meta = await run_in_threadpool(store.load_from_upload, cfg_path, dat_path)
        return _meta_to_dict(meta)
    except HTTPException:
        raise
    except Exception as exc:
        raise HTTPException(status_code=400, detail=_error_detail(exc)) from exc


@app.get("/api/records/{record_id}")
def get_record(record_id: str):
    try:
        return _meta_to_dict(store.get_meta(record_id))
    except KeyError as exc:
        raise HTTPException(status_code=404, detail="Registro não encontrado.") from exc


@app.get("/api/records/{record_id}/waveform")
def get_waveform(
    record_id: str,
    channels: str = Query(..., description="Índices separados por vírgula"),
    start_sample: int = Query(0, ge=0),
    end_sample: int | None = Query(None),
    max_points: int = Query(4000, ge=100, le=20000),
):
    try:
        indices = [int(x.strip()) for x in channels.split(",") if x.strip()]
        return store.get_waveform(record_id, indices, start_sample, end_sample, max_points)
    except KeyError as exc:
        raise HTTPException(status_code=404, detail="Registro não encontrado.") from exc
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=_error_detail(exc)) from exc


@app.get("/api/records/{record_id}/value-at-time")
def get_value_at_time(
    record_id: str,
    channels: str = Query(..., description="Índices separados por vírgula"),
    time_s: float = Query(..., description="Tempo em segundos"),
):
    try:
        indices = [int(x.strip()) for x in channels.split(",") if x.strip()]
        return store.get_value_at_time(record_id, indices, time_s)
    except KeyError as exc:
        raise HTTPException(status_code=404, detail="Registro não encontrado.") from exc
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=_error_detail(exc)) from exc


@app.get("/api/records/{record_id}/phasor-config")
def get_phasor_config(record_id: str):
    try:
        return store.get_phasor_config(record_id)
    except KeyError as exc:
        raise HTTPException(status_code=404, detail="Registro não encontrado.") from exc


@app.get("/api/records/{record_id}/derived/waveform")
def get_derived_waveform(
    record_id: str,
    voltage_group: str = Query(...),
    current_group: str = Query(...),
    metrics: str = Query(..., description="Métricas separadas por vírgula"),
    start_sample: int = Query(0, ge=0),
    end_sample: int | None = Query(None),
    window_cycles: float = Query(1.0, ge=0.5, le=10.0),
    max_points: int = Query(4000, ge=100, le=20000),
    estimator: str = Query("ls", max_length=32),
):
    try:
        metric_list = [m.strip() for m in metrics.split(",") if m.strip()]
        return store.get_derived_waveform(
            record_id,
            voltage_group,
            current_group,
            metric_list,
            start_sample,
            end_sample,
            window_cycles,
            max_points,
            estimator,
        )
    except KeyError as exc:
        raise HTTPException(status_code=404, detail="Registro não encontrado.") from exc
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=_error_detail(exc)) from exc


@app.get("/api/records/{record_id}/derived/at-time")
def get_derived_at_time(
    record_id: str,
    voltage_group: str = Query(...),
    current_group: str = Query(...),
    time_s: float = Query(...),
    window_cycles: float = Query(1.0, ge=0.5, le=10.0),
    estimator: str = Query("ls", max_length=32),
):
    try:
        return store.get_derived_at_time(
            record_id, voltage_group, current_group, time_s, window_cycles, estimator
        )
    except KeyError as exc:
        raise HTTPException(status_code=404, detail="Registro não encontrado.") from exc
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=_error_detail(exc)) from exc


@app.post("/api/records/{record_id}/groups")
def add_group(record_id: str, body: GroupRequest):
    try:
        group = store.add_group(record_id, body.quantity, body.label, body.a, body.b, body.c)
        return {"group": group, "config": store.get_phasor_config(record_id)}
    except KeyError as exc:
        raise HTTPException(status_code=404, detail="Registro não encontrado.") from exc
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=_error_detail(exc)) from exc


@app.delete("/api/records/{record_id}/groups/{group_id:path}")
def remove_group(record_id: str, group_id: str):
    try:
        store.remove_group(record_id, group_id)
        return {"config": store.get_phasor_config(record_id)}
    except KeyError as exc:
        raise HTTPException(status_code=404, detail="Registro não encontrado.") from exc
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=_error_detail(exc)) from exc


@app.get("/api/analyses")
def get_analyses():
    """Catálogo de análises disponíveis com o esquema de parâmetros de cada uma."""
    return {"analyses": list_analyses()}


@app.post("/api/records/{record_id}/analyses/{analysis_id}")
def run_analysis(record_id: str, analysis_id: str, body: AnalysisBody):
    try:
        req = AnalysisRequest(**body.model_dump())
        return store.run_analysis(record_id, analysis_id, req)
    except KeyError as exc:
        raise HTTPException(status_code=404, detail=str(exc).strip("'")) from exc
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=_error_detail(exc)) from exc


@app.get("/api/samples")
def list_sample_files():
    """Lista oscilografias de exemplo disponíveis no diretório configurado."""
    return {"samples": list_samples(SAMPLES_DIR)}


@app.get("/")
def index():
    return FileResponse(STATIC_DIR / "index.html")


if STATIC_DIR.exists():
    app.mount("/static", StaticFiles(directory=STATIC_DIR), name="static")
