# Gera as três distribuições do Oscilo (Windows):
#   release\Oscilo_<versão>_x64-setup.exe      instalador (NSIS, sem administrador)
#   release\Oscilo_<versão>_x64-portable.zip   portátil: extraia e execute Oscilo.exe
#   release\Oscilo_<versão>_web.zip            versão web (navegador; requer Python)
#
# Requer: Python 3.10+, Node.js 20+ e Rust (rustup) com o Visual Studio Build Tools (C++).
# Passo a passo: docs/desktop.md. As pastas pesadas de compilação vão para
# %LOCALAPPDATA%\oscilo-build (fora de pastas sincronizadas).
$ErrorActionPreference = "Stop"
$root = Split-Path -Parent $PSScriptRoot
Set-Location $root

$version = (Get-Content src-tauri\tauri.conf.json -Raw | ConvertFrom-Json).version
$work = Join-Path $env:LOCALAPPDATA "oscilo-build"
New-Item -ItemType Directory -Force -Path $work | Out-Null
$env:CARGO_TARGET_DIR = Join-Path $work "target"

# 1) Ambiente Python isolado só para o empacotamento
$venv = Join-Path $work "venv"
if (-not (Test-Path (Join-Path $venv "Scripts\python.exe"))) {
    Write-Host "Criando ambiente Python de build em $venv"
    py -3 -m venv $venv
}
$py = Join-Path $venv "Scripts\python.exe"
& $py -m pip install --upgrade pip | Out-Null
& $py -m pip install -r backend\requirements.txt pyinstaller

# 2) Servidor (backend) -> build\server
$server = Join-Path $root "build\server"
& $py -m PyInstaller desktop\oscilo-server.spec --noconfirm --distpath (Join-Path $root "build") --workpath (Join-Path $work "pyinstaller")

# 3) Janela Tauri + instalador NSIS
npm install
npx tauri build

$rel = Join-Path $root "release"
New-Item -ItemType Directory -Force -Path $rel | Out-Null
Copy-Item -Force (Join-Path $env:CARGO_TARGET_DIR "release\bundle\nsis\*.exe") $rel

# 4) Portátil: Oscilo.exe + server\ lado a lado
$stage = Join-Path $work "portable\Oscilo"
if (Test-Path $stage) { Remove-Item -Recurse -Force $stage }
New-Item -ItemType Directory -Force -Path $stage | Out-Null
Copy-Item (Join-Path $env:CARGO_TARGET_DIR "release\oscilo.exe") (Join-Path $stage "Oscilo.exe")
Copy-Item -Recurse $server (Join-Path $stage "server")
Copy-Item LICENSE $stage
$portable = Join-Path $rel "Oscilo_${version}_x64-portable.zip"
if (Test-Path $portable) { Remove-Item -Force $portable }
Compress-Archive -Path $stage -DestinationPath $portable

# 5) Versão web
& $py scripts\package_web.py --out $rel

Write-Host ""
Write-Host "Pronto ($version):"
Get-ChildItem $rel | Where-Object { $_.Name -like "*$version*" } | ForEach-Object { Write-Host "  $($_.FullName)" }
