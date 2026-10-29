# Desenvolvimento do Oscilo

Guia técnico: executar a partir do código, publicar a versão web num servidor,
convenções de cálculo, arquitetura de análises e API. Para gerar o instalador e a
versão portátil, veja [desktop.md](desktop.md). Para baixar o programa pronto,
vá à página de [Releases](https://github.com/angelommaia/oscilografias-comtrade/releases).

## Requisitos

- Python 3.10+

## Instalação local

```powershell
cd backend
pip install -r requirements.txt
python -m uvicorn main:app --reload --host 127.0.0.1 --port 8000
```

Abra [http://127.0.0.1:8000](http://127.0.0.1:8000).

### Oscilografias de exemplo

Coloque pares `.cfg` + `.dat` em `samples/` (veja `samples/README.md`).  
Opcionalmente, defina `COMTRADE_SAMPLES_DIR` apontando para outro diretório.

Para testar localmente com seus arquivos SIPROTEC:

```powershell
$env:COMTRADE_SAMPLES_DIR = "C:\caminho\para\suas\oscilografias"
cd backend
python -m uvicorn main:app --reload --host 127.0.0.1 --port 8000
```

## Deploy no Railway

1. Conecte o repositório GitHub ao Railway
2. Railway detecta o `Dockerfile` na raiz
3. Configure as variáveis (copie de `.env.example`):

| Variável | Valor sugerido |
|----------|----------------|
| `ENV` | `production` |
| `ALLOWED_ORIGINS` | URL pública do app (ou vazio se tudo no mesmo domínio) |
| `COMTRADE_SAMPLES_DIR` | `/app/samples` |
| `MAX_UPLOAD_BYTES` | `52428800` (50 MB) – padrão local é 2 GB |

4. Para exemplos no deploy, copie `.cfg`/`.dat` para `samples/` no repositório ou monte um volume persistente

Guia completo: **[DEPLOY.md](../DEPLOY.md)** (GitHub + Railway passo a passo).

### Segurança em produção

- **`POST /api/load/path` removido** — não expõe leitura arbitrária de arquivos do servidor
- Exemplos carregados apenas por **ID** dentro de `COMTRADE_SAMPLES_DIR`
- Upload limitado por tamanho e com nomes sanitizados
- CORS restrito via `ALLOWED_ORIGINS`
- Documentação OpenAPI desabilitada quando `ENV=production`
- Mensagens de erro genéricas em produção (sem vazar caminhos internos)
- Headers de segurança (HSTS, X-Frame-Options, etc.)

## Uso

1. **Abrir arquivo**: clique em "Abrir COMTRADE" e selecione o `.cfg` (e o `.dat`).
2. **Exemplos**: escolha uma oscilografia no menu suspenso (se houver arquivos em `samples/`).
3. **Canais**: marque/desmarque analógicos e digitais na barra lateral.
4. **Fasores**: selecione grupos de tensão/corrente (ou crie um com "+ Grupo trifásico"), janela e estimador.
5. **Análises**: posicione o cursor (Fasores) ou arraste na régua para selecionar um intervalo (Impedância/Harmônicos). `Esc` limpa a seleção. Cada aba tem "Parâmetros" (salvos no navegador).

## Modo Proteção

Guia **Proteção** (no topo, ao lado de **Oscilografia**): ajustes de funções de proteção aplicados ao registro aberto, com característica, trajetória das grandezas, **simulação de partida/trip no tempo** e comparação com canais digitais do registro (ex.: trip real do relé).

| Função | Gráfico principal | Ajustes |
|---|---|---|
| **21** Distância | Plano R-X com 5 zonas e trajetória dos 6 laços | mho (offset, blinders) ou quadrilateral (X, R terra/fase, tilt, retas direcionais); direção; laços; temporização; k0 (complexo, módulo/ângulo ou RE/RL–XE/XL); alcances em Ω ou % de Z1; ohms prim./sec.; liberação por I mín. e 3I0; **load encroachment** |
| **78** Oscilação de potência | R-X com blinders interno/externo e trajetória de Z1 | blinders (R dir./esq., X sup./inf., inclinação), ΔT, retenção, OOS; gráfico de dZ/dt |
| **87T** Diferencial | Idiff × Irest com região de operação e trajetória por fase | S, V por enrolamento, grupo vetorial (índice horário), eliminação de I0, polaridade, base (trafo/TC); pickup, slope 1 (base), slope 2 (contínuo ou base própria), Idiff>>; restrição Σ\|I\|, Σ\|I\|/2, máx\|I\| ou k·Σ\|I\|; bloqueio 2ª/5ª (por fase ou cruzado); gráfico das harmônicas |
| **50/51/67** Sobrecorrente | Curvas tempo-corrente log-log com pontos de operação | até 4 estágios: fase, 3I0 ou I2; tempo definido ou curvas IEC/IEEE/US; TMS/TD; direcional 67 (quadratura, MTA) e 67N (−3V0 ou seq. negativa, RCA) |

- **Intervalo simulado**: seleção feita na guia Oscilografia (ou registro inteiro), janela visível ou registro inteiro.
- **Perfis**: *Exportar*/*Importar* salvam os ajustes de cada função em JSON; *Padrão* restaura os valores iniciais. Os ajustes ficam salvos no navegador.
- Clique em pontos da trajetória, da linha do tempo ou nos tempos da tabela para mover o cursor (sincronizado com a guia Oscilografia).
- As características são modelos **genéricos** com convenções selecionáveis de vários fabricantes; não reproduzem a lógica interna de um relé específico (seleção de fase, filtros, lógicas adaptativas).

### Nova função de proteção

Crie `backend/protection/minha.py` com uma classe `@register` (`category = "protection"`, `code`, `inputs`, `params` com `section`/`visible_if`) e importe-a em `backend/protection/__init__.py`. O `run()` devolve o formato padrão – `plane`, `geometry` (polígonos) ou `curves`, `trajectories`, `lanes`, `summary`, `series` – e a interface desenha tudo sem código novo no frontend (detalhes opcionais em `FUNC_UI`, `static/js/protection/view.js`).

## Convenções de cálculo

- Fasores em **valor eficaz (RMS)**, janela **causal** (termina no instante analisado, como num relé), referência angular absoluta (t = 0) – ângulos exibidos são relativos à referência escolhida.
- Potência: S = Σ V·I* com fasores RMS.
- Laços de terra: Z = V / (I + k0·3I0), k0 = (Z0 − Z1)/(3·Z1). Base secundária: Z_sec = Z_pri · RTC/RTP (relações do CFG).

## Arquitetura de análises (como estender)

```
backend/analysis/
├── dsp.py          # estimadores fasoriais vetorizados (registro @register_estimator)
├── groups.py       # detecção/definição de grupos trifásicos
├── context.py      # AnalysisContext: tempo↔amostra, sinais primários, fasores, grupos
├── registry.py     # Analysis, Param, @register
└── builtin/        # phasor_diagram.py, impedance.py, harmonics.py
static/js/analyses/
├── dock.js         # painel com abas, formulário automático de parâmetros, disparo/concorrência
├── index.js        # registro das views
└── views/          # phasor-diagram.js, impedance.js, harmonics.js
static/js/plots/xyplot.js   # plano XY com zoom/pan reutilizável
```

**Nova análise** (ex.: plano P-Q, frequência, oscilação de potência):

1. Backend – crie `backend/analysis/builtin/minha.py`, decore a classe com `@register`, declare `params` (o formulário no frontend é gerado a partir deles) e implemente `run(ctx, req)`; importe o módulo em `builtin/__init__.py`.
2. Frontend – crie `static/js/analyses/views/minha.js` (`{ id, title, analysisId, refetchOn, range, create(root, ctx) }`, ver contrato em `dock.js`) e registre em `analyses/index.js`.

**Nova grandeza no tempo**: uma linha em `_METRICS` (`backend/phasor_analysis.py`).
**Novo estimador**: uma função com `@register_estimator` em `dsp.py` (aparece automaticamente nos seletores).

Testes: `cd backend && python -m pytest tests`.

## Estrutura

```
Oscilografias/
├── backend/
│   ├── main.py
│   ├── config.py
│   ├── sample_catalog.py
│   ├── comtrade_service.py
│   ├── phasor_analysis.py
│   ├── analysis/          # núcleo de análises plugáveis
│   ├── protection/        # funções de proteção (21, 78, 87T, 50/51/67)
│   ├── desktop_server.py  # entrada do servidor na versão desktop
│   ├── tests/
│   └── requirements.txt
├── static/
├── samples/
├── src-tauri/             # janela desktop (Tauri)
├── desktop/               # empacotamento do servidor (PyInstaller) e tela de abertura
├── scripts/build.ps1      # build local do instalador (Windows)
├── Dockerfile
└── .env.example
```

## API

| Método | Endpoint | Descrição |
|--------|----------|-----------|
| POST | `/api/load/upload` | Upload multipart `.cfg` + `.dat` |
| POST | `/api/load/sample` | Carrega exemplo `{ "sample_id": "pasta/arquivo" }` |
| GET | `/api/samples` | Lista exemplos disponíveis (sem caminhos do servidor) |
| GET | `/api/records/{id}/waveform` | Dados decimados para plotagem |
| GET | `/api/records/{id}/derived/waveform` | Grandezas derivadas |
| GET | `/api/records/{id}/derived/at-time` | Grandezas no cursor |
| GET | `/api/records/{id}/phasor-config` | Grupos trifásicos, métricas e estimadores |
| POST | `/api/records/{id}/groups` | Cria grupo trifásico manual `{quantity, label, a, b, c}` |
| DELETE | `/api/records/{id}/groups/{group_id}` | Remove grupo manual |
| GET | `/api/analyses` | Catálogo de análises com esquema de parâmetros |
| POST | `/api/records/{id}/analyses/{analysis_id}` | Executa análise `{time_s, t_start, t_end, voltage_group, current_group, channels, params}` |

### Oscilografias grandes

- Local (sem `ENV=production`) o limite de upload é **2 GB** por arquivo; em produção, 50 MB (ajuste `MAX_UPLOAD_BYTES`).
- O upload é gravado em disco em blocos e decodificado direto do arquivo (memmap); canais BINARY ficam em 16 bits na RAM.
- RAM aproximada por registro carregado: ≈ tamanho do `.dat` (BINARY) ou 2× (BINARY32/FLOAT32/ASCII). Reduza `MAX_RECORDS_IN_MEMORY` se for abrir vários arquivos grandes.
- Para arquivos muito grandes no uso local, evite o upload: aponte `COMTRADE_SAMPLES_DIR` para a pasta das oscilografias e abra pelo menu **Exemplos**.

Variável opcional: `MAX_RECORDS_IN_MEMORY` (padrão 12) – registros mais antigos são descartados (LRU).
