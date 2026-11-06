"""Detecção automática e definição manual de conjuntos trifásicos (A/B/C).

Nomenclaturas reconhecidas:
* letras: A/B/C, L1/L2/L3, R/S/T, AN/BN/CN, AG/BG/CG;
* cores (padrão comum no setor elétrico brasileiro): AZ/AZUL = A,
  BR/BRANCA = B, VR/VM/VERMELHA = C – inclusive em nomes como "Vaz", "Ibr",
  "Ivr" e no campo de fase do CFG ("AZ", "BR", "VR" ou "A", "B", "V");
* sem fase no nome: canais consecutivos com o mesmo nome, unidade e relação
  de TC/TP são tomados na ordem do arquivo (A, B, C[, N]).

Depois da detecção, cada grupo passa por uma verificação de rotação: se a
sequência negativa domina, as fases estão em ordem ACB (trocadas). Grupos
montados pela ordem dos canais são corrigidos automaticamente; nos demais o
aviso fica no grupo para o usuário decidir.
"""

from __future__ import annotations

import re
from typing import Any, Callable

import numpy as np

PHASES = ("A", "B", "C")

_COLORS = {
    "AZ": "A", "AZUL": "A",
    "BR": "B", "BRANCA": "B", "BRANCO": "B",
    "VR": "C", "VM": "C", "VERM": "C", "VERMELHA": "C", "VERMELHO": "C",
}

# Sinônimos de fase usados por diferentes fabricantes e empresas
_PHASE_ALIASES = {
    "A": "A", "B": "B", "C": "C",
    "L1": "A", "L2": "B", "L3": "C",
    "R": "A", "S": "B", "T": "C",
    "AN": "A", "BN": "B", "CN": "C",
    "AG": "A", "BG": "B", "CG": "C",
    **_COLORS,
}
_COLOR_RE = "AZUL|AZ|BRANCA|BRANCO|BR|VERMELHA|VERMELHO|VERM|VR|VM"

# Padrões de nome (em ordem de prioridade). O grupo "ph" captura a fase e
# o restante do nome (sem a fase) vira a chave do agrupamento.
_NAME_PATTERNS = [
    # SIPROTEC: "TC1 4S:I A", "TP1 3a:V B"
    re.compile(r"^(?P<pre>.+?):\s*(?P<q>[VUI])\s*(?P<ph>L[123]|[ABC])\b(?P<post>.*)$", re.I),
    # cores: "Vaz LT 500 kV", "Ibr", "I_VR LT1", "V AZUL"
    re.compile(rf"^(?P<pre>.*?)(?<![A-Za-z])(?P<q>[VUI])\s*[-_ ]?\s*(?P<ph>{_COLOR_RE})(?![A-Za-z0-9])(?P<post>.*)$", re.I),
    # "IA", "VA", "Ia_LT1", "UL1", "IL2 Linha"
    re.compile(r"^(?P<pre>.*?)(?<![A-Za-z])(?P<q>[VUI])\s*[-_ ]?\s*(?P<ph>L[123]|[ABC])(?:N|G)?(?![A-Za-z0-9])(?P<post>.*)$", re.I),
    # "LT1 Fase A", "Corrente A", "TENSAO_B", "Corrente fase azul"
    re.compile(rf"^(?P<pre>.*?)[\s_\-]+(?:fase\s*)?(?P<ph>L[123]|[ABC]|{_COLOR_RE})(?P<post>[\s_\-]*)$", re.I),
]


def _quantity_from_unit(unit: str) -> str | None:
    u = (unit or "").strip().lower()
    if u in ("v", "kv", "mv"):
        return "V"
    if u in ("a", "ka", "ma"):
        return "I"
    return None


def _phase_from_field(ph: str | None, v_is_c: bool = False) -> str | None:
    if not ph:
        return None
    key = ph.strip().upper()
    if key == "V" and v_is_c:
        return "C"  # campo de fase "V" = vermelha quando o arquivo não usa "C"
    return _PHASE_ALIASES.get(key)


def _classify(name: str, unit: str, ph_field: str | None, v_is_c: bool) -> tuple[str, str, str] | None:
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
    phase = _phase_from_field(ph_field, v_is_c)
    if phase and qty_unit:
        return qty_unit, phase, re.sub(r"[\s_\-]*[ABC]$", "", name.strip(), flags=re.I) or qty_unit
    return None


def _uses_v_for_red(channels: list[Any]) -> bool:
    fields = {(getattr(ch, "phase", None) or "").strip().upper() for ch in channels}
    return "V" in fields and "C" not in fields


def detect_three_phase_groups(channels: list[Any]) -> list[dict[str, Any]]:
    """Detecta grupos trifásicos completos. Retorna lista de grupos."""
    analog = [ch for ch in channels if getattr(ch, "kind", None) == "analog"]
    v_is_c = _uses_v_for_red(analog)
    buckets: dict[tuple[str, str], dict[str, int]] = {}
    for ch in analog:
        cls = _classify(ch.name, ch.unit, ch.phase, v_is_c)
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

    groups += _consecutive_triplets(analog, used, v_is_c)
    groups += _same_name_runs(analog, used)
    _unique_ids(groups)
    return groups


def _unique_ids(groups: list[dict[str, Any]]) -> None:
    seen: dict[str, int] = {}
    for g in groups:
        n = seen.get(g["id"], 0)
        seen[g["id"]] = n + 1
        if n:
            g["label"] = f"{g['label']} ({n + 1})"
            g["id"] = f"{g['id']}#{n + 1}"


