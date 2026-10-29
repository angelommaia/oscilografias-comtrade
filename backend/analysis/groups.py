"""Detecção automática e definição manual de conjuntos trifásicos (A/B/C)."""

from __future__ import annotations

import re
from typing import Any

PHASES = ("A", "B", "C")

# Sinônimos de fase usados por diferentes fabricantes
_PHASE_ALIASES = {
    "A": "A", "B": "B", "C": "C",
    "L1": "A", "L2": "B", "L3": "C",
    "R": "A", "S": "B", "T": "C",
    "AN": "A", "BN": "B", "CN": "C",
    "AG": "A", "BG": "B", "CG": "C",
}

# Padrões de nome (em ordem de prioridade). O grupo "ph" captura a fase e
# o restante do nome (sem a fase) vira a chave do agrupamento.
_NAME_PATTERNS = [
    # SIPROTEC: "TC1 4S:I A", "TP1 3a:V B"
    re.compile(r"^(?P<pre>.+?):\s*(?P<q>[VUI])\s*(?P<ph>L[123]|[ABC])\b(?P<post>.*)$", re.I),
    # "IA", "VA", "Ia_LT1", "UL1", "IL2 Linha"
    re.compile(r"^(?P<pre>.*?)(?<![A-Za-z])(?P<q>[VUI])\s*[-_ ]?\s*(?P<ph>L[123]|[ABC])(?:N|G)?(?![A-Za-z0-9])(?P<post>.*)$", re.I),
    # "LT1 Fase A", "Corrente A", "TENSAO_B"
    re.compile(r"^(?P<pre>.*?)[\s_\-]+(?:fase\s*)?(?P<ph>L[123]|[ABC])(?P<post>[\s_\-]*)$", re.I),
]


def _quantity_from_unit(unit: str) -> str | None:
    u = (unit or "").strip().lower()
    if u in ("v", "kv", "mv"):
        return "V"
    if u in ("a", "ka", "ma"):
        return "I"
    return None


def _phase_from_field(ph: str | None) -> str | None:
    if not ph:
        return None
    return _PHASE_ALIASES.get(ph.strip().upper())


def _classify(name: str, unit: str, ph_field: str | None) -> tuple[str, str, str] | None:
    """Retorna (quantidade, fase, chave) ou None."""
    qty_unit = _quantity_from_unit(unit)
    for pattern in _NAME_PATTERNS:
        m = pattern.match(name.strip())
        if not m:
            continue
        phase = _PHASE_ALIASES.get(m.group("ph").upper())
        if phase is None:
            continue
        q = (m.groupdict().get("q") or "").upper()
        qty = {"V": "V", "U": "V", "I": "I"}.get(q) or qty_unit
        if qty is None:
            continue
        key = f"{m.group('pre').strip()}|{m.group('post').strip()}".strip("|") or qty
        return qty, phase, key

    # Fallback: campo "ph" do CFG + unidade + prefixo comum do nome
    phase = _phase_from_field(ph_field)
    if phase and qty_unit:
        return qty_unit, phase, re.sub(r"[\s_\-]*[ABC]$", "", name.strip(), flags=re.I) or qty_unit
    return None


def detect_three_phase_groups(channels: list[Any]) -> list[dict[str, Any]]:
    """Detecta grupos trifásicos completos. Retorna lista de grupos."""
    buckets: dict[tuple[str, str], dict[str, int]] = {}
    for ch in channels:
        if getattr(ch, "kind", None) != "analog":
            continue
        cls = _classify(ch.name, ch.unit, ch.phase)
        if cls is None:
            continue
        qty, phase, key = cls
        buckets.setdefault((qty, key), {}).setdefault(phase, ch.index)

    groups: list[dict[str, Any]] = []
    used: set[int] = set()
    for (qty, key), phases in sorted(buckets.items()):
        if not all(p in phases for p in PHASES):
            continue
        label = key.replace("|", " ").strip() or ("Tensão" if qty == "V" else "Corrente")
        groups.append(make_group(qty, label, phases["A"], phases["B"], phases["C"], source="auto"))
        used.update(phases.values())

    groups += _consecutive_triplets([ch for ch in channels if getattr(ch, "kind", None) == "analog"], used)
    return groups


def _channel_phase(ch: Any) -> str | None:
    phase = _phase_from_field(ch.phase)
    if phase:
        return phase
    m = re.search(r"(?:^|[\s_\-:])(L[123]|[ABC])(?:$|[\s_\-])", ch.name, re.I)
    return _PHASE_ALIASES.get(m.group(1).upper()) if m else None


def _consecutive_triplets(analog: list[Any], used: set[int]) -> list[dict[str, Any]]:
    """Segunda passada: três canais consecutivos A, B, C com a mesma unidade e
    a mesma relação de TC/TP (padrão de exportação da maioria dos IEDs)."""
    groups: list[dict[str, Any]] = []
    i = 0
    while i + 2 < len(analog):
        trio = analog[i : i + 3]
        qtys = {_quantity_from_unit(ch.unit) for ch in trio}
        ratios = {(getattr(ch, "primary", None), getattr(ch, "secondary", None)) for ch in trio}
        if (
            [_channel_phase(ch) for ch in trio] == list(PHASES)
            and len(qtys) == 1 and None not in qtys
            and len(ratios) == 1
            and not any(ch.index in used for ch in trio)
        ):
            qty = qtys.pop()
            label = f"Canais {trio[0].index + 1}–{trio[2].index + 1} ({trio[0].name})"
            groups.append(make_group(qty, label, trio[0].index, trio[1].index, trio[2].index, source="auto"))
            used.update(ch.index for ch in trio)
            i += 3
        else:
            i += 1
    return groups


def make_group(quantity: str, label: str, a: int, b: int, c: int, source: str = "manual") -> dict[str, Any]:
    quantity = quantity.upper()
    if quantity not in ("V", "I"):
        raise ValueError("Grandeza deve ser 'V' ou 'I'.")
    prefix = "M" if source == "manual" else quantity
    return {
        "id": f"{prefix}:{quantity}:{label}" if source == "manual" else f"{quantity}:{label}",
        "label": label,
        "quantity": quantity,
        "a": int(a),
        "b": int(b),
        "c": int(c),
        "source": source,
        # compatibilidade com o frontend/endpoint antigos
        "va": int(a),
        "vb": int(b),
        "vc": int(c),
    }
