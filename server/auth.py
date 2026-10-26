"""Optional password gate for the studio gateway.

Authentication is enabled only when ``STUDIO_PASSWORD`` is non-empty. With no
password configured the gateway behaves exactly as before and every request is
let through.

Browser sessions use an HMAC-signed, HttpOnly cookie issued by ``/login``.
Scripts may authenticate with HTTP Basic instead (the username is ignored, only
the password is checked), which keeps ``curl``/SDK usage simple.
"""

from __future__ import annotations

import base64
import hashlib
import hmac
import html
import os
import time
from http.cookies import SimpleCookie
from urllib.parse import quote

from fastapi import Request
from fastapi.responses import JSONResponse, RedirectResponse, Response
from starlette.datastructures import Headers
from starlette.types import ASGIApp, Receive, Scope, Send

PASSWORD = os.environ.get("STUDIO_PASSWORD", "")
AUTH_ENABLED = bool(PASSWORD)

COOKIE_NAME = "ming_studio_session"
_SESSION_HOURS = os.environ.get("STUDIO_SESSION_HOURS", "24")


def _session_seconds() -> int:
    try:
        hours = float(_SESSION_HOURS)
    except (TypeError, ValueError):
        hours = 24.0
    hours = min(max(hours, 0.1), 24 * 365)
    return int(hours * 3600)


SESSION_SECONDS = _session_seconds()

# These paths must stay reachable without a password: the login form itself and
# the health probe used by launchers / reverse proxies.
EXEMPT_PATHS = {"/login", "/logout", "/health", "/favicon.ico"}

_LOGIN_HTML = """<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex">
<title>需要密码 · Ming TTS Studio</title>
<style>
:root { color-scheme: dark; }
* { box-sizing: border-box; margin: 0; padding: 0; }
body {
  min-height: 100vh;
  display: grid;
  place-items: center;
  padding: 24px;
  color: #f2f5ec;
  background:
    radial-gradient(900px 500px at 15% -10%, rgba(214, 243, 106, 0.09), transparent 60%),
    radial-gradient(700px 420px at 90% 110%, rgba(116, 231, 208, 0.06), transparent 60%),
    #080a0b;
  font: 14px/1.6 "Avenir Next", "Segoe UI", "Helvetica Neue", "PingFang SC", "Microsoft YaHei", sans-serif;
  -webkit-font-smoothing: antialiased;
}
.card {
  width: min(400px, 100%);
  padding: 34px 32px 28px;
  background: linear-gradient(160deg, rgba(22, 31, 34, 0.92), rgba(12, 17, 18, 0.96));
  border: 1px solid rgba(232, 242, 226, 0.1);
  border-radius: 22px;
  box-shadow: 0 30px 80px rgba(0, 0, 0, 0.45), inset 0 1px 0 rgba(255, 255, 255, 0.04);
}
.brand { display: flex; align-items: center; gap: 12px; margin-bottom: 26px; }
.mark {
  width: 42px; height: 42px; display: grid; place-items: center;
  color: #0b1005; background: #d6f36a; border-radius: 12px;
}
.mark svg { width: 22px; height: 22px; }
.brand strong { display: block; font-size: 16px; letter-spacing: 0.02em; }
.brand small { display: block; color: #66736a; font-size: 10px; letter-spacing: 0.18em; text-transform: uppercase; }
h1 { font-size: 23px; font-weight: 600; letter-spacing: 0.01em; }
.hint { margin-top: 6px; color: #9aa69c; font-size: 12.5px; }
form { margin-top: 24px; display: flex; flex-direction: column; gap: 12px; }
label { color: #66736a; font-size: 10.5px; letter-spacing: 0.08em; text-transform: uppercase; }
input[type="password"] {
  width: 100%;
  height: 46px;
  padding: 0 14px;
  color: #f2f5ec;
  background: rgba(0, 0, 0, 0.28);
  border: 1px solid rgba(232, 242, 226, 0.12);
  border-radius: 11px;
  font-size: 15px;
  letter-spacing: 0.04em;
  outline: none;
  transition: border-color 0.2s, box-shadow 0.2s;
}
input[type="password"]:focus {
  border-color: rgba(214, 243, 106, 0.45);
  box-shadow: 0 0 0 3px rgba(214, 243, 106, 0.08);
}
button {
  height: 46px;
  margin-top: 4px;
  color: #0b1005;
  background: #d6f36a;
  border: 0;
  border-radius: 11px;
  font-size: 14px;
  font-weight: 600;
  letter-spacing: 0.03em;
  cursor: pointer;
  transition: background 0.2s, transform 0.2s;
}
button:hover { background: #e4ff86; }
button:active { transform: translateY(1px); }
.error {
  margin-top: 14px;
  padding: 10px 12px;
  color: #ffb1bb;
  font-size: 12.5px;
  background: rgba(255, 135, 152, 0.08);
  border: 1px solid rgba(255, 135, 152, 0.2);
  border-radius: 9px;
}
.foot { margin-top: 22px; color: #4d5850; font-size: 10.5px; line-height: 1.7; }
.foot code { color: #66736a; font-family: "SFMono-Regular", Consolas, monospace; }
</style>
</head>
<body>
<main class="card">
  <div class="brand">
    <span class="mark" aria-hidden="true">
      <svg viewBox="0 0 24 24" fill="currentColor"><rect x="2" y="9" width="3" height="6" rx="1.5"/><rect x="7" y="5" width="3" height="14" rx="1.5"/><rect x="12" y="2" width="3" height="20" rx="1.5"/><rect x="17" y="7" width="3" height="10" rx="1.5"/></svg>
    </span>
    <span><strong>Ming TTS Studio</strong><small>Password access</small></span>
  </div>
  <h1>输入访问密码</h1>
  <p class="hint">这个部署已开启密码保护，验证后才能进入工作台。</p>
  <form method="post" action="/login">
    <input type="hidden" name="next" value="__NEXT_URL__">
    <label for="password">访问密码</label>
    <input id="password" name="password" type="password" autocomplete="current-password" autofocus required>
    <button type="submit">进入工作台</button>
  </form>
  __ERROR_BLOCK__
  <p class="foot">密码由部署者在 <code>.env</code> 的 <code>STUDIO_PASSWORD</code> 中配置；会话默认有效 24 小时。</p>
</main>
</body>
</html>
"""


