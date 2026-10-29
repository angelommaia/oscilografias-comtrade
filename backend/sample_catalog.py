"""Catálogo de oscilografias de exemplo com acesso restrito ao diretório configurado."""

from __future__ import annotations

import re
from pathlib import Path

_SAMPLE_ID_RE = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._\-/ ]*[A-Za-z0-9]$|^[A-Za-z0-9]$")


def _is_safe_sample_id(sample_id: str) -> bool:
    if not sample_id or ".." in sample_id:
        return False
    if sample_id.startswith(("/", "\\")):
        return False
    if any(part in (".", "..") for part in sample_id.replace("\\", "/").split("/")):
        return False
    return bool(_SAMPLE_ID_RE.match(sample_id))


def _resolve_cfg(samples_dir: Path, sample_id: str) -> Path:
    if not _is_safe_sample_id(sample_id):
        raise ValueError("ID de exemplo inválido")

    root = samples_dir.resolve()
    cfg = (root / f"{sample_id}.cfg").resolve()

    if not cfg.is_file():
        raise FileNotFoundError(f"Exemplo não encontrado: {sample_id}")

    try:
        cfg.relative_to(root)
    except ValueError as exc:
        raise ValueError("Acesso ao exemplo negado") from exc

    return cfg


def list_samples(samples_dir: Path) -> list[dict[str, object]]:
    if not samples_dir.exists():
        return []

    root = samples_dir.resolve()
    samples: list[dict[str, object]] = []

    for cfg in sorted(root.rglob("*.cfg")):
        try:
            rel = cfg.relative_to(root)
        except ValueError:
            continue

        sample_id = rel.with_suffix("").as_posix()
        if not _is_safe_sample_id(sample_id):
            continue

        dat_candidates = [cfg.with_suffix(".dat"), cfg.with_suffix(".DAT")]
        has_dat = any(path.is_file() for path in dat_candidates)
        folder = rel.parent.as_posix()
        if folder == ".":
            folder = ""

        samples.append(
            {
                "id": sample_id,
                "name": cfg.stem,
                "folder": folder,
                "has_dat": has_dat,
            }
        )

    return samples


def get_sample_cfg_path(samples_dir: Path, sample_id: str) -> Path:
    return _resolve_cfg(samples_dir, sample_id)
