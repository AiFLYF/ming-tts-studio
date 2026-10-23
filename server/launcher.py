#!/usr/bin/env python3
"""Cross-platform launcher for the Ming TTS Studio backend.

It downloads the checkpoint when needed, starts one worker per GPU behind the
least-in-flight gateway, warms the workers, and records PID files so the same
command can stop or inspect the deployment later.

Examples:
    python server/launcher.py start --source modelscope
    python server/launcher.py start --gpus 0,1 --no-warmup
    python server/launcher.py status
    python server/launcher.py stop
"""

from __future__ import annotations

import argparse
import importlib.util
import json
import os
import shutil
import signal
import socket
import subprocess
import sys
import time
import urllib.error
import urllib.request
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

BASE_DIR = Path(__file__).resolve().parent.parent
SERVER_DIR = BASE_DIR / "server"
RUN_DIR = BASE_DIR / "run"
LOG_DIR = BASE_DIR / "logs"
UPLOAD_DIR = BASE_DIR / "uploads"
DEFAULT_MODEL_PATH = BASE_DIR / "models" / "Ming-3.0-tts-tiny"
DEFAULT_MODEL_ID = "inclusionAI/Ming-3.0-tts-tiny"

REQUIRED_MODULES = (
    "fastapi",
    "uvicorn",
    "httpx",
    "multipart",
    "torch",
    "torchaudio",
    "transformers",
    "soundfile",
    "onnxruntime",
    "x_transformers",
    "einops",
    "einx",
    "fla",
    "triton",
)


def load_env_file(path: Path = BASE_DIR / ".env") -> None:
    if not path.is_file():
        return
    for raw_line in path.read_text(encoding="utf-8").splitlines():
        line = raw_line.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        key, value = line.split("=", 1)
        key = key.strip()
        value = value.strip().strip('"').strip("'")
        if key and key not in os.environ:
            os.environ[key] = value


def log(message: str) -> None:
    print(message, flush=True)


def _pid_alive(pid: int) -> bool:
    if pid <= 0:
        return False
    if os.name == "nt":
        import ctypes

        synchronize = 0x00100000
        handle = ctypes.windll.kernel32.OpenProcess(synchronize, False, pid)
        if not handle:
            return False
        ctypes.windll.kernel32.CloseHandle(handle)
        return True
    try:
        os.kill(pid, 0)
    except OSError:
        return False
    return True


def _read_pid(name: str) -> int | None:
    path = RUN_DIR / name
    try:
        return int(path.read_text(encoding="utf-8").strip())
    except (OSError, ValueError):
        return None


def _write_pid(name: str, pid: int) -> None:
    RUN_DIR.mkdir(parents=True, exist_ok=True)
    (RUN_DIR / name).write_text(f"{pid}\n", encoding="utf-8")


def _pid_files() -> list[Path]:
    if not RUN_DIR.is_dir():
        return []
    return sorted(RUN_DIR.glob("worker_*.pid")) + sorted(RUN_DIR.glob("gateway.pid"))


def _running_pids() -> list[tuple[str, int]]:
    running = []
    for path in _pid_files():
        try:
            pid = int(path.read_text(encoding="utf-8").strip())
        except (OSError, ValueError):
            pid = 0
        if _pid_alive(pid):
            running.append((path.name, pid))
        else:
            path.unlink(missing_ok=True)
    return running


def check_python() -> None:
    if sys.version_info[:2] != (3, 10):
        message = (
            f"Python 3.10.x is required by the pinned Ming-3.0-tts-tiny runtime; "
            f"current interpreter is {sys.version.split()[0]} ({sys.executable}). "
            "Use scripts/setup_linux.sh or setup_windows.ps1 to create .venv."
        )
        if os.environ.get("ALLOW_UNSUPPORTED_PYTHON") == "1":
            log(f"Warning: {message}")
        else:
            raise SystemExit(message)


def check_dependencies() -> None:
    missing = [name for name in REQUIRED_MODULES if importlib.util.find_spec(name) is None]
    if missing:
        lines = [
            "Missing Python packages: " + ", ".join(missing),
            "Install the environment first:",
            "  Linux/WSL:  ./scripts/setup_linux.sh",
            "  Windows:    scripts\\setup_windows.ps1 -Native",
        ]
        raise SystemExit("\n".join(lines))


