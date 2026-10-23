#!/usr/bin/env python3
"""
Ming-3.0-tts-tiny Full Feature API
支持官方模型的所有 10 种任务类型：
1. seed (TTS/clone/zero_shot) - 语音克隆
2. multilingual - 多语言
3. paralinguistic - 副语言标签
4. podcast - 多人对话
5. basic - 基础属性控制
6. emotion - 情感控制
7. dialect - 方言控制
8. freeform - 自由格式
9. voice_design - 声音设计
10. ip - 内置职业配音员
"""

import asyncio
import os
import io
import re
import tempfile
import uuid
from datetime import datetime
from pathlib import Path
from typing import Optional, List
from pydantic import BaseModel, Field

from fastapi import FastAPI, HTTPException, Request, UploadFile, File
from fastapi.responses import StreamingResponse
from fastapi.staticfiles import StaticFiles
from fastapi.middleware.cors import CORSMiddleware
from contextlib import asynccontextmanager
from starlette.concurrency import run_in_threadpool
from loguru import logger

# The upstream contract already defines the canonical values and their aliases;
# importing them keeps this file from drifting out of sync (task_protocol has no
# torch dependency, so this stays cheap).
from ming_tiny.task_protocol import (
    DIALECT_ALIASES,
    DIALECT_VALUES,
    EMOTION_ALIASES,
    EMOTION_VALUES,
)

# Model loading
tts_model = None

BASE_DIR = Path(__file__).resolve().parent.parent
UPLOAD_DIR = Path(os.environ.get("UPLOAD_DIR", BASE_DIR / "uploads")).resolve()
UPLOAD_DIR.mkdir(parents=True, exist_ok=True)
TEMP_DIR = Path(tempfile.gettempdir())

ALLOWED_AUDIO_EXTENSIONS = {".wav", ".mp3", ".flac"}
MAX_UPLOAD_BYTES = 50 * 1024 * 1024

TASK_ALIASES = {
    "tts": "seed",
    "clone": "seed",
    "zero_shot": "seed",
    "basic_attributes": "basic",
    "emotion_cv3": "emotion",
    "emotion_cv3n": "emotion",
    "style": "voice_design",
    "voice": "voice_design",
    "voice_actor": "ip",
    "nvbench": "paralinguistic",
    "free_form": "freeform",
}

# Tasks whose conditioning requires a reference clip (and, for the first
# group, the matching transcript).
REFERENCE_ONLY_TASKS = {"basic", "emotion", "dialect"}
REFERENCE_TEXT_TASKS = {"seed", "multilingual", "paralinguistic"}

LANGUAGES = (
    "Chinese", "English", "Japanese", "Korean", "German", "French", "Spanish",
)
# The official API accepts short codes as well as full names; keep accepting the
# Chinese labels too so hand-written curl requests do not fail.
LANGUAGE_ALIASES = {
    "zh": "Chinese", "chinese": "Chinese", "中文": "Chinese",
    "en": "English", "english": "English", "英语": "English",
    "ja": "Japanese", "jp": "Japanese", "japanese": "Japanese", "日语": "Japanese",
    "ko": "Korean", "korean": "Korean", "韩语": "Korean",
    "de": "German", "german": "German", "德语": "German",
    "fr": "French", "french": "French", "法语": "French",
    "es": "Spanish", "spanish": "Spanish", "西班牙语": "Spanish",
}
SPEEDS = {"慢速", "中速", "快速"}
PITCH_VOLUMES = {"低", "中", "高"}
# The model can only run one generation at a time per process, and torch is not
# thread-safe, so serialise inference instead of letting concurrent requests
# corrupt the CUDA context.
GENERATE_LOCK = asyncio.Lock()


def _as_text(value, field_name: str) -> str:
    """Reject non-strings early: an int/list here used to reach the model and
    surface as a 500 instead of a 400."""
    if value is None:
        return ""
    if not isinstance(value, str):
        raise HTTPException(
            status_code=400, detail=f"'{field_name}' must be a string"
        )
    return value


