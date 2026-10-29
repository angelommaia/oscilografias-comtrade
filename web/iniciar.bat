@echo off
rem Oscilo - versao web. Cria o ambiente Python na primeira execucao e abre o navegador.
rem Opcoes: iniciar.bat --host 0.0.0.0   (acesso pela rede)   --port 8080   --no-browser
setlocal
cd /d "%~dp0"
set "VENV=%~dp0.venv"
if exist "%VENV%\Scripts\python.exe" goto deps
echo Preparando o ambiente Python - apenas na primeira execucao...
py -3 -m venv "%VENV%" 2>nul
if not exist "%VENV%\Scripts\python.exe" python -m venv "%VENV%"
if not exist "%VENV%\Scripts\python.exe" goto nopython
:deps
fc /b "backend\requirements.txt" "%VENV%\requirements.ok" >nul 2>&1
if not errorlevel 1 goto run
echo Instalando dependencias...
"%VENV%\Scripts\python.exe" -m pip install --disable-pip-version-check -q -r "backend\requirements.txt"
if errorlevel 1 goto fail
copy /y "backend\requirements.txt" "%VENV%\requirements.ok" >nul
:run
"%VENV%\Scripts\python.exe" "backend\web_launcher.py" %*
goto end
:nopython
echo.
echo Python 3.10 ou mais novo nao foi encontrado.
echo Instale em https://www.python.org/downloads/ e execute este arquivo novamente.
:fail
pause
:end
endlocal
