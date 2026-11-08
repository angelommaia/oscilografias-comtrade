"""Rastreabilidade dos arquivos de origem de um registro (bloco "Informações
de processamento" do relatório).

O SHA-256 do .dat é calculado sob demanda (só ao gerar o relatório), lendo o
arquivo em blocos, e fica guardado no objeto para não ser recalculado. Quando o
.dat não fica em disco (upload da versão web, gravado num diretório temporário
apagado após a leitura), o hash é calculado durante a gravação do upload e
entregue pronto.
"""

from __future__ import annotations

import hashlib
import threading
from dataclasses import dataclass, field
from pathlib import Path

HASH_CHUNK = 1024 * 1024
SHORT_HASH = 12


def sha256_file(path: Path, chunk: int = HASH_CHUNK) -> str:
    """SHA-256 (hex) de um arquivo, lido em blocos – não carrega o arquivo na RAM."""
    h = hashlib.sha256()
    with open(path, "rb") as fh:
        while True:
            block = fh.read(chunk)
            if not block:
                break
            h.update(block)
    return h.hexdigest()


def safe_name(name: str) -> str:
    """Só o nome do arquivo, nunca o caminho (que pode conter usuário e pastas)."""
    return Path((name or "").replace("\\", "/")).name


@dataclass(eq=False)
class SourceFile:
    """Um par .cfg/.dat de origem."""

    name: str  # nome do .cfg (sem caminho)
    revision: str = ""  # revisão COMTRADE (1991/1999/2013)
    data_format: str = ""  # ASCII, BINARY, BINARY32, FLOAT32
    dat_path: Path | None = None  # None quando o .dat não fica em disco
    _sha256: str | None = field(default=None, repr=False)
    _lock: threading.Lock = field(default_factory=threading.Lock, repr=False)

    def __post_init__(self) -> None:
        self.name = safe_name(self.name)

    def sha256(self) -> str | None:
        with self._lock:
            if self._sha256 is None and self.dat_path is not None:
                try:
                    self._sha256 = sha256_file(self.dat_path)
                except OSError:
                    return None
            return self._sha256

    def sha256_short(self) -> str | None:
        full = self.sha256()
        return full[:SHORT_HASH] if full else None


@dataclass
class SourceRef:
    """Arquivo de origem como aparece num registro (no combinado, com rótulo e alinhamento)."""

    file: SourceFile
    label: str = ""
    align_mode: str | None = None  # onset, trigger ou absolute (registro combinado)
    offset_ms: float | None = None
