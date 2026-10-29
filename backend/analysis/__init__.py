"""Núcleo de análises de oscilografia (fasores, impedância, harmônicos, …)."""

from . import builtin  # noqa: F401  (registra as análises embutidas)
from .context import AnalysisContext, RecordData
from .registry import AnalysisRequest, get_analysis, list_analyses

__all__ = ["AnalysisContext", "RecordData", "AnalysisRequest", "get_analysis", "list_analyses"]
