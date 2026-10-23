#!/usr/bin/env bash
# Show PID files and gateway health.
set -Eeuo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$ROOT_DIR"

PYTHON_BIN="${PYTHON_BIN:-$ROOT_DIR/.venv/bin/python}"
if [[ ! -x "$PYTHON_BIN" ]]; then
    echo "错误: 未找到 .venv，服务尚未部署。" >&2
    exit 1
fi

exec "$PYTHON_BIN" server/launcher.py status "$@"
