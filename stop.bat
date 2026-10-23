@echo off
chcp 65001 >nul
rem Stop the gateway and all workers started by start.bat.
setlocal
cd /d "%~dp0"

if exist ".venv\Scripts\python.exe" (
    ".venv\Scripts\python.exe" server\launcher.py stop %*
    exit /b %ERRORLEVEL%
)

where wsl.exe >nul 2>nul
if errorlevel 1 (
    echo 未找到 .venv，也未检测到 WSL2。
    exit /b 1
)

rem "%~dp0" already ends with a backslash; the dot keeps the quoting intact.
for /f "usebackq delims=" %%i in (`wsl.exe wslpath -a "%~dp0."`) do set "WSLDIR=%%i"
if not defined WSLDIR (
    echo 无法将项目路径转换为 WSL 路径，请确认已安装 WSL2 发行版。
    exit /b 1
)
wsl.exe bash -lc "cd '%WSLDIR%' && ./stop.sh %*"
exit /b %ERRORLEVEL%
