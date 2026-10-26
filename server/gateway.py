#!/usr/bin/env python3
"""Load-balancing gateway for multiple TTS worker processes.

Each worker owns one GPU and one Uvicorn port. Requests are assigned to the
worker with the fewest in-flight requests, which keeps long generations from
queueing behind each other. Uploaded files live in a shared directory, so any
worker can serve a file uploaded through a different worker.
"""

from __future__ import annotations

import asyncio
import inspect
import os
import time
from contextlib import asynccontextmanager, suppress
from dataclasses import dataclass
from pathlib import Path
from typing import Iterable

import anyio
import httpx
import uvicorn
from fastapi import FastAPI, HTTPException, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import (
    FileResponse,
    HTMLResponse,
    JSONResponse,
    RedirectResponse,
    Response,
    StreamingResponse,
)
from fastapi.staticfiles import StaticFiles
from loguru import logger

try:
    from auth import (
        AUTH_ENABLED,
        COOKIE_NAME,
        PasswordGate,
        check_password,
        login_page_html,
        request_is_authenticated,
        safe_next,
        set_session_cookie,
    )
except ImportError:  # imported as `server.gateway` instead of a script
    from server.auth import (
        AUTH_ENABLED,
        COOKIE_NAME,
        PasswordGate,
        check_password,
        login_page_html,
        request_is_authenticated,
        safe_next,
        set_session_cookie,
    )

BASE_DIR = Path(__file__).resolve().parent.parent
STUDIO_DIR = Path(os.environ.get("STUDIO_DIR", BASE_DIR)).resolve()
WORKER_HOST = os.environ.get("WORKER_HOST", "127.0.0.1")
WORKER_PORTS = [
    int(item) for item in os.environ.get("WORKER_PORTS", "8091,8092,8093,8094").split(",") if item.strip()
]
WORKER_GPUS = [
    int(item) for item in os.environ.get("WORKER_GPUS", "0,1,2,3").split(",") if item.strip()
]
HEALTH_INTERVAL = float(os.environ.get("HEALTH_INTERVAL", "5"))
READY_RECHECK_CYCLES = max(1, int(os.environ.get("READY_RECHECK_CYCLES", "6")))
MAX_REQUEST_BYTES = 55 * 1024 * 1024
STARTED_AT = time.monotonic()

HOP_BY_HOP = {
    "connection",
    "keep-alive",
    "proxy-authenticate",
    "proxy-authorization",
    "te",
    "trailer",
    "transfer-encoding",
    "upgrade",
}
DROP_REQUEST_HEADERS = HOP_BY_HOP | {
    "host",
    "content-length",
    "accept-encoding",
    # Gateway-only credentials must never reach (or be logged by) a worker.
    "authorization",
    "cookie",
    # Set by the gateway itself; never trust a client-supplied value.
    "x-forwarded-for",
    "x-forwarded-host",
    "x-forwarded-proto",
}
DROP_RESPONSE_HEADERS = HOP_BY_HOP | {
    "content-length",
    "content-encoding",
    "content-type",
    "date",
    "server",
    "access-control-allow-origin",
    "access-control-allow-credentials",
    "access-control-allow-headers",
    "access-control-allow-methods",
    "access-control-expose-headers",
    "access-control-max-age",
}


@dataclass
class Worker:
    index: int
    gpu: int
    port: int
    up: bool = False
    ready: bool = False
    active: int = 0
    total: int = 0
    failures: int = 0
    last_error: str = ""

    @property
    def url(self) -> str:
        return f"http://{WORKER_HOST}:{self.port}"

    @property
    def usable(self) -> bool:
        return self.up and self.ready