def _nvidia_gpus() -> list[dict]:
    executable = shutil.which("nvidia-smi")
    if not executable:
        raise SystemExit("nvidia-smi was not found. An NVIDIA GPU and driver are required.")
    command = [
        executable,
        "--query-gpu=index,memory.free,name",
        "--format=csv,noheader,nounits",
    ]
    result = subprocess.run(command, capture_output=True, text=True, check=False)
    if result.returncode != 0:
        raise SystemExit(f"nvidia-smi failed: {result.stderr.strip() or result.stdout.strip()}")
    gpus = []
    for line in result.stdout.splitlines():
        parts = [part.strip() for part in line.split(",")]
        if len(parts) < 3:
            continue
        try:
            gpus.append({"index": int(parts[0]), "free_mb": int(parts[1]), "name": ", ".join(parts[2:])})
        except ValueError:
            continue
    if not gpus:
        raise SystemExit("nvidia-smi did not report any GPUs.")
    return gpus


def select_gpus(raw: str, count: int | None) -> tuple[list[int], dict[int, dict]]:
    info = {gpu["index"]: gpu for gpu in _nvidia_gpus()}
    if raw.strip():
        try:
            selected = [int(item.strip()) for item in raw.split(",") if item.strip()]
        except ValueError as error:
            raise SystemExit(f"Invalid GPU list: {raw!r}") from error
    elif count:
        selected = sorted(info)[:count]
    else:
        selected = sorted(info)
    if not selected:
        raise SystemExit("No GPUs selected.")
    if len(set(selected)) != len(selected):
        raise SystemExit(f"Duplicate GPU indices: {selected}")
    missing = [gpu for gpu in selected if gpu not in info]
    if missing:
        raise SystemExit(f"GPU indices not found: {missing}; available: {sorted(info)}")
    return selected, info


def _port_free(port: int) -> bool:
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as sock:
        if os.name != "nt":
            # On Windows SO_REUSEADDR lets two sockets share a port, which would
            # make this probe report "free" for a port that is actually taken.
            sock.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
        try:
            sock.bind(("0.0.0.0", port))
        except OSError:
            return False
    return True


def _http_json(url: str, timeout: float = 3.0) -> dict:
    request = urllib.request.Request(url, headers={"Accept": "application/json"})
    with urllib.request.urlopen(request, timeout=timeout) as response:
        return json.loads(response.read().decode("utf-8"))


def _tail(path: Path, lines: int = 35) -> str:
    try:
        content = path.read_text(encoding="utf-8", errors="replace").splitlines()
    except OSError:
        return ""
    return "\n".join(content[-lines:])


def _popen_kwargs() -> dict:
    if os.name == "nt":
        flags = getattr(subprocess, "CREATE_NEW_PROCESS_GROUP", 0)
        flags |= getattr(subprocess, "DETACHED_PROCESS", 0)
        return {"creationflags": flags}
    return {"start_new_session": True}


def _spawn(script: Path, env: dict, log_path: Path) -> subprocess.Popen:
    log_path.parent.mkdir(parents=True, exist_ok=True)
    handle = open(log_path, "w", encoding="utf-8", buffering=1)
    try:
        process = subprocess.Popen(
            [sys.executable, str(script)],
            cwd=str(BASE_DIR),
            env=env,
            stdin=subprocess.DEVNULL,
            stdout=handle,
            stderr=subprocess.STDOUT,
            **_popen_kwargs(),
        )
    finally:
        handle.close()
    return process


def _worker_env(gpu: int, port: int, model_path: Path) -> dict:
    env = os.environ.copy()
    env.update(
        {
            "CUDA_VISIBLE_DEVICES": str(gpu),
            "DEVICE": "cuda:0",
            "HOST": "127.0.0.1",
            "PORT": str(port),
            "MODEL_PATH": str(model_path),
            "UPLOAD_DIR": str(UPLOAD_DIR),
            "PYTHONUNBUFFERED": "1",
            "PYTHONPATH": str(SERVER_DIR) + os.pathsep + env.get("PYTHONPATH", ""),
            "TOKENIZERS_PARALLELISM": "false",
        }
    )
    return env


