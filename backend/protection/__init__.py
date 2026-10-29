"""Funções de proteção (modo "Proteção" da interface).

Cada função é uma análise registrada com category = "protection". Para criar
uma nova (ex.: 59, 81, 87L), copie um dos módulos, declare `inputs` e
`params` (o formulário é gerado automaticamente) e devolva no `run()` o
formato padrão: plane, geometry/curves, trajectories, lanes, summary, series.
"""

from . import differential, distance, overcurrent, power_swing  # noqa: F401