def _resolve_language(value) -> str:
    lang = _as_text(value, 'target_language').strip()
    if not lang:
        raise HTTPException(
            status_code=400, detail="'target_language' is required for this task"
        )
    canonical = LANGUAGE_ALIASES.get(lang.lower())
    if canonical is None:
        raise HTTPException(
            status_code=400,
            detail=(
                f"Unsupported 'target_language' {lang!r}; use one of "
                f"{list(LANGUAGES)} (ISO codes ja/ko/de/fr/es are also accepted)"
            ),
        )
    return canonical


def _resolve_dialect(value) -> str:
    """Accept the official control values (`cantonese`, `chuanyu dialect`) and
    the Chinese labels, then hand the canonical value to the model."""
    raw = _as_text(value, 'dialect').strip() or "川渝话"
    canonical = DIALECT_ALIASES.get(raw.lower(), raw)
    if canonical not in DIALECT_VALUES:
        raise HTTPException(
            status_code=400,
            detail=(
                f"Invalid dialect {raw!r}; use one of {sorted(DIALECT_VALUES)} "
                "(cantonese / chuanyu dialect also accepted)"
            ),
        )
    return canonical


def _resolve_emotion(value) -> str:
    raw = _as_text(value, 'emotion').strip() or "中性"
    canonical = EMOTION_ALIASES.get(raw.lower(), raw)
    if canonical not in EMOTION_VALUES:
        raise HTTPException(
            status_code=400,
            detail=f"Invalid emotion {raw!r}; use one of {sorted(EMOTION_VALUES)}",
        )
    return canonical


def _resolve_choice(value, field_name: str, allowed: set, default: str) -> str:
    choice = _as_text(value, field_name).strip() or default
    if choice not in allowed:
        raise HTTPException(
            status_code=400,
            detail=f"Invalid {field_name} {choice!r}; use one of {sorted(allowed)}",
        )
    return choice


# ==================== Request Models ====================

class BaseRequest(BaseModel):
    text: str = Field(..., description="要合成的文本内容")
    task: str = Field(default="ip", description="任务类型")


class TTSRequest(BaseRequest):
    """seed 任务请求 - 语音克隆"""
    prompt_wav: Optional[str] = Field(None, description="参考音频路径")
    prompt_text: Optional[str] = Field(None, description="参考音频的文字转录")
    target_language: str = Field(..., description="Chinese 或 English")


class MultilingualRequest(BaseRequest):
    """multilingual 任务请求 - 多语言"""
    prompt_wav: Optional[str] = Field(None, description="该语言的参考音频")
    prompt_text: Optional[str] = Field(None, description="参考文本")
    target_language: str = Field(
        ..., 
        description="German / Spanish / French / Korean / Japanese"
    )


class ParalinguisticRequest(BaseRequest):
    """paralinguistic 任务请求 - 副语言控制"""
    prompt_wav: Optional[str] = Field(None, description="参考音频")
    prompt_text: Optional[str] = Field(None, description="参考文本")
    target_language: str = Field(
        ..., 
        description="Chinese 或 English"
    )


class PodcastRequest(BaseRequest):
    """podcast 任务请求 - 多人对话"""
    prompt_wav: List[str] = Field(..., description="每个角色的参考音频列表")
    prompt_text: List[str] = Field(..., description="与 prompt_wav 对应的文本列表")


class BasicRequest(BaseRequest):
    """basic 任务请求 - 基础属性控制"""
    prompt_wav: Optional[str] = Field(None, description="参考音频")
    speed: str = Field(default="中速", description="慢速/中速/快速")
    pitch: str = Field(default="中", description="低/中/高")
    volume: str = Field(default="中", description="低/中/高")


class EmotionRequest(BaseRequest):
    """emotion 任务请求 - 情感控制"""
    prompt_wav: Optional[str] = Field(None, description="参考音频")
    emotion: str = Field(
        default="中性",
        description="中性/悲伤/愤怒/高兴/惊讶/恐惧/厌恶"
    )


