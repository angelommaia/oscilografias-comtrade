"""Lista cronológica das mudanças de estado dos canais digitais (SOE)."""

from __future__ import annotations

from typing import Any

from ..context import AnalysisContext
from ..registry import Analysis, AnalysisRequest, Param, register
from ..sequence import CATEGORIES, absolute_time, digital_events


@register
class DigitalEvents(Analysis):
    id = "events"
    name = "Eventos digitais"
    description = (
        "Sequência de eventos: cada mudança de estado dos canais digitais, com tempo "
        "relativo ao trigger e categoria (trip, partida, disjuntor, bloqueio…)."
    )
    mode = "interval"
    params = [
        Param("scope", "Intervalo", "select", "all", options=[
            {"value": "all", "label": "Registro inteiro"},
            {"value": "range", "label": "Seleção / janela"},
        ]),
    ]

    def run(self, ctx: AnalysisContext, req: AnalysisRequest) -> dict[str, Any]:
        if self.param(req, "scope") == "range" and req.t_start is not None:
            i0, i1 = ctx.range_indices(req.t_start, req.t_end)
        else:
            i0, i1 = 0, ctx.n_samples - 1
        result = digital_events(ctx, i0, i1)
        for ev in result["events"]:
            ev["absolute"] = absolute_time(ctx, ev["time_s"])
        out = {"categories": CATEGORIES, "scope": self.param(req, "scope"), **result}
        if out["scope"] == "range":  # o painel mostra o intervalo só quando ele foi aplicado
            out["t_start"] = float(ctx.time[i0])
            out["t_end"] = float(ctx.time[i1])
        return out
