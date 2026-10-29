#!/usr/bin/env python3
"""Anonimiza arquivos COMTRADE (.cfg, .hdr, .inf) e copia .dat sem alteração.

Os nomes reais a substituir (subestação, relés, disjuntores) e os arquivos de
origem ficam num arquivo LOCAL, fora do Git:

    backend/anonymize.local.json   (copie de anonymize.example.json)

    python anonymize_comtrade.py [--config caminho.json] [--output ../samples]
"""

from __future__ import annotations

import argparse
import json
import re
import shutil
from dataclasses import dataclass
from pathlib import Path

_DEMO_STATION = "SUBESTACAO_DEMO"
_DEMO_DEVICE_PREFIX = "IED_DEMO"
_DEMO_DATE = "15/01/2020"
_DEMO_TIME_START = "10:00:00.000000"
_DEMO_TIME_TRIGGER = "10:00:01.000000"

_UNIT_LABELS = {
    "A": "COR",
    "V": "TEN",
    "KV": "TEN",
    "HZ": "FREQ",
    "I/IROBJ": "ANG",
}


@dataclass
class CfgStructure:
    analog_count: int
    digital_count: int
    footer_start: int


def _read_text(path: Path) -> str:
    for encoding in ("utf-8", "latin-1", "cp1252"):
        try:
            return path.read_text(encoding=encoding)
        except UnicodeDecodeError:
            continue
    return path.read_text(encoding="latin-1", errors="replace")


def _write_text(path: Path, content: str) -> None:
    path.write_text(content, encoding="latin-1", errors="replace")


def _parse_cfg_structure(lines: list[str]) -> CfgStructure:
    parts = lines[1].strip().split(",")
    analog = int(re.sub(r"[^0-9]", "", parts[1]))
    digital = int(re.sub(r"[^0-9]", "", parts[2]))
    footer_start = 2 + analog + digital
    return CfgStructure(analog, digital, footer_start)


def _phase_suffix(phase: str) -> str:
    phase = (phase or "").strip().upper()
    mapping = {"A": "A", "B": "B", "C": "C", "N": "N"}
    return mapping.get(phase, "X")


def _generic_analog_name(index: int, parts: list[str]) -> str:
    unit = parts[4].strip().upper() if len(parts) > 4 else ""
    phase = parts[2].strip().upper() if len(parts) > 2 else ""
    prefix = _UNIT_LABELS.get(unit, "ANL")
    suffix = _phase_suffix(phase)
    return f"{prefix}_{suffix}_{index:03d}"


def _replace_field(parts: list[str], idx: int, value: str) -> None:
    if idx < len(parts):
        parts[idx] = value


def anonymize_cfg(text: str, device_id: str) -> str:
    lines = text.splitlines()
    if len(lines) < 3:
        raise ValueError("CFG inválido: poucas linhas.")

    header = lines[0].split(",")
    while len(header) < 3:
        header.append("")
    header[0] = _DEMO_STATION
    header[1] = device_id
    lines[0] = ",".join(header[:3])

    structure = _parse_cfg_structure(lines)
    analog_idx = 0
    digital_idx = 0

    for line_no in range(2, structure.footer_start):
        parts = lines[line_no].split(",")
        if not parts:
            continue

        if line_no < 2 + structure.analog_count:
            analog_idx += 1
            _replace_field(parts, 1, _generic_analog_name(analog_idx, parts))
            if len(parts) > 3:
                _replace_field(parts, 3, f"AN{analog_idx:03d}")
        else:
            digital_idx += 1
            _replace_field(parts, 1, f"EST_{digital_idx:03d}")
            if len(parts) > 3 and parts[3].strip():
                _replace_field(parts, 3, f"BLK_{digital_idx:03d}")

        lines[line_no] = ",".join(parts)

    date_lines = [
        idx
        for idx in range(structure.footer_start, len(lines))
        if re.match(r"^\d{2}/\d{2}/\d{4},", lines[idx])
    ]
    if len(date_lines) >= 1:
        lines[date_lines[0]] = f"{_DEMO_DATE},{_DEMO_TIME_START}"
    if len(date_lines) >= 2:
        lines[date_lines[1]] = f"{_DEMO_DATE},{_DEMO_TIME_TRIGGER}"

    return "\n".join(lines) + ("\n" if text.endswith("\n") else "")


def anonymize_hdr(text: str, device_id: str) -> str:
    return _anonymize_hdr_simple(text)


def _anonymize_hdr_simple(text: str) -> str:
    out_lines = []
    for line in text.splitlines():
        if re.match(r"(?i)^Station Name:", line):
            out_lines.append(f"Station Name: {_DEMO_STATION}")
        elif re.match(r"(?i)^Fault number", line):
            out_lines.append("Fault number / Stoerfallnummer: 00000001")
        elif re.match(r"(?i)^Start time", line):
            out_lines.append(f"Start time / Startzeit: {_DEMO_DATE} {_DEMO_TIME_START}")
        elif re.match(r"(?i)^Trigger time", line):
            out_lines.append(f"Trigger time / Triggerzeit: {_DEMO_DATE} {_DEMO_TIME_TRIGGER}")
        elif re.match(r"(?i)^Trigger name", line):
            out_lines.append("Trigger name / Triggername: Protecao diferencial")
        else:
            cleaned = line
            for token in (*_EXTRA_TOKENS, "SIPROTEC", "SIEMENS"):
                cleaned = cleaned.replace(token, "DEMO")
            cleaned = re.sub(r"SE\s+DEMO", _DEMO_STATION, cleaned, flags=re.I)
            cleaned = re.sub(r"SE\s+[A-Z0-9 ]{3,}", _DEMO_STATION, cleaned, flags=re.I)
            out_lines.append(cleaned)
    return "\n".join(out_lines) + ("\n" if text.endswith("\n") else "")


