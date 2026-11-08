"""Versão do Oscilo, lida de uma única fonte: src-tauri/tauri.conf.json.

O mesmo arquivo é usado pelo build do Tauri, por scripts/build.ps1, pelo
release.yml e por scripts/package_web.py. package.json e Cargo.toml repetem o
número (o Cargo exige literal); tests/test_version.py garante que coincidam.

Onde o arquivo é procurado (ROOT vem de config.py):
- código-fonte: <repo>/src-tauri/tauri.conf.json;
- executável PyInstaller: <_MEIPASS>/src-tauri/tauri.conf.json (incluído pelo spec);
- pacote web e Docker: <raiz>/src-tauri/tauri.conf.json (copiado pelo empacotamento).
A variável OSCILO_VERSION, se definida, tem prioridade.
"""

from __future__ import annotations

import json
import os
from functools import lru_cache
from pathlib import Path

from config import ROOT

CONF_PATH = Path("src-tauri") / "tauri.conf.json"


@lru_cache(maxsize=1)
def get_version() -> str:
    env = os.environ.get("OSCILO_VERSION", "").strip()
    if env:
        return env
    try:
        data = json.loads((ROOT / CONF_PATH).read_text(encoding="utf-8"))
        v = str(data.get("version") or "").strip()
        if v:
            return v
    except (OSError, ValueError):
        pass
    return "dev"
