#!/usr/bin/env bash
# One-click start for Linux / WSL2. Downloads the checkpoint on first run.
set -Eeuo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$ROOT_DIR"

PYTHON_BIN="${PYTHON_BIN:-$ROOT_DIR/.venv/bin/python}"
if [[ ! -x "$PYTHON_BIN" ]]; then
    cat >&2 <<'EOF'
错误: 未找到 .venv 环境。

首次部署请执行:
  ./scripts/setup_linux.sh
然后重新运行 ./start.sh
EOF
    exit 1
fi

exec "$PYTHON_BIN" server/launcher.py start "$@"
