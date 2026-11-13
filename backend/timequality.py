"""Qualidade de tempo de um registro COMTRADE (IEEE C37.111-2013).

A revisão 2013 do .cfg traz, depois do multiplicador de tempo, duas linhas:
    time_code,local_code   – fuso dos carimbos de tempo e do local (ex.: "-3", "+5h30", "0")
    tmq_code,leapsec       – qualidade do relógio (hexadecimal, C37.118) e segundo bissexto
Revisões 1991/1999 não têm essas informações ("não informado").
"""

from __future__ import annotations

import re
from datetime import datetime, timedelta
from typing import Any

# tmq_code (IEEE C37.118): 0 = relógio travado à fonte de tempo; 1..B = erro máximo; F = falha
_TMQ = {
    0: "relógio sincronizado (travado)",
    1: "erro < 1 ns", 2: "erro < 10 ns", 3: "erro < 100 ns", 4: "erro < 1 µs", 5: "erro < 10 µs",
    6: "erro < 100 µs", 7: "erro < 1 ms", 8: "erro < 10 ms", 9: "erro < 100 ms", 10: "erro < 1 s",
    11: "erro < 10 s", 15: "falha do relógio – horário não confiável",
}
_LEAP = {
    0: "sem segundo bissexto",
    1: "segundo bissexto acrescentado",
    2: "segundo bissexto subtraído",
    3: "fonte de tempo não trata segundo bissexto",
}
# acima disto o erro de relógio já invalida comparação de ângulos entre terminais
_GOOD_TMQ = {0, 1, 2, 3, 4, 5, 6}


def parse_time_code(text: str | None) -> float | None:
    """Fuso em horas: "-3" → -3; "+5h30" → 5,5; "0" → 0; vazio/"x" → None."""
    if text is None:
        return None
    s = str(text).strip().lower()
    m = re.fullmatch(r"([+-]?)(\d{1,2})(?:h(\d{1,2}))?", s)
    if not m:
        return None
    sign = -1.0 if m.group(1) == "-" else 1.0
    hours = int(m.group(2)) + (int(m.group(3)) / 60.0 if m.group(3) else 0.0)
    return sign * hours if hours <= 14 else None


def _tmq_value(text: str | None) -> int | None:
    if text is None:
        return None
    s = str(text).strip()
    if not s:
        return None
    try:
        return int(s, 16)
    except ValueError:
        return None


def from_cfg(cfg: Any, revision: str | None) -> dict[str, Any]:
    """Informações de tempo do .cfg (biblioteca `comtrade`)."""
    rev = str(revision or "").strip()
    info: dict[str, Any] = {
        "revision": rev,
        "informed": False,
        "time_code": None,
        "local_code": None,
        "utc_offset_h": None,
        "tmq_code": None,
        "tmq_text": None,
        "leap_second": None,
        "leap_text": None,
        "locked": None,
    }
    # a biblioteca guarda strings quando as linhas existem (inteiro 0 quando não existem)
    tc = getattr(cfg, "_time_code", None)
    lc = getattr(cfg, "_local_code", None)
    tq = getattr(cfg, "_tmq_code", None)
    ls = getattr(cfg, "_leap_second", None)
    if rev != "2013" or not isinstance(tc, str):
        return info
    info["informed"] = True
    info["time_code"] = tc
    info["local_code"] = lc if isinstance(lc, str) else None
    info["utc_offset_h"] = parse_time_code(tc)
    tmq = _tmq_value(tq) if isinstance(tq, str) else None
    info["tmq_code"] = (str(tq).strip().upper() or None) if isinstance(tq, str) else None
    if tmq is not None:
        info["tmq_text"] = _TMQ.get(tmq, f"código {tmq:X}")
        info["locked"] = tmq in _GOOD_TMQ
    try:
        leap = int(str(ls).strip()) if isinstance(ls, str) and str(ls).strip() else None
    except ValueError:
        leap = None
    info["leap_second"] = leap
    info["leap_text"] = _LEAP.get(leap) if leap is not None else None
    return info


def summary(info: dict[str, Any] | None) -> str:
    """Texto curto para a interface."""
    if not info or not info.get("informed"):
        return "qualidade de tempo não informada no .cfg" + (
            f" (COMTRADE {info['revision']})" if info and info.get("revision") else "")
    parts = []
    off = info.get("utc_offset_h")
    if off is not None:
        h = int(abs(off))
        mins = int(round((abs(off) - h) * 60))
        parts.append("UTC" if off == 0 else f"UTC{'+' if off > 0 else '−'}{h}" + (f"h{mins:02d}" if mins else ""))
    elif info.get("time_code"):
        parts.append(f"fuso “{info['time_code']}”")
    if info.get("tmq_text"):
        parts.append(f"{info['tmq_text']} (tmq {info['tmq_code']})")
    if info.get("leap_text") and info.get("leap_second"):
        parts.append(info["leap_text"])
    return " · ".join(parts) or "informações de tempo vazias"


def to_utc(start: datetime | None, info: dict[str, Any] | None) -> datetime | None:
    """Converte o início do registro para UTC quando o fuso é conhecido."""
    if start is None or not info or info.get("utc_offset_h") is None:
        return None
    return start - timedelta(hours=float(info["utc_offset_h"]))