class WorkerPool:
    def __init__(self, ports: Iterable[int], gpus: Iterable[int]) -> None:
        ports = list(ports)
        gpus = list(gpus)
        if len(ports) != len(gpus):
            raise ValueError("WORKER_PORTS and WORKER_GPUS must have the same length")
        if not ports:
            raise ValueError("At least one worker is required")
        self.workers = [
            Worker(index=index, gpu=gpu, port=port)
            for index, (port, gpu) in enumerate(zip(ports, gpus))
        ]
        self._cursor = 0

    def usable_workers(self) -> list[Worker]:
        return [worker for worker in self.workers if worker.usable]

    def acquire(self) -> Worker:
        usable = self.usable_workers()
        if not usable:
            raise HTTPException(status_code=503, detail="No TTS worker is available")
        least_active = min(worker.active for worker in usable)
        count = len(self.workers)
        for offset in range(count):
            worker = self.workers[(self._cursor + offset) % count]
            if worker.usable and worker.active == least_active:
                worker.active += 1
                worker.total += 1
                self._cursor = (worker.index + 1) % count
                return worker
        raise HTTPException(status_code=503, detail="No TTS worker is available")

    def release(self, worker: Worker) -> None:
        if worker.active <= 0:
            # Would mean a double release: the scheduler is about to under-count
            # this worker and start sending it more work than it can take.
            logger.warning(f"worker gpu={worker.gpu} released without an active request")
        worker.active = max(0, worker.active - 1)

    def mark_down(self, worker: Worker, reason: str) -> None:
        was_usable = worker.usable
        worker.up = False
        worker.ready = False
        worker.failures += 1
        worker.last_error = reason
        if was_usable:
            logger.warning(f"worker gpu={worker.gpu} port={worker.port} marked down: {reason}")

    def mark_failure(self, worker: Worker, reason: str) -> None:
        worker.failures += 1
        worker.last_error = reason

    def summary(self) -> dict:
        usable = self.usable_workers()
        return {
            "workers_total": len(self.workers),
            "workers_available": len(usable),
            "requests_in_flight": sum(worker.active for worker in self.workers),
            "workers": [
                {
                    "index": worker.index,
                    "gpu": worker.gpu,
                    "port": worker.port,
                    "status": "up" if worker.usable else "down",
                    "health": "ready" if worker.ready else "not_ready",
                    "active": worker.active,
                    "requests": worker.total,
                    "failures": worker.failures,
                    "last_error": worker.last_error,
                }
                for worker in self.workers
            ],
        }

    async def _http_ready(self, worker: Worker) -> bool:
        try:
            async with httpx.AsyncClient(timeout=httpx.Timeout(3.0)) as client:
                response = await client.get(f"{worker.url}/health")
                payload = response.json()
            return response.status_code == 200 and bool(payload.get("model_loaded"))
        except Exception as error:  # noqa: BLE001 - any probe failure means not ready
            worker.last_error = f"health probe failed: {error}"
            return False

    async def _tcp_up(self, worker: Worker) -> bool:
        writer = None
        try:
            _, writer = await asyncio.wait_for(
                asyncio.open_connection(WORKER_HOST, worker.port), timeout=1.0
            )
            return True
        except Exception:  # noqa: BLE001 - connection failure means down
            return False
        finally:
            if writer is not None:
                writer.close()
                with suppress(Exception):
                    await writer.wait_closed()

    async def initial_check(self) -> None:
        ready = await asyncio.gather(
            *(self._http_ready(worker) for worker in self.workers)
        )
        for worker, is_ready in zip(self.workers, ready):
            worker.ready = is_ready
            worker.up = is_ready
        available = len(self.usable_workers())
        logger.info(f"initial worker health: {available}/{len(self.workers)} ready")

    async def monitor(self) -> None:
        cycle = 0
        while True:
            await asyncio.sleep(HEALTH_INTERVAL)
            cycle += 1
            # A worker that already reported "ready" is re-probed occasionally:
            # without this, a worker that restarted and is still loading its
            # checkpoint would keep being marked ready until the next reboot.
            recheck_ready = cycle % READY_RECHECK_CYCLES == 0
            for worker in self.workers:
                was_up = worker.up
                worker.up = await self._tcp_up(worker)
                if not worker.up:
                    worker.ready = False
                    if was_up:
                        logger.warning(
                            f"worker gpu={worker.gpu} port={worker.port} is unreachable"
                        )
                    continue
                if not worker.ready:
                    if await self._http_ready(worker):
                        worker.ready = True
                        logger.info(f"worker gpu={worker.gpu} port={worker.port} is ready")
                    elif was_up:
                        logger.info(f"worker gpu={worker.gpu} port={worker.port} is back")
                    continue
                if recheck_ready and not await self._http_ready(worker):
                    worker.ready = False
                    logger.warning(
                        f"worker gpu={worker.gpu} port={worker.port} stopped reporting "
                        "model_loaded; routing around it until it recovers"
                    )


POOL = WorkerPool(WORKER_PORTS, WORKER_GPUS)


