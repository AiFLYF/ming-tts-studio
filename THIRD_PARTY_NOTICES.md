# Third-Party Notices

## Ming-3.0-tts-tiny

- Upstream: inclusionAI / Ant Group
- Model: <https://huggingface.co/inclusionAI/Ming-3.0-tts-tiny>
- ModelScope: <https://modelscope.cn/models/inclusionAI/Ming-3.0-tts-tiny>
- License: MIT

The inference package in [`server/ming_tiny`](server/ming_tiny) is copied from the
upstream Ming-3.0-tts-tiny release and adapted for this service (import paths,
device handling, and API glue). Model weights are **not** distributed with this
repository; they are downloaded at runtime from ModelScope or Hugging Face and
remain subject to the upstream license.

The built-in demo clip `assets/audio/demo-zh.wav` was generated with this model
and is used only for interface demonstration.

## Python dependencies

Runtime dependencies are pinned in [`server/requirements-server.txt`](server/requirements-server.txt)
and [`server/requirements-server-windows.txt`](server/requirements-server-windows.txt).
Each package retains its own license, including:

- PyTorch / torchaudio — BSD-3-Clause
- Transformers / tokenizers / huggingface_hub — Apache-2.0
- FastAPI — MIT
- Uvicorn — BSD-3-Clause
- Triton — MIT
- flash-linear-attention (fla-core) — MIT
- ModelScope — Apache-2.0

Refer to each project for the authoritative license text and notices.