class DialectRequest(BaseRequest):
    """dialect 任务请求 - 方言控制"""
    prompt_wav: Optional[str] = Field(None, description="该方言的参考音频")
    dialect: str = Field(default="川渝话", description="川渝话/广粤话")


class FreeformRequest(BaseRequest):
    """freeform 任务请求 - 自由格式描述"""
    instruction: str = Field(..., description="自然语言描述期望的声音风格")


class VoiceDesignRequest(BaseRequest):
    """voice_design 任务请求 - 声音设计"""
    style: str = Field(..., description="详细描述声音特征")


class IPRequest(BaseRequest):
    """ip 任务请求 - 内置职业配音员"""
    ip: str = Field(default="灵小柔", description="内置声音名称，如：灵小柔、灵楷等")


# ==================== Load Model ====================

def load_model(model_path: str):
    """Load the TTS model."""
    global tts_model
    logger.info(f"Loading Ming-3.0-tts-tiny from {model_path}")
    
    device = os.environ.get('DEVICE', 'cuda:0')
    logger.info(f"Using device: {device}")
    
    from ming_tiny import MingTinyTTS
    
    tts_model = MingTinyTTS.from_pretrained(
        model_path,
        device=device,
    )
    logger.info("Model loaded successfully!")
    return tts_model


@asynccontextmanager
async def lifespan(app: FastAPI):
    """Handle startup and shutdown."""
    model_path = os.environ.get(
        "MODEL_PATH",
        str(BASE_DIR / "models" / "Ming-3.0-tts-tiny"),
    )
    try:
        load_model(model_path)
        logger.info("TTS Service started")
    except Exception as e:
        logger.error(f"Failed to load model: {e}")
        raise
    yield
    logger.info("TTS Service stopped")


# ==================== Create App ====================

app = FastAPI(
    title="Ming-3.0-tts-tiny API (Full Features)",
    description="支持官方模型全部 10 种任务的 TTS API",
    version="2.0.0",
    lifespan=lifespan
)

@app.get("/")
async def root():
    """Worker service information; users normally open the gateway or /studio."""
    return {
        "service": "Ming-3.0-tts-tiny worker",
        "health": "/health",
        "docs": "/docs",
        "tasks": "/tasks",
    }

# Allow direct browser access during development. The gateway adds its own CORS
# headers for the studio, and strips the upstream ones while proxying.
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=False,
    allow_methods=["*"],
    allow_headers=["*"],
    expose_headers=["X-Duration", "X-Sample-Rate", "X-Task"],
)


# A direct browser call from an HTTPS page to a worker on a LAN address needs
# Chrome's Private Network Access opt-in, same as the gateway.
@app.middleware("http")
async def allow_private_network(request: Request, call_next):
    response = await call_next(request)
    if request.headers.get("access-control-request-private-network") == "true":
        response.headers["Access-Control-Allow-Private-Network"] = "true"
    return response


@app.get("/health")
async def health_check():
    """Check service health."""
    return {"status": "healthy", "model_loaded": tts_model is not None}


@app.get("/tasks")
async def list_tasks():
    """List available tasks with descriptions."""
    from ming_tiny import task_protocol
    tasks = {
        name: spec.conditioning for name, spec in task_protocol.TASK_SPECS.items()
    }
    return {"tasks": tasks}


# ==================== Generation Functions ====================

def generate_speech(
    task: str,
    text: str,
    output_path: str,
    **kwargs
):
    """Common generation function for all tasks."""
    if tts_model is None:
        raise ValueError("Model not loaded")
    
    output = tts_model.generate(
        task=task,
        text=text,
        output_path=output_path,
        **kwargs,
    )
    return output


def _probe_audio(path: Path) -> dict:
    """Best-effort duration / sample-rate metadata for an uploaded clip."""
    try:
        import soundfile as sf

        info = sf.info(str(path))
        if info.samplerate:
            return {
                "duration": round(info.frames / info.samplerate, 2),
                "sample_rate": info.samplerate,
                "channels": info.channels,
            }
    except Exception:
        pass
    return {}


