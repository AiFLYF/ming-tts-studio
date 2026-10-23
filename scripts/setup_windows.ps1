# Create the Ming TTS Studio environment on Windows.
#
# Default (recommended): install and run inside WSL2. The script delegates to
# scripts/setup_linux.sh in the current WSL distribution.
#
# Native Windows is experimental because Triton has no official Windows build.
# Use -Native to create a Windows .venv with triton-windows.
#
#   powershell -ExecutionPolicy Bypass -File scripts\setup_windows.ps1
#   powershell -ExecutionPolicy Bypass -File scripts\setup_windows.ps1 -Native

param(
    [switch]$Native,
    [switch]$SkipModelScope,
    [string]$Python = "python"
)

$ErrorActionPreference = "Stop"
$Root = Split-Path -Parent $PSScriptRoot
Set-Location $Root

function Fail([string]$Message) {
    Write-Host $Message -ForegroundColor Red
    exit 1
}

if (-not $Native) {
    $wsl = Get-Command wsl.exe -ErrorAction SilentlyContinue
    if (-not $wsl) {
        Fail @"
未检测到 WSL2。Windows 上推荐通过 WSL2 部署：
  1. 以管理员身份打开 PowerShell，执行: wsl --install -d Ubuntu-22.04
  2. 重启后完成 Ubuntu 初始化
  3. 重新运行本脚本

如确需原生 Windows（实验性），请使用: scripts\setup_windows.ps1 -Native
"@
    }

    $linuxRoot = (& wsl.exe wslpath -a ($Root -replace '\\', '/')).Trim()
    if ($LASTEXITCODE -ne 0 -or -not $linuxRoot) {
        Fail "无法把项目路径转换为 WSL 路径，请确认 WSL 中已安装 Ubuntu 发行版。"
    }

    Write-Host "通过 WSL2 准备环境: $linuxRoot"
    $skip = if ($SkipModelScope) { "SKIP_MODELSCOPE=1 " } else { "" }
    wsl.exe bash -lc "cd '$linuxRoot' && ${skip}./scripts/setup_linux.sh"
    exit $LASTEXITCODE
}

Write-Host "原生 Windows 模式（实验性）" -ForegroundColor Yellow

# Probe first: with $ErrorActionPreference = "Stop", invoking a missing command
# throws CommandNotFoundException before any $LASTEXITCODE check can run.
if (-not (Get-Command $Python -ErrorAction SilentlyContinue)) {
    Fail "未找到 Python（$Python）。请先安装 Python 3.10.x 并勾选 Add to PATH，或用 -Python 指定解释器路径。"
}

$versionOk = & $Python -c "import sys; print('ok' if sys.version_info[:2] == (3, 10) else sys.version.split()[0])"
if ($LASTEXITCODE -ne 0) {
    Fail "未找到 Python，请先安装 Python 3.10.x 并勾选 Add to PATH。"
}
if ($versionOk.Trim() -ne "ok") {
    Fail "需要 Python 3.10.x，当前为 $($versionOk.Trim())。请安装 3.10 后使用 -Python 指定解释器。"
}

if (-not (Test-Path ".venv\Scripts\python.exe")) {
    Write-Host "创建虚拟环境 .venv ..."
    & $Python -m venv .venv
    if ($LASTEXITCODE -ne 0) { Fail "创建虚拟环境失败。" }
}

$VenvPython = Join-Path $Root ".venv\Scripts\python.exe"
& $VenvPython -m pip install --upgrade pip wheel
if ($LASTEXITCODE -ne 0) { Fail "升级 pip 失败。" }

Write-Host "安装推理与 API 依赖（torch 2.7.1 + CUDA 11.8，首次约 2-4 GB）..."
& $VenvPython -m pip install -r server\requirements-server-windows.txt
if ($LASTEXITCODE -ne 0) { Fail "依赖安装失败。请检查网络或使用国内镜像。" }

if (-not $SkipModelScope) {
    Write-Host "安装魔搭下载器（可选）..."
    & $VenvPython -m pip install -r server\requirements-modelscope.txt
    if ($LASTEXITCODE -ne 0) { Write-Host "魔搭下载器安装失败，Hugging Face 下载仍可使用。" -ForegroundColor Yellow }
}

if (-not (Get-Command nvidia-smi -ErrorAction SilentlyContinue)) {
    Write-Host "警告: 未检测到 nvidia-smi，推理需要 NVIDIA 驱动 >= 525 和至少一张 24 GB 显存显卡。" -ForegroundColor Yellow
}

Write-Host ""
Write-Host "环境准备完成。下一步运行: start.bat" -ForegroundColor Green
Write-Host "  start.bat --source modelscope     # 强制使用魔搭"
Write-Host "  start.bat --source huggingface    # 强制使用 Hugging Face"
