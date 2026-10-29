"""Parâmetros compartilhados entre análises."""

from __future__ import annotations

from ..dsp import list_estimators
from ..registry import Param


def window_param() -> Param:
    return Param(
        "window_cycles", "Janela", "select", "1",
        options=[
            {"value": "0.5", "label": "½ ciclo"},
            {"value": "1", "label": "1 ciclo"},
            {"value": "2", "label": "2 ciclos"},
            {"value": "4", "label": "4 ciclos"},
        ],
        help="Comprimento da janela de estimação fasorial (causal: termina no instante analisado).",
        section="Estimação",
    )


def estimator_param() -> Param:
    return Param(
        "estimator", "Estimador", "select", "ls",
        options=[{"value": e["id"], "label": e["name"]} for e in list_estimators()],
        help="Algoritmo de estimação fasorial.",
        section="Estimação",
    )