def _gateway_env(worker_ports: list[int], gpus: list[int], gateway_port: int) -> dict:
    env = os.environ.copy()
    env.update(
        {
            "HOST": "0.0.0.0",
            "PORT": str(gateway_port),
            "WORKER_PORTS": ",".join(str(port) for port in worker_ports),
            "WORKER_GPUS": ",".join(str(gpu) for gpu in gpus),
            "STUDIO_DIR": str(BASE_DIR),
            "PYTHONUNBUFFERED": "1",
            "PYTHONPATH": str(SERVER_DIR) + os.pathsep + env.get("PYTHONPATH", ""),
        }
    )
    return env


def _wait_workers(processes: list[dict], timeout: float) -> None:
    deadline = time.monotonic() + timeout
    pending = {item["port"] for item in processes}
    last_report = 0.0
    while pending and time.monotonic() < deadline:
        for item in processes:
            port = item["port"]
            if port not in pending:
                continue
            if item["process"].poll() is not None:
                tail = _tail(item["log"])
                raise SystemExit(
                    f"Worker for GPU {item['gpu']} exited with code "
                    f"{item['process'].returncode}.\n{tail}"
                )
            try:
                payload = _http_json(f"http://127.0.0.1:{port}/health", timeout=2)
                if payload.get("model_loaded"):
                    pending.discard(port)
                    log(f"  GPU {item['gpu']} ready on :{port}")
            except Exception:
                pass
        if not pending:
            break
        now = time.monotonic()
        if now - last_report > 15:
            ready = len(processes) - len(pending)
            log(f"  loading checkpoint... {ready}/{len(processes)} workers ready")
            last_report = now
        time.sleep(3)
    if pending:
        lines = []
        for item in processes:
            if item["port"] in pending:
                lines.append(f"--- GPU {item['gpu']} log ---\n{_tail(item['log'])}")
        raise SystemExit("Timed out waiting for workers:\n" + "\n".join(lines))


def _warmup(processes: list[dict]) -> None:
    body = json.dumps({"task": "ip", "text": "你好。", "ip": "灵小柔"}).encode("utf-8")

    def warm(item: dict) -> tuple[int, str | None]:
        request = urllib.request.Request(
            f"http://127.0.0.1:{item['port']}/generate",
            data=body,
            headers={"Content-Type": "application/json"},
            method="POST",
        )
        try:
            with urllib.request.urlopen(request, timeout=600) as response:
                response.read()
            return item["gpu"], None
        except Exception as error:  # noqa: BLE001 - report each worker failure
            return item["gpu"], str(error)

    with ThreadPoolExecutor(max_workers=len(processes)) as executor:
        results = list(executor.map(warm, processes))
    failures = [(gpu, error) for gpu, error in results if error]
    if failures:
        details = "\n".join(f"GPU {gpu}: {error}" for gpu, error in failures)
        raise SystemExit(f"Worker warm-up failed:\n{details}")


def _wait_gateway(port: int, expected: int, timeout: float = 60) -> dict:
    deadline = time.monotonic() + timeout
    last_error = ""
    while time.monotonic() < deadline:
        try:
            payload = _http_json(f"http://127.0.0.1:{port}/health", timeout=2)
            if payload.get("workers_available") == expected:
                return payload
            last_error = json.dumps(payload, ensure_ascii=False)
        except Exception as error:  # noqa: BLE001 - keep polling
            last_error = str(error)
        time.sleep(1)
    raise SystemExit(f"Gateway did not become ready: {last_error}")