class TrackedStreamingResponse(StreamingResponse):
    """StreamingResponse that guarantees a cleanup callback runs exactly once.

    A plain generator's `finally` only executes once Starlette starts iterating
    it. If the client disconnects before that — or the response object is
    dropped after headers were built — the generator is never entered, the
    release is skipped, and the worker's in-flight counter drifts upward until
    the scheduler misroutes load. Tying cleanup to `__call__` covers both.
    """

    def __init__(self, *args, on_done, **kwargs) -> None:
        super().__init__(*args, **kwargs)
        self._on_done = on_done
        self._finished = False

    def _finish(self) -> None:
        if self._finished:
            return
        self._finished = True
        result = self._on_done()
        if inspect.isawaitable(result):
            self._pending = asyncio.ensure_future(result)

    async def __call__(self, scope, receive, send) -> None:
        try:
            await super().__call__(scope, receive, send)
        finally:
            self._finish()
            pending = getattr(self, "_pending", None)
            if pending is not None:
                with suppress(Exception, asyncio.CancelledError):
                    await pending


@asynccontextmanager
async def lifespan(_: FastAPI):
    client = httpx.AsyncClient(
        timeout=httpx.Timeout(connect=10.0, read=None, write=120.0, pool=10.0),
        limits=httpx.Limits(max_connections=100, max_keepalive_connections=20),
        follow_redirects=False,
    )
    app.state.client = client
    await POOL.initial_check()
    monitor_task = asyncio.create_task(POOL.monitor())
    logger.info(
        "gateway ready: "
        + ", ".join(
            f"gpu{worker.gpu}=:{worker.port}" for worker in POOL.workers
        )
    )
    try:
        yield
    finally:
        monitor_task.cancel()
        with suppress(asyncio.CancelledError):
            await monitor_task
        await client.aclose()


app = FastAPI(
    title="Ming-3.0-tts Gateway",
    version="1.0.0",
    docs_url=None,
    redoc_url=None,
    openapi_url=None,
    lifespan=lifespan,
)

# Optional password gate (active only when STUDIO_PASSWORD is set). Registered
# before CORS so CORS stays outermost and even 401/login redirects keep their
# cross-origin headers.
app.add_middleware(PasswordGate)

# The studio can be hosted on GitHub Pages or any other static origin, so the
# public gateway must answer CORS preflights itself and expose the audio metadata
# response headers to browser JavaScript.
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=False,
    allow_methods=["*"],
    allow_headers=["*"],
    expose_headers=["X-Duration", "X-Sample-Rate", "X-Task"],
)


# Chrome's Private Network Access: a public HTTPS page (GitHub Pages) reaching a
# gateway on a private IP is gated behind this opt-in. Registered after the CORS
# middleware so it also covers the preflight response CORS writes itself.
@app.middleware("http")
async def allow_private_network(request: Request, call_next):
    response = await call_next(request)
    if request.headers.get("access-control-request-private-network") == "true":
        response.headers["Access-Control-Allow-Private-Network"] = "true"
    return response


@app.get("/health")
async def health():
    summary = POOL.summary()
    available = summary["workers_available"]
    total = summary["workers_total"]
    if available == 0:
        status = "offline"
    elif available < total:
        status = "degraded"
    else:
        status = "healthy"
    return JSONResponse(
        status_code=200 if available else 503,
        content={
            "status": status,
            "model_loaded": available > 0,
            "workers_available": available,
            "workers_total": total,
            "requests_in_flight": summary["requests_in_flight"],
        },
    )


@app.get("/favicon.ico", include_in_schema=False)
async def favicon():
    """The login page is server-rendered and has no asset links, so browsers ask
    for /favicon.ico. Answer it publicly instead of proxying a 404/401."""
    icon = STUDIO_DIR / "assets" / "img" / "favicon.svg"
    if icon.is_file():
        return FileResponse(
            icon,
            media_type="image/svg+xml",
            headers={"Cache-Control": "public, max-age=86400"},
        )
    return Response(status_code=204)


@app.get("/login", response_class=HTMLResponse)
async def login_form(request: Request, next: str = "/studio/"):
    target = safe_next(next)
    if not AUTH_ENABLED or request_is_authenticated(request):
        return RedirectResponse(target, status_code=303)
    return HTMLResponse(
        login_page_html(target),
        headers={"Cache-Control": "no-store", "X-Robots-Tag": "noindex"},
    )


