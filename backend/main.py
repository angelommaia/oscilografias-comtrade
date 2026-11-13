"""API FastAPI para visualização de oscilografias COMTRADE."""

from __future__ import annotations

import hashlib
import re
import tempfile
from pathlib import Path

from fastapi import FastAPI, File, HTTPException, Query, Request, UploadFile
from fastapi.middleware.cors import CORSMiddleware
from fastapi.middleware.trustedhost import TrustedHostMiddleware
from fastapi.responses import FileResponse, Response
from fastapi.staticfiles import StaticFiles
from starlette.concurrency import run_in_threadpool
from pydantic import BaseModel, Field

from analysis import AnalysisRequest, list_analyses
import protection  # noqa: F401  (registra as funções de proteção)
from comtrade_service import store
import archive
from merge import DEFAULT_MODE as MERGE_DEFAULT_MODE, MODES as MERGE_MODES, MergeIncompatible, merge_records, preview_alignment
from timequality import summary as time_summary
from report import ReportOptions, build_report
import hmac

from config import (
    ALLOWED_HOSTS,
    ALLOWED_ORIGINS,
    DESKTOP_TOKEN,
    IS_DESKTOP,
    IS_PRODUCTION,
    MAX_EXTRACT_BYTES,
    MAX_UPLOAD_BYTES,
    ROOT,
    SAMPLES_DIR,
)
from sample_catalog import get_sample_cfg_path, list_samples
from version import get_version

STATIC_DIR = ROOT / "static"

