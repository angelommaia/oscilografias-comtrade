"""Abrir .cff, .zip, pastas e vários arquivos (arrastar e soltar)."""

from __future__ import annotations

import asyncio
import io
import sys
import zipfile
from pathlib import Path

import numpy as np
import pytest
from fastapi import HTTPException

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

import archive  # noqa: E402
from comtrade_service import ComtradeStore  # noqa: E402

FS = 1200.0
F0 = 60.0
N = 240


def _cfg_text(name: str, ft: str, rev: str = "2013") -> str:
    lines = [f"ST_{name},DEV_{name},{rev}", "3,2A,1D",
             "1,IA,A,,A,0.01,0,0,-32767,32767,1,1,P", "2,VA,A,,kV,0.001,0,0,-32767,32767,1,1,P",
             "1,TRIP,,,0", f"{F0:g}", "1", f"{FS:g},{N}", "01/11/2026,10:00:00.000000",
             "01/11/2026,10:00:00.050000", ft, "1"]
    if rev == "2013":
        lines += ["-3,-3", "0,0"]
    return "\r\n".join(lines) + "\r\n"


def _signals():
    t = np.arange(N) / FS
    ia = np.round(100 * np.sin(2 * np.pi * F0 * t) / 0.01).astype(np.int16)
    va = np.round(10 * np.cos(2 * np.pi * F0 * t) / 0.001).astype(np.int16)
    trip = (np.arange(N) >= N // 2).astype(np.uint16)
    return ia, va, trip


def _dat_binary() -> bytes:
    ia, va, trip = _signals()
    rec = np.zeros(N, dtype=[("n", "<u4"), ("ts", "<u4"), ("a", "<i2", (2,)), ("d", "<u2", (1,))])
    rec["n"] = np.arange(1, N + 1)
    rec["ts"] = np.round(np.arange(N) * 1e6 / FS).astype(np.uint32)
    rec["a"][:, 0], rec["a"][:, 1], rec["d"][:, 0] = ia, va, trip
    return rec.tobytes()


def _dat_ascii() -> bytes:
    ia, va, trip = _signals()
    rows = [f"{k + 1},{int(round(k * 1e6 / FS))},{ia[k]},{va[k]},{trip[k]}" for k in range(N)]
    return ("\r\n".join(rows) + "\r\n").encode()


def write_pair(folder: Path, name: str, ft: str = "BINARY") -> Path:
    folder.mkdir(parents=True, exist_ok=True)
    (folder / f"{name}.cfg").write_bytes(_cfg_text(name, ft).encode())
    (folder / f"{name}.dat").write_bytes(_dat_binary() if ft == "BINARY" else _dat_ascii())
    return folder / f"{name}.cfg"


def write_cff(path: Path, name: str, ft: str = "BINARY", with_size: bool = True) -> Path:
    dat = _dat_binary() if ft == "BINARY" else _dat_ascii()
    parts = [b"--- file type: CFG ---\r\n", _cfg_text(name, ft).encode(),
             b"--- file type: INF ---\r\n", b"[Public Record_Information]\r\n",
             b"--- file type: HDR ---\r\n", b"Registro sintetico\r\n"]
    if ft == "BINARY":
        parts.append(f"--- file type: DAT BINARY: {len(dat)} ---\r\n".encode() if with_size
                     else b"--- file type: DAT BINARY ---\r\n")
    else:
        parts.append(b"--- file type: DAT ASCII ---\r\n")
    parts.append(dat)
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_bytes(b"".join(parts))
    return path


def _values(store, meta):
    data = store._get(meta.id)
    return np.asarray(data.analog[0][:]), np.asarray(data.analog[1][:]), np.asarray(data.digital[0][:])


@pytest.mark.parametrize("ft,with_size", [("BINARY", True), ("BINARY", False), ("ASCII", True)])
def test_cff_matches_cfg_dat(tmp_path, ft, with_size):
    store = ComtradeStore()
    ref = store.load_from_path(write_pair(tmp_path / "ref", "R", ft))
    cff = write_cff(tmp_path / "X.cff", "R", ft, with_size)
    cfg = archive.split_cff(cff, tmp_path / "split")
    assert cfg.name == "X.cfg" and (tmp_path / "split" / "X.inf").is_file() and (tmp_path / "split" / "X.hdr").is_file()
    meta = store.load_from_path(cfg)
    for a, b in zip(_values(store, ref), _values(store, meta)):
        np.testing.assert_allclose(a, b)
    assert meta.time_quality["utc_offset_h"] == -3


def test_cff_errors(tmp_path):
    bad = tmp_path / "bad.cff"
    bad.write_bytes(b"isto nao e um cff\r\n")
    with pytest.raises(archive.ArchiveError):
        archive.split_cff(bad, tmp_path / "o1")
    cff = write_cff(tmp_path / "T.cff", "T")
    data = cff.read_bytes()
    cff.write_bytes(data[:-100])  # DAT truncado
    with pytest.raises(archive.ArchiveError, match="truncada"):
        archive.split_cff(cff, tmp_path / "o2")


def _zip(path: Path, members: dict[str, bytes]) -> Path:
    with zipfile.ZipFile(path, "w", zipfile.ZIP_DEFLATED) as zf:
        for name, data in members.items():
            zf.writestr(name, data)
    return path


def test_zip_collect_pairs_and_ignores_unsafe(tmp_path):
    src = tmp_path / "src"
    write_pair(src / "ev1", "A")
    write_pair(src / "ev2", "B", "ASCII")
    cff = write_cff(src / "C.cff", "C")
    inner = _zip(tmp_path / "inner.zip", {"D.cfg": _cfg_text("D", "BINARY").encode(), "D.DAT": _dat_binary()})
    z = _zip(tmp_path / "pack.zip", {
        "ev1/A.cfg": (src / "ev1/A.cfg").read_bytes(), "ev1/A.dat": (src / "ev1/A.dat").read_bytes(),
        "ev2/B.CFG": (src / "ev2/B.cfg").read_bytes(), "ev2/B.dat": (src / "ev2/B.dat").read_bytes(),
        "C.cff": cff.read_bytes(), "sub/inner.zip": inner.read_bytes(),
        "../evil.cfg": b"x", "orphan.cfg": b"x", "readme.txt": b"x",
    })
    work = tmp_path / "work"
    cands, notes = archive.collect([z], work, 10**8)
    names = sorted(c.display for c in cands)
    assert names == ["C.cff", "ev1/A.cfg", "ev2/B.CFG", "sub/inner.zip/D.cfg"]
    assert not any(p.name == "evil.cfg" for p in tmp_path.rglob("*"))
    assert all(c.temporary and c.container == "pack.zip" for c in cands)
    a = next(c for c in cands if c.display == "ev1/A.cfg")
    assert a.info["station"] == "ST_A" and a.info["sample_rate_hz"] == FS and a.info["samples"] == N
    store = ComtradeStore()
    for c in cands:
        meta = store.load_candidate(c, work)
        assert meta.total_samples == N and "pack.zip" in meta.source_name
    assert store._get(meta.id).sources[0].file.sha256 is not None


def test_zip_limits(tmp_path):
    z = _zip(tmp_path / "big.zip", {"A.cfg": _cfg_text("A", "BINARY").encode(), "A.dat": b"\0" * 200_000})
    with pytest.raises(archive.ArchiveError, match="limite"):
        archive.collect([z], tmp_path / "w", 50_000)
    bad = tmp_path / "bad.zip"
    bad.write_bytes(b"PK nada")
    with pytest.raises(archive.ArchiveError):
        archive.collect([bad], tmp_path / "w2", 10**8)


def test_loose_files_and_folder(tmp_path):
    cfg = write_pair(tmp_path / "d", "A")
    write_pair(tmp_path / "d" / "x", "B")
    # só o .dat escolhido: acha o .cfg ao lado
    cands, _ = archive.collect([cfg.with_suffix(".dat"), cfg], tmp_path / "w", 10**8)
    assert [c.display for c in cands] == ["A.cfg"] and not cands[0].temporary
    cands, notes = archive.collect([tmp_path / "d"], tmp_path / "w", 10**8)
    assert [c.display for c in cands] == ["A.cfg", "x/B.cfg"] and cands[0].container == "d"
    lonely = tmp_path / "s" / "L.cfg"
    lonely.parent.mkdir()
    lonely.write_bytes(b"x")
    cands, notes = archive.collect([lonely], tmp_path / "w", 10**8)
    assert not cands and "falta o .dat" in notes[0]


class _Upload:
    """UploadFile mínimo para chamar o endpoint direto (sem TestClient/httpx)."""

    def __init__(self, name: str, data: bytes):
        self.filename = name
        self._buf = io.BytesIO(data)

    async def read(self, n: int = -1) -> bytes:
        return self._buf.read(n)


def test_endpoints_files_and_staged(tmp_path):
    import main

    cfg = write_pair(tmp_path / "p", "A")
    one = asyncio.run(main.load_from_files([_Upload("A.cfg", cfg.read_bytes()),
                                            _Upload("A.dat", cfg.with_suffix(".dat").read_bytes())]))
    assert one["total_samples"] == N and "choose" not in one

    cff = write_cff(tmp_path / "C.cff", "C")
    one = asyncio.run(main.load_from_files([_Upload("C.cff", cff.read_bytes())]))
    assert one["total_samples"] == N

    z = _zip(tmp_path / "two.zip", {"A.cfg": cfg.read_bytes(), "A.dat": cfg.with_suffix(".dat").read_bytes(),
                                    "C.cff": cff.read_bytes()})
    res = asyncio.run(main.load_from_files([_Upload("two.zip", z.read_bytes())]))
    ch = res["choose"]
    assert len(ch["records"]) == 2 and ch["title"] == "two.zip"
    keys = [r["key"] for r in ch["records"]]
    loaded = main.load_staged(main.LoadStagedRequest(staging=ch["staging"], keys=keys))
    assert len(loaded["records"]) == 2
    main.drop_staged(ch["staging"])
    with pytest.raises(HTTPException) as exc:
        main.load_staged(main.LoadStagedRequest(staging=ch["staging"], keys=keys))
    assert exc.value.status_code == 410

    with pytest.raises(HTTPException) as exc:
        asyncio.run(main.load_from_files([_Upload("notas.txt", b"x")]))
    assert exc.value.status_code == 400


def test_safe_relative():
    assert str(archive.safe_relative("Pasta/sub/A.cfg")) == "Pasta/sub/A.cfg"
    assert str(archive.safe_relative("C:\\x\\..\\y\\A.cfg")) == "x/y/A.cfg"
    assert str(archive.safe_relative("/../../etc/A.cfg")) == "etc/A.cfg"
    assert str(archive.safe_relative("a/b/c/d/e/f/g/A.cfg")) == "c/d/e/f/g/A.cfg"
    assert str(archive.safe_relative('p?:<x>/A.cfg')) == "p___x_/A.cfg"
    assert str(archive.safe_relative("")) == "arquivo"
    assert str(archive.safe_relative("../..")) == "arquivo"


def test_endpoint_dropped_folder_keeps_subfolders(tmp_path):
    """Pasta solta no navegador: mesmos nomes em subpastas diferentes não se
    misturam e a lista mostra a subpasta."""
    import main

    a = write_pair(tmp_path / "t1", "REG")
    b = write_pair(tmp_path / "t2", "REG", "ASCII")
    ups = [
        _Upload("Evento/T1/REG.cfg", a.read_bytes()), _Upload("Evento/T1/REG.dat", a.with_suffix(".dat").read_bytes()),
        _Upload("Evento/T2/REG.cfg", b.read_bytes()), _Upload("Evento/T2/REG.dat", b.with_suffix(".dat").read_bytes()),
        _Upload("Evento/../../fora.cfg", b"x"),
    ]
    res = asyncio.run(main.load_from_files(ups))
    ch = res["choose"]
    assert ch["title"] == "Evento"
    recs = sorted(ch["records"], key=lambda r: r["folder"])
    assert [(r["folder"], r["name"]) for r in recs] == [("Evento/T1", "REG.cfg"), ("Evento/T2", "REG.cfg")]
    assert recs[0]["path"] == "Evento/T1/REG.cfg"
    loaded = main.load_staged(main.LoadStagedRequest(staging=ch["staging"], keys=[r["key"] for r in recs]))
    assert [r["total_samples"] for r in loaded["records"]] == [N, N]
    main.drop_staged(ch["staging"])


def test_case_insensitive_disk(tmp_path, monkeypatch):
    """macOS/Windows: "A.CFG" existe quando "A.cfg" existe. O nome escolhido
    pelo usuário é mantido e o par não é duplicado."""
    real_is_file = Path.is_file

    def is_file_ci(self):
        if real_is_file(self):
            return True
        try:
            return any(c.name.lower() == self.name.lower() and real_is_file(c) for c in self.parent.iterdir())
        except OSError:
            return False

    monkeypatch.setattr(Path, "is_file", is_file_ci)
    cfg = write_pair(tmp_path / "d", "A")
    for chosen in ([cfg.with_suffix(".dat"), cfg], [cfg.with_suffix(".dat")], [cfg]):
        cands, notes = archive.collect(chosen, tmp_path / "w", 10**8)
        assert [c.display for c in cands] == ["A.cfg"], chosen
        assert not notes

