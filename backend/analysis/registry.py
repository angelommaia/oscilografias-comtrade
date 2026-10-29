"""Registro de análises plugáveis.

Uma análise é uma classe que declara metadados + parâmetros (usados pelo
frontend para montar o formulário automaticamente) e implementa `run()`.

Exemplo mínimo de nova análise (arquivo em analysis/builtin/):

    from analysis.registry import Analysis, Param, register

    @register
    class MinhaAnalise(Analysis):
        id = "minha"
        name = "Minha análise"
        mode = "interval"                  # "instant" (cursor) | "interval" (janela/seleção)
        requires = ("voltage_group",)      # entradas obrigatórias da requisição
        params = [Param("ganho", "Ganho", "number", 1.0)]

        def run(self, ctx, req):
            i0, i1 = ctx.range_indices(req.t_start, req.t_end)
            ...
            return {"valores": [...]}
"""

from __future__ import annotations

from dataclasses import asdict, dataclass, field
from typing import TYPE_CHECKING, Any, ClassVar

if TYPE_CHECKING:  # pragma: no cover
    from .context import AnalysisContext


@dataclass
class Param:
    key: str
    label: str
    type: str = "number"  # number | select | bool | text
    default: Any = None
    options: list[dict[str, Any]] | None = None  # para select: [{"value":..,"label":..}]
    unit: str = ""
    help: str = ""
    min: float | None = None
    max: float | None = None
    step: float | None = None
    section: str = ""  # agrupamento visual no formulário
    visible_if: dict[str, Any] | None = None  # {"outro_param": valor | [valores]}

    def to_dict(self) -> dict[str, Any]:
        return {k: v for k, v in asdict(self).items() if v not in (None, "")}


@dataclass
class AnalysisRequest:
    time_s: float | None = None
    t_start: float | None = None
    t_end: float | None = None
    voltage_group: str | None = None
    current_group: str | None = None
    channels: list[int] = field(default_factory=list)
    params: dict[str, Any] = field(default_factory=dict)
    max_points: int = 3000
    inputs: dict[str, str] = field(default_factory=dict)  # entradas nomeadas (ex.: {"w1": grupo, "w2": grupo})


class Analysis:
    id: ClassVar[str] = ""
    name: ClassVar[str] = ""
    description: ClassVar[str] = ""
    mode: ClassVar[str] = "instant"
    category: ClassVar[str] = "analysis"  # "analysis" | "protection"
    code: ClassVar[str] = ""  # código ANSI (ex.: "21", "87T")
    requires: ClassVar[tuple[str, ...]] = ()
    # Entradas nomeadas: [{"key": "v", "label": "Tensão", "quantity": "V", "required": True}]
    inputs: ClassVar[list[dict[str, Any]]] = []
    params: ClassVar[list[Param]] = []

    def param(self, req: AnalysisRequest, key: str) -> Any:
        for p in self.params:
            if p.key == key:
                value = req.params.get(key, p.default)
                if value is None or value == "":
                    return p.default
                if p.type == "number":
                    try:
                        value = float(value)
                    except (TypeError, ValueError) as exc:
                        raise ValueError(f"Parâmetro inválido: {p.label}") from exc
                    if p.min is not None and value < p.min:
                        raise ValueError(f"{p.label} deve ser ≥ {p.min}")
                    if p.max is not None and value > p.max:
                        raise ValueError(f"{p.label} deve ser ≤ {p.max}")
                elif p.type == "bool":
                    value = value in (True, "true", "1", 1, "on")
                elif p.type == "select" and p.options:
                    allowed = {str(o["value"]) for o in p.options}
                    if str(value) not in allowed:
                        raise ValueError(f"Opção inválida para {p.label}: {value}")
                return value
        return req.params.get(key)

    def validate(self, req: AnalysisRequest) -> None:
        for need in self.requires:
            if need == "time" and req.time_s is None:
                raise ValueError("Informe o instante (cursor).")
            if need == "voltage_group" and not req.voltage_group:
                raise ValueError("Selecione um grupo de tensão.")
            if need == "current_group" and not req.current_group:
                raise ValueError("Selecione um grupo de corrente.")
            if need == "channels" and not req.channels:
                raise ValueError("Selecione ao menos um canal.")
        for spec in self.inputs:
            if spec.get("required") and not req.inputs.get(spec["key"]):
                raise ValueError(f"Selecione a entrada: {spec['label']}.")

    def run(self, ctx: "AnalysisContext", req: AnalysisRequest) -> dict[str, Any]:  # pragma: no cover
        raise NotImplementedError

    @classmethod
    def describe(cls) -> dict[str, Any]:
        return {
            "id": cls.id,
            "name": cls.name,
            "description": cls.description,
            "mode": cls.mode,
            "category": cls.category,
            "code": cls.code,
            "requires": list(cls.requires),
            "inputs": cls.inputs,
            "params": [p.to_dict() for p in cls.params],
        }


_REGISTRY: dict[str, Analysis] = {}


def register(cls: type[Analysis]) -> type[Analysis]:
    if not cls.id:
        raise ValueError("Análise sem id")
    _REGISTRY[cls.id] = cls()
    return cls


def get_analysis(analysis_id: str) -> Analysis:
    try:
        return _REGISTRY[analysis_id]
    except KeyError as exc:
        raise KeyError(f"Análise desconhecida: {analysis_id}") from exc


def list_analyses() -> list[dict[str, Any]]:
    return [a.describe() for a in _REGISTRY.values()]
