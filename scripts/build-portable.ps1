# Gera só a versão portátil do Oscilo (Windows), para compilar e testar localmente:
#   release\Oscilo_<versão>_x64-portable.zip   o mesmo pacote publicado no Release
#   release\Oscilo-portatil\                   a mesma pasta já extraída, pronta para testar
#
# Mais rápido que scripts\build.ps1: não gera instalador (tauri build --no-bundle)
# nem a versão web.
#
# Uso (na raiz do repositório):
#   powershell -ExecutionPolicy Bypass -File scripts\build-portable.ps1            # tudo
#   powershell -ExecutionPolicy Bypass -File scripts\build-portable.ps1 -Run       # e abre o Oscilo
#   ... -SkipTests     não roda o pytest antes de compilar
#   ... -SkipServer    reaproveita build\server (só mudou Rust/lib.rs; o frontend
#                      static\ vai DENTRO do servidor, então mudou JS/CSS/HTML -> não use)
#   ... -Reinstall     reinstala as dependências Python do ambiente de build
#
# Requer: Python 3.10+, Node.js 20+ e Rust (rustup) com o Visual Studio Build Tools (C++).
# As pastas pesadas ficam em %LOCALAPPDATA%\oscilo-build (as mesmas do build.ps1).
param(
    [switch]$Run,
    [switch]$SkipTests,
    [switch]$SkipServer,
    [switch]$Reinstall
)
$ErrorActionPreference = "Stop"
$root = Split-Path -Parent $PSScriptRoot
Set-Location $root

function Step($text) { Write-Host ""; Write-Host "==> $text" -ForegroundColor Cyan }
function Check($what) { if ($LASTEXITCODE -ne 0) { throw "$what falhou (código $LASTEXITCODE)." } }

$version = (Get-Content src-tauri\tauri.conf.json -Raw | ConvertFrom-Json).version
$work = Join-Path $env:LOCALAPPDATA "oscilo-build"
New-Item -ItemType Directory -Force -Path $work | Out-Null
$env:CARGO_TARGET_DIR = Join-Path $work "target"
$timer = [Diagnostics.Stopwatch]::StartNew()
Write-Host "Oscilo $version - versão portátil"

# 0) Um Oscilo portátil aberto trava os arquivos da pasta de teste
$test = Join-Path $root "release\Oscilo-portatil"
Get-Process -Name "Oscilo", "oscilo-server" -ErrorAction SilentlyContinue |
    Where-Object { $_.Path -and $_.Path.StartsWith($test, [StringComparison]::OrdinalIgnoreCase) } |
    ForEach-Object { Write-Host "Encerrando $($_.Name) (PID $($_.Id))"; Stop-Process -Id $_.Id -Force }

# 1) Ambiente Python de build (criado uma vez)
$venv = Join-Path $work "venv"
$py = Join-Path $venv "Scripts\python.exe"
if (-not (Test-Path $py)) {
    Step "Criando ambiente Python de build em $venv"
    py -3 -m venv $venv; Check "Criação do venv"
    $Reinstall = $true
}
# venv antigo (ex.: criado pelo build.ps1) pode não ter tudo: confere os módulos usados aqui
if (-not $Reinstall) {
    # find_spec não escreve no stderr (no PowerShell 5.1, stderr + "Stop" vira exceção)
    & $py -c "import importlib.util as u, sys; sys.exit(0 if all(u.find_spec(m) for m in ('fastapi', 'numpy', 'comtrade', 'PyInstaller', 'pytest')) else 1)"
    if ($LASTEXITCODE -ne 0) { $Reinstall = $true }
}
if ($Reinstall) {
    Step "Instalando dependências Python"
    & $py -m pip install --upgrade pip | Out-Null
    & $py -m pip install -r backend\requirements.txt pyinstaller pytest; Check "pip install"
}

# 2) Testes do backend
if (-not $SkipTests) {
    Step "Testes (pytest)"
    Push-Location backend
    try { & $py -m pytest tests -q -p no:cacheprovider; Check "pytest" } finally { Pop-Location }
}

# 3) Servidor (backend + static + samples) -> build\server
$server = Join-Path $root "build\server"
if ($SkipServer -and (Test-Path (Join-Path $server "oscilo-server.exe"))) {
    Step "Reaproveitando build\server (-SkipServer)"
} else {
    Step "Servidor (PyInstaller)"
    & $py -m PyInstaller desktop\oscilo-server.spec --noconfirm --distpath (Join-Path $root "build") --workpath (Join-Path $work "pyinstaller")
    Check "PyInstaller"
}

# 4) Janela Tauri, sem instalador
Step "Janela (Tauri, sem instalador)"
if (-not (Test-Path node_modules)) { npm install; Check "npm install" }
npx tauri build --no-bundle; Check "tauri build"
$exe = Join-Path $env:CARGO_TARGET_DIR "release\oscilo.exe"
if (-not (Test-Path $exe)) { throw "oscilo.exe não encontrado em $exe" }

# 5) Pasta portátil (Oscilo.exe + server\ lado a lado) e o zip do Release
Step "Montando a versão portátil"
if (Test-Path $test) { Remove-Item -Recurse -Force $test }
New-Item -ItemType Directory -Force -Path $test | Out-Null
Copy-Item $exe (Join-Path $test "Oscilo.exe")
Copy-Item -Recurse $server (Join-Path $test "server")
Copy-Item LICENSE $test

$stage = Join-Path $work "portable\Oscilo"
if (Test-Path $stage) { Remove-Item -Recurse -Force $stage }
New-Item -ItemType Directory -Force -Path (Split-Path $stage) | Out-Null
Copy-Item -Recurse $test $stage
$zip = Join-Path $root "release\Oscilo_${version}_x64-portable.zip"
if (Test-Path $zip) { Remove-Item -Force $zip }
Compress-Archive -Path $stage -DestinationPath $zip

$timer.Stop()
$mb = "{0:N0} MB" -f ((Get-Item $zip).Length / 1MB)
Write-Host ""
Write-Host "Pronto em $([int]$timer.Elapsed.TotalMinutes) min $($timer.Elapsed.Seconds) s ($version):" -ForegroundColor Green
Write-Host "  $zip ($mb)"
Write-Host "  $test\Oscilo.exe"
Write-Host "Log do servidor: %LOCALAPPDATA%\io.github.angelommaia.oscilo\logs\server.log"

if ($Run) {
    Step "Abrindo o Oscilo"
    Start-Process (Join-Path $test "Oscilo.exe")
}