def _channel_phase(ch: Any, v_is_c: bool = False) -> str | None:
    phase = _phase_from_field(ch.phase, v_is_c)
    if phase:
        return phase
    m = re.search(rf"(?:^|[\s_\-:])(L[123]|[ABC]|{_COLOR_RE})(?:$|[\s_\-])", ch.name, re.I)
    return _PHASE_ALIASES.get(m.group(1).upper()) if m else None


def _consecutive_triplets(analog: list[Any], used: set[int], v_is_c: bool = False) -> list[dict[str, Any]]:
    """Segunda passada: três canais consecutivos A, B, C com a mesma unidade e
    a mesma relação de TC/TP (padrão de exportação da maioria dos IEDs)."""
    groups: list[dict[str, Any]] = []
    i = 0
    while i + 2 < len(analog):
        trio = analog[i : i + 3]
        qtys = {_quantity_from_unit(ch.unit) for ch in trio}
        ratios = {(getattr(ch, "primary", None), getattr(ch, "secondary", None)) for ch in trio}
        if (
            [_channel_phase(ch, v_is_c) for ch in trio] == list(PHASES)
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


def _same_name_runs(analog: list[Any], used: set[int]) -> list[dict[str, Any]]:
    """Terceira passada: nomes sem fase. Sequências de 3 ou 4 canais seguidos com
    nome, unidade e relação iguais são tomadas como A, B, C (e N), na ordem do
    arquivo. A verificação de rotação confirma ou corrige essa suposição."""
    groups: list[dict[str, Any]] = []

    def sig(ch):
        return (ch.name.strip().lower(), (ch.unit or "").strip().lower(),
                getattr(ch, "primary", None), getattr(ch, "secondary", None))

    i = 0
    while i < len(analog):
        j = i
        while j + 1 < len(analog) and sig(analog[j + 1]) == sig(analog[i]):
            j += 1
        run = analog[i : j + 1]
        qty = _quantity_from_unit(run[0].unit)
        if len(run) in (3, 4) and qty and not any(ch.index in used for ch in run[:3]):
            a, b, c = (ch.index for ch in run[:3])
            label = f"Canais {a + 1}–{c + 1} ({run[0].name.strip()})"
            group = make_group(qty, label, a, b, c, source="auto")
            group["inferred"] = "ordem dos canais"
            groups.append(group)
            used.update((a, b, c))
        i = j + 1
    return groups


# ---------------------------------------------------------------------------
# Verificação de rotação (sequência de fases)
# ---------------------------------------------------------------------------
_A = np.exp(2j * np.pi / 3)


def _phasor(x: np.ndarray, fs: float, f0: float) -> complex:
    n = len(x)
    t = np.arange(n) / fs
    w = 2 * np.pi * f0 * t
    basis = np.column_stack([np.cos(w), -np.sin(w)])
    coef, *_ = np.linalg.lstsq(basis, x, rcond=None)
    return complex(coef[0], coef[1]) / np.sqrt(2)


def check_rotation(
    group: dict[str, Any],
    signal: Callable[[int, int, int], np.ndarray],
    n_samples: int,
    fs: float,
    f0: float,
    probes: int = 9,
) -> dict[str, Any]:
    """Compara sequência positiva e negativa em alguns instantes do registro e
    escolhe o mais equilibrado e com sinal presente.

    Retorna {"rotation": "ABC" | "ACB" | None, "ratio": |X2|/|X1|}."""
    n = max(int(round(fs / f0)), 8)
    if n_samples < 2 * n:
        return {"rotation": None, "ratio": None}
    best = None
    for end in np.linspace(2 * n, n_samples - 1, probes).astype(int):
        try:
            xs = [np.nan_to_num(np.asarray(signal(group[p], end - n + 1, end + 1), dtype=float)) for p in ("a", "b", "c")]
        except (ValueError, IndexError):
            return {"rotation": None, "ratio": None}
        if any(len(x) < n for x in xs):
            continue
        pa, pb, pc = (_phasor(x, fs, f0) for x in xs)
        mags = np.abs([pa, pb, pc])
        if mags.max() <= 0 or mags.min() < 0.2 * mags.max():
            continue  # fase ausente ou falta muito desequilibrada nesse instante
        x1 = abs(pa + _A * pb + _A**2 * pc) / 3
        x2 = abs(pa + _A**2 * pb + _A * pc) / 3
        balance = mags.min() / mags.max()
        score = balance * mags.max()
        if best is None or score > best[0]:
            best = (score, x1, x2)
    if best is None:
        return {"rotation": None, "ratio": None}
    _, x1, x2 = best
    ratio = x2 / x1 if x1 > 0 else float("inf")
    if ratio < 0.5:
        rotation = "ABC"
    elif ratio > 2.0:
        rotation = "ACB"
    else:
        rotation = None
    return {"rotation": rotation, "ratio": float(min(ratio, 1e6))}


def apply_rotation_checks(groups: list[dict[str, Any]], signal, n_samples: int, fs: float, f0: float) -> None:
    """Anota a rotação em cada grupo; troca B↔C nos grupos inferidos pela ordem."""
    for g in groups:
        res = check_rotation(g, signal, n_samples, fs, f0)
        g["rotation"] = res["rotation"]
        g["seq_ratio"] = res["ratio"]
        if res["rotation"] == "ACB" and g.get("inferred"):
            g["b"], g["c"] = g["c"], g["b"]
            g["vb"], g["vc"] = g["b"], g["c"]
            g["rotation"] = "ABC"
            g["inferred"] += "; B e C trocadas (sequência negativa)"


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
