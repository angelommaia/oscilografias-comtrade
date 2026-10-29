"""Configuração da aplicação via variáveis de ambiente."""

from __future__ import annotations

import os
import sys
from pathlib import Path

# Raiz com static/ e samples/: variável OSCILO_ROOT, pasta do executável
# empacotado (PyInstaller) ou a raiz do repositório.
if os.environ.get("OSCILO_ROOT"):
    ROOT = Path(os.environ["OSCILO_ROOT"]).resolve()
elif getattr(sys, "frozen", False):
    ROOT = Path(getattr(sys, "_MEIPASS", Path(sys.executable).parent)).resolve()
else:
    ROOT = Path(__file__).resolve().parent.parent
SAMPLES_DIR = Path(os.environ.get("COMTRADE_SAMPLES_DIR", ROOT / "samples")).resolve()

ENV = os.environ.get("ENV", "development").strip().lower()
IS_PRODUCTION = ENV == "production"

# Versão desktop (janela Tauri): servidor só em 127.0.0.1, protegido por token
# aleatório gerado a cada execução; libera abrir arquivos direto do disco.
IS_DESKTOP = os.environ.get("OSCILO_DESKTOP") == "1"
DESKTOP_TOKEN = os.environ.get("OSCILO_TOKEN", "")
if IS_DESKTOP and len(DESKTOP_TOKEN) < 16:
    raise RuntimeError("Modo desktop exige OSCILO_TOKEN com pelo menos 16 caracteres.")

# Limite de upload por arquivo. Local (desenvolvimento): 2 GB. Produção: 50 MB,
# a menos que MAX_UPLOAD_BYTES seja definido (o servidor precisa ter RAM ≈ 2× o .dat).
_DEFAULT_UPLOAD = 50 * 1024 * 1024 if IS_PRODUCTION else 2 * 1024 * 1024 * 1024
MAX_UPLOAD_BYTES = int(os.environ.get("MAX_UPLOAD_BYTES", _DEFAULT_UPLOAD))

_allowed_origins = os.environ.get("ALLOWED_ORIGINS", "").strip()
if _allowed_origins:
    ALLOWED_ORIGINS = [origin.strip() for origin in _allowed_origins.split(",") if origin.strip()]
elif IS_PRODUCTION:
    ALLOWED_ORIGINS: list[str] = []
else:
    ALLOWED_ORIGINS = [
        "http://127.0.0.1:8000",
        "http://localhost:8000",
    ]

_allowed_hosts = os.environ.get("ALLOWED_HOSTS", "").strip()
if IS_DESKTOP:
    ALLOWED_ORIGINS = []  # mesma origem apenas
    ALLOWED_HOSTS = ["127.0.0.1", "localhost"]  # bloqueia DNS rebinding
elif _allowed_hosts:
    ALLOWED_HOSTS = [host.strip() for host in _allowed_hosts.split(",") if host.strip()]
elif IS_PRODUCTION:
    ALLOWED_HOSTS = ["*"]
else:
    ALLOWED_HOSTS = ["*"]
