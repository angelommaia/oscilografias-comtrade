"""Análises embutidas. Importar este pacote registra todas elas.

Para adicionar uma análise nova: crie um módulo aqui, decore a classe com
@register e inclua o import abaixo.
"""

from . import harmonics, impedance, phasor_diagram  # noqa: F401
