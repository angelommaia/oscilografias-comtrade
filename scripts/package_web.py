"""Gera o pacote da versão web: dist/Oscilo_<versão>_web.zip

    python scripts/package_web.py [--out dist]

Conteúdo: backend/ (sem testes), static/, samples/, LICENSE e os scripts de
web/ (iniciar.bat, iniciar.sh, LEIA-ME.txt) na raiz da pasta "Oscilo".
"""

from __future__ import annotations

import argparse
import json
import stat
import zipfile
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
SKIP_DIRS = {"__pycache__", "tests", ".pytest_cache"}


def version() -> str:
    return json.loads((ROOT / "src-tauri" / "tauri.conf.json").read_text(encoding="utf-8"))["version"]


def add(zf: zipfile.ZipFile, src: Path, arc: str, executable: bool = False) -> None:
    info = zipfile.ZipInfo.from_file(src, arc)
    info.compress_type = zipfile.ZIP_DEFLATED
    mode = 0o755 if executable else 0o644
    info.external_attr = (stat.S_IFREG | mode) << 16
    with open(src, "rb") as fh:
        zf.writestr(info, fh.read())


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--out", default=str(ROOT / "dist"))
    args = parser.parse_args()
    out_dir = Path(args.out)
    out_dir.mkdir(parents=True, exist_ok=True)
    target = out_dir / f"Oscilo_{version()}_web.zip"

    with zipfile.ZipFile(target, "w", zipfile.ZIP_DEFLATED) as zf:
        for folder in ("backend", "static", "samples"):
            for path in sorted((ROOT / folder).rglob("*")):
                rel = path.relative_to(ROOT)
                if path.is_dir() or SKIP_DIRS.intersection(rel.parts) or path.suffix == ".pyc":
                    continue
                add(zf, path, f"Oscilo/{rel.as_posix()}")
        for name in ("iniciar.bat", "iniciar.sh", "LEIA-ME.txt"):
            add(zf, ROOT / "web" / name, f"Oscilo/{name}", executable=name.endswith(".sh"))
        add(zf, ROOT / "LICENSE", "Oscilo/LICENSE")

    print(f"{target} ({target.stat().st_size / 1e6:.1f} MB)")


if __name__ == "__main__":
    main()