def _upload_payload(path: Path, original_name: Optional[str] = None) -> dict:
    """Describe an uploaded clip for the browser.

    `path` deliberately stays a URL, not a filesystem path: the browser only
    needs to name the upload back, and a real server path would leak the
    deployment layout into page source and into every request payload.
    """
    try:
        stat = path.stat()
    except OSError:
        return {}  # deleted between listing and stat
    payload = {
        "filename": path.name,
        "url": f"/uploads/{path.name}",
        "path": f"/uploads/{path.name}",
        "size": stat.st_size,
        "size_kb": round(stat.st_size / 1024, 1),
        "uploaded_at": datetime.fromtimestamp(stat.st_mtime).isoformat(timespec="seconds"),
    }
    if original_name:
        payload["original_name"] = original_name
    payload.update(_probe_audio(path))
    return payload


def _resolve_reference_path(value: str) -> str:
    """Map a client-supplied reference onto a file inside UPLOAD_DIR.

    Accepts "/uploads/<name>", "<name>" or a legacy absolute path — everything
    is folded to its basename and must land inside UPLOAD_DIR. Returning ""
    means "not an upload", which the caller turns into a 400. Passing through
    arbitrary absolute paths would otherwise make /generate an arbitrary
    file-read primitive.
    """
    name = Path(str(value).replace("\\", "/")).name
    if not name or name.startswith("."):
        return ""
    candidate = (UPLOAD_DIR / name).resolve()
    try:
        candidate.relative_to(UPLOAD_DIR)
    except ValueError:
        return ""
    return str(candidate) if candidate.is_file() else ""