# Preenchido a partir do arquivo de configuração local (ver main()).
_EXTRA_TOKENS: list[str] = []


def anonymize_inf(text: str) -> str:
    return _anonymize_hdr_simple(text)


def find_dat_file(cfg_path: Path) -> Path | None:
    directory = cfg_path.parent
    stem = cfg_path.stem.lower()
    for path in directory.iterdir():
        if path.is_file() and path.suffix.lower() == ".dat" and path.stem.lower() == stem:
            return path
    return None


def process_pair(cfg_path: Path, output_dir: Path, device_id: str, output_stem: str = "registro") -> bool:
    output_dir.mkdir(parents=True, exist_ok=True)

    dat_path = find_dat_file(cfg_path)
    if dat_path is None:
        print(f"[AVISO] .dat ausente para {cfg_path.name} — copie o .dat manualmente para {output_dir / (output_stem + '.dat')}")
        return False

    cfg_text = _read_text(cfg_path)
    out_cfg = output_dir / f"{output_stem}.cfg"
    _write_text(out_cfg, anonymize_cfg(cfg_text, device_id))
    shutil.copy2(dat_path, output_dir / f"{output_stem}.dat")

    for ext in (".hdr", ".HDR", ".inf", ".INF"):
        sidecar = cfg_path.with_suffix(ext)
        if not sidecar.is_file():
            continue
        side_text = _read_text(sidecar)
        if ext.lower() == ".hdr":
            side_text = anonymize_hdr(side_text, device_id)
        else:
            side_text = anonymize_inf(side_text)
        _write_text(output_dir / f"{output_stem}{ext.lower()}", side_text)

    return True


LOCAL_CONFIG = Path(__file__).resolve().parent / "anonymize.local.json"


def main() -> None:
    parser = argparse.ArgumentParser(description="Anonimiza oscilografias COMTRADE.")
    parser.add_argument("--config", type=Path, default=LOCAL_CONFIG,
                        help="JSON com 'input', 'tokens' e 'datasets' (veja anonymize.example.json).")
    parser.add_argument("--input", type=Path, default=None, help="Sobrescreve 'input' do JSON.")
    parser.add_argument(
        "--output",
        type=Path,
        default=Path(__file__).resolve().parent.parent / "samples",
        help="Diretório de saída (samples/ do projeto).",
    )
    args = parser.parse_args()

    if not args.config.is_file():
        raise SystemExit(
            f"Configuração não encontrada: {args.config}\n"
            "Copie backend/anonymize.example.json para backend/anonymize.local.json e preencha "
            "(esse arquivo é ignorado pelo Git e não deve ser publicado)."
        )
    cfg = json.loads(args.config.read_text(encoding="utf-8"))
    _EXTRA_TOKENS[:] = [str(t) for t in cfg.get("tokens", [])]
    datasets = cfg.get("datasets", [])
    args.input = args.input or Path(cfg["input"])

    input_root = args.input.resolve()
    output_root = args.output.resolve()
    output_root.mkdir(parents=True, exist_ok=True)

    processed = 0
    for item in datasets:
        cfg_path = input_root / item["cfg"]
        if not cfg_path.is_file():
            print(f"[IGNORADO] Não encontrado: {cfg_path}")
            continue
        out_dir = output_root / item["out"]
        ok = process_pair(cfg_path, out_dir, item.get("device", f"{_DEMO_DEVICE_PREFIX}_{processed + 1:03d}"))
        if ok:
            print(f"[OK] {cfg_path.name} -> {out_dir / 'registro.cfg'} + registro.dat")
            processed += 1
        else:
            # Gera CFG anonimizado mesmo sem DAT, para o usuário acoplar o .dat depois
            out_dir.mkdir(parents=True, exist_ok=True)
            cfg_text = _read_text(cfg_path)
            _write_text(out_dir / "registro.cfg", anonymize_cfg(cfg_text, item["device"]))
            for ext in (".hdr", ".HDR", ".inf", ".INF"):
                sidecar = cfg_path.with_suffix(ext)
                if sidecar.is_file():
                    side_text = _read_text(sidecar)
                    side_text = anonymize_hdr(side_text, item["device"]) if ext.lower() == ".hdr" else anonymize_inf(side_text)
                    _write_text(out_dir / f"registro{ext.lower()}", side_text)
            print(f"[PARCIAL] CFG anonimizado em {out_dir} — falta copiar registro.dat")

    print(f"\nConcluído: {processed} registro(s) anonimizado(s) em {output_root}")


if __name__ == "__main__":
    main()
