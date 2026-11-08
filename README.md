# Oscilo

**Análise de oscilografias COMTRADE de perturbações em sistemas de transmissão.**
Visualização, fasores, impedância, harmônicos e simulação de funções de proteção, no computador ou no navegador.

[![Última versão](https://img.shields.io/github/v/release/angelommaia/oscilografias-comtrade?label=baixar&color=1f3b73)](https://github.com/angelommaia/oscilografias-comtrade/releases/latest)
[![Licença](https://img.shields.io/github/license/angelommaia/oscilografias-comtrade?color=555)](LICENSE)

![Falta interna em transformador no tema escuro: formas de onda com os cursores C1/C2 e diagrama fasorial](docs/img/oscilografia.png)

## Download

Todas as versões estão na página de **[Releases](https://github.com/angelommaia/oscilografias-comtrade/releases/latest)**:

| Versão | Arquivo | Como usar |
|---|---|---|
| **Instalador** (Windows) | `Oscilo_x.y.z_x64-setup.exe` | Execute. Instala só para o usuário, sem precisar de administrador. |
| **Portátil** (Windows) | `Oscilo_x.y.z_x64-portable.zip` | Extraia em qualquer pasta, inclusive num pendrive, e abra `Oscilo.exe`. |
| **Web** (navegador) | `Oscilo_x.y.z_web.zip` | Requer Python 3.10+. Execute `iniciar.bat` (Windows) ou `./iniciar.sh` (Linux/macOS). |
| Linux / macOS | `.AppImage`, `.deb`, `.dmg` | AppImage é portátil; o `.dmg` é para Apple Silicon. |

O instalador e a versão portátil não precisam de Python nem de internet, e os arquivos abertos nunca saem do computador.

## Características

- **COMTRADE** (IEEE C37.111, revisões 1991/1999/2013), nos formatos ASCII, BINARY, BINARY32 e FLOAT32, de qualquer fabricante. Registros de **1 GB** abrem em segundos.
- **Visualização** com faixas por canal ou sobrepostas, zoom, régua com cursor sincronizado, marcadores e canais digitais.
- **Cursores C1/C2** arrastáveis, com Δt e valores instantâneos, RMS e fasoriais em cada um, além de pico e RMS do trecho entre eles.
- **Sequência de eventos** dos canais digitais (trip, partida, disjuntor, bloqueio, religamento), com tempo relativo ao trigger.
- **Resumo automático da perturbação:**
  - início, duração e tipo da falta, com as fases envolvidas e a indicação de terra;
  - correntes máximas e afundamentos de tensão;
  - tempos de partida, trip e abertura do disjuntor, interrupção por polo e religamento;
  - identificação de energização por inrush.

  ![Resumo automático de uma falta fase A-terra em transformador, no tema escuro](docs/img/resumo.png)
- **Interface enxuta** para notebooks: menus, painéis de análise sob demanda e tema claro ou escuro.
- **Relatório** em Word (.docx), HTML ou PDF, com resumo, eventos, medições, figuras e os comentários do analista. Termina com as **informações de processamento**: versão do programa, data/hora, SHA-256 do arquivo analisado e parâmetros de cálculo usados.
- **Grupos trifásicos** reconhecidos automaticamente, inclusive por cores (azul/branca/vermelha, como `Vaz`, `Ibr` e `VR`), pelo campo de fase do arquivo ou pela ordem dos canais quando o nome não traz a fase. Uma verificação de rotação aponta fases trocadas (sequência ACB); também é possível montar os grupos manualmente.
- **Juntar registros** de terminais ou IEDs diferentes numa base de tempo comum. O alinhamento pode ser feito pelo início da perturbação (registros sem sincronismo), pelo trigger ou pelo horário GPS, com ajuste fino manual; o programa também mostra o erro de relógio de cada arquivo. Todas as análises funcionam sobre o registro combinado.
- **Fasores** estimados por mínimos quadrados, exatos mesmo com número fracionário de amostras por ciclo. Também disponíveis: DFT e variantes com rejeição de DC.
- **Painel de análises:**
  - diagrama fasorial com componentes simétricas, inclusive com as duas pontas da linha sobrepostas (registro combinado);
  - plano **R-X** com a trajetória dos 6 laços e compensação k0;
  - **harmônicos** e THD;
  - grandezas no tempo: RMS, P/Q/S e sequências.
- **Modo Proteção** com ajustes livres e convenções de vários fabricantes. Simula partida e trip no tempo e compara o resultado com os canais digitais do registro.

<p>
  <img src="docs/img/protecao-87t.png" width="49%" alt="87T no tema escuro: energização com inrush (bloqueio por 2ª harmônica) e falta interna">
  <img src="docs/img/protecao-78.png" width="49%" alt="78 no tema escuro: oscilação de potência e perda de sincronismo no plano R-X">
</p>

| Função | O que mostra |
|---|---|
| **21** Distância | Zonas mho/quadrilaterais, direcionalidade, k0 (complexo ou RE/RL–XE/XL), load encroachment |
| **78** Oscilação de potência | Blinders interno/externo, ΔT, bloqueio (PSB), perda de sincronismo (OOS), dZ/dt |
| **87T** Diferencial | Plano Idiff × Irest, slopes, Idiff>>, grupo vetorial, bloqueio por 2ª/5ª harmônica |
| **50/51/67** Sobrecorrente | Curvas IEC/IEEE/US em log-log, tempo definido, direcional de fase e de terra (67N) |

Os ajustes de cada função podem ser exportados e importados em JSON.

O programa já vem com **oscilografias de exemplo sintéticas**: falta interna em transformador, falta externa (corrente passante), energização com inrush e oscilação de potência com perda de sincronismo. Detalhes em [samples/README.md](samples/README.md).

## Documentação

- [Guia do usuário](docs/guia-do-usuario.md)
- [Versão desktop e portátil: como funciona e como compilar](docs/desktop.md)
- [Desenvolvimento: executar pelo código, publicar a versão web, arquitetura e API](docs/desenvolvimento.md)

Licença: [GPL v3](LICENSE).
