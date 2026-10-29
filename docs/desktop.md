# Versão desktop do Oscilo

A versão desktop usa a mesma interface e o mesmo backend da versão web, empacotados num programa instalável:

```
┌─────────────── Oscilo (janela Tauri, WebView2/WebKit) ───────────────┐
│  interface (static/)  ──HTTP 127.0.0.1:<porta sorteada> + token──►    │
│                                       servidor Python (PyInstaller)   │
│                                       backend/ + numpy                │
└───────────────────────────────────────────────────────────────────────┘
```

- A janela inicia o servidor local numa **porta livre sorteada**, só em `127.0.0.1`, com um **token aleatório** exigido em toda chamada de API. Outras páginas abertas no navegador não conseguem usar o servidor.
- Os arquivos são abertos **direto do disco** com **Abrir…** ou **Ctrl+O**, sem upload. O `.dat` é lido da mesma pasta do `.cfg`. A lista **Recentes…** guarda os últimos 12 arquivos.
- O servidor é encerrado ao fechar a janela. Se a janela travar, ele se encerra sozinho, porque vigia o processo pai.
- O log do servidor fica em `%LOCALAPPDATA%\io.github.angelommaia.oscilo\logs\server.log` no Windows.
- Um `.cfg` passado na linha de comando (`Oscilo.exe C:\caminho\registro.cfg`) é aberto na inicialização. A extensão `.cfg` **não** é associada automaticamente ao Oscilo porque é usada por muitos outros programas. Use "Abrir com…" se quiser.

## Instalar (usuários)

Na página **Releases** do repositório:

- **Instalador:** `Oscilo_x.y.z_x64-setup.exe`. Instala só para o usuário atual, **sem administrador**, e baixa o WebView2 se faltar (Windows 10 e 11 já trazem).
- **Portátil:** `Oscilo_x.y.z_x64-portable.zip`. Extraia em qualquer pasta e execute `Oscilo.exe`. A pasta `server\` precisa ficar ao lado do executável. O WebView2 precisa estar presente (já vem no Windows 10 e 11). Os recentes e a janela ficam salvos no perfil do usuário (`%LOCALAPPDATA%\io.github.angelommaia.oscilo`), não na pasta do programa.
- **Web:** `Oscilo_x.y.z_web.zip`. Roda no navegador com Python 3.10+. Extraia e execute `iniciar.bat` (Windows) ou `./iniciar.sh` (Linux/macOS). Veja o `LEIA-ME.txt` do pacote.
- **Linux e macOS:** `.AppImage` (portátil), `.deb` e `.dmg` (Apple Silicon).

## Gerar os instaladores pelo GitHub (recomendado)

1. Atualize a versão em `src-tauri/tauri.conf.json`, `src-tauri/Cargo.toml` e `package.json`.
2. Crie e envie uma tag:
   ```powershell
   git tag v0.6.2
   git push origin v0.6.2
   ```
3. O workflow **Release** (`.github/workflows/release.yml`) roda os testes e empacota o servidor. Depois gera o instalador e o portátil do Windows, os pacotes de Linux e macOS e o pacote web, e anexa tudo a um **Release em rascunho**. Revise e publique.

Ele também pode ser disparado manualmente em *Actions → Release → Run workflow*. Nesse caso, os instaladores ficam em *Artifacts*.

## Compilar no Windows (local)

Pré-requisitos, instalados uma vez:

1. **Python 3.10+**, pelo instalador de python.org com o *py launcher*.
2. **Node.js 20+**.
3. **Rust**, pelo `rustup-init.exe` de rustup.rs.
4. **Visual Studio Build Tools** com a carga de trabalho "Desenvolvimento para desktop com C++".

Depois, no PowerShell, na raiz do repositório:

```powershell
powershell -ExecutionPolicy Bypass -File scripts\build.ps1
```

O script gera em `release\` o instalador, o portátil (`…_x64-portable.zip`) e o pacote web (`…_web.zip`). Ele:

- cria um ambiente Python só para o empacotamento em `%LOCALAPPDATA%\oscilo-build\venv`;
- empacota o servidor em `build\server`;
- compila a janela.

A pasta de compilação do Rust tem vários GB. Por isso o script a coloca em `%LOCALAPPDATA%\oscilo-build`, **fora do OneDrive**.

## Desenvolver

- `npm run desktop` abre a janela em modo de desenvolvimento. Se `build\server` não existir, o servidor é iniciado com o Python do sistema (ou o da variável `OSCILO_PYTHON`) a partir de `backend/desktop_server.py`.
- A versão web continua igual: `python -m uvicorn main:app --reload` em `backend/`.

## Arquivos

| Arquivo | Função |
|---|---|
| `backend/desktop_server.py` | Ponto de entrada do servidor desktop (porta, token, vigia do processo pai) |
| `desktop/oscilo-server.spec` | Empacotamento PyInstaller (onedir, com `static/` e `samples/`) |
| `desktop/splash/` | Tela de abertura enquanto o servidor inicia (e mensagens de erro) |
| `src-tauri/` | Janela Tauri: inicia/encerra o servidor e concede à interface só o diálogo "Abrir" |
| `scripts/build.ps1` | Build local no Windows (instalador, portátil e web) |
| `scripts/package_web.py` | Monta o pacote da versão web |
| `web/` | `iniciar.bat`, `iniciar.sh` e `LEIA-ME.txt` do pacote web |
| `backend/web_launcher.py` | Inicia a versão web e abre o navegador |
| `.github/workflows/release.yml` | Release por tag: instalador, portátil, Linux, macOS e web |
