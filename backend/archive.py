"""Fontes de registros além do par .cfg/.dat: .cff (COMTRADE 2013 combinado),
.zip, pastas e conjuntos de arquivos soltos (arrastar e soltar).

Fluxo: ``collect()`` examina as entradas (expandindo ZIPs num diretório de
trabalho) e devolve os *candidatos* – cada par .cfg/.dat ou .cff encontrado –
com um resumo lido só do início do .cfg. Nada é decodificado aqui; o registro
escolhido é carregado depois pelo ComtradeStore. ``split_cff()`` separa um
.cff em .cfg/.dat (e .inf/.hdr) por cópia em blocos, sem ler tudo na memória.

Segurança dos ZIPs: só são extraídos membros com extensão COMTRADE (e ZIPs
internos, 1 nível), caminhos absolutos ou com ".." são recusados, e o total
descompactado é limitado (contado nos bytes realmente gravados, não no
cabeçalho do ZIP, que pode mentir).
"""

from __future__ import annotations

import re
import shutil
import tempfile
import threading
import uuid
import zipfile
from dataclasses import dataclass, field
from pathlib import Path, PurePosixPath
from typing import Any, Iterable

COMTRADE_EXT = {".cfg", ".dat", ".cff", ".inf", ".hdr"}
ACCEPTED_EXT = COMTRADE_EXT | {".zip"}
MAX_MEMBERS = 5000
MAX_CANDIDATES = 500
MAX_DIR_DEPTH = 4
_CHUNK = 4 * 1024 * 1024

_CFF_HEADER = re.compile(
    rb"^\s*-{2,}\s*file\s*type\s*:\s*(CFG|INF|HDR|DAT)\s*(ASCII|BINARY32|BINARY|FLOAT32)?\s*(?::\s*(\d+))?\s*-{2,}\s*$",
    re.I,
)


class ArchiveError(ValueError):
    """Entrada inválida (mensagem pronta para o usuário)."""


@dataclass
class Candidate:
    key: str
    kind: str  # "cfg" | "cff"
    path: Path  # .cfg ou .cff
    display: str  # caminho relativo exibido (ex.: "evento1/REG.cfg")
    container: str = ""  # nome do .zip/pasta de origem ("" para arquivo solto)
    temporary: bool = False  # True quando está no diretório de trabalho
    size: int = 0  # bytes do .dat (ou do .cff)
    info: dict[str, Any] = field(default_factory=dict)

    @property
    def source_name(self) -> str:
        # caminho relativo inteiro: registros de mesmo nome em pastas diferentes
        # (ex.: "T1/registro.cfg" e "T2/registro.cfg") ficam distinguíveis
        return f"{self.display} ({self.container})" if self.container else self.display

    def to_dict(self) -> dict[str, Any]:
        rel = PurePosixPath(self.display)
        folder = str(rel.parent) if str(rel.parent) != "." else ""
        return {"key": self.key, "kind": self.kind, "name": rel.name, "folder": folder, "path": self.display,
                "container": self.container, "size": self.size, **self.info}


# ---------------------------------------------------------------------------
# .cff
# ---------------------------------------------------------------------------
def _cff_sections(fh) -> Iterable[tuple[str, str, int | None]]:
    """Itera os cabeçalhos de seção, deixando ``fh`` posicionado no conteúdo."""
    while True:
        line = fh.readline()
        if not line:
            return
        m = _CFF_HEADER.match(line.rstrip(b"\r\n"))
        if m:
            yield m.group(1).upper().decode(), (m.group(2) or b"").upper().decode(), (
                int(m.group(3)) if m.group(3) else None)