app = FastAPI(
    title="Oscilografias COMTRADE",
    version=get_version(),
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
    path: str | None = Field(None, min_length=1, max_length=4096)
    paths: list[str] | None = Field(None, max_length=200)


class LoadStagedRequest(BaseModel):
    staging: str = Field(..., min_length=1, max_length=40)
    keys: list[str] = Field(..., min_length=1, max_length=6)


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


class MergeItem(BaseModel):
    id: str = Field(..., max_length=64)
    label: str = Field("", max_length=40)
    offset_ms: float = Field(0.0, ge=-3_600_000, le=3_600_000)


class MergeBody(BaseModel):
    records: list[MergeItem] = Field(..., min_length=2, max_length=6)
    mode: str = Field(MERGE_DEFAULT_MODE, max_length=16)
    reference: str | None = Field(None, max_length=64)
    force: bool = False  # GPS: juntar mesmo com horários incompatíveis (com aviso)


class ReportImage(BaseModel):
    caption: str = Field("", max_length=300)
    data: str = Field(..., max_length=9_000_000)  # PNG em base64 (ou data URL)


class ReportBody(BaseModel):
    format: str = Field("docx", pattern="^(docx|html)$")
    title: str = Field("Relatório de análise de perturbação", max_length=200)
    analyst: str = Field("", max_length=120)
    occurrence: str = Field("", max_length=200)
    comments: str = Field("", max_length=20_000)
    conclusion: str = Field("", max_length=20_000)
    sections: dict[str, bool] = Field(default_factory=dict)
    voltage_group: str | None = Field(None, max_length=200)
    current_group: str | None = Field(None, max_length=200)
    summary_params: dict = Field(default_factory=dict)
    cursors: dict | None = None
    images: list[ReportImage] = Field(default_factory=list, max_length=12)
    source_name: str = Field("", max_length=260)
    save_path: str | None = Field(None, max_length=4096)  # só na versão desktop
    # rastreabilidade (opcionais – payloads antigos continuam válidos)
    generated_at: str = Field("", max_length=40)  # data/hora local do analista, formatada
    estimator: str | None = Field(None, max_length=40)
    window_cycles: float | None = Field(None, gt=0, le=16)
    impedance_params: dict | None = None  # só quando a figura da aba R-X vai no relatório


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
        "source_name": meta.source_name,
        "merge": meta.merge,
        "time_quality": meta.time_quality,
        "time_summary": time_summary(meta.time_quality) if meta.merge is None else None,
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


async def _save_upload_limited(upload: UploadFile, dest: Path, label: str) -> str:
    """Grava o upload em disco em blocos de 4 MB, respeitando o limite.
    Devolve o SHA-256 do conteúdo, calculado durante a gravação (o arquivo
    temporário é apagado logo após a leitura e não poderia ser relido depois)."""
    total = 0
    digest = hashlib.sha256()
    with dest.open("wb") as fh:
        while True:
            chunk = await upload.read(4 * 1024 * 1024)
            if not chunk:
                break
            digest.update(chunk)
            total += len(chunk)
            if total > MAX_UPLOAD_BYTES:
                raise HTTPException(
                    status_code=413,
                    detail=f"Arquivo {label} excede o limite de {MAX_UPLOAD_BYTES // (1024 * 1024)} MB "
                    "(ajuste a variável MAX_UPLOAD_BYTES).",
                )
            fh.write(chunk)
    return digest.hexdigest()


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


staging = archive.StagingArea()


def _open_inputs(inputs: list[Path], tmp, title: str, source_path: str | None = None,
                 loose_base: Path | None = None) -> dict:
    """Um registro → carrega e devolve o meta; vários → lista para o usuário
    escolher ({"choose": …}); nenhum → 400 com o motivo."""
    keep_tmp = False
    try:
        try:
            cands, notes = archive.collect(inputs, Path(tmp.name), MAX_EXTRACT_BYTES, loose_base)
        except archive.ArchiveError as exc:
            raise HTTPException(status_code=400, detail=str(exc)) from exc
        if not cands:
            why = "; ".join(notes[:5])
            raise HTTPException(
                status_code=400,
                detail="Nenhum registro COMTRADE encontrado (.cfg + .dat, .cff ou .zip com eles)"
                + (f": {why}." if why else "."),
            )
        if len(cands) == 1:
            try:
                meta = store.load_candidate(cands[0], Path(tmp.name), MAX_EXTRACT_BYTES)
            except archive.ArchiveError as exc:
                raise HTTPException(status_code=400, detail=str(exc)) from exc
            except Exception as exc:
                raise HTTPException(status_code=400, detail=_error_detail(exc)) from exc
            out = {**_meta_to_dict(meta), "notes": notes}
            if source_path:
                out["source_path"] = source_path
            return out
        st = staging.add(tmp, cands, title)
        keep_tmp = True
        return {"choose": {"staging": st.id, "title": title, "notes": notes,
                           "records": [c.to_dict() for c in cands]}}
    finally:
        if not keep_tmp:
            tmp.cleanup()


@app.post("/api/load/path")
def load_from_local_path(body: LoadPathRequest):
    """Abre do disco (somente na versão desktop): .cfg (com o .dat ao lado),
    .cff, .zip, pasta ou vários desses (arrastar e soltar)."""
    if not IS_DESKTOP:
        raise HTTPException(status_code=404, detail="Disponível apenas na versão desktop.")
    raw = [p for p in ([body.path] if body.path else []) + (body.paths or []) if p]
    if not raw:
        raise HTTPException(status_code=400, detail="Nenhum arquivo informado.")
    paths = [Path(p).expanduser() for p in raw]
    for p in paths:
        if not p.exists():
            raise HTTPException(status_code=404, detail=f"Arquivo não encontrado: {p.name}")
    single_cfg = len(paths) == 1 and paths[0].suffix.lower() == ".cfg"
    if not single_cfg:
        title = paths[0].name if len(paths) == 1 else f"{len(paths)} itens"
        src = str(paths[0].resolve()) if len(paths) == 1 else None
        return _open_inputs(paths, staging.new_dir(), title, src)
    cfg_path = paths[0]
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
        meta = store.load_from_path(cfg_path, f"{body.sample_id.strip()}.cfg")
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
            dat_sha256 = await _save_upload_limited(dat, dat_path, "DAT")
            # decodificação é CPU-bound: roda fora do loop de eventos
            meta = await run_in_threadpool(store.load_from_upload, cfg_path, dat_path,
                                           Path((cfg.filename or "").replace("\\", "/")).name or None,
                                           dat_sha256)
        return _meta_to_dict(meta)
    except HTTPException:
        raise
    except Exception as exc:
        raise HTTPException(status_code=400, detail=_error_detail(exc)) from exc


@app.post("/api/load/files")
async def load_from_files(files: list[UploadFile] = File(...)):
    """Web: arquivos soltos ou escolhidos (.cfg/.dat, .cff, .zip, vários de uma vez)."""
    if not files or len(files) > 200:
        raise HTTPException(status_code=400, detail="Envie de 1 a 200 arquivos.")
    tmp = staging.new_dir()
    try:
        up = Path(tmp.name) / "up"
        up.mkdir()
        inputs: list[Path] = []
        for f in files:
            # O nome pode trazer subpastas ("Pasta/sub/A.cfg") quando o usuário
            # solta uma pasta: preservá-las mantém juntos o .cfg e o .dat de
            # cada pasta e separa registros de mesmo nome.
            rel = archive.safe_relative(f.filename)
            if rel.suffix.lower() not in archive.ACCEPTED_EXT:
                continue
            dest = up.joinpath(*rel.parts)
            dest.parent.mkdir(parents=True, exist_ok=True)
            n = 1
            while dest.exists():  # mesmo caminho enviado duas vezes
                dest = dest.with_name(f"{rel.stem}~{n}{rel.suffix}")
                n += 1
            await _save_upload_limited(f, dest, rel.name)
            inputs.append(dest)
        if not inputs:
            raise HTTPException(status_code=400, detail="Nenhum arquivo .cfg, .dat, .cff ou .zip enviado.")
    except BaseException:
        tmp.cleanup()
        raise
    tops = {p.relative_to(up).parts[0] for p in inputs if len(p.relative_to(up).parts) > 1}
    if len(files) == 1:
        title = files[0].filename
    elif len(tops) == 1 and all(len(p.relative_to(up).parts) > 1 for p in inputs):
        title = next(iter(tops))  # uma pasta solta: o nome dela
    else:
        title = f"{len(inputs)} arquivos"
    return await run_in_threadpool(_open_inputs, inputs, tmp, archive_safe_name(title), None, up)


def archive_safe_name(name: str | None) -> str:
    base = Path((name or "").replace("\\", "/")).name.strip() or "arquivo"
    return re.sub(r'[<>:"|?*\x00-\x1f]', "_", base)[:200]


@app.post("/api/load/staged")
def load_staged(body: LoadStagedRequest):
    """Carrega os registros escolhidos de uma listagem (.zip/pasta/vários arquivos)."""
    try:
        st = staging.get(body.staging)
    except KeyError as exc:
        raise HTTPException(status_code=410, detail="A lista expirou; abra o arquivo novamente.") from exc
    out = []
    for key in body.keys:
        cand = st.candidates.get(key)
        if cand is None:
            raise HTTPException(status_code=400, detail="Registro inválido na lista.")
        try:
            meta = store.load_candidate(cand, st.dir, MAX_EXTRACT_BYTES)
        except archive.ArchiveError as exc:
            raise HTTPException(status_code=400, detail=str(exc)) from exc
        except Exception as exc:
            raise HTTPException(status_code=400, detail=f"{cand.display}: {_error_detail(exc)}") from exc
        out.append(_meta_to_dict(meta))
    return {"records": out}


@app.delete("/api/load/staged/{staging_id}")
def drop_staged(staging_id: str):
    staging.drop(staging_id)
    return {"ok": True}


@app.get("/api/records")
def list_loaded_records():
    """Registros na memória do servidor (mais recentes primeiro)."""
    return {"records": [
        {
            "id": m.id,
            "station": m.station,
            "device": m.device,
            "source_name": m.source_name,
            "start_time": m.start_time,
            "trigger_time": m.trigger_time,
            "sample_rate_hz": m.sample_rate_hz,
            "duration_s": m.duration_s,
            "analog": len(m.analog_channels),
            "digital": len(m.digital_channels),
            "merged": m.merge is not None,
            "revision": m.revision,
            "time_summary": time_summary(m.time_quality) if m.merge is None else None,
        }
        for m in store.list_records()
    ]}


@app.post("/api/merge")
def merge(body: MergeBody):
    """Junta 2 a 6 registros carregados numa base de tempo comum (registro combinado)."""
    if body.mode not in MERGE_MODES:
        raise HTTPException(status_code=400, detail="Modo de alinhamento inválido.")
    try:
        meta = run_merge(body)
        return _meta_to_dict(meta)
    except KeyError as exc:
        raise HTTPException(status_code=404, detail="Registro não encontrado (abra-o novamente).") from exc
    except MergeIncompatible as exc:
        # 409: a interface oferece outro modo ou "juntar mesmo assim" (não troca sozinha)
        raise HTTPException(status_code=409, detail={"message": str(exc), "problems": exc.problems,
                                                     "forceable": all(p["status"] != "invalid" for p in exc.problems)}) from exc
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=_error_detail(exc)) from exc


