"""Versão: fonte única em src-tauri/tauri.conf.json, repetida em package.json e Cargo.toml."""

from __future__ import annotations

import json
import re
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from version import get_version  # noqa: E402

REPO = Path(__file__).resolve().parents[2]


def test_versions_match():
    conf = json.loads((REPO / "src-tauri" / "tauri.conf.json").read_text(encoding="utf-8"))["version"]
    pkg = json.loads((REPO / "package.json").read_text(encoding="utf-8"))["version"]
    cargo = re.search(r'^version\s*=\s*"([^"]+)"', (REPO / "src-tauri" / "Cargo.toml").read_text(encoding="utf-8"), re.M)
    assert conf == pkg == cargo.group(1)


def test_backend_reads_tauri_conf():
    conf = json.loads((REPO / "src-tauri" / "tauri.conf.json").read_text(encoding="utf-8"))["version"]
    assert get_version() == conf