@app.post("/generate")
async def generate(request: dict):
    """
    Unified endpoint for all tasks.
    
    Supported tasks:
    - seed/TTS/clone/zero_shot: Requires prompt_wav, prompt_text, target_language
    - multilingual: Requires prompt_wav, prompt_text, target_language
    - paralinguistic/nvbench: Requires prompt_wav, prompt_text, target_language
    - podcast: Requires prompt_wav[], prompt_text[]
    - basic/basic_attributes: Can use prompt_wav, optional speed/pitch/volume
    - emotion/emotion_cv3/emotion_cv3n: Can use prompt_wav, requires emotion
    - dialect: Can use prompt_wav, requires dialect
    - freeform: Uses instruction (no prompt_wav recommended)
    - voice_design/style/voice: Uses style (no prompt_wav)
    - ip/voice_actor: Uses ip (no prompt_wav required)
    """
    if tts_model is None:
        raise HTTPException(status_code=503, detail="Model not loaded")

    request_task = "unknown"
    try:
        raw_task = _as_text(request.get('task', 'ip'), 'task').lower()
        request_task = TASK_ALIASES.get(raw_task, raw_task)
        request_text = _as_text(request.get('text', ''), 'text')

        if not request_text.strip():
            raise HTTPException(status_code=400, detail="Missing 'text' field")

        # Validate task
        valid_tasks = ['seed', 'multilingual', 'podcast', 'basic', 
                       'emotion', 'dialect', 'voice_design', 'ip', 
                       'freeform', 'paralinguistic']
        if request_task not in valid_tasks:
            raise HTTPException(
                status_code=400, 
                detail=f"Invalid task '{raw_task}'. Valid tasks: {'/'.join(valid_tasks)}"
            )

        # Reference clips are only ever read from UPLOAD_DIR; anything else is a
        # client error, not a missing file deep inside the model call.
        prompt_wav_value = request.get('prompt_wav')
        if isinstance(prompt_wav_value, str) and prompt_wav_value.strip():
            resolved = _resolve_reference_path(prompt_wav_value)
            if not resolved:
                raise HTTPException(
                    status_code=400,
                    detail=f"Reference audio not found: {Path(prompt_wav_value).name!r}",
                )
            request['prompt_wav'] = resolved
        elif isinstance(prompt_wav_value, list):
            resolved_list = []
            for item in prompt_wav_value:
                resolved = _resolve_reference_path(_as_text(item, 'prompt_wav'))
                if not resolved:
                    raise HTTPException(
                        status_code=400,
                        detail=f"Reference audio not found: {Path(str(item)).name!r}",
                    )
                resolved_list.append(resolved)
            request['prompt_wav'] = resolved_list
        elif prompt_wav_value not in (None, "", []):
            raise HTTPException(
                status_code=400, detail="'prompt_wav' must be a string or a list"
            )
        else:
            request['prompt_wav'] = None

        logger.info(f"Request: task={request_task}, text={request_text[:30]}...")
        
        output_path = str(TEMP_DIR / f"ming_tts_{uuid.uuid4().hex}.wav")
        kwargs = {}
        
        # Handle each task type
        if request_task in ['seed', 'tts', 'clone', 'zero_shot']:
            # TTS clone task
            prompt_wav = request.get('prompt_wav')
            prompt_text = _as_text(request.get('prompt_text'), 'prompt_text')
            target_lang = _resolve_language(request.get('target_language'))

            if prompt_wav:
                kwargs['prompt_wav'] = prompt_wav
            if prompt_text:
                kwargs['prompt_text'] = prompt_text

            kwargs['target_language'] = target_lang

        elif request_task == 'multilingual':
            prompt_wav = request.get('prompt_wav')
            prompt_text = _as_text(request.get('prompt_text'), 'prompt_text')
            target_lang = _resolve_language(request.get('target_language'))

            if prompt_wav:
                kwargs['prompt_wav'] = prompt_wav
            if prompt_text:
                kwargs['prompt_text'] = prompt_text

            kwargs['target_language'] = target_lang

        elif request_task == 'paralinguistic':
            prompt_wav = request.get('prompt_wav')
            prompt_text = _as_text(request.get('prompt_text'), 'prompt_text')
            target_lang = _resolve_language(request.get('target_language'))

            if prompt_wav:
                kwargs['prompt_wav'] = prompt_wav
            if prompt_text:
                kwargs['prompt_text'] = prompt_text

            kwargs['target_language'] = target_lang
            
        elif request_task == 'podcast':
            prompt_wavs = request.get('prompt_wav', [])
            prompt_texts = request.get('prompt_text', [])
            
            if not isinstance(prompt_wavs, list) or len(prompt_wavs) < 2:
                raise HTTPException(
                    status_code=400,
                    detail="podcast task requires at least 2 prompt_wav files"
                )
            if not isinstance(prompt_texts, list) or len(prompt_texts) < 2:
                raise HTTPException(
                    status_code=400,
                    detail="podcast task requires at least 2 prompt_text entries"
                )
            if len(prompt_wavs) != len(prompt_texts):
                raise HTTPException(
                    status_code=400,
                    detail="Length of prompt_wav and prompt_text must match"
                )

            prompt_texts = [_as_text(item, 'prompt_text') for item in prompt_texts]
            if any(not item.strip() for item in prompt_texts):
                raise HTTPException(
                    status_code=400,
                    detail="podcast task requires a non-empty prompt_text per speaker"
                )

            kwargs['prompt_wav'] = prompt_wavs
            kwargs['prompt_text'] = prompt_texts

        elif request_task in ['basic', 'basic_attributes']:
            # Basic task can optionally use prompt_wav
            kwargs['speed'] = _resolve_choice(request.get('speed'), 'speed', SPEEDS, '中速')
            kwargs['pitch'] = _resolve_choice(request.get('pitch'), 'pitch', PITCH_VOLUMES, '中')
            kwargs['volume'] = _resolve_choice(request.get('volume'), 'volume', PITCH_VOLUMES, '中')

            # Only add prompt_wav if provided and valid
            if request.get('prompt_wav'):
                kwargs['prompt_wav'] = request.get('prompt_wav')

        elif request_task in ['emotion', 'emotion_cv3', 'emotion_cv3n']:
            kwargs['emotion'] = _resolve_emotion(request.get('emotion'))

            # Add prompt_wav only if provided (optional for emotion)
            if request.get('prompt_wav'):
                kwargs['prompt_wav'] = request.get('prompt_wav')

        elif request_task == 'dialect':
            kwargs['dialect'] = _resolve_dialect(request.get('dialect'))

            # Add prompt_wav only if provided (can work without reference too)
            if request.get('prompt_wav'):
                kwargs['prompt_wav'] = request.get('prompt_wav')

        elif request_task in ['freeform', 'free_form']:
            instruction = _as_text(request.get('instruction'), 'instruction').strip()
            if not instruction:
                raise HTTPException(
                    status_code=400,
                    detail="'instruction' is required for freeform task"
                )
            kwargs['instruction'] = instruction
            # One optional reference: with it the model clones that voice and
            # still follows the instruction (upstream switches conditioning to
            # speaker_only); without it a voice is invented from the instruction.
            if request.get('prompt_wav'):
                kwargs['prompt_wav'] = request.get('prompt_wav')

        elif request_task in ['voice_design', 'style', 'voice']:
            style = _as_text(request.get('style'), 'style').strip()
            if not style:
                raise HTTPException(
                    status_code=400,
                    detail="'style' is required for voice_design task"
                )
            kwargs['style'] = style

        elif request_task in ['ip', 'voice_actor']:
            ip_name = _as_text(request.get('ip'), 'ip').strip() or '灵小柔'
            kwargs['ip'] = ip_name

        # Reference-conditioned tasks cannot synthesize without an uploaded clip.
        references = kwargs.get('prompt_wav')
        if request_task in REFERENCE_ONLY_TASKS or request_task in REFERENCE_TEXT_TASKS:
            if not references:
                raise HTTPException(
                    status_code=400,
                    detail=(
                        f"'prompt_wav' is required for task '{request_task}'. "
                        "Upload a reference audio file first."
                    ),
                )
            if request_task in REFERENCE_TEXT_TASKS and not kwargs.get('prompt_text'):
                raise HTTPException(
                    status_code=400,
                    detail=(
                        f"'prompt_text' is required for task '{request_task}'. "
                        "It must match the uploaded reference audio."
                    ),
                )
        if references:
            reference_list = [references] if isinstance(references, str) else references
            for reference in reference_list:
                if not isinstance(reference, str) or not os.path.isfile(reference):
                    raise HTTPException(
                        status_code=400,
                        detail=f"Reference audio not found on server: {reference!r}",
                    )
        
        # Generate speech. The model call is blocking CPU/GPU work, so it runs in
        # a worker thread: doing it inline would freeze the event loop, and the
        # gateway's readiness probe (/health, 3s timeout) would then mark a busy
        # worker as down and stop routing to it.
        logger.info(f"Generating audio for task: {request_task}")
        try:
            async with GENERATE_LOCK:
                output = await run_in_threadpool(
                    generate_speech,
                    task=request_task,
                    text=request_text,
                    output_path=output_path,
                    **kwargs,
                )

                with open(output_path, 'rb') as f:
                    audio_data = f.read()

                duration_sec = round(
                    output.waveform.shape[-1] / tts_model.sample_rate,
                    2
                )
        finally:
            if os.path.exists(output_path):
                os.remove(output_path)

        return StreamingResponse(
            io.BytesIO(audio_data),
            media_type="audio/wav",
            headers={
                "Content-Disposition": "attachment; filename=speech.wav",
                "X-Duration": str(duration_sec),
                "X-Sample-Rate": str(tts_model.sample_rate),
                "X-Task": request_task,
                "Cache-Control": "no-store",
            }
        )

    except HTTPException:
        raise
    except ValueError as error:
        # Bad parameter values surface from the task protocol as ValueError.
        logger.warning(f"Rejected task {request_task}: {error}")
        raise HTTPException(status_code=400, detail=str(error)[:300]) from error
    except Exception as error:  # noqa: BLE001 - API boundary
        # Log the traceback but keep the response generic: exception text often
        # carries absolute paths and checkpoint layout.
        logger.exception(f"Generation failed for task {request_task}: {error}")
        raise HTTPException(
            status_code=500, detail="生成失败，请查看服务端日志。"
        ) from error


