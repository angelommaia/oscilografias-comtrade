"""Sequência de eventos (SOE) dos canais digitais e utilidades de tempo.

Classifica os canais digitais pelo nome (trip, partida, disjuntor, bloqueio,
religamento, teleproteção) para que o resumo automático encontre os instantes
de atuação sem configuração. A classificação é heurística e cobre as
nomenclaturas mais comuns (português, inglês, códigos ANSI).
"""

from __future__ import annotations

import re
from datetime import datetime
from typing import Any

import numpy as np

MAX_EVENTS_PER_CHANNEL = 200

CATEGORIES = {
    "trip": "Trip / operação",
    "pickup": "Partida",
    "breaker": "Disjuntor",
    "block": "Bloqueio",
    "reclose": "Religamento",
    "teleprot": "Teleproteção",
    "other": "Outros",
}

# Ordem importa: o primeiro padrão que casar define a categoria.
_RULES: list[tuple[str, re.Pattern[str]]] = [
    ("reclose", re.compile(r"\b(79|RELIG\w*|RECLOS\w*|AR\s*(?:IN|ON|OP|CLOSE)\w*)\b", re.I)),
    ("teleprot", re.compile(r"\b(85|TELEP\w*|TP\s*(?:RX|TX)|PUTT|POTT|DCB|DCUB|DTT|TDD|TRANSF\w*\s*DIR\w*|RX|TX)\b", re.I)),
    ("breaker", re.compile(r"\b(DJ|52[AB]?|CB|DISJ\w*|BREAKER|BKR)\b", re.I)),
    ("block", re.compile(r"\b(BLOQ\w*|BLK|BLOCK\w*|86\w*|PSB|68)\b", re.I)),
    ("trip", re.compile(r"\b(TRIP\w*|OPER\w*|ATUA\w*|DISP\w*|DESL\w*|94|OOS)\b", re.I)),
    ("pickup", re.compile(r"\b(PART\w*|PICK\s*UP|PICKUP|PKP|START\w*|PU|SENS\w*)\b", re.I)),
]

_OPEN_WORDS = re.compile(r"\b(ABERT\w*|ABRIR|OPEN\w*|52B|DESLIG\w*|OFF)\b", re.I)
_CLOSED_WORDS = re.compile(r"\b(FECHAD\w*|FECHAR|CLOSE\w*|52A|LIGAD\w*|ON)\b", re.I)


def classify_channel(name: str) -> dict[str, Any]:
    """Categoria e, para disjuntores, o significado do nível 1."""
    text = re.sub(r"[_\-/.]", " ", name or "")
    category = "other"
    for cat, pattern in _RULES:
        if pattern.search(text):
            category = cat
            break
    meaning = None
    if category == "breaker":
        if _OPEN_WORDS.search(text):
            meaning = "open"  # 1 = aberto (ex.: 52b, "DJ ABERTO")
        elif _CLOSED_WORDS.search(text):
            meaning = "closed"  # 1 = fechado (ex.: 52a, "DJ FECHADO")
        elif re.search(r"\b(TRIP|ABRE|ABRIR|OPEN\s*CMD)\b", text, re.I):
            category = "trip"
    return {"category": category, "meaning": meaning}


def describe_transition(category: str, meaning: str | None, new_state: int) -> str:
    if category == "breaker" and meaning:
        opened = (new_state == 1) == (meaning == "open")
        return "abriu" if opened else "fechou"
    return "ativou" if new_state else "desativou"


def parse_timestamp(text: str) -> datetime | None:
    text = (text or "").strip()
    if not text:
        return None
    try:
        return datetime.fromisoformat(text)
    except ValueError:
        pass
    for fmt in ("%d/%m/%Y,%H:%M:%S.%f", "%m/%d/%Y,%H:%M:%S.%f", "%d/%m/%Y %H:%M:%S.%f"):
        try:
            return datetime.strptime(text, fmt)
        except ValueError:
            continue
    return None


def trigger_offset_s(ctx) -> float | None:
    """Instante do trigger na escala de tempo do registro (s)."""
    start = parse_timestamp(ctx.meta.start_time)
    trig = parse_timestamp(ctx.meta.trigger_time)
    if start is None or trig is None:
        return None
    off = (trig - start).total_seconds() + float(ctx.time[0])
    if not (float(ctx.time[0]) - 1.0 <= off <= float(ctx.time[-1]) + 1.0):
        return None
    return off


def absolute_time(ctx, t: float) -> str | None:
    """Data/hora absoluta (ISO, µs) de um instante do registro."""
    start = parse_timestamp(ctx.meta.start_time)
    if start is None:
        return None
    from datetime import timedelta

    return (start + timedelta(seconds=float(t) - float(ctx.time[0]))).isoformat(sep=" ", timespec="microseconds")


def digital_events(ctx, i0: int = 0, i1: int | None = None) -> dict[str, Any]:
    """Transições de todos os canais digitais em [i0, i1], em ordem cronológica."""
    data = ctx.data
    time = ctx.time
    i1 = ctx.n_samples - 1 if i1 is None else i1
    trig = trigger_offset_s(ctx)
    events: list[dict[str, Any]] = []
    channels: list[dict[str, Any]] = []
    for pos, info in enumerate(data.meta.digital_channels):
        arr = np.asarray(data.digital[pos][i0 : i1 + 1], dtype=np.int8)
        if not len(arr):
            continue
        cls = classify_channel(info.name)
        changes = np.flatnonzero(np.diff(arr)) + 1
        truncated = len(changes) > MAX_EVENTS_PER_CHANNEL
        channels.append({
            "index": info.index,
            "name": info.name,
            "initial": int(arr[0]),
            "final": int(arr[-1]),
            "changes": int(len(changes)),
            "truncated": truncated,
            **cls,
        })
        for k in changes[:MAX_EVENTS_PER_CHANNEL]:
            t = float(time[i0 + k])
            new = int(arr[k])
            events.append({
                "time_s": t,
                "rel_trigger_ms": (t - trig) * 1e3 if trig is not None else None,
                "index": info.index,
                "name": info.name,
                "from": int(arr[k - 1]),
                "to": new,
                "category": cls["category"],
                "meaning": cls["meaning"],
                "action": describe_transition(cls["category"], cls["meaning"], new),
            })
    events.sort(key=lambda e: (e["time_s"], e["index"]))
    return {"events": events, "channels": channels, "trigger_s": trig}


def first_event(events: list[dict[str, Any]], category: str, *, action: str | None = None,
                after: float | None = None) -> dict[str, Any] | None:
    for ev in events:
        if ev["category"] != category:
            continue
        if action is not None and ev["action"] != action:
            continue
        if after is not None and ev["time_s"] < after:
            continue
        return ev
    return None
