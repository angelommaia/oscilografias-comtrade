# Oscilo – Guia do Usuário

Nov 8, 2026 · @Angelo

## 1. Visão geral e instalação

O Oscilo abre oscilografias COMTRADE de qualquer fabricante e mostra, no mesmo lugar, formas de onda, fasores, impedância, harmônicos, sequência de eventos, resumo automático da perturbação e simulação de funções de proteção. Este guia vale para a versão 0.8.0.

Os arquivos abertos nunca saem do computador: o instalador e o portátil funcionam sem internet e sem Python.

| Versão | Arquivo na página de [Releases](https://github.com/angelommaia/oscilografias-comtrade/releases/latest) | Quando usar |
| --- | --- | --- |
| Instalador (Windows) | `Oscilo_x.y.z_x64-setup.exe` | Recomendada. Instala só para o seu usuário, sem administrador. |
| Portátil (Windows) | `Oscilo_x.y.z_x64-portable.zip` | Sem instalar: extraia e abra `Oscilo.exe`. Primeira abertura pode ser lenta. |
| Web | `Oscilo_x.y.z_web.zip` | Requer Python 3.10+. Rode `iniciar.bat` (Windows) ou `./iniciar.sh`. |
| Linux / macOS | `.AppImage`, `.deb`, `.dmg` | AppImage é portátil; `.dmg` para Apple Silicon. |

**Primeira execução.** A tela de abertura mostra o tempo decorrido e a etapa atual. Em notebooks corporativos o antivírus verifica cada biblioteca na primeira vez, e isso pode levar alguns minutos; nas aberturas seguintes é rápido. Se a demora se repetir, use o instalador numa pasta local (fora do OneDrive ou de rede) — veja a seção 11.

## 2. Abrir um registro

Use **Arquivo ▾ → Abrir…** (Ctrl+O) e escolha o `.cfg`; o `.dat` é lido da mesma pasta. **Recentes** reabre os últimos arquivos.

- **Formatos:** COMTRADE IEEE C37.111 (1991, 1999, 2013) em ASCII, BINARY, BINARY32 e FLOAT32.
- **Tamanho:** registros de \~1 GB abrem em segundos na versão desktop. Na versão web hospedada o limite de envio é 50 MB.
- **Ainda não suportados:** `.cff` (arquivo único) e `.cev`.

**Exemplos para treinar.** Em **Arquivo ▾ → Exemplos** há quatro registros 100% sintéticos, cada um feito para demonstrar uma função:

| Exemplo | Evento | Bom para praticar |
| --- | --- | --- |
| `demo_falta_transformador` | Falta interna A-terra no lado AT de um transformador 500/34,5 kV | 87T atuando, componente DC, 50N |
| `demo_87t_exportacao` | Falta B-C externa no alimentador de 34,5 kV, eliminada em 150 ms | 87T estável com corrente passante |
| `demo_87t_diferencial` | Energização com inrush e, em 1,8 s, falta interna B-C | Bloqueio por 2ª harmônica, depois trip |
| `demo_oscilacao_potencia` | Linha 500 kV: oscilação amortecida a partir de 1 s e perda de sincronismo após 5 s | 78/PSB/OOS, trajetória R-X |

## 3. A tela principal

A tela tem quatro áreas: a barra superior, a lista de canais à esquerda, as formas de onda no centro e o painel de análises à direita, que só aparece quando você abre uma análise.

**Guias no topo.** **Oscilografia** é o modo de análise do registro; **Proteção** é o modo de simulação das funções de proteção (seção 7).

**Barra superior, da esquerda para a direita:**

| Controle | Para que serve |
| --- | --- |
| ☰ | Mostra ou oculta a lista de canais |
| Arquivo ▾ | Abrir, Recentes, Exemplos, Juntar registros…, Relatório… e, no fim, Sobre o Oscilo… |
| − / + | Afastar e aproximar o zoom |
| Ajustar | Volta ao registro inteiro |
| Seleção | Zoom no trecho selecionado na régua |
| C1 / C2 / × | Fixa os cursores (ou teclas 1 e 2); × remove os dois |
| Todos os canais | Exibe todos os canais do registro |
| Limpar tela | Desmarca todos os canais |
| Exibir ▾ | Tipo de faixa, o que mostrar ao abrir, marcadores |
| ☾ / ☀ | Tema escuro ou claro |
| Análises ▾ | Abre uma análise no painel lateral |

**Lista de canais.** Tem três abas. **Analógicos** e **Digitais** têm "Marcar listados" e "Desmarcar listados"; nos digitais, **Só os que mudam** deixa apenas os que mudaram de estado. **Fasores** escolhe o grupo trifásico, a janela (½, 1, 2 ou 4 ciclos) e o 2º terminal.

**Exibir ▾** controla:

- **Faixas:** uma faixa por canal ou analógicos sobrepostos; faixas compactas ou altas.
- **Ao abrir um registro, mostrar:** todos os canais, analógicos e digitais que mudam, ou só os analógicos principais.
- **Marcador no cursor** e **Limpar marcadores.**

**Painel de análises.** Fica fechado por padrão e, fechado, não calcula nada — isso mantém o programa leve em notebooks. Use ⤢ para ampliar e × para fechar. O rodapé recolhível **Grandezas no cursor** mostra os valores no ponto do cursor.

**Barra de status** (rodapé): posição, seleção, zoom, número de marcadores e o lembrete das teclas 1 e 2. À direita aparece a versão do programa (ex.: **v0.8.1**); clique nela para abrir a janela **Sobre o Oscilo**.

**Sobre o Oscilo** (**Arquivo ▾ → Sobre o Oscilo…** ou clique na versão da barra de status) mostra a versão, o autor, os links para o repositório e para este guia, a licença (GPL v3) e se você está na versão desktop ou na web. Na versão desktop os links abrem no navegador padrão do sistema; na web, numa nova aba.

## 4. Navegar no registro

O jeito mais rápido de chegar ao trecho da falta é arrastar na régua e clicar em **Seleção**; depois, posicione C1 e C2 com as teclas 1 e 2.

**Zoom e deslocamento**

- **Arrastar na régua** marca um trecho; **Seleção** dá zoom nele; **Esc** desfaz a seleção.
- **− / +** afastam e aproximam; **Ajustar** volta ao registro inteiro.
- A barra **Navegar no tempo** desloca a janela sem mudar o zoom.
- O cursor do mouse é sincronizado em todas as faixas e na régua.

**Cursores C1 e C2**

1. Passe o mouse no instante desejado e tecle **1** (ou clique em C1). Repita com **2** para C2.
2. Arraste a linha do cursor para ajustar a posição.
3. Abra **Análises ▾ → Cursores** para ver, em cada cursor, os valores instantâneo, RMS e fasorial, o Δt entre eles e o pico e o RMS do trecho entre C1 e C2.
4. **×** remove os dois cursores.

As teclas 1 e 2 não funcionam enquanto você digita num campo nem no modo Proteção.

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

1. Escolha os registros e dê um rótulo curto a cada um (por exemplo, o nome do terminal).
2. Escolha o alinhamento e, se precisar, um ajuste fino em ms:

| Alinhamento | Quando usar |
| --- | --- |
| Início da perturbação | Registros sem sincronismo GPS. É o mais comum na prática. |
| Trigger | Quando os triggers dos dois equipamentos são confiáveis e simultâneos. |
| Horário absoluto (GPS) | Registradores sincronizados. O programa mostra o erro de relógio de cada arquivo. |

3. No registro combinado, canais e grupos levam o rótulo do terminal na frente ("RÓTULO: nome").
4. Para comparar as pontas no fasorial, escolha o 2º terminal na aba Fasores (seção 6).

Cuidado com a diferença angular: sem GPS, ela inclui o erro de alinhamento (21,6° por ms a 60 Hz). O fasorial avisa quando o registro não foi alinhado por GPS.

## 9. Relatório

**Arquivo ▾ → Relatório…** gera o relatório da análise em Word (.docx), HTML ou PDF (pelo botão **Imprimir / PDF**, escolhendo "Salvar como PDF").

**Campos de texto:** Título, Ocorrência, Analista, Comentários / análise e Conclusão.

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
4. Selecione o trecho da falta na régua e clique em **Seleção**.
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

## 12. Atalhos e glossário

| Tecla | Ação |
| --- | --- |
| Ctrl+O | Abrir registro |
| 1 / 2 | Fixar C1 / C2 na posição do mouse |
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