# ==================== File Management ====================

@app.post("/upload")
async def upload_audio(file: UploadFile = File(...)):
    """上传参考音频，返回可试听的 URL 和模型可直接读取的本地路径。"""
    original_name = file.filename or ""
    if not original_name:
        raise HTTPException(status_code=400, detail="未选择文件")

    ext = Path(original_name).suffix.lower()
    if ext not in ALLOWED_AUDIO_EXTENSIONS:
        raise HTTPException(
            status_code=400,
            detail=f"不支持的格式 '{ext}'，仅支持 WAV、MP3、FLAC"
        )

    safe_stem = re.sub(
        r"[^A-Za-z0-9\u4e00-\u9fff_-]+", "_", Path(original_name).stem
    ).strip("_")[:40] or "audio"
    filename = f"{uuid.uuid4().hex[:10]}_{safe_stem}{ext}"
    filepath = UPLOAD_DIR / filename

    # Stream to disk instead of buffering: `await file.read()` would hold the
    # whole 50 MB per concurrent upload in RAM before the size check runs.
    size = 0
    try:
        with filepath.open("wb") as handle:
            while True:
                chunk = await file.read(1024 * 1024)
                if not chunk:
                    break
                size += len(chunk)
                if size > MAX_UPLOAD_BYTES:
                    raise HTTPException(
                        status_code=413,
                        detail=f"文件过大，最大支持 {MAX_UPLOAD_BYTES // (1024 * 1024)} MB",
                    )
                handle.write(chunk)
        if not size:
            raise HTTPException(status_code=400, detail="上传文件为空")
    except HTTPException:
        filepath.unlink(missing_ok=True)
        raise
    except Exception as error:  # noqa: BLE001 - disk boundary
        filepath.unlink(missing_ok=True)
        logger.error(f"文件保存失败：{error}")
        raise HTTPException(status_code=500, detail="文件保存失败") from error

    payload = await run_in_threadpool(_upload_payload, filepath, original_name)
    logger.info(
        f"文件 '{original_name}' 上传成功：{filename} "
        f"({payload.get('size_kb', 0)} KB, {payload.get('duration', '?')}s)"
    )
    payload["message"] = f"文件 '{original_name}' 上传成功"
    return payload