@app.post("/api/merge/preview")
def merge_preview(body: MergeBody):
    """Candidatos de alinhamento, compatibilidade do GPS e qualidade de tempo, sem juntar."""
    if body.mode not in MERGE_MODES:
        raise HTTPException(status_code=400, detail="Modo de alinhamento inválido.")
    try:
        return preview_alignment(store, [r.model_dump() for r in body.records], body.mode, body.reference)
    except KeyError as exc:
        raise HTTPException(status_code=404, detail="Registro não encontrado (abra-o novamente).") from exc
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=_error_detail(exc)) from exc


def run_merge(body: MergeBody):
    return merge_records(store, [r.model_dump() for r in body.records], body.mode, body.reference, body.force)


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
    time_s: float | None = Query(None, description="Tempo em segundos"),
    times: str | None = Query(None, description="Vários instantes (s) separados por vírgula"),
    mode: str = Query("inst", description="inst | true_rms | fund"),
):
    try:
        indices = [int(x.strip()) for x in channels.split(",") if x.strip()]
        many = [float(x) for x in (times or "").split(",") if x.strip()]
        return store.get_value_at_time(record_id, indices, time_s, times=many, mode=mode)
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


@app.post("/api/records/{record_id}/report")
def make_report(record_id: str, body: ReportBody):
    """Gera o relatório (DOCX ou HTML). Na versão desktop pode gravar direto no
    caminho escolhido no diálogo "Salvar"."""
    try:
        ctx = store.context(record_id)
        opts = ReportOptions(
            title=body.title.strip() or "Relatório de análise de perturbação",
            analyst=body.analyst.strip(),
            occurrence=body.occurrence.strip(),
            comments=body.comments,
            conclusion=body.conclusion,
            sections=body.sections,
            voltage_group=body.voltage_group,
            current_group=body.current_group,
            summary_params=body.summary_params,
            cursors=body.cursors,
            images=[img.model_dump() for img in body.images],
            source_name=Path(body.source_name.replace("\\", "/")).name,
            app_version=app.version,
            generated_at=body.generated_at.strip(),
            estimator=body.estimator,
            window_cycles=body.window_cycles,
            impedance_params=body.impedance_params,
        )
        content = build_report(ctx, opts, body.format)
    except KeyError as exc:
        raise HTTPException(status_code=404, detail="Registro não encontrado.") from exc
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=_error_detail(exc)) from exc

    media = ("application/vnd.openxmlformats-officedocument.wordprocessingml.document"
             if body.format == "docx" else "text/html; charset=utf-8")
    if body.save_path:
        if not IS_DESKTOP:
            raise HTTPException(status_code=404, detail="Gravar em disco só na versão desktop.")
        dest = Path(body.save_path).expanduser()
        if dest.suffix.lower() != f".{body.format}":
            dest = dest.with_suffix(f".{body.format}")
        if not dest.parent.is_dir():
            raise HTTPException(status_code=400, detail="Pasta de destino inexistente.")
        try:
            dest.write_bytes(content)
        except OSError as exc:
            raise HTTPException(status_code=400, detail=f"Não foi possível gravar: {exc}") from exc
        return {"saved": str(dest.resolve()), "bytes": len(content)}
    return Response(content=content, media_type=media,
                    headers={"Content-Disposition": f'attachment; filename="relatorio.{body.format}"'})


@app.get("/api/samples")
def list_sample_files():
    """Lista oscilografias de exemplo disponíveis no diretório configurado."""
    return {"samples": list_samples(SAMPLES_DIR)}


@app.get("/")
def index():
    return FileResponse(STATIC_DIR / "index.html")


if STATIC_DIR.exists():
    app.mount("/static", StaticFiles(directory=STATIC_DIR), name="static")
