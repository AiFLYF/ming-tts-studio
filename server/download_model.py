#!/usr/bin/env python3
"""Download Ming-3.0-tts-tiny from ModelScope (魔搭) or Hugging Face.

Both hubs publish the checkpoint under the same repository id. The downloader
targets a normal directory (not a symlinked cache) so it can be moved, copied
to Windows/WSL, and passed to ModelScope or Hugging Face interchangeably.

Examples:
    python server/download_model.py --source modelscope
    python server/download_model.py --source huggingface
    python server/download_model.py --source auto --output models/Ming-3.0-tts-tiny
"""

from __future__ import annotations

import argparse
import importlib.util
import json
import os
import shutil
import sys
from pathlib import Path

DEFAULT_MODEL_ID = "inclusionAI/Ming-3.0-tts-tiny"
DEFAULT_OUTPUT = Path(__file__).resolve().parent.parent / "models" / "Ming-3.0-tts-tiny"


def normalize_source(value: str) -> str:
    value = (value or "auto").strip().lower()
    aliases = {
        "auto": "auto",
        "modelscope": "modelscope",
        "ms": "modelscope",
        "魔搭": "modelscope",
        "huggingface": "huggingface",
        "hf": "huggingface",
        "hugging-face": "huggingface",
    }
    if value not in aliases:
        raise ValueError(f"Unknown model source: {value}")
    return aliases[value]


def is_model_complete(path: Path) -> bool:
    """Check that the checkpoint can actually be loaded.

    A 17 GB download interrupted near the end still leaves config.json,
    tokenizer.json and some .safetensors behind, so a presence-only check would
    skip the re-download and then fail at load time. Verify every shard listed
    in the index (and that the index itself parses).
    """
    # Keep in sync with ming_tiny/task_protocol.py:validate_release_bundle,
    # otherwise an interrupted download looks complete here and fails at load.
    required = ("config.json", "tokenizer.json", "tokenizer_config.json", "campplus.onnx")
    if not all((path / name).is_file() for name in required):
        return False

    index = path / "model.safetensors.index.json"
    if index.is_file():
        try:
            weight_map = json.loads(index.read_text(encoding="utf-8")).get("weight_map", {})
        except (OSError, ValueError):
            return False
        shards = {name for name in weight_map.values() if isinstance(name, str)}
        if not shards:
            return False
        return all((path / shard).is_file() for shard in shards)

    # Single-file checkpoints have no index.
    return any(blob.stat().st_size > 0 for blob in path.glob("*.safetensors"))


def _modelscope_available() -> bool:
    return importlib.util.find_spec("modelscope") is not None


def _huggingface_available() -> bool:
    return importlib.util.find_spec("huggingface_hub") is not None


def _download_modelscope(model_id: str, output: Path, revision: str | None) -> None:
    if not _modelscope_available():
        raise RuntimeError(
            "ModelScope is not installed. Run: pip install -r server/requirements-modelscope.txt"
        )
    from modelscope import snapshot_download

    print(f"[ModelScope] {model_id} -> {output}")
    snapshot_download(model_id, revision=revision, local_dir=str(output))


def _download_huggingface(model_id: str, output: Path, revision: str | None) -> None:
    if not _huggingface_available():
        raise RuntimeError(
            "huggingface_hub is not installed. Run: pip install -r server/requirements-server.txt"
        )
    from huggingface_hub import snapshot_download

    print(f"[Hugging Face] {model_id} -> {output}")
    snapshot_download(
        repo_id=model_id,
        revision=revision,
        local_dir=str(output),
        token=os.environ.get("HF_TOKEN") or None,
    )


def _candidates(source: str) -> list[str]:
    if source == "modelscope":
        return ["modelscope"]
    if source == "huggingface":
        return ["huggingface"]

    candidates = []
    if _modelscope_available():
        candidates.append("modelscope")
    if _huggingface_available():
        candidates.append("huggingface")
    if not candidates:
        candidates = ["huggingface"]
    return candidates


def download_model(
    source: str = "auto",
    model_id: str = DEFAULT_MODEL_ID,
    output: str | Path = DEFAULT_OUTPUT,
    revision: str | None = None,
    force: bool = False,
) -> Path:
    source = normalize_source(source)
    target = Path(output).expanduser().resolve()

    if is_model_complete(target) and not force:
        print(f"Model already present, skipping download: {target}")
        return target

    target.mkdir(parents=True, exist_ok=True)
    free_gb = shutil.disk_usage(target).free / (1024**3)
    if free_gb < 20:
        print(
            f"Warning: only {free_gb:.1f} GB free at {target.parent}; "
            "the checkpoint needs roughly 20 GB.",
            file=sys.stderr,
        )

    errors: list[str] = []
    for candidate in _candidates(source):
        try:
            if candidate == "modelscope":
                _download_modelscope(model_id, target, revision)
            else:
                _download_huggingface(model_id, target, revision)
        except Exception as error:  # noqa: BLE001 - fall back to the other hub
            errors.append(f"{candidate}: {error}")
            print(f"{candidate} download failed: {error}", file=sys.stderr)
            if source != "auto":
                break
            continue

        if is_model_complete(target):
            print(f"Model ready: {target}")
            return target
        errors.append(f"{candidate}: download finished but required files are missing")

    hints = [
        "Model download failed.",
        "ModelScope: pip install -r server/requirements-modelscope.txt",
        "Hugging Face: pip install -r server/requirements-server.txt",
        "Manual option: download the checkpoint and pass --model-path /path/to/checkpoint",
        "China mirror for Hugging Face: set HF_ENDPOINT=https://hf-mirror.com",
    ]
    details = "\n".join(f"  - {item}" for item in errors)
    raise RuntimeError("\n".join(hints) + ("\nAttempts:\n" + details if details else ""))


def main() -> int:
    parser = argparse.ArgumentParser(description="Download the Ming-3.0-tts-tiny checkpoint")
    parser.add_argument(
        "--source",
        default=os.environ.get("MODEL_SOURCE", "auto"),
        help="auto, modelscope or huggingface (default: auto)",
    )
    parser.add_argument(
        "--model-id",
        default=os.environ.get("MODEL_ID", DEFAULT_MODEL_ID),
        help=f"Hub repository id (default: {DEFAULT_MODEL_ID})",
    )
    parser.add_argument(
        "--output",
        default=os.environ.get("MODEL_PATH", str(DEFAULT_OUTPUT)),
        help="Target checkpoint directory",
    )
    parser.add_argument("--revision", default=os.environ.get("MODEL_REVISION"))
    parser.add_argument("--force", action="store_true", help="Download even if the folder looks complete")
    parser.add_argument("--check", action="store_true", help="Only check whether the model is present")
    args = parser.parse_args()

    target = Path(args.output).expanduser().resolve()
    if args.check:
        ok = is_model_complete(target)
        print(f"{'ready' if ok else 'missing'}: {target}")
        return 0 if ok else 1

    try:
        download_model(
            source=args.source,
            model_id=args.model_id,
            output=target,
            revision=args.revision,
            force=args.force,
        )
    except Exception as error:  # noqa: BLE001 - CLI boundary
        print(f"\n{error}", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
