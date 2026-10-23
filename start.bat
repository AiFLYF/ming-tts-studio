@echo off
chcp 65001 >nul
rem One-click start for Windows.
rem Prefers a native .venv; otherwise delegates to WSL2 (recommended).
setlocal
cd /d "%~dp0"

if exist ".venv\Scripts\python.exe" (
    ".venv\Scripts\python.exe" server\launcher.py start %*
    exit /b %ERRORLEVEL%
)

where wsl.exe >nul 2>nul
if errorlevel 1 (
    echo.
    echo 未找到 .venv，也未检测到 WSL2。
    echo 首次部署请运行: powershell -ExecutionPolicy Bypass -File scripts\setup_windows.ps1
    echo 原生 Windows 环境: powershell -ExecutionPolicy Bypass -File scripts\setup_windows.ps1 -Native
    echo.
    exit /b 1
)

rem "%~dp0" always ends with a backslash; a trailing \" would close the quote
rem early and corrupt the argument passed to wslpath.
for /f "usebackq delims=" %%i in (`wsl.exe wslpath -a "%~dp0."`) do set "WSLDIR=%%i"
if not defined WSLDIR (
    echo 无法将项目路径转换为 WSL 路径，请确认已安装 WSL2 发行版。
    exit /b 1
)

echo 通过 WSL2 启动: %WSLDIR%
wsl.exe bash -lc "cd '%WSLDIR%' && ./start.sh %*"
exit /b %ERRORLEVEL%