@app.post("/login")
async def login_submit(request: Request):
    if not AUTH_ENABLED:
        return RedirectResponse("/studio/", status_code=303)
    form = await request.form()
    target = safe_next(str(form.get("next") or "/studio/"))
    if not check_password(str(form.get("password") or "")):
        # Slow down online guessing without locking out legitimate users.
        await asyncio.sleep(0.4)
        return HTMLResponse(
            login_page_html(target, "密码不正确，请重试。"),
            status_code=401,
            headers={"Cache-Control": "no-store", "X-Robots-Tag": "noindex"},
        )
    forwarded_proto = request.headers.get("x-forwarded-proto", "").split(",")[0].strip().lower()
    secure = request.url.scheme == "https" or forwarded_proto == "https"
    response = RedirectResponse(target, status_code=303)
    set_session_cookie(response, secure)
    response.headers["Cache-Control"] = "no-store"
    return response


@app.api_route("/logout", methods=["GET", "POST"])
async def logout():
    response = RedirectResponse("/login" if AUTH_ENABLED else "/studio/", status_code=303)
    response.delete_cookie(COOKIE_NAME, path="/")
    response.headers["Cache-Control"] = "no-store"
    return response


@app.get("/cluster/status")
async def cluster_status():
    return {
        "gateway": "ok",
        "mode": "least-in-flight",
        "uptime_seconds": round(time.monotonic() - STARTED_AT, 1),
        **POOL.summary(),
    }


STUDIO_ENABLED = (STUDIO_DIR / "index.html").is_file()
if STUDIO_ENABLED and (STUDIO_DIR / "assets").is_dir():
    # Only the frontend assets are published; the rest of the checkout
    # (server code, checkpoints, uploads, logs, .env) must stay private.
    app.mount(
        "/studio/assets",
        StaticFiles(directory=str(STUDIO_DIR / "assets")),
        name="studio-assets",
    )


@app.get("/studio")
async def studio_redirect():
    return RedirectResponse(url="/studio/", status_code=307)


@app.get("/studio/")
async def studio_index():
    if not STUDIO_ENABLED:
        raise HTTPException(status_code=404, detail="Studio frontend is not installed")
    return FileResponse(STUDIO_DIR / "index.html")


@app.get("/studio/index.html")
async def studio_index_file():
    """The service worker precaches this exact URL, so it must exist here too —
    otherwise install fails (or, worse, activates with an empty cache) and the
    studio loses offline support when served by the gateway."""
    if not STUDIO_ENABLED:
        raise HTTPException(status_code=404, detail="Studio frontend is not installed")
    return FileResponse(STUDIO_DIR / "index.html")


@app.get("/studio/site.webmanifest")
async def studio_manifest():
    manifest = STUDIO_DIR / "site.webmanifest"
    if not manifest.is_file():
        raise HTTPException(status_code=404, detail="Manifest not found")
    return FileResponse(manifest, media_type="application/manifest+json")


@app.get("/studio/sw.js")
async def studio_service_worker():
    """The front end registers this worker relative to /studio/.

    Without an explicit route the catch-all proxy below would forward the
    request to a TTS worker, which answers 404 — silently disabling the
    offline shell whenever the studio is served by the gateway.
    """
    service_worker = STUDIO_DIR / "sw.js"
    if not service_worker.is_file():
        raise HTTPException(status_code=404, detail="Service worker not found")
    return FileResponse(
        service_worker,
        media_type="application/javascript",
        headers={"Cache-Control": "no-cache"},
    )


@app.get("/")
async def root():
    if STUDIO_ENABLED:
        return RedirectResponse(url="/studio/", status_code=307)
    return JSONResponse(
        {
            "service": "Ming-3.0-tts Gateway",
            "health": "/health",
            "cluster": "/cluster/status",
        }
    )


async def _read_body(request: Request) -> bytes:
    """Read the request body with a hard cap.

    `await request.body()` buffers everything before the size check, so a client
    that lies about (or omits) Content-Length could exhaust memory. Stream it and
    abort as soon as the cap is crossed.
    """
    declared = request.headers.get("content-length")
    if declared:
        try:
            if int(declared) > MAX_REQUEST_BYTES:
                raise HTTPException(status_code=413, detail="Request body too large")
        except ValueError:
            raise HTTPException(status_code=400, detail="Invalid Content-Length header")

    buffer = bytearray()
    async for chunk in request.stream():
        buffer.extend(chunk)
        if len(buffer) > MAX_REQUEST_BYTES:
            raise HTTPException(status_code=413, detail="Request body too large")
    return bytes(buffer)