@app.get("/uploads")
async def list_uploads():
    """列出所有已上传的音频文件（按上传时间倒序）。"""
    entries = []
    for path in UPLOAD_DIR.iterdir():
        try:
            if not path.is_file():
                continue
            entries.append((path.stat().st_mtime, path))
        except OSError:
            continue  # deleted between listing and stat
    entries.sort(key=lambda item: item[0], reverse=True)
    paths = [path for _, path in entries]

    files = await run_in_threadpool(
        lambda: [payload for path in paths if (payload := _upload_payload(path))]
    )
    return {"count": len(files), "files": files}


@app.delete("/uploads/{filename}")
async def delete_upload(filename: str):
    """删除上传的文件"""
    if Path(filename).name != filename or filename.startswith("."):
        raise HTTPException(status_code=400, detail="非法文件名")

    filepath = UPLOAD_DIR / filename

    if not filepath.exists():
        raise HTTPException(status_code=404, detail="文件不存在")
    
    try:
        filepath.unlink()
        logger.info(f"文件已删除：{filename}")
        return {"message": f"文件 '{filename}' 已删除"}
    except OSError as error:
        logger.error(f"删除文件失败：{error}")
        raise HTTPException(status_code=500, detail="删除失败，请查看服务端日志。") from error


# Serve uploaded clips for in-browser preview / playback. Registered after the
# /uploads JSON route so GET /uploads still lists files.
app.mount("/uploads", StaticFiles(directory=str(UPLOAD_DIR)), name="uploads")


if __name__ == "__main__":
    import uvicorn
    host = os.environ.get("HOST", "0.0.0.0")
    port = int(os.environ.get("PORT", 8081))
    
    logger.info(f"Starting TTS server on {host}:{port}")
    uvicorn.run(app, host=host, port=port, log_level="info")
