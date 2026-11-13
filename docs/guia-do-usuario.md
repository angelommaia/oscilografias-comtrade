# Oscilo – Guia do Usuário

Nov 8, 2026 · @Angelo

## 1. Visão geral e instalação

O Oscilo abre oscilografias COMTRADE de qualquer fabricante e mostra, no mesmo lugar, formas de onda, fasores, impedância, harmônicos, sequência de eventos, resumo automático da perturbação e simulação de funções de proteção. Este guia vale para a versão 0.9.0.

Os arquivos abertos nunca saem do computador: o instalador e o portátil funcionam sem internet e sem Python.

| Versão | Arquivo na página de [Releases](https://github.com/angelommaia/oscilografias-comtrade/releases/latest) | Quando usar |
| --- | --- | --- |
| Instalador (Windows) | `Oscilo_x.y.z_x64-setup.exe` | Recomendada. Instala só para o seu usuário, sem administrador. |
| Portátil (Windows) | `Oscilo_x.y.z_x64-portable.zip` | Sem instalar: extraia e abra `Oscilo.exe`. Primeira abertura pode ser lenta. |
| Web | `Oscilo_x.y.z_web.zip` | Requer Python 3.10+. Rode `iniciar.bat` (Windows) ou `./iniciar.sh`. |
| Linux / macOS | `.AppImage`, `.deb`, `.dmg` | AppImage é portátil; `.dmg` para Apple Silicon. |

**Primeira execução.** A tela de abertura mostra o tempo decorrido e a etapa atual. Em notebooks corporativos o antivírus verifica cada biblioteca na primeira vez, e isso pode levar alguns minutos; nas aberturas seguintes é rápido. Se a demora se repetir, use o instalador numa pasta local (fora do OneDrive ou de rede) — veja a seção 11.

## 2. Abrir um registro

Use **Arquivo ▾ → Abrir…** (Ctrl+O) e escolha o `.cfg` (o `.dat` é lido da mesma pasta), um `.cff` ou um `.zip`. Dá para escolher vários de uma vez. **Recentes** reabre os últimos arquivos.

**Arrastar e soltar.** Arraste arquivos `.cfg` + `.dat`, `.cff`, `.zip` ou uma pasta inteira para a janela; aparece o aviso "Solte para abrir". Pastas são lidas até 4 níveis abaixo.

**Vários registros de uma vez.** Quando o `.zip`, a pasta ou os arquivos soltos têm mais de um registro, o Oscilo mostra uma lista (com subpasta, estação, início, taxa, duração e tamanho) em vez de abrir tudo:

- **Abrir** (ou duplo clique na linha) abre aquele registro;
- marque de 2 a 6 (por exemplo, os dois terminais da linha) e use **Juntar selecionados**: o primeiro é aberto e o diálogo **Juntar registros** já vem com eles marcados.

- **Formatos:** COMTRADE IEEE C37.111 (1991, 1999, 2013) em ASCII, BINARY, BINARY32 e FLOAT32; `.cff` (COMTRADE 2013 em arquivo único); `.zip` com `.cfg`/`.dat` ou `.cff` (inclusive em subpastas e um `.zip` dentro de outro). ZIP com senha não é aceito.
- **Tamanho:** registros de \~1 GB abrem em segundos na versão desktop. Na versão web hospedada o limite de envio é 50 MB por arquivo.
- **Ainda não suportado:** `.cev`.

**Exemplos para treinar.** Em **Arquivo ▾ → Exemplos** há quatro registros 100% sintéticos, cada um feito para demonstrar uma função:

| Exemplo | Evento | Bom para praticar |
| --- | --- | --- |
| `demo_falta_transformador` | Falta interna A-terra no lado AT de um transformador 500/34,5 kV | 87T atuando, componente DC, 50N |
| `demo_87t_exportacao` | Falta B-C externa no alimentador de 34,5 kV, eliminada em 150 ms | 87T estável com corrente passante |
| `demo_87t_diferencial` | Energização com inrush e, em 1,8 s, falta interna B-C | Bloqueio por 2ª harmônica, depois trip |
| `demo_oscilacao_potencia` | Linha 500 kV: oscilação amortecida a partir de 1 s e perda de sincronismo após 5 s | 78/PSB/OOS, trajetória R-X |

## 3. A tela principal

A tela tem quatro áreas: a barra superior, a lista de canais à esquerda, as formas de onda no centro e o painel de análises à direita, que abre já na aba **Resumo**.

**Guias no topo.** **Oscilografia** é o modo de análise do registro; **Proteção** é o modo de simulação das funções de proteção (seção 7).

**Barra superior, da esquerda para a direita:**

| Controle | Para que serve |
| --- | --- |
| ☰ | Mostra ou oculta a lista de canais |
| Arquivo ▾ | Abrir, Recentes, Exemplos, Juntar registros…, Relatório… e, no fim, Sobre o Oscilo… |
| − / + | Afastar e aproximar o zoom |
| Ajustar | Volta ao registro inteiro |
| Seleção | Zoom no trecho selecionado na régua |
| C1 / C2 / × | Fixa os cursores na posição do cursor (ou teclas 1 e 2 na posição do mouse); × remove os dois |
| Todos os canais | Exibe todos os canais do registro |
| Limpar tela | Desmarca todos os canais |
| Exibir ▾ | Altura das faixas, valor no cursor, o que mostrar ao abrir, marcadores |
| ☾ / ☀ | Tema escuro ou claro |
| Análises ▾ | Abre uma análise no painel lateral |

**Lista de canais.** Tem três abas. **Analógicos** e **Digitais** têm "Marcar listados" e "Desmarcar listados"; nos digitais, **Só os que mudam** deixa apenas os que mudaram de estado. **Fasores** escolhe o grupo trifásico, a janela (½, 1, 2 ou 4 ciclos) e o 2º terminal.

**Exibir ▾** controla:

- **Faixas:** compactas ou altas (vale para todas as faixas analógicas e desfaz as alturas ajustadas à mão; digitais ficam sempre compactos). Para sobrepor canais, veja **Organizar as faixas** na seção 4.
- **Valor no cursor (C1/C2):** RMS verdadeiro (padrão), RMS fundamental ou instantâneo — ver seção 4.
- **Ao abrir um registro, mostrar:** todos os canais, analógicos e digitais que mudam, ou só os analógicos principais.
- **Marcador no cursor** e **Limpar marcadores.**

**Painel de análises.** O programa abre com ele visível, na aba **Resumo**; feche com × quando quiser mais espaço — fechado, não calcula nada (reabra em **Análises ▾**). Use ⤢ para ampliar e × para fechar. O rodapé recolhível **Grandezas no cursor** mostra os valores no ponto do cursor.

**Barra de status** (rodapé): posição, seleção, zoom, número de marcadores e o lembrete das teclas 1 e 2. À direita aparece a versão do programa (ex.: **v0.9.0**); clique nela para abrir a janela **Sobre o Oscilo**.

**Sobre o Oscilo** (**Arquivo ▾ → Sobre o Oscilo…** ou clique na versão da barra de status) mostra a versão, o autor, os links para o repositório e para este guia, a licença (GPL v3) e se você está na versão desktop ou na web. Na versão desktop os links abrem no navegador padrão do sistema; na web, numa nova aba.

## 4. Navegar no registro

O jeito mais rápido de chegar ao trecho da falta é desenhar um retângulo com o **botão direito** em volta dele; depois, posicione C1 e C2 com as teclas 1 e 2.

**Gestos do mouse nas faixas**

| Gesto | O que faz |
| --- | --- |
| Clique (botão esquerdo) | Posiciona o **cursor** (linha fina, igual em todas as faixas e na régua). Segurando e arrastando, o cursor acompanha o mouse. Só passar o mouse não move nada. |
| Arrastar com o botão direito | Desenha um retângulo e dá zoom nele. Dentro de uma única faixa analógica, também amplia a escala vertical dela (aparece "zoom vertical" no canto); atravessando várias faixas, só o tempo. Um retângulo estreito e alto amplia só a vertical. |
| Clique com o botão da roda (ou clique direito sem arrastar) | Volta ao zoom anterior (um passo por clique) |
| Dois cliques com o botão da roda | Volta ao registro inteiro (zoom original) |
| Duplo clique | Volta a escala vertical da faixa ao automático |
| Shift + roda | Desloca a janela no tempo (10 % por passo da roda); sem Shift, a roda rola a lista de faixas |
| Ctrl + roda | Zoom no tempo, mantendo fixo o instante sob o mouse |

**Zoom e deslocamento**

- **Botão direito** nas faixas: zoom por retângulo (ver acima).
- **Arrastar na régua** marca um trecho; **Seleção** dá zoom nele; **Esc** desfaz a seleção.
- **− / +** afastam e aproximam em torno do cursor; **Ajustar** volta ao registro inteiro e desfaz os zooms verticais.
- **Ctrl + roda** aproxima e afasta mantendo o instante sob o mouse no lugar.
- A barra **Navegar no tempo** e **Shift + roda do mouse** deslocam a janela sem mudar o zoom; as faixas acompanham enquanto você arrasta.
- Zoom, deslocamento e reordenar não mexem na rolagem vertical da lista de faixas.

**Cursores C1 e C2**

1. Com o mouse sobre a faixa, tecle **1** para fixar **C1** e **2** para **C2** naquele instante. Os botões C1/C2 fixam na posição do cursor.
2. Arraste a linha do cursor para ajustar a posição.
3. Abra **Análises ▾ → Cursores** para ver, em cada cursor, os valores instantâneo, RMS e fasorial, o Δt entre eles e o pico e o RMS do trecho entre C1 e C2.
4. **×** remove os dois cursores.

As teclas 1 e 2 não funcionam enquanto você digita num campo nem no modo Proteção.

**Lista de canais (barra lateral)**

- **Clique** no nome seleciona; **Ctrl+clique** acrescenta ou tira da seleção; **Shift+clique** seleciona um intervalo; arrastar a partir de uma área vazia da lista desenha um retângulo de seleção (Ctrl+A seleciona todos os listados).
- **Abrir/fechar:** o **checkbox** ou **duplo clique** no nome abre/fecha um canal; para os selecionados, use **Enter** (abre), **Delete** (fecha) ou o botão **Abrir/Fechar N selecionados** (abre todos se algum estiver fechado; senão fecha).
- **Registro combinado:** os canais aparecem em seções por terminal, que você pode recolher (o estado fica guardado durante a sessão).

**Organizar as faixas**

- **Reordenar:** arraste o nome do canal (ou a alça **⋮⋮** à esquerda dele) para cima ou para baixo. Uma linha azul mostra onde a faixa vai entrar; perto da borda de cima ou de baixo da área, a lista rola sozinha.
- **Sobrepor:** solte o nome sobre o **meio** de outra faixa analógica (ela fica destacada). Canais da mesma unidade usam o mesmo eixo (kV e V contam como a mesma); uma segunda unidade vai para o eixo da direita; uma terceira é recusada com aviso (contorno tracejado). Digitais e grandezas calculadas não se sobrepõem.
- **Da barra lateral:** arraste um canal (ou vários selecionados) da lista para o gráfico — entre duas faixas, cada canal abre numa faixa própria ali, na ordem da lista; sobre o meio de uma faixa, todos são sobrepostos a ela. Digitais só podem ir antes ou depois de outras faixas.
- **Faixa sobreposta:** cada canal tem uma cor; a legenda no topo da faixa tem **×** para retirar um canal (ele volta a ter faixa própria logo abaixo). Os valores em C1/C2/Δ aparecem para cada canal.
- **Altura:** arraste a borda inferior de uma faixa analógica; **duplo clique** nessa borda volta à altura padrão. Só aquela faixa muda; trocar entre compactas/altas em **Exibir ▾** reaplica a altura padrão a todas.
- **Menu ⋯** (ao lado do nome, também pelo teclado): mover para cima/baixo, separar canais sobrepostos, fechar.
- **Zoom vertical:** o retângulo com o botão direito vale para a faixa inteira (todos os canais sobrepostos, cada eixo na sua escala); **duplo clique** na faixa volta à escala automática.
- A organização vale para o registro durante a sessão e entra na figura do relatório.

**Valores nas faixas.** Ao lado do nome de cada canal aparecem os valores em **C1**, e, com C2 fixado, em **C2** e a diferença **Δ = C2 − C1** (a faixa fica um pouco mais alta para caber as três linhas). Os valores só mudam quando você move um cursor — passar o mouse não altera nada. A grandeza é escolhida em **Exibir ▾ → Valor no cursor** e aparece ao lado do número:

| Rótulo | Grandeza |
| --- | --- |
| **rms** (padrão) | RMS verdadeiro: raiz da média dos quadrados em 1 ciclo nominal que termina no cursor; inclui harmônicos e componente DC |
| **fund.** | RMS da fundamental: módulo do fasor (mínimos quadrados, 1 ciclo), o mesmo que entra nas análises fasoriais |
| **inst.** | Valor da amostra mais próxima do cursor |

No primeiro ciclo do registro ainda não há janela completa: aparece **—** em vez de um valor enganoso. Com a frequência longe da nominal (ex.: 57 Hz num sistema de 60 Hz), o RMS verdadeiro ondula levemente, porque a janela deixa de conter ciclos inteiros. Digitais mostram o estado em C1 (e "0 → 1" quando C2 está fixado).

**Grandezas no cursor.** O rodapé do painel de análises mostra os valores dos canais no ponto do cursor, sem precisar abrir outra análise.

**Marcadores.** Em **Exibir ▾ → Marcador no cursor** você deixa uma marca fixa no instante atual (útil para comparar eventos); **Limpar marcadores** remove todas.

## 5. Grupos trifásicos e fases

Quase todas as análises trabalham sobre um grupo trifásico (Va, Vb, Vc ou Ia, Ib, Ic). O Oscilo monta esses grupos sozinho; você só precisa intervir quando ele não reconhece os canais ou quando a rotação está trocada.

**Como os grupos são reconhecidos, em ordem:**

1. Pelo nome com a fase (A/B/C, R/S/T) ou pela cor (azul/branca/vermelha, como `Vaz`, `Ibr`, `VR` ou `VM`).
2. Pelo campo de fase do `.cfg` (o valor "V" é tratado como vermelha).
3. Pela ordem dos canais, quando o nome não traz a fase. Esses grupos aparecem como inferidos — confira antes de confiar.

**Montar um grupo manualmente.** Na aba **Fasores**, clique em **+ Grupo trifásico**, escolha Tensão ou Corrente, dê um nome e indique o canal de cada fase. **Remover manual** apaga os grupos manuais selecionados.

**Verificação de rotação.** Se o registro estiver em sequência ACB (fases B e C trocadas na fiação ou no cadastro), o programa avisa e oferece a correção B↔C. Faça isso antes de olhar componentes simétricas ou impedância: com a rotação errada, I2 e os laços ficam trocados.

**Janela do fasor.** Na mesma aba escolha ½, 1, 2 ou 4 ciclos. 1 ciclo é o padrão; janelas maiores suavizam, menores respondem mais rápido à falta. O estimador padrão é o de mínimos quadrados, exato mesmo quando a taxa de amostragem não é múltipla de 60 Hz; DFT e variantes com rejeição de DC também estão disponíveis.

## 6. Análises

Abra qualquer análise em **Análises ▾**; ela aparece numa aba do painel lateral e recalcula quando você move o cursor ou muda a seleção. Os parâmetros ficam num formulário no topo de cada aba.

| Análise | O que mostra | Parâmetros principais |
| --- | --- | --- |
| Resumo da perturbação | Início, duração, tipo da falta (fases e terra), correntes máximas, afundamentos, tempos de partida, trip, abertura por polo e religamento; identifica inrush | Sensibilidade do início, grupo de corrente (automático ou escolhido) |
| Eventos digitais | Sequência de eventos (SOE): trip, partida, disjuntor, bloqueio, religamento, com tempo relativo ao trigger | — |
| Cursores | Valores em C1 e C2, Δt, pico e RMS entre eles | Janela RMS/fasor |
| Diagrama fasorial | Fasores no cursor, componentes simétricas, P/Q; até 2 terminais | Componentes simétricas, tensões de linha, 2º terminal |
| Diagrama de impedância (R-X) | Trajetória dos 6 laços (AN, BN, CN, AB, BC, CA) até o cursor, zonas mho | R1/X1/R0/X0 ou k0 manual, ohms primários ou secundários |
| Harmônicos | Espectro e THD de cada canal | Ordem máxima (padrão 15), intervalo, ciclos no cursor |

O painel também oferece grandezas no tempo: RMS, P/Q/S e componentes de sequência.

**Dicas por análise**

- **Resumo:** analisa só a primeira perturbação do registro. Se o início sair adiantado por ruído, reduza a sensibilidade; se perder uma falta de alta impedância, aumente.
- **Fasorial com 2 terminais:** num registro combinado (seção 8), escolha o 2º terminal na aba Fasores — o programa sugere o grupo do outro terminal. Os fasores remotos aparecem com ′ (traço fino, ponta vazada), e a tabela **Entre terminais** dá a razão de módulo e a diferença angular por fase. Sem GPS, cada 1 ms de erro de alinhamento vale 21,6° a 60 Hz.
- **R-X:** informe a linha (R1, X1, R0, X0) para o k0 ser calculado, ou digite |k0| e ∠k0. Se a linha estava aberta ou desenergizada, a análise avisa em vez de mostrar trajetórias de ruído.
- **Harmônicos:** com um trecho selecionado, o espectro é do trecho; sem seleção, usa alguns ciclos em torno do cursor. Para inrush, olhe a 2ª harmônica em relação à fundamental.

## 7. Modo Proteção

O modo Proteção responde à pergunta "com estes ajustes, a função teria partido e dado trip, e quando?" — e compara a resposta com os digitais do próprio registro.

**Como usar**

1. Abra o registro e clique na guia **Proteção** no topo.
2. Escolha a função e indique os canais de entrada (grupos de tensão e corrente).
3. Preencha os ajustes. As seções do formulário mudam conforme a convenção escolhida (por exemplo, k0 complexo ou RE/RL–XE/XL).
4. Veja o gráfico característico com a trajetória e, abaixo, as faixas de partida e trip no tempo ao lado dos digitais reais do relé.
5. Exporte os ajustes em JSON para reaproveitar em outros registros, ou importe um arquivo já salvo.

| Função | O que mostra |
| --- | --- |
| 21 Distância | Zonas mho e quadrilaterais, direcionalidade, k0, load encroachment |
| 78 Oscilação de potência | Blinders interno e externo, ΔT, bloqueio (PSB), perda de sincronismo (OOS), dZ/dt |
| 87T Diferencial | Plano Idiff × Irest, slopes, Idiff>>, grupo vetorial, bloqueio por 2ª e 5ª harmônica |
| 50/51/67 Sobrecorrente | Curvas IEC/IEEE/US em log-log, tempo definido, direcional de fase e de terra (67N) |

Os ajustes são genéricos, não de um fabricante específico: confira as convenções do seu relé (base primária/secundária, definição de k0, referência de ângulo) antes de comparar com a atuação real. As características desenhadas são exatamente as usadas no teste de atuação — se o ponto está dentro do polígono no gráfico, a função considera dentro.

## 8. Juntar registros de terminais diferentes

**Arquivo ▾ → Juntar registros…** combina de 2 a 6 oscilografias (os dois terminais de uma linha, ou IEDs diferentes da mesma subestação) numa base de tempo comum. Todas as análises funcionam sobre o registro combinado.

1. Escolha os registros e dê um rótulo curto a cada um (por exemplo, o nome do terminal). **+ Adicionar arquivo…** — ou arrastar arquivos, `.zip` ou pastas para o diálogo — abre outros registros sem trocar o exibido; os novos já entram marcados.
2. Escolha o alinhamento e, se precisar, um ajuste fino em ms. O padrão é **GPS / horário absoluto**:

| Alinhamento | Quando usar |
| --- | --- |
| GPS / horário absoluto (padrão) | Registradores sincronizados. Usa a data/hora de início de cada .cfg, convertida para UTC quando o arquivo informa o fuso (COMTRADE 2013). |
| Início da perturbação | Registros sem sincronismo GPS: alinha o primeiro instante em que tensões e correntes variam. |
| Trigger | Quando os triggers dos dois equipamentos são confiáveis e simultâneos. |

   Antes de juntar, o diálogo mostra para cada registro o início gravado no .cfg, o fuso e a qualidade do relógio (quando o .cfg 2013 informa: `time_code`, `tmq_code`, segundo bissexto) e o deslocamento que cada modo daria (GPS, Trigger, Perturbação).

   Se os horários forem **incompatíveis** para GPS (sem sobreposição no tempo, inícios mais distantes que a duração do maior registro, ou data inválida como ano "0023"), o programa **não troca o modo sozinho**: mostra o motivo e oferece **Usar Início da perturbação** ou, quando os horários existem, **Juntar mesmo assim (GPS)** – nesse caso o registro e o fasorial avisam que ângulos e tempos entre terminais não são confiáveis.

3. No registro combinado, canais e grupos levam o rótulo do terminal na frente ("RÓTULO: nome").
4. Para comparar as pontas no fasorial, escolha o 2º terminal na aba Fasores (seção 6).

Cuidado com a diferença angular: sem GPS, ela inclui o erro de alinhamento (21,6° por ms a 60 Hz). O fasorial avisa quando o registro não foi alinhado por GPS.

## 9. Relatório

**Arquivo ▾ → Relatório…** gera o relatório da análise em Word (.docx), HTML ou PDF (pelo botão **Imprimir / PDF**, escolhendo "Salvar como PDF").

**Campos de texto:** Título, Ocorrência, Analista, Parecer técnico do analista (comentários) e Conclusão — os dois últimos formam a seção **Parecer técnico do analista** do relatório.

**O que incluir** (marque o que quiser):

- Resumo da perturbação e Atuação da proteção
- Sequência de eventos
- Medições C1/C2
- Figura da oscilografia visível
- Figura do gráfico da aba de análise aberta

As figuras saem do que está na tela: antes de gerar, deixe o zoom, os canais e a aba de análise como você quer que apareçam. Elas sempre saem no tema claro, mesmo se você estiver usando o escuro.

**Informações de processamento.** O relatório termina com um bloco discreto, em letra menor, que permite saber depois como ele foi gerado:

- versão do Oscilo e data/hora (do seu computador) em que o relatório foi gerado;
- arquivo analisado: nome do .cfg, revisão e formato COMTRADE e os 12 primeiros caracteres do **SHA-256** do .dat. Se alguém gerar o hash do mesmo .dat (por exemplo, `certutil -hashfile registro.dat SHA256` no Windows), os caracteres devem coincidir: é a garantia de que o relatório se refere àquele arquivo;
- num registro combinado, uma linha por registro de origem, com rótulo, hash, modo de alinhamento (onset, trigger ou absolute) e o ajuste em ms;
- parâmetros de cálculo: estimador fasorial, janela em ciclos e grupos de tensão e de corrente; se a figura da aba **Impedância** estiver incluída, também a base (ohms primários ou secundários) e o k0.

O relatório traz só o nome dos arquivos, nunca a pasta em que estão. O hash é calculado na hora de gerar o primeiro relatório do registro; em arquivos muito grandes isso pode levar alguns segundos.

## 10. Roteiros do dia a dia

Cada roteiro leva de 2 a 5 minutos e cobre uma pergunta típica de pós-ocorrência.

**A. Análise rápida de uma falta em linha**

1. Abra o `.cfg` (Ctrl+O).
2. **Análises ▾ → Resumo da perturbação:** anote tipo da falta, fases, duração e tempos de trip/abertura.
3. **Análises ▾ → Eventos digitais:** confira a sequência partida → trip → disjuntor → religamento.
4. Desenhe um retângulo com o botão direito em volta da falta (ou selecione o trecho na régua e clique em **Seleção**).
5. Tecle **1** antes da falta e **2** cerca de 2 ciclos após o início.
6. **Diagrama fasorial:** confirme as fases envolvidas e veja I2 e I0.
7. **Diagrama R-X:** informe a linha e veja a trajetória do laço em falta.
8. **Arquivo ▾ → Relatório…** com resumo, eventos, medições e figuras.

**B. Conferir a atuação do 87T**

1. Abra o registro e verifique os grupos de AT e BT na aba Fasores.
2. Guia **Proteção → Diferencial de transformador**: informe grupo vetorial, relações e slopes.
3. Compare as faixas de partida e trip simuladas com os digitais do relé.
4. Se houver energização, abra **Harmônicos** para ver a 2ª harmônica.

**C. Comparar os dois terminais de uma linha**

1. **Arquivo ▾ → Juntar registros…** com os dois arquivos; alinhe pelo início da perturbação (ou GPS).
2. Na aba Fasores, escolha o 2º terminal.
3. No **Diagrama fasorial**, leia a tabela Entre terminais.
4. Desconfie de diferenças angulares se o alinhamento não for GPS.

**D. Suspeita de oscilação de potência**

1. Veja se a envoltória das correntes "bate" lentamente (0,1 a 3 Hz), sem degrau.
2. **Diagrama R-X:** uma trajetória contínua e lenta indica oscilação; um salto em \~1 ciclo indica falta.
3. No fasorial, I2 e I0 próximos de zero reforçam oscilação.
4. Guia **Proteção → Oscilação de potência / blinders** para ver ΔT entre blinders, PSB e OOS.

## 11. Solução de problemas

| Sintoma | Causa provável | O que fazer |
| --- | --- | --- |
| A primeira abertura demora minutos | O antivírus verifica cada biblioteca na primeira execução | Aguarde; a tela mostra o progresso. Prefira o instalador, numa pasta local (não OneDrive nem rede). Persistindo, peça ao TI uma exceção para a pasta do Oscilo. |
| A janela não cabe na tela | Notebook com tela pequena e escala de 125% | O Oscilo abre maximizado; recolha a lista de canais (☰) e use faixas compactas em **Exibir ▾**. |
| "Nenhum conjunto trifásico reconhecido" | Nomes de canais sem fase nem cor | Monte o grupo em **Fasores → + Grupo trifásico**. |
| Aviso de rotação ACB | Fases B e C trocadas no cadastro ou na fiação | Aceite a correção B↔C antes de analisar sequências e impedância. |
| R-X vazio ou com trajetórias estranhas | Linha aberta ou desenergizada; corrente abaixo de \~1% do TC | A análise avisa; não há impedância a medir. Confira o estado do disjuntor nos digitais. |
| Diferença angular estranha entre terminais | Registros alinhados sem GPS | Ajuste o offset em ms ou use o alinhamento GPS, se houver. |
| Resumo pegou o evento errado | O resumo considera só a primeira perturbação | Ajuste a sensibilidade ou analise o segundo evento com cursores. |
| Painel de análises não atualiza | O painel está fechado (fechado não calcula) | Abra a análise em **Análises ▾**. |
| Arquivo grande recusado na versão web | Limite de envio de 50 MB no servidor | Use a versão desktop ou portátil. |
| "Nenhum registro COMTRADE encontrado" ao abrir .zip ou pasta | Falta o `.dat` (ou o `.cfg`) do par, ZIP com senha ou só arquivos de outros tipos | Confira se `.cfg` e `.dat` têm o mesmo nome e estão na mesma pasta; a mensagem cita os arquivos sem par. |

## 12. Atalhos e glossário

| Tecla | Ação |
| --- | --- |
| Ctrl+O | Abrir registro |
| 1 / 2 | Fixar C1 / C2 na posição do mouse |
| Clique na faixa | Posicionar o cursor (arrastando, ele acompanha) |
| Arrastar com o botão direito | Zoom no retângulo (tempo e, numa faixa só, vertical) |
| Botão da roda (ou clique direito) | Voltar ao zoom anterior |
| Dois cliques no botão da roda | Voltar ao registro inteiro |
| Shift + roda | Deslocar no tempo |
| Ctrl + roda | Zoom no tempo no ponto do mouse |
| Lista de canais: clique / Ctrl+clique / Shift+clique | Selecionar um / alternar / intervalo |
| Lista de canais: Enter / Delete | Abrir / fechar os selecionados |
| Esc | Desfazer a seleção na régua; fechar menus |

| Termo | Significado no Oscilo |
| --- | --- |
| Fasor | Valor RMS com ângulo, estimado numa janela causal (que termina no cursor); a referência angular é absoluta, comum a todos os canais |
| Componentes simétricas | I1, I2, I0 (e V1, V2, V0); I2 e I0 relevantes indicam falta desequilibrada ou polo aberto |
| Laço | Par de grandezas usado no 21: fase-terra (AN, BN, CN) ou fase-fase (AB, BC, CA) |
| k0 | Fator de compensação de terra, (Z0 − Z1) / (3·Z1) |
| Trajetória R-X | Caminho da impedância aparente ao longo do tempo até o cursor |
| PSB / OOS | Bloqueio por oscilação de potência / perda de sincronismo (função 78) |
| Inrush | Corrente de energização do transformador, rica em 2ª harmônica |
| SOE | Sequência de eventos dos canais digitais |
| Registro combinado | Resultado de Juntar registros; canais com o rótulo do terminal na frente |
