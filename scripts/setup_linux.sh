#!/usr/bin/env bash
# Create the Python 3.10 environment used by the Ming TTS Studio backend.
# Works on Linux and inside WSL2.
set -Eeuo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT_DIR"

PYTHON_BIN="${PYTHON_BIN:-}"
if [[ -z "$PYTHON_BIN" ]]; then
    for candidate in python3.10 python3; do
        if command -v "$candidate" >/dev/null 2>&1; then
            if "$candidate" -c 'import sys; raise SystemExit(0 if sys.version_info[:2] == (3, 10) else 1)' 2>/dev/null; then
                PYTHON_BIN="$(command -v "$candidate")"
                break
            fi
        fi
    done
fi

if [[ -z "$PYTHON_BIN" ]]; then
    cat >&2 <<'EOF'
错误: 未找到 Python 3.10。

Ubuntu / Debian:
  sudo apt update && sudo apt install -y python3.10 python3.10-venv python3-pip

其他发行版请安装 Python 3.10 后重试，或用 PYTHON_BIN=/path/to/python3.10 指定。
EOF
    exit 1
fi

echo "使用 Python: $PYTHON_BIN ($("$PYTHON_BIN" -V 2>&1))"

if [[ ! -d .venv ]]; then
    echo "创建虚拟环境 .venv ..."
    "$PYTHON_BIN" -m venv .venv
fi

VENV_PY="$ROOT_DIR/.venv/bin/python"
"$VENV_PY" -m pip install --upgrade pip wheel

echo "安装推理与 API 依赖（torch 2.7.1 + CUDA 11.8，首次约 2-4 GB）..."
"$VENV_PY" -m pip install -r server/requirements-server.txt

if [[ "${SKIP_MODELSCOPE:-0}" != "1" ]]; then
    echo "安装魔搭下载器（可选，用于 --source modelscope）..."
    "$VENV_PY" -m pip install -r server/requirements-modelscope.txt
fi

if ! command -v nvidia-smi >/dev/null 2>&1; then
    echo
    echo "警告: 未检测到 nvidia-smi，推理需要 NVIDIA 驱动 >= 525 和至少一张 24 GB 显存显卡。" >&2
fi

echo
echo "环境准备完成。下一步："
echo "  ./start.sh                          # 自动下载模型并启动（默认 auto: 魔搭优先，失败转 Hugging Face）"
echo "  ./start.sh --source modelscope      # 强制使用魔搭"
echo "  ./start.sh --source huggingface     # 强制使用 Hugging Face"
echo "  .venv/bin/python server/download_model.py --help"
