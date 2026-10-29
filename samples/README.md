# Oscilografias de exemplo (sintéticas)

Registros COMTRADE usados nos exemplos do Oscilo (menu **Exemplos…**).
**São 100% sintéticos:** foram gerados por `scripts/generate_samples.py` a partir
de modelos de rede e não contêm dados de nenhuma instalação real. A estrutura
dos arquivos imita registros típicos de relés de transformador e de
registradores de perturbação: número e tipo de canais, relações de TC/TP, taxas
de amostragem, formatos e revisões COMTRADE.

| Pasta | Formato | Canais | Evento simulado | Para testar |
|-------|---------|--------|-----------------|-------------|
| `demo_falta_transformador/` | BINARY 2013, 2 kHz, 6,4 s | 42A / 128D | Falta interna fase A-terra nos terminais AT de um transformador 500/34,5 kV (YNd1, 150 MVA); disjuntores abrem em ~62 ms | 87T (atua), componente DC, 50N |
| `demo_87t_exportacao/` | ASCII 2013, 2 kHz, 6,0 s | 25A / 115D | Falta B-C externa no alimentador de 34,5 kV, eliminada em 150 ms | 87T estável com corrente passante |
| `demo_87t_diferencial/` | BINARY 1997, 16 kHz, 3,0 s | 41A / 45D | Registrador de 400 kV: energização do transformador (inrush) e, em 1,8 s, falta interna B-C | Bloqueio por 2ª harmônica, depois trip |
| `demo_oscilacao_potencia/` | FLOAT32 2013, 2 kHz, 10 s | 8A / 16D | Linha 500 kV: oscilação amortecida a partir de 1 s e perda de sincronismo após 5 s | 78/68: PSB, OOS, trajetória R-X |

Os nomes dos canais seguem o padrão `TIPO_FASE_nnn` (`COR` corrente, `TEN`
tensão, `FREQ` frequência, `CALC` grandezas calculadas pelo relé). O campo de
fase do `.cfg` vem preenchido, então os conjuntos trifásicos são reconhecidos
automaticamente. Os canais digitais com evento têm nomes descritivos
(`87T OPERADO`, `DJ AT1 ABERTO`, `68 PSB ATIVO`…). Os demais (`EST_nnn`)
ficam constantes, como acontece num relé real.

## Regenerar

```powershell
python scripts/generate_samples.py
```

A geração é determinística: os arquivos saem idênticos a cada execução. Os
testes em `backend/tests/test_samples.py` conferem que cada exemplo continua
demonstrando o que a tabela promete.

## Usar registros reais como exemplo

Registros reais **não** devem ir para o repositório. Para uso interno,
`backend/anonymize_comtrade.py` troca nomes de subestação, equipamentos e
datas (configuração em `backend/anonymize.local.json`, ignorado pelo Git).
Mesmo anonimizadas, as formas de onda continuam sendo dados reais.
