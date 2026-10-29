"""Inicia a versão web do Oscilo e abre o navegador.

Uso (a partir da pasta do pacote web ou do repositório):
    python backend/web_launcher.py                 # só neste computador (127.0.0.1)
    python backend/web_launcher.py --host 0.0.0.0  # acessível na rede local
    python backend/web_launcher.py --port 8080 --no-browser

Os scripts iniciar.bat / iniciar.sh do pacote web criam o ambiente Python
na primeira execução e chamam este arquivo.
"""

from __future__ import annotations

import argparse
import os
import socket
import sys
import threading
import time
import webbrowser


def _port_free(host: str, port: int) -> bool:
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as s:
        try:
            s.bind((host if host != "0.0.0.0" else "", port))
            return True
        except OSError:
            return False


def _open_when_ready(url: str, port: int) -> None:
    deadline = time.time() + 60
    while time.time() < deadline:
        try:
            with socket.create_connection(("127.0.0.1", port), timeout=0.5):
                webbrowser.open(url)
                return
        except OSError:
            time.sleep(0.3)


def main() -> None:
    parser = argparse.ArgumentParser(description="Oscilo – versão web")
    parser.add_argument("--host", default="127.0.0.1", help="0.0.0.0 para liberar acesso pela rede (sem autenticação!)")
    parser.add_argument("--port", type=int, default=8000)
    parser.add_argument("--no-browser", action="store_true", help="não abrir o navegador")
    args = parser.parse_args()

    port = args.port
    while not _port_free(args.host, port) and port < args.port + 20:
        port += 1
    url = f"http://127.0.0.1:{port}/"

    os.environ.setdefault("ENV", "development")
    os.environ.setdefault("ALLOWED_ORIGINS", url.rstrip("/"))
    sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

    import uvicorn

    from main import app

    print(f"\n  Oscilo – versão web {app.version}")
    print(f"  Endereço: {url}")
    if args.host == "0.0.0.0":
        print(f"  Rede local: http://<ip-deste-computador>:{port}/  (sem senha – use só em rede confiável)")
    print("  Para encerrar: feche esta janela ou pressione Ctrl+C\n")

    if not args.no_browser:
        threading.Thread(target=_open_when_ready, args=(url, port), daemon=True).start()
    uvicorn.run(app, host=args.host, port=port, log_level="warning")


if __name__ == "__main__":
    main()
