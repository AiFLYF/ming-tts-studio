(function () {
  "use strict";

  const STORAGE_KEY = "ming-tts-studio:api-base";

  function normalizeBase(value) {
    let base = String(value || "").trim();
    if (!base) return "";
    if (!/^https?:\/\//i.test(base)) base = `http://${base}`;
    return base.replace(/\/+$/, "");
  }

  function resolveDefaultBase(configBase) {
    if (configBase) return normalizeBase(configBase);
    if (window.location.protocol === "http:" || window.location.protocol === "https:") {
      return window.location.origin;
    }
    return "http://127.0.0.1:8081";
  }

  const LOOPBACK_RE = /^https?:\/\/(?:127\.0\.0\.1|localhost|\[::1\])(?::\d+)?(?:\/|$)/i;

  function isLoopback(url) {
    return LOOPBACK_RE.test(String(url || ""));
  }

  /** An HTTPS page may not fetch plain http:// — the browser blocks the request
   *  and `fetch` only reports "Failed to fetch", which reads like "the service
   *  is down" even when it is running fine on another machine. */
  function blockedByMixedContent(url) {
    return window.location.protocol === "https:"
      && /^http:\/\//i.test(String(url || ""))
      && !isLoopback(url);
  }

  function hostOf(url) {
    try {
      return new URL(url).host;
    } catch (error) {
      return String(url || "");
    }
  }

  /** Turn a network-level failure into something the user can act on. */
  function describeConnectionFailure(url) {
    const host = hostOf(url);
    if (blockedByMixedContent(url)) {
      return `连不上 ${host}：这个页面是 HTTPS，浏览器默认禁止它请求 http:// 地址（混合内容拦截）。`
        + "两种办法——① 允许本页加载不安全内容：点地址栏左侧的图标 → 网站设置 → 把「不安全内容」改成「允许」→ 刷新本页再连；"
        + `② 直接打开网关自带的页面 http://${host}/studio/（同源，什么都不用设）。`;
    }
    return `连不上 ${host}。常见原因：网关没启动、端口写错、被防火墙拦截，或服务端没放行当前域名的跨域请求。`
      + "如果网关只在你的内网/本机，公网浏览器本来就访问不到它。";
  }

  function readStoredBase() {
    try {
      return localStorage.getItem(STORAGE_KEY) || "";
    } catch (error) {
      return "";
    }
  }

  function writeStoredBase(value) {
    try {
      if (value) localStorage.setItem(STORAGE_KEY, value);
      else localStorage.removeItem(STORAGE_KEY);
    } catch (error) {
      /* Private browsing can block storage; the in-memory value still works. */
    }
  }

  function errorMessage(payload, fallback) {
    if (!payload) return fallback;
    if (typeof payload.detail === "string") return payload.detail;
    if (Array.isArray(payload.detail)) {
      return payload.detail.map(item => item.msg || JSON.stringify(item)).join("；");
    }
    if (typeof payload.message === "string") return payload.message;
    return fallback;
  }

  function readWavMeta(buffer) {
    const meta = { duration: 0, sampleRate: 0, channels: 0 };
    if (!buffer || buffer.byteLength < 12) return meta;
    const view = new DataView(buffer);
    const tag = offset => String.fromCharCode(
      view.getUint8(offset), view.getUint8(offset + 1),
      view.getUint8(offset + 2), view.getUint8(offset + 3)
    );
    if (tag(0) !== "RIFF" || tag(8) !== "WAVE") return meta;

    let offset = 12;
    let bits = 0;
    let dataSize = 0;
    while (offset + 8 <= view.byteLength) {
      const id = tag(offset);
      const size = view.getUint32(offset + 4, true);
      const body = offset + 8;
      if (id === "fmt " && body + 16 <= view.byteLength) {
        meta.channels = view.getUint16(body + 2, true);
        meta.sampleRate = view.getUint32(body + 4, true);
        bits = view.getUint16(body + 14, true);
      } else if (id === "data") {
        dataSize = Math.min(size, view.byteLength - body);
        break;
      }
      offset = body + size + (size % 2);
    }

    const bytesPerFrame = meta.channels * Math.ceil(bits / 8);
    if (meta.sampleRate && bytesPerFrame && dataSize) {
      meta.duration = dataSize / (meta.sampleRate * bytesPerFrame);
    }
    return meta;
  }

  class TTSClient {
    constructor(config = {}) {
      this.config = config;
      this.defaultBaseUrl = resolveDefaultBase(config.apiBase);
      const stored = normalizeBase(readStoredBase());
      this.baseUrl = stored || this.defaultBaseUrl;
      this.demoAudioPath = config.demoAudio || "assets/audio/demo-zh.wav";
      this.demoCache = null;
    }

    get isCustomBase() {
      return this.baseUrl !== this.defaultBaseUrl;
    }

    setBase(value, persist = true) {
      const normalized = normalizeBase(value) || this.defaultBaseUrl;
      this.baseUrl = normalized;
      if (persist) writeStoredBase(normalized === this.defaultBaseUrl ? "" : normalized);
      return this.baseUrl;
    }

    resetBase() {
      writeStoredBase("");
      this.baseUrl = this.defaultBaseUrl;
      return this.baseUrl;
    }

    /** True when the browser would block this URL before the request leaves. */
    blockedByMixedContent(base) {
      return blockedByMixedContent(normalizeBase(base) || this.defaultBaseUrl);
    }

    describeConnectionFailure(base) {
      return describeConnectionFailure(normalizeBase(base) || this.defaultBaseUrl);
    }

    url(path) {
      if (!path) return "";
      if (/^https?:\/\//i.test(path)) return path;
      return `${this.baseUrl}${path.startsWith("/") ? "" : "/"}${path}`;
    }

    docsUrl() {
      return `${this.baseUrl}/docs`;
    }

    async fetchWithTimeout(url, options = {}, timeoutMs = 15000) {
      const controller = new AbortController();
      const timer = window.setTimeout(() => controller.abort(), timeoutMs);
      try {
        return await fetch(url, { ...options, signal: controller.signal });
      } catch (error) {
        if (error.name === "AbortError") {
          throw new Error(`请求超时（${Math.round(timeoutMs / 1000)} 秒），请检查 API 地址与网络。`);
        }
        throw new Error(describeConnectionFailure(this.baseUrl));
      } finally {
        window.clearTimeout(timer);
      }
    }

    async readError(response) {
      if (response.status === 401) {
        // Expired password session: send the tab back to the login page when
        // the gateway is same-origin. A cross-origin page (GitHub Pages talking
        // to someone's LAN gateway) can never share that cookie, so pointing it
        // at /login would be a dead end — tell it where the login page lives.
        let sameOrigin = false;
        let origin = "";
        try {
          const base = new URL(this.baseUrl, window.location.href);
          origin = base.origin;
          sameOrigin = origin === window.location.origin;
        } catch (error) {
          sameOrigin = false;
        }
        if (sameOrigin) {
          const next = window.location.pathname + window.location.search;
          window.location.assign(`/login?next=${encodeURIComponent(next)}`);
          return "需要密码访问，请重新登录。";
        }
        return `该网关已开启访问密码，而这个页面与网关不同源，拿不到登录状态。请改用网关自带的页面 ${origin}/studio/ 登录后再使用。`;
      }
      let payload = null;
      try {
        const text = await response.text();
        payload = text ? JSON.parse(text) : null;
      } catch (error) {
        payload = null;
      }
      return errorMessage(payload, `请求失败（HTTP ${response.status}）`);
    }

    async health() {
      const response = await this.fetchWithTimeout(`${this.baseUrl}/health`, { cache: "no-store" }, 5000);
      let payload = null;
      try {
        payload = await response.json();
      } catch (error) {
        payload = null;
      }
      if (!response.ok) {
        throw new Error(errorMessage(payload, `服务不可用（HTTP ${response.status}）`));
      }
      return payload || {};
    }

    async generate(payload) {
      const response = await this.fetchWithTimeout(`${this.baseUrl}/generate`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload)
      }, 300000);

      if (!response.ok) {
        throw new Error(await this.readError(response));
      }

      const blob = await response.blob();
      if (!blob.size) throw new Error("服务返回了空音频，请稍后重试。");

      return {
        blob,
        duration: Number.parseFloat(response.headers.get("X-Duration") || "0") || 0,
        sampleRate: Number.parseInt(response.headers.get("X-Sample-Rate") || "0", 10) || 0,
        task: response.headers.get("X-Task") || payload.task
      };
    }

    async upload(file) {
      const form = new FormData();
      form.append("file", file, file.name);
      const response = await this.fetchWithTimeout(`${this.baseUrl}/upload`, {
        method: "POST",
        body: form
      }, 90000);
      if (!response.ok) throw new Error(await this.readError(response));
      return response.json();
    }

    async listUploads() {
      const response = await this.fetchWithTimeout(`${this.baseUrl}/uploads`, { cache: "no-store" }, 10000);
      if (!response.ok) throw new Error(await this.readError(response));
      const payload = await response.json();
      const files = Array.isArray(payload?.files) ? payload.files : [];
      return { files, count: Number.isFinite(payload?.count) ? payload.count : files.length };
    }

    async deleteUpload(url) {
      const target = this.url(url);
      const response = await this.fetchWithTimeout(target, { method: "DELETE" }, 15000);
      if (!response.ok) throw new Error(await this.readError(response));
      try {
        return await response.json();
      } catch (error) {
        return {};
      }
    }

    async demoGenerate() {
      if (!this.demoCache) {
        const response = await this.fetchWithTimeout(this.demoAudioPath, { cache: "force-cache" }, 20000);
        if (!response.ok) throw new Error("演示音频加载失败，请确认 assets/audio/demo-zh.wav 存在。");
        const buffer = await response.arrayBuffer();
        const meta = readWavMeta(buffer);
        this.demoCache = {
          blob: new Blob([buffer], { type: "audio/wav" }),
          duration: meta.duration,
          sampleRate: meta.sampleRate
        };
      }
      return {
        blob: this.demoCache.blob,
        duration: this.demoCache.duration,
        sampleRate: this.demoCache.sampleRate,
        task: "demo",
        demo: true
      };
    }

    async testConnection(base) {
      const target = normalizeBase(base) || this.defaultBaseUrl;
      const started = performance.now();
      const controller = new AbortController();
      const timer = window.setTimeout(() => controller.abort(), 6000);
      try {
        const response = await fetch(`${target}/health`, {
          cache: "no-store",
          signal: controller.signal
        });
        let payload = null;
        try {
          payload = await response.json();
        } catch (error) {
          payload = null;
        }
        if (!response.ok) {
          throw new Error(errorMessage(payload, `服务不可用（HTTP ${response.status}）`));
        }
        return {
          base: target,
          payload: payload || {},
          latency: Math.max(1, Math.round(performance.now() - started))
        };
      } catch (error) {
        if (error.name === "AbortError") throw new Error("连接超时，请检查地址和网络。");
        const message = String(error.message || "");
        // Browsers only say "Failed to fetch" for a blocked or refused request.
        if (!message || /failed to fetch|networkerror|load failed/i.test(message)) {
          throw new Error(describeConnectionFailure(target));
        }
        throw new Error(message);
      } finally {
        window.clearTimeout(timer);
      }
    }
  }

  window.MingAPI = { TTSClient, normalizeBase, readWavMeta };
})();
