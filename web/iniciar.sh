#!/usr/bin/env sh
# Oscilo – versão web. Cria o ambiente Python na primeira execução e abre o navegador.
# Opções: ./iniciar.sh --host 0.0.0.0 (acesso pela rede) --port 8080 --no-browser
set -e
cd "$(dirname "$0")"
PY="${PYTHON:-python3}"
if [ ! -x .venv/bin/python ]; then
  echo "Preparando o ambiente Python (apenas na primeira execução)..."
  "$PY" -m venv .venv || { echo "Falha ao criar o ambiente. No Debian/Ubuntu: sudo apt install python3-venv"; exit 1; }
fi
if ! cmp -s backend/requirements.txt .venv/requirements.ok 2>/dev/null; then
  echo "Instalando dependências..."
  .venv/bin/python -m pip install --disable-pip-version-check -q -r backend/requirements.txt
  cp backend/requirements.txt .venv/requirements.ok
fi
exec .venv/bin/python backend/web_launcher.py "$@"
