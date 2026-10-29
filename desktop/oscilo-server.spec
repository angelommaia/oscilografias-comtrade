# -*- mode: python ; coding: utf-8 -*-
# PyInstaller: empacota o backend (FastAPI + numpy) como executável "onedir".
#   pyinstaller desktop/oscilo-server.spec --noconfirm --distpath build --workpath build/pyinstaller
# Resultado: build/server/oscilo-server(.exe) + _internal/ (static/ e samples/ inclusos)
import os

from PyInstaller.utils.hooks import collect_submodules

ROOT = os.path.abspath(os.path.join(SPECPATH, ".."))
BACKEND = os.path.join(ROOT, "backend")

# uvicorn "puro" (asyncio + h11): servidor local de um usuário não precisa de
# uvloop/httptools/websockets/watchfiles – economiza ~40 MB
UVICORN = [
    "uvicorn.logging",
    "uvicorn.loops.auto",
    "uvicorn.loops.asyncio",
    "uvicorn.protocols.http.auto",
    "uvicorn.protocols.http.h11_impl",
    "uvicorn.protocols.websockets.auto",
    "uvicorn.lifespan.on",
    "uvicorn.lifespan.off",
]

hidden = (
    UVICORN
    + collect_submodules("analysis")
    + collect_submodules("protection")
    + ["comtrade", "comtrade_reader", "comtrade_service", "phasor_analysis", "sample_catalog", "config", "main"]
)

a = Analysis(
    [os.path.join(BACKEND, "desktop_server.py")],
    pathex=[BACKEND],
    datas=[
        (os.path.join(ROOT, "static"), "static"),
        (os.path.join(ROOT, "samples"), "samples"),
    ],
    hiddenimports=hidden,
    excludes=[
        "tkinter", "matplotlib", "pandas", "scipy", "PIL", "pytest", "IPython",
        "uvloop", "httptools", "websockets", "wsproto", "watchfiles", "yaml", "dotenv",
        "cryptography", "pip", "setuptools",
    ],
    noarchive=False,
)
pyz = PYZ(a.pure)
exe = EXE(
    pyz,
    a.scripts,
    [],
    exclude_binaries=True,
    name="oscilo-server",
    console=True,  # a janela Tauri o inicia oculto (CREATE_NO_WINDOW); console garante stdout p/ o log
    upx=False,
)
coll = COLLECT(exe, a.binaries, a.datas, name="server", upx=False)