def split_cff(cff_path: Path, out_dir: Path, max_bytes: int | None = None) -> Path:
    """Separa o .cff em <nome>.cfg/.dat (+ .inf/.hdr) dentro de ``out_dir``.
    Devolve o caminho do .cfg."""
    out_dir.mkdir(parents=True, exist_ok=True)
    stem = out_dir / cff_path.stem
    found: set[str] = set()
    with cff_path.open("rb") as fh:
        first = fh.readline()
        if not _CFF_HEADER.match(first.rstrip(b"\r\n")):
            raise ArchiveError(f"{cff_path.name}: não parece um .cff (falta a linha '--- file type: CFG ---').")
        fh.seek(0)
        pending = None  # cabeçalho já lido ao fim de uma seção de texto
        sections = _cff_sections(fh)
        while True:
            hdr = pending or next(sections, None)
            pending = None
            if hdr is None:
                break
            kind, fmt, nbytes = hdr
            ext = {"CFG": ".cfg", "INF": ".inf", "HDR": ".hdr", "DAT": ".dat"}[kind]
            found.add(kind)
            with stem.with_suffix(ext).open("wb") as out:
                if kind == "DAT" and fmt != "ASCII":
                    # binário: exatamente nbytes (ou o resto do arquivo se o tamanho não veio)
                    remaining = nbytes
                    written = 0
                    while remaining is None or remaining > 0:
                        chunk = fh.read(_CHUNK if remaining is None else min(_CHUNK, remaining))
                        if not chunk:
                            break
                        out.write(chunk)
                        written += len(chunk)
                        if remaining is not None:
                            remaining -= len(chunk)
                        if max_bytes is not None and written > max_bytes:
                            raise ArchiveError("Arquivo .cff maior que o limite permitido.")
                    if nbytes is not None and written < nbytes:
                        raise ArchiveError(f"{cff_path.name}: seção DAT truncada ({written} de {nbytes} bytes).")
                    continue
                # seções de texto (e DAT ASCII): até o próximo cabeçalho
                while True:
                    line = fh.readline()
                    if not line:
                        break
                    m = _CFF_HEADER.match(line.rstrip(b"\r\n"))
                    if m:
                        pending = (m.group(1).upper().decode(), (m.group(2) or b"").upper().decode(),
                                   int(m.group(3)) if m.group(3) else None)
                        break
                    out.write(line)
    if "CFG" not in found or "DAT" not in found:
        raise ArchiveError(f"{cff_path.name}: .cff sem seção {'CFG' if 'CFG' not in found else 'DAT'}.")
    return stem.with_suffix(".cfg")


def _cff_cfg_head(cff_path: Path, limit: int = 256 * 1024) -> list[str]:
    """Linhas da seção CFG de um .cff (para o resumo), sem ler o DAT."""
    lines: list[str] = []
    with cff_path.open("rb") as fh:
        fh.readline()  # cabeçalho CFG
        read = 0
        for raw in fh:
            read += len(raw)
            if _CFF_HEADER.match(raw.rstrip(b"\r\n")) or read > limit:
                break
            lines.append(raw.decode("latin-1").rstrip("\r\n"))
    return lines


# ---------------------------------------------------------------------------
# Resumo do .cfg (sem decodificar o .dat)
# ---------------------------------------------------------------------------
def peek_cfg_lines(lines: list[str]) -> dict[str, Any]:
    info: dict[str, Any] = {}
    try:
        first = [x.strip() for x in lines[0].split(",")]
        info["station"] = first[0] if first else ""
        info["device"] = first[1] if len(first) > 1 else ""
        info["revision"] = first[2] if len(first) > 2 else "1991"
        counts = [x.strip().upper() for x in lines[1].split(",")]
        total = int(counts[0])
        info["analog"] = int(counts[1].rstrip("A")) if len(counts) > 1 else 0
        info["digital"] = int(counts[2].rstrip("D")) if len(counts) > 2 else 0
        i = 2 + total
        info["frequency_hz"] = float(lines[i]); i += 1
        nrates = int(lines[i]); i += 1
        rates = []
        for _ in range(max(nrates, 1)):
            parts = lines[i].split(","); i += 1
            rates.append((float(parts[0]), int(float(parts[1]))))
        info["sample_rate_hz"] = rates[0][0] if rates else None
        info["samples"] = rates[-1][1] if rates else None
        info["start"] = lines[i].strip(); i += 1
        info["trigger"] = lines[i].strip()
    except (IndexError, ValueError):
        pass
    return info


def peek_cfg(path: Path, limit: int = 256 * 1024) -> dict[str, Any]:
    try:
        with path.open("rb") as fh:
            text = fh.read(limit).decode("latin-1")
    except OSError:
        return {}
    return peek_cfg_lines(text.splitlines())


# ---------------------------------------------------------------------------
# Nomes enviados pelo navegador
# ---------------------------------------------------------------------------
_BAD_CHARS = re.compile(r'[<>:"|?*\x00-\x1f]')


def safe_relative(name: str | None, max_parts: int = MAX_DIR_DEPTH + 2) -> PurePosixPath:
    """Caminho relativo seguro a partir do nome enviado no upload
    ("Pasta/sub/A.cfg" quando vem de uma pasta solta). Remove unidade, raiz,
    "." e "..", troca caracteres proibidos no Windows e limita a profundidade
    (mantém as últimas partes). Nunca devolve caminho vazio nem absoluto."""
    raw = (name or "").replace("\\", "/")
    raw = re.sub(r"^[A-Za-z]:", "", raw)
    parts = []
    for part in raw.split("/"):
        part = _BAD_CHARS.sub("_", part).strip().rstrip(".")
        if part and part not in (".", ".."):
            parts.append(part[:120])
    parts = parts[-max_parts:] or ["arquivo"]
    return PurePosixPath(*parts)


