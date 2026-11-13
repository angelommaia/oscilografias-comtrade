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

1. **Abrir**: menu **Arquivo → Abrir COMTRADE…** (no navegador, selecione o `.cfg` e o `.dat` juntos; no desktop, **Abrir…**/Ctrl+O e só o `.cfg`). Exemplos e Recentes ficam no mesmo menu.
2. **Canais**: ao abrir, todos os canais são exibidos (mude em **Exibir → Ao abrir um registro**). **Limpar tela** desmarca tudo; **Todos os canais** volta a mostrar tudo. Na barra lateral (abas Analógicos | Digitais | Fasores), a busca filtra a lista e "Marcar/Desmarcar listados" age só nos canais filtrados; "Só os que mudam" marca os digitais com transição. ☰ recolhe a barra lateral.
3. **Exibir**: uma faixa por canal ou analógicos sobrepostos; faixas compactas (padrão, cabem em notebooks) ou altas; marcadores.
4. **Fasores**: na aba Fasores da barra lateral, selecione grupos de tensão/corrente (ou crie um com "+ Grupo trifásico"), janela e estimador.
5. **Análises**: o painel da direita abre só quando pedido, pelo menu **Análises** (Resumo, Eventos, Cursores, Fasores, Impedância, Harmônicos); ⤢ amplia e × fecha. Painel fechado não calcula nada. Posicione o cursor (Fasores) ou arraste na régua para selecionar um intervalo (Impedância/Harmônicos). `Esc` limpa a seleção.
6. **Cursores C1/C2**: com o mouse sobre a oscilografia, tecle `1` ou `2` (ou use os botões C1/C2); arraste as linhas para ajustar. Clique simples move o cursor comum; botão direito arrastando = zoom por retângulo; botão da roda (ou clique direito) = zoom anterior; Shift + roda = deslocar no tempo. A análise **Cursores** mostra valores em cada um, Δt e estatísticas do trecho.
7. **Eventos e Resumo**: **Eventos** lista as mudanças dos canais digitais; **Resumo** caracteriza a perturbação (início, tipo, máximos, tempos de proteção). Clique num instante para levar o cursor até ele.
8. **Juntar registros**: **Arquivo → Juntar registros…** – marque 2 a 6 oscilografias abertas (ou adicione arquivos no próprio diálogo), escolha o alinhamento (início da perturbação, trigger ou horário GPS) e, se preciso, um ajuste em ms por registro. Os canais ganham o rótulo do terminal ("TERMINAL_A: Ia…"). "Ajustar alinhamento…" na barra lateral refaz a junção mantendo os canais exibidos.
9. **Fasores de duas pontas**: na análise Fasores, marque **2º terminal** e escolha os grupos V/I da outra ponta (num registro combinado o programa já sugere os do outro terminal). Os fasores da 2ª ponta aparecem com ′, traço fino e ponta vazada; a tabela mostra razão de módulo e Δ ângulo entre as pontas. Se o alinhamento não for por GPS, cada 1 ms de erro vale 21,6° (60 Hz).
10. **Tema**: botão ☾/☀ na barra alterna claro/escuro (as figuras do relatório saem sempre no tema claro).
11. **Relatório**: **Arquivo → Relatório…** (ou "Gerar relatório…" no Resumo) gera DOCX, HTML ou PDF (impressão) com resumo, eventos, cursores, figuras e o texto do analista.

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
├── groups.py       # grupos trifásicos: letras, cores (AZ/BR/VR), campo ph, ordem dos canais; rotação ABC/ACB
├── context.py      # AnalysisContext: tempo↔amostra, sinais primários, fasores, grupos
├── registry.py     # Analysis, Param, @register
├── sequence.py     # SOE: transições digitais, classificação dos canais pelo nome, trigger
└── builtin/        # summary.py, events.py, cursors.py, phasor_diagram.py, impedance.py, harmonics.py
backend/merge.py    # registro combinado: alinhamento (perturbação/trigger/GPS) e reamostragem
backend/report/     # relatório: builder.py (conteúdo → DOCX/HTML), docx.py (DOCX sem dependências)
backend/provenance.py  # arquivos de origem de cada registro (SourceFile/SourceRef) e SHA-256 do .dat sob demanda
backend/version.py  # versão do programa, lida de src-tauri/tauri.conf.json
static/js/analyses/
├── dock.js         # painel com abas, formulário automático de parâmetros, disparo/concorrência
├── index.js        # registro das views
└── views/          # summary.js, events.js, cursors.js, phasor-diagram.js, impedance.js, harmonics.js
static/js/report.js         # diálogo do relatório, captura das figuras
static/js/plots/xyplot.js   # plano XY com zoom/pan reutilizável
```

**Nova análise** (ex.: plano P-Q, frequência, oscilação de potência):

1. Backend – crie `backend/analysis/builtin/minha.py`, decore a classe com `@register`, declare `params` (o formulário no frontend é gerado a partir deles) e implemente `run(ctx, req)`; importe o módulo em `builtin/__init__.py`.
2. Frontend – crie `static/js/analyses/views/minha.js` (`{ id, title, analysisId, refetchOn, range, create(root, ctx) }`, ver contrato em `dock.js`) e registre em `analyses/index.js`.

**Nova grandeza no tempo**: uma linha em `_METRICS` (`backend/phasor_analysis.py`).
**Novo estimador**: uma função com `@register_estimator` em `dsp.py` (aparece automaticamente nos seletores).

Testes: `cd backend && python -m pytest tests` e, para o frontend, `npm run test:js` (= `node --test static/js/tests/*.test.mjs`, Node 22+, sem pacotes).

## Estrutura

```
Oscilografias/
├── backend/
│   ├── main.py
│   ├── config.py
│   ├── sample_catalog.py
│   ├── comtrade_service.py
│   ├── archive.py         # .cff, .zip, pastas e arquivos soltos → candidatos
│   ├── phasor_analysis.py
│   ├── analysis/          # núcleo de análises plugáveis
│   ├── protection/        # funções de proteção (21, 78, 87T, 50/51/67)
│   ├── report/            # relatório DOCX/HTML
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
| POST | `/api/load/upload` | Upload multipart `.cfg` + `.dat` (antigo; a interface usa `/api/load/files`) |
| POST | `/api/load/files` | Web: multipart `files` (1–200) com `.cfg`/`.dat`, `.cff`, `.zip`. O nome do arquivo pode trazer subpastas (`Pasta/sub/A.cfg`, pasta solta) – saneadas por `archive.safe_relative` e preservadas, para separar registros de mesmo nome. Resposta: meta (1 registro) ou `{choose: {staging, title, notes, records: [{key, kind, name, folder, path, container, size, station, device, start, sample_rate_hz, samples, …}]}}` |
| POST | `/api/load/path` | Desktop: `{path}` ou `{paths}` (.cfg, .cff, .zip, pastas). Mesma resposta |
| POST | `/api/load/staged` | `{staging, keys}` (≤ 6) → `{records: [meta…]}`; listagem expirada (só as 3 últimas ficam) → **410** |
| DELETE | `/api/load/staged/{staging}` | Descarta a listagem e os arquivos extraídos |
| POST | `/api/load/sample` | Carrega exemplo `{ "sample_id": "pasta/arquivo" }` |
| GET | `/api/samples` | Lista exemplos disponíveis (sem caminhos do servidor) |
| GET | `/api/records/{id}/waveform` | Dados decimados para plotagem |
| GET | `/api/records/{id}/derived/waveform` | Grandezas derivadas |
| GET | `/api/records/{id}/derived/at-time` | Grandezas no cursor |
| GET | `/api/records/{id}/value-at-time` | Valor dos canais em até 16 instantes: `channels`, `times` (ou `time_s`), `mode` = `inst` (padrão), `true_rms` ou `fund`; janela causal de 1 ciclo nominal, `null` se incompleta |
| GET | `/api/records/{id}/phasor-config` | Grupos trifásicos, métricas e estimadores |
| POST | `/api/records/{id}/groups` | Cria grupo trifásico manual `{quantity, label, a, b, c}` |
| DELETE | `/api/records/{id}/groups/{group_id}` | Remove grupo manual |
| GET | `/api/analyses` | Catálogo de análises com esquema de parâmetros |
| POST | `/api/records/{id}/analyses/{analysis_id}` | Executa análise `{time_s, t_start, t_end, voltage_group, current_group, channels, params}` |
| GET | `/api/records` | Registros abertos na sessão do servidor |
| POST | `/api/merge` | Junta registros `{records: [{id, label, offset_ms}], mode: absolute (padrão)\|onset\|trigger, reference, force}`. GPS incompatível → **409** `{message, problems, forceable}`; `force: true` junta assim mesmo (exceto data inválida) |
| POST | `/api/merge/preview` | Mesmo corpo: candidatos de deslocamento (GPS/trigger/perturbação), compatibilidade do GPS e qualidade de tempo de cada registro, sem juntar |
| POST | `/api/records/{id}/report` | Gera relatório `{format: docx\|html, title, analyst, comments, conclusion, sections, cursors, images}`; na versão desktop aceita `save_path`. Campos opcionais (rastreabilidade): `generated_at` (data/hora local já formatada), `estimator`, `window_cycles`, `impedance_params` (parâmetros da aba R-X, só quando a figura dela vai no relatório) |

### Oscilografias grandes

- Local (sem `ENV=production`) o limite de upload é **2 GB** por arquivo; em produção, 50 MB (ajuste `MAX_UPLOAD_BYTES`).
- O upload é gravado em disco em blocos e decodificado direto do arquivo (memmap); canais BINARY ficam em 16 bits na RAM.
- RAM aproximada por registro carregado: ≈ tamanho do `.dat` (BINARY) ou 2× (BINARY32/FLOAT32/ASCII). Reduza `MAX_RECORDS_IN_MEMORY` se for abrir vários arquivos grandes.
- Para arquivos muito grandes no uso local, evite o upload: aponte `COMTRADE_SAMPLES_DIR` para a pasta das oscilografias e abra pelo menu **Exemplos**.

Variável opcional: `MAX_RECORDS_IN_MEMORY` (padrão 12) – registros mais antigos são descartados (LRU).

## Versão

A fonte única é `src-tauri/tauri.conf.json` (também lida por `scripts/build.ps1`,
`scripts/package_web.py` e `release.yml`). `package.json` e `src-tauri/Cargo.toml`
repetem o número – o Cargo exige literal – e `tests/test_version.py` falha se
divergirem. O backend lê a versão em `backend/version.py` (`OSCILO_VERSION`, se
definida; senão `<ROOT>/src-tauri/tauri.conf.json`) e a expõe em
`GET /api/health` (`{status, version, desktop}`), usada pela janela "Sobre o Oscilo".
Por isso o arquivo vai junto em todos os pacotes: no spec do PyInstaller (`datas`),
no pacote web e no Dockerfile.

## Rastreabilidade do relatório

Cada `RecordData` tem `sources: list[SourceRef]`. Num registro aberto do disco, o
`SourceFile` guarda o caminho do .dat e calcula o SHA-256 em blocos de 1 MB só
quando o relatório é gerado (resultado em cache). No upload da versão web o .dat
fica num diretório temporário apagado após a leitura; por isso o hash é calculado
durante a gravação do upload (`_save_upload_limited`) e entregue pronto. O registro
combinado reaproveita os `SourceFile` de origem, com rótulo, modo de alinhamento
usado e ajuste manual. O relatório mostra só nomes de arquivo (`provenance.safe_name`).

## Links externos na versão desktop

A janela Tauri não navega para fora do servidor local: `static/js/about.js` chama
`plugin:opener|open_url`, e `lib.rs` concede `opener:allow-open-url` à origem
`http://127.0.0.1:<porta>` só para URLs `https://*`, junto com
`dialog:allow-open`/`allow-save`.

## Abrir arquivos: .cff, .zip, pastas e arrastar e soltar

`static/js/open-files.js` é o ponto único de abertura (menu, diálogo nativo,
recentes, linha de comando, arraste). `openSources({files}|{paths}, purpose)`
chama `/api/load/files` (web) ou `/api/load/path` (desktop); com vários
registros mostra a lista de escolha (`#open-choose-dialog`) e carrega os
escolhidos por `/api/load/staged`. `purpose: "add"` é usado pelo diálogo Juntar
(`merge.js`), que marca os registros adicionados; com o Juntar aberto, arquivos
soltos na janela vão para ele (`addToMergeDialog`).

Arrastar e soltar:

- **Web:** eventos HTML5; pastas lidas com `webkitGetAsEntry` (até 4 níveis,
  400 arquivos), enviadas com o caminho relativo no nome do multipart.
- **Desktop:** com o drag-drop do Tauri ligado, o WebView2 não entrega arquivos
  externos ao HTML5. A interface ouve `tauri://drag-enter|drag-leave|drag-drop`
  (o último traz os **caminhos**, nada é enviado); `lib.rs` concede
  `core:event:allow-listen`/`allow-unlisten` à origem local. Arrastes internos
  (faixas, canais, cursores) usam eventos de ponteiro, não HTML5.
- Linha de comando ("Abrir com…"): `.cfg`, `.cff` ou `.zip`.

## Faixas do gráfico

`static/js/tracks-layout.js` (sem DOM, testado em `static/js/tests/`) guarda,
por registro e durante a sessão, a lista ordenada de faixas
`{id, channels: ["12", "derived:p"…], height, yZoom: {eixo: [lo, hi]}}`
(JSON puro, pronto para "salvar sessão"). `syncLayout` acerta o layout com os
canais exibidos (os checkboxes continuam sendo a fonte de "o que está aberto";
novos entram no fim). Sobreposição só de analógicos, até `MAX_UNITS = 2`
unidades-base (`baseUnit`: kV → V); zoom vertical por faixa e por eixo, sempre
na unidade-base.

Em `app.js`: `renderTrack` monta cada faixa (alça ⋮⋮, menu ⋯, legenda com ×,
alça de altura); `drawTrackCanvas` desenha com `drawAnalogWaveform` (1 canal),
`drawMultiAnalog` (sobrepostos, eixo da direita para a 2ª unidade) ou
`drawDigitalWaveform`, e guarda em `canvas._axes` a escala usada (para o
retângulo de zoom). `startLayoutDrag` trata o arraste do nome da faixa e dos
canais da barra lateral (eventos de mouse, não HTML5 DnD: ver "Abrir arquivos"),
com `dropTarget` (meio = sobrepor, bordas = inserir) e rolagem automática.
Reordenar/sobrepor só redesenha (`relayout`); abrir um canal novo faz a consulta.

### Barra lateral e rolagem

- Lista de canais (`app.js`, `renderChannelLists`/`createChannelItem`): o nome não é `<label for>` – clique seleciona (`sideSel` por tipo, âncora para Shift), duplo clique ou checkbox abre/fecha (`setChannelsOpen`), Enter/Delete/botão `.sel-toggle` agem nos selecionados, retângulo a partir de área vazia (`startSideRect`). Registro combinado: `<details class="ch-group">` por rótulo de terminal (`merge.records[].label`, canais "RÓTULO: nome"), estado em `groupOpen`. Arrastar vários = fonte `{type: "channels", ids}`; entre faixas usa `insertChannelsEach` (uma faixa por canal).
- `renderTracks` só reconstrói o DOM quando a estrutura muda (assinatura: faixas, canais, alturas, modo, tema, marcadores, linhas C1/C2) e preserva `scrollTop`; zoom e pan só redesenham.
- Pan/zoom contínuos: `panRefreshView` com no máximo uma consulta em andamento (a próxima sai assim que a anterior termina) e redesenho imediato do que já está carregado.
- `.tracks-container` usa `scrollbar-gutter: stable` e `--track-sbw` (largura medida da barra de rolagem) é descontada da régua e da barra de navegação: sem isso, com a barra do Windows (~17 px), os eixos de tempo da régua e das faixas ficavam desalinhados.