def command_start(args: argparse.Namespace) -> int:
    check_python()
    check_dependencies()

    from download_model import download_model, is_model_complete

    model_path = Path(args.model_path).expanduser().resolve()
    if not is_model_complete(model_path):
        if args.dry_run:
            # A dry run is a plan preview: never pull the checkpoint for it.
            log(f"Model not present at {model_path}; a real run would download it first.")
        elif args.skip_model_download:
            raise SystemExit(
                f"Model is incomplete at {model_path}. Remove --skip-model-download or set MODEL_PATH."
            )
        else:
            log(f"Downloading checkpoint via {args.source} ...")
            download_model(
                source=args.source,
                model_id=args.model_id,
                output=model_path,
                revision=args.revision,
            )

    running = _running_pids()
    if running:
        lines = ", ".join(f"{name}={pid}" for name, pid in running)
        raise SystemExit(f"Services are already running ({lines}). Run stop first.")

    selected, gpu_info = select_gpus(args.gpus, args.gpu_count)
    min_free = int(os.environ.get("MIN_FREE_VRAM_MB", "19000"))
    for gpu in selected:
        free = gpu_info[gpu]["free_mb"]
        if free < min_free:
            raise SystemExit(
                f"GPU {gpu} has only {free} MiB free; need {min_free} MiB. "
                "Free the GPU or lower MIN_FREE_VRAM_MB."
            )

    worker_ports = [args.worker_base_port + index for index in range(len(selected))]
    if args.gateway_port in worker_ports:
        raise SystemExit(
            f"Gateway port {args.gateway_port} collides with a worker port "
            f"({worker_ports[0]}+). Move --worker-base-port or --gateway-port."
        )
    all_ports = worker_ports + [args.gateway_port]
    busy = [port for port in all_ports if not _port_free(port)]
    if busy:
        raise SystemExit(
            f"Ports already in use: {busy}. Stop the old service or choose different ports."
        )

    log("Ming TTS Studio deployment plan")
    log(f"  Python:   {sys.executable}")
    log(f"  Model:    {model_path}")
    for gpu, port in zip(selected, worker_ports):
        log(f"  GPU {gpu:<2}   worker :{port}  ({gpu_info[gpu]['name']}, {gpu_info[gpu]['free_mb']} MiB free)")
    log(f"  Gateway:  :{args.gateway_port}")
    log(f"  Uploads:  {UPLOAD_DIR}")
    if args.dry_run:
        log("Dry run complete; nothing was started.")
        return 0

    RUN_DIR.mkdir(parents=True, exist_ok=True)
    LOG_DIR.mkdir(parents=True, exist_ok=True)
    UPLOAD_DIR.mkdir(parents=True, exist_ok=True)

    processes = []
    try:
        for gpu, port in zip(selected, worker_ports):
            log_path = LOG_DIR / f"worker_gpu{gpu}.log"
            process = _spawn(SERVER_DIR / "worker.py", _worker_env(gpu, port, model_path), log_path)
            _write_pid(f"worker_{gpu}.pid", process.pid)
            processes.append({"gpu": gpu, "port": port, "process": process, "log": log_path})
            log(f"Started worker GPU {gpu} on :{port} (pid {process.pid})")

        log("Waiting for checkpoints to load (1-3 minutes per worker)...")
        _wait_workers(processes, timeout=float(os.environ.get("STARTUP_TIMEOUT", "900")))

        if not args.no_warmup:
            log("Warming up workers (first inference can take about 30 seconds)...")
            _warmup(processes)
            log("Warm-up complete.")

        gateway_log = LOG_DIR / "gateway.log"
        gateway = _spawn(
            SERVER_DIR / "gateway.py",
            _gateway_env(worker_ports, selected, args.gateway_port),
            gateway_log,
        )
        _write_pid("gateway.pid", gateway.pid)
        (RUN_DIR / "gateway.port").write_text(f"{args.gateway_port}\n", encoding="utf-8")
        log(f"Started gateway on :{args.gateway_port} (pid {gateway.pid})")
        _wait_gateway(args.gateway_port, len(selected))
    except BaseException:
        log("Startup failed; stopping processes created by this run...")
        command_stop(argparse.Namespace())
        raise

    log("")
    log("Ming TTS Studio is ready")
    log(f"  Studio:   http://127.0.0.1:{args.gateway_port}/studio/")
    log(f"  API:      http://127.0.0.1:{args.gateway_port}")
    log(f"  Health:   http://127.0.0.1:{args.gateway_port}/health")
    log(f"  Docs:     http://127.0.0.1:{args.gateway_port}/docs")
    log(f"  Logs:     {LOG_DIR}")
    log("  Stop:     ./stop.sh   (Windows: stop.bat)")
    return 0


def _terminate(pid: int, name: str) -> None:
    if not _pid_alive(pid):
        return
    log(f"Stopping {name} (pid {pid})...")
    if os.name == "nt":
        subprocess.run(
            ["taskkill", "/PID", str(pid), "/T", "/F"],
            capture_output=True,
            text=True,
            check=False,
        )
        return
    try:
        os.kill(pid, signal.SIGTERM)
    except OSError:
        return
    deadline = time.monotonic() + 30
    while time.monotonic() < deadline:
        if not _pid_alive(pid):
            return
        time.sleep(0.5)
    try:
        os.kill(pid, signal.SIGKILL)
    except OSError:
        pass