@app.api_route(
    "/{path:path}",
    methods=["GET", "POST", "PUT", "PATCH", "DELETE", "HEAD", "OPTIONS"],
)
async def proxy(path: str, request: Request):
    client: httpx.AsyncClient = app.state.client

    body = await _read_body(request)

    headers = {
        name: value
        for name, value in request.headers.items()
        if name.lower() not in DROP_REQUEST_HEADERS
    }
    headers["accept-encoding"] = "identity"
    headers["x-forwarded-proto"] = request.url.scheme
    headers["x-forwarded-host"] = request.headers.get("host", "")
    if request.client:
        headers["x-forwarded-for"] = request.client.host

    query = f"?{request.url.query}" if request.url.query else ""
    target_path = f"/{path}{query}"

    attempts = max(1, len(POOL.usable_workers()))
    last_error = "no worker available"
    for _ in range(attempts):
        worker = POOL.acquire()
        # The in-flight counter is released exactly once: here in `finally` for
        # every failure path, or by the response stream once the body is handed
        # off to Starlette.
        handed_off = False
        try:
            upstream_request = client.build_request(
                request.method,
                f"{worker.url}{target_path}",
                headers=headers,
                content=body,
            )
            upstream = await client.send(upstream_request, stream=True)

            response_headers = {
                name: value
                for name, value in upstream.headers.items()
                if name.lower() not in DROP_RESPONSE_HEADERS
            }
            media_type = upstream.headers.get("content-type")

            if request.method == "HEAD" or upstream.status_code in (204, 304):
                length = upstream.headers.get("content-length")
                if length:
                    response_headers["content-length"] = length
                with suppress(Exception):
                    await upstream.aclose()
                return Response(
                    status_code=upstream.status_code,
                    headers=response_headers,
                    media_type=media_type,
                )

            async def stream_response():
                try:
                    async for chunk in upstream.aiter_raw():
                        yield chunk
                finally:
                    # Closing here keeps the connection from lingering while the
                    # body is being streamed; the on_done callback below is the
                    # safety net for the case where this generator never runs.
                    with suppress(Exception):
                        await upstream.aclose()

            async def release_and_close() -> None:
                POOL.release(worker)
                # Shielded: on client disconnect this callback runs inside a
                # cancelled task, so a bare aclose() would raise immediately and
                # leak the httpx connection until GC.
                with anyio.CancelScope(shield=True):
                    with suppress(Exception):
                        await upstream.aclose()

            response = TrackedStreamingResponse(
                stream_response(),
                status_code=upstream.status_code,
                headers=response_headers,
                media_type=media_type,
                # Released by __call__ even when the body is never iterated.
                on_done=release_and_close,
            )
            handed_off = True
            return response
        except (httpx.ConnectError, httpx.ConnectTimeout) as error:
            POOL.mark_down(worker, str(error))
            last_error = str(error)
            logger.warning(f"worker gpu={worker.gpu} unreachable: {error}")
            continue
        except httpx.RequestError as error:
            POOL.mark_failure(worker, str(error))
            logger.error(f"worker gpu={worker.gpu} proxy failure: {error}")
            raise HTTPException(status_code=502, detail="Upstream worker failed") from error
        except (UnicodeEncodeError, ValueError, httpx.InvalidURL) as error:
            # httpx refuses headers it cannot encode (e.g. non-ASCII bytes that
            # Starlette decoded as latin-1). That is a client-side problem: fail
            # fast instead of retrying every worker and leaking the counter.
            logger.warning(f"proxy could not build upstream request: {error}")
            raise HTTPException(
                status_code=400, detail="请求头或地址包含无法转发的字符"
            ) from error
        finally:
            if not handed_off:
                POOL.release(worker)

    raise HTTPException(status_code=503, detail=f"No TTS worker is available: {last_error}")


if __name__ == "__main__":
    host = os.environ.get("HOST", "0.0.0.0")
    port = int(os.environ.get("PORT", "8081"))
    logger.info(f"Starting TTS gateway on {host}:{port}")
    uvicorn.run(app, host=host, port=port, log_level="info")