# ---------------------------------------------------------------------------
# ZIP
# ---------------------------------------------------------------------------
def _safe_member(name: str) -> PurePosixPath | None:
    p = PurePosixPath(name.replace("\\", "/"))
    if p.is_absolute() or any(part in ("..", "") for part in p.parts) or re.match(r"^[A-Za-z]:", name):
        return None
    return p


def extract_zip(zip_path: Path, out_dir: Path, budget: list[int], depth: int = 0) -> None:
    """Extrai só os membros COMTRADE de ``zip_path`` em ``out_dir``.
    ``budget`` = [bytes restantes] compartilhado entre ZIPs aninhados."""
    try:
        zf = zipfile.ZipFile(zip_path)
    except zipfile.BadZipFile as exc:
        raise ArchiveError(f"{zip_path.name}: arquivo ZIP inválido ou corrompido.") from exc
    with zf:
        members = [m for m in zf.infolist() if not m.is_dir()]
        if len(members) > MAX_MEMBERS:
            raise ArchiveError(f"{zip_path.name}: arquivos demais no ZIP ({len(members)}).")
        for m in members:
            rel = _safe_member(m.filename)
            if rel is None:
                continue  # caminho perigoso: ignorado
            ext = rel.suffix.lower()
            if ext not in ACCEPTED_EXT or (ext == ".zip" and depth >= 1):
                continue
            if m.flag_bits & 0x1:
                raise ArchiveError(f"{zip_path.name}: ZIP protegido por senha não é suportado.")
            dest = out_dir.joinpath(*rel.parts)
            dest.parent.mkdir(parents=True, exist_ok=True)
            with zf.open(m) as src, dest.open("wb") as out:
                while True:
                    chunk = src.read(_CHUNK)
                    if not chunk:
                        break
                    budget[0] -= len(chunk)
                    if budget[0] < 0:
                        raise ArchiveError("Conteúdo descompactado maior que o limite permitido.")
                    out.write(chunk)
            if ext == ".zip":
                inner = dest.with_name(dest.name + "_")
                extract_zip(dest, inner, budget, depth + 1)
                dest.unlink(missing_ok=True)


# ---------------------------------------------------------------------------
# Coleta de candidatos
# ---------------------------------------------------------------------------
def _walk(root: Path, depth: int = 0) -> Iterable[Path]:
    try:
        entries = sorted(root.iterdir(), key=lambda p: p.name.lower())
    except OSError:
        return
    for p in entries:
        if p.is_dir():
            if depth < MAX_DIR_DEPTH:
                yield from _walk(p, depth + 1)
        elif p.suffix.lower() in COMTRADE_EXT:
            yield p


def _pair(files: Iterable[Path], base: Path | None, container: str, temporary: bool) -> list[Candidate]:
    by_dir: dict[Path, dict[str, dict[str, Path]]] = {}
    for f in files:
        by_dir.setdefault(f.parent, {}).setdefault(f.stem.lower(), {})[f.suffix.lower()] = f
    out: list[Candidate] = []
    for folder in sorted(by_dir, key=lambda p: str(p).lower()):
        for stem in sorted(by_dir[folder]):
            group = by_dir[folder][stem]
            for kind in ("cfg", "cff"):
                path = group.get(f".{kind}")
                if path is None or (kind == "cfg" and ".dat" not in group):
                    continue
                try:
                    display = str(path.relative_to(base)).replace("\\", "/") if base else path.name
                except ValueError:
                    display = path.name
                display = re.sub(r"\.zip_/", ".zip/", display)
                if kind == "cfg":
                    size = group[".dat"].stat().st_size
                    info = peek_cfg(path)
                else:
                    size = path.stat().st_size
                    info = peek_cfg_lines(_cff_cfg_head(path))
                out.append(Candidate(key="", kind=kind, path=path, display=display, container=container,
                                     temporary=temporary, size=size, info=info))
    return out


