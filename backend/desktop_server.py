"""Ponto de entrada do servidor na versão desktop (empacotado com PyInstaller).

A janela Tauri inicia este executável com:
    oscilo-server --port 51234 --token <aleatório> --parent-pid <pid da janela>

O servidor escuta só em 127.0.0.1, exige o token em toda chamada /api e
encerra sozinho se a janela (processo pai) deixar de existir.
"""

from __future__ import annotations

import argparse
import os
import sys
import threading
import time


def _watch_parent(pid: int) -> None:
    """Encerra o servidor quando o processo da janela termina."""
    if pid <= 0:
        return
    if sys.platform == "win32":
        import ctypes

        synchronize, infinite = 0x00100000, 0xFFFFFFFF
        handle = ctypes.windll.kernel32.OpenProcess(synchronize, False, pid)
        if not handle:
            return
        ctypes.windll.kernel32.WaitForSingleObject(handle, infinite)
        os._exit(0)
    while True:
        time.sleep(2)
        try:
            os.kill(pid, 0)
        except OSError:
            os._exit(0)


def main() -> None:
    parser = argparse.ArgumentParser(description="Servidor local do Oscilo")
    parser.add_argument("--port", type=int, required=True)
    parser.add_argument("--token", required=True)
    parser.add_argument("--parent-pid", type=int, default=0)
    args = parser.parse_args()

    # precisa estar no ambiente ANTES de importar a aplicação (config.py lê no import)
    os.environ["OSCILO_DESKTOP"] = "1"
    os.environ["OSCILO_TOKEN"] = args.token
    os.environ.setdefault("ENV", "development")

    sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
    import uvicorn

    from main import app

    threading.Thread(target=_watch_parent, args=(args.parent_pid,), daemon=True).start()
    uvicorn.run(
        app,
        host="127.0.0.1",
        port=args.port,
        loop="asyncio",
        http="h11",
        ws="none",
        lifespan="on",
        log_level="warning",
        access_log=False,
    )


if __name__ == "__main__":
    main()