def command_stop(_: argparse.Namespace) -> int:
    gateway_pid = _read_pid("gateway.pid")
    if gateway_pid:
        _terminate(gateway_pid, "gateway")
    (RUN_DIR / "gateway.pid").unlink(missing_ok=True)
    (RUN_DIR / "gateway.port").unlink(missing_ok=True)

    worker_files = sorted(RUN_DIR.glob("worker_*.pid")) if RUN_DIR.is_dir() else []
    for path in worker_files:
        try:
            pid = int(path.read_text(encoding="utf-8").strip())
        except (OSError, ValueError):
            pid = 0
        _terminate(pid, path.stem)
        path.unlink(missing_ok=True)
    log("Ming TTS Studio stopped.")
    return 0


def command_status(_: argparse.Namespace) -> int:
    found = False
    for path in _pid_files():
        pid = _read_pid(path.name)
        state = "running" if pid and _pid_alive(pid) else "stopped"
        if pid:
            found = True
        log(f"{path.stem:<12} pid={pid or '-':<8} {state}")
    if not found:
        log("No PID files recorded; the service is probably stopped.")

    port = int(os.environ.get("GATEWAY_PORT", "8081"))
    port_file = RUN_DIR / "gateway.port"
    try:
        port = int(port_file.read_text(encoding="utf-8").strip())
    except (OSError, ValueError):
        pass
    try:
        health = _http_json(f"http://127.0.0.1:{port}/health", timeout=2)
        log("Gateway /health: " + json.dumps(health, ensure_ascii=False))
    except Exception as error:  # noqa: BLE001 - status should not fail hard
        log(f"Gateway /health unavailable on :{port} ({error})")
    return 0


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description="Ming TTS Studio backend launcher")
    subparsers = parser.add_subparsers(dest="command", required=True)

    start = subparsers.add_parser("start", help="Download the model if needed and start the cluster")
    start.add_argument(
        "--source",
        default=os.environ.get("MODEL_SOURCE", "auto"),
        choices=["auto", "modelscope", "huggingface"],
        help="Checkpoint download source (default: auto)",
    )
    start.add_argument("--model-id", default=os.environ.get("MODEL_ID", DEFAULT_MODEL_ID))
    start.add_argument("--model-path", default=os.environ.get("MODEL_PATH", str(DEFAULT_MODEL_PATH)))
    start.add_argument("--revision", default=os.environ.get("MODEL_REVISION"))
    start.add_argument("--gpus", default=os.environ.get("GPUS", ""))
    start.add_argument("--gpu-count", type=int, default=int(os.environ.get("GPU_COUNT", "0")) or None)
    start.add_argument("--gateway-port", type=int, default=int(os.environ.get("GATEWAY_PORT", "8081")))
    start.add_argument(
        "--worker-base-port", type=int, default=int(os.environ.get("WORKER_BASE_PORT", "8091"))
    )
    start.add_argument("--no-warmup", action="store_true")
    start.add_argument("--skip-model-download", action="store_true")
    start.add_argument("--dry-run", action="store_true")
    start.set_defaults(func=command_start)

    stop = subparsers.add_parser("stop", help="Stop workers and gateway")
    stop.set_defaults(func=command_stop)

    status = subparsers.add_parser("status", help="Show PID and health status")
    status.set_defaults(func=command_status)

    download = subparsers.add_parser("download-model", help="Only download the checkpoint")
    download.add_argument("--source", default=os.environ.get("MODEL_SOURCE", "auto"))
    download.add_argument("--model-id", default=os.environ.get("MODEL_ID", DEFAULT_MODEL_ID))
    download.add_argument("--model-path", default=os.environ.get("MODEL_PATH", str(DEFAULT_MODEL_PATH)))
    download.add_argument("--revision", default=os.environ.get("MODEL_REVISION"))
    download.set_defaults(func=command_download)

    return parser


def command_download(args: argparse.Namespace) -> int:
    from download_model import download_model

    download_model(
        source=args.source,
        model_id=args.model_id,
        output=args.model_path,
        revision=args.revision,
    )
    return 0


def main() -> int:
    load_env_file()
    parser = build_parser()
    args = parser.parse_args()
    try:
        return args.func(args)
    except KeyboardInterrupt:
        log("Interrupted.")
        return 130
    except SystemExit as error:
        message = str(error)
        if message:
            log(message)
        return 1
    except Exception as error:  # noqa: BLE001 - CLI boundary
        log(f"Error: {error}")
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