def collect(inputs: list[Path], workdir: Path, max_extract: int,
            loose_base: Path | None = None) -> tuple[list[Candidate], list[str]]:
    """Candidatos a registro em ``inputs`` (arquivos, pastas ou .zip).
    Devolve (candidatos, avisos). ZIPs são extraídos em ``workdir``.
    ``loose_base``: raiz dos arquivos soltos para exibir o caminho relativo
    (upload de pastas soltas no navegador); sem ela, só o nome."""
    budget = [max_extract]
    loose: list[Path] = []
    cands: list[Candidate] = []
    notes: list[str] = []
    for i, p in enumerate(inputs):
        if p.is_dir():
            cands += _pair(_walk(p), p, p.name, temporary=False)
        elif p.suffix.lower() == ".zip":
            dest = workdir / f"z{i}"
            dest.mkdir(parents=True, exist_ok=True)
            extract_zip(p, dest, budget)
            zcands = _pair(_walk(dest), dest, p.name, temporary=True)
            if loose_base is not None and _is_within(p, loose_base):
                # ZIP de dentro de uma pasta solta: mostra a pasta antes do conteúdo
                parent = PurePosixPath(*p.parent.resolve().relative_to(loose_base.resolve()).parts)
                if str(parent) != ".":
                    for c in zcands:
                        c.display = f"{parent}/{c.display}"
            cands += zcands
        elif p.suffix.lower() in COMTRADE_EXT:
            loose.append(p)
        else:
            notes.append(f"{p.name}: tipo de arquivo ignorado")
    # arquivos soltos: .dat pode vir sem o .cfg na lista, mas ao lado dele no disco
    extra = []
    stems = {(f.parent, f.stem.lower()) for f in loose}
    for f in loose:
        if f.suffix.lower() == ".dat":
            for ext in (".cfg", ".CFG", ".Cfg"):
                cfg = f.with_suffix(ext)
                if cfg.is_file() and (cfg.parent, cfg.stem.lower()) in stems and cfg not in loose:
                    extra.append(cfg)
                    break
        elif f.suffix.lower() == ".cfg":
            for ext in (".dat", ".DAT", ".Dat"):
                dat = f.with_suffix(ext)
                if dat.is_file() and dat not in loose:
                    extra.append(dat)
                    break
    temp_loose = any(_is_within(f, workdir) for f in loose)
    cands += _pair(loose + extra, loose_base, "", temporary=temp_loose)
    for f in loose:
        if f.suffix.lower() == ".cfg" and not any(c.path == f for c in cands):
            notes.append(f"{f.name}: falta o .dat correspondente")
        if f.suffix.lower() == ".dat" and not any(c.path.with_suffix("").name.lower() == f.stem.lower()
                                                  and c.path.parent == f.parent for c in cands):
            notes.append(f"{f.name}: falta o .cfg correspondente")
    if len(cands) > MAX_CANDIDATES:
        notes.append(f"Mostrando os primeiros {MAX_CANDIDATES} de {len(cands)} registros.")
        cands = cands[:MAX_CANDIDATES]
    for n, c in enumerate(cands):
        c.key = f"r{n}"
    return cands, notes


def _is_within(path: Path, root: Path) -> bool:
    try:
        path.resolve().relative_to(root.resolve())
        return True
    except ValueError:
        return False


# ---------------------------------------------------------------------------
# Área de preparação (lista mostrada ao usuário antes de carregar)
# ---------------------------------------------------------------------------
@dataclass
class Staging:
    id: str
    tmp: tempfile.TemporaryDirectory
    candidates: dict[str, Candidate]
    title: str

    @property
    def dir(self) -> Path:
        return Path(self.tmp.name)


class StagingArea:
    """Guarda as últimas listagens (e os arquivos extraídos) até o usuário
    escolher; as mais antigas são apagadas."""

    def __init__(self, keep: int = 3) -> None:
        self._keep = keep
        self._items: dict[str, Staging] = {}
        self._lock = threading.Lock()

    def new_dir(self) -> tempfile.TemporaryDirectory:
        return tempfile.TemporaryDirectory(prefix="oscilo_in_", ignore_cleanup_errors=True)

    def add(self, tmp: tempfile.TemporaryDirectory, candidates: list[Candidate], title: str) -> Staging:
        st = Staging(uuid.uuid4().hex[:12], tmp, {c.key: c for c in candidates}, title)
        with self._lock:
            self._items[st.id] = st
            while len(self._items) > self._keep:
                old = self._items.pop(next(iter(self._items)))
                old.tmp.cleanup()
        return st

    def get(self, staging_id: str) -> Staging:
        with self._lock:
            st = self._items.get(staging_id)
        if st is None:
            raise KeyError(staging_id)
        return st

    def drop(self, staging_id: str) -> None:
        with self._lock:
            st = self._items.pop(staging_id, None)
        if st:
            st.tmp.cleanup()


def materialize(c: Candidate, workdir: Path, max_bytes: int | None = None) -> tuple[Path, bool]:
    """Caminho do .cfg pronto para o leitor (separa o .cff se preciso) e se o
    .dat é temporário."""
    if c.kind == "cff":
        out = workdir / "cff" / c.key
        cfg = split_cff(c.path, out, max_bytes)
        return cfg, True
    return c.path, c.temporary


def remove_tree(path: Path) -> None:
    shutil.rmtree(path, ignore_errors=True)