def safe_next(value: str | None) -> str:
    """Only allow same-site absolute paths as post-login redirect targets."""
    target = (value or "").strip()
    if not target.startswith("/") or target.startswith("//"):
        return "/studio/"
    if "\\" in target or "\r" in target or "\n" in target:
        return "/studio/"
    if target in ("/login", "/logout"):
        return "/studio/"
    return target


def check_password(candidate: str) -> bool:
    if not AUTH_ENABLED:
        return True
    return hmac.compare_digest(candidate.encode("utf-8"), PASSWORD.encode("utf-8"))


def _signing_key() -> bytes:
    return hashlib.sha256(b"ming-tts-studio\0" + PASSWORD.encode("utf-8")).digest()


def issue_session(now: float | None = None) -> str:
    expiry = int(now if now is not None else time.time()) + SESSION_SECONDS
    signature = hmac.new(_signing_key(), str(expiry).encode("ascii"), hashlib.sha256).hexdigest()
    return f"{expiry}.{signature}"


def valid_session(token: str | None) -> bool:
    if not token:
        return False
    try:
        expiry_text, signature = token.split(".", 1)
        expiry = int(expiry_text)
    except (ValueError, TypeError):
        return False
    if expiry < time.time():
        return False
    expected = hmac.new(_signing_key(), expiry_text.encode("ascii"), hashlib.sha256).hexdigest()
    return hmac.compare_digest(signature, expected)


def _basic_password(authorization: str | None) -> str | None:
    if not authorization or not authorization.lower().startswith("basic "):
        return None
    try:
        decoded = base64.b64decode(authorization[6:].strip(), validate=True).decode("utf-8")
    except (ValueError, UnicodeDecodeError):
        return None
    _username, separator, password = decoded.partition(":")
    return password if separator else None


def _authenticated_cookie(cookie_header: str | None) -> bool:
    if not cookie_header:
        return False
    jar = SimpleCookie()
    try:
        jar.load(cookie_header)
    except Exception:
        return False
    morsel = jar.get(COOKIE_NAME)
    return bool(morsel and valid_session(morsel.value))


def request_is_authenticated(request: Request) -> bool:
    if not AUTH_ENABLED:
        return True
    if _authenticated_cookie(request.headers.get("cookie")):
        return True
    password = _basic_password(request.headers.get("authorization"))
    return password is not None and check_password(password)


def login_page_html(target: str, error: str = "") -> str:
    error_block = f'<p class="error" role="alert">{html.escape(error)}</p>' if error else ""
    return _LOGIN_HTML.replace("__NEXT_URL__", html.escape(target, quote=True)).replace("__ERROR_BLOCK__", error_block)


def set_session_cookie(response: Response, secure: bool) -> None:
    response.set_cookie(
        COOKIE_NAME,
        issue_session(),
        max_age=SESSION_SECONDS,
        httponly=True,
        samesite="lax",
        secure=secure,
        path="/",
    )


def _wants_html(scope: Scope, headers: Headers) -> bool:
    if scope.get("method") not in ("GET", "HEAD"):
        return False
    path = scope.get("path", "")
    if path.startswith("/studio/assets/") or path.startswith("/uploads/"):
        return False
    return "text/html" in headers.get("accept", "").lower()


class PasswordGate:
    """ASGI middleware: let requests through only after password verification."""

    def __init__(self, app: ASGIApp) -> None:
        self.app = app

    async def __call__(self, scope: Scope, receive: Receive, send: Send) -> None:
        if scope.get("type") != "http" or not AUTH_ENABLED:
            await self.app(scope, receive, send)
            return

        path = scope.get("path", "/")
        method = scope.get("method", "GET")
        if method == "OPTIONS" or path in EXEMPT_PATHS:
            await self.app(scope, receive, send)
            return

        headers = Headers(scope=scope)
        password = _basic_password(headers.get("authorization"))
        if _authenticated_cookie(headers.get("cookie")) or (password is not None and check_password(password)):
            await self.app(scope, receive, send)
            return

        if _wants_html(scope, headers):
            query = scope.get("query_string", b"").decode("latin-1")
            target = path + (f"?{query}" if query else "")
            response = RedirectResponse(
                "/login?next=" + quote(target, safe=""),
                status_code=307,
                headers={"Cache-Control": "no-store"},
            )
        else:
            response = JSONResponse(
                {"detail": "需要密码访问，请先登录 / password required"},
                status_code=401,
                headers={"Cache-Control": "no-store"},
            )
        await response(scope, receive, send)
