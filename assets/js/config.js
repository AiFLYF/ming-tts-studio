/**
 * Ming TTS Studio runtime configuration.
 *
 * apiBase:
 *   - Leave empty to use the page origin (works when the FastAPI service
 *     serves this folder), or set an explicit gateway URL such as
 *     "http://192.168.1.20:8081".
 *   - Visitors can also change it at runtime from the settings dialog.
 *
 * version:
 *   - Shown in the footer. Bump it together with the ?v= query strings in
 *     index.html and the VERSION constant in sw.js, otherwise browsers keep
 *     serving the old stylesheet and scripts.
 *
 * serviceWorker:
 *   - Offline shell caching. Set to false if you deploy behind a proxy that
 *     already handles caching and you do not want a second cache layer.
 *
 * apiDocs:
 *   - Where the header's "API 文档" link points when no gateway is connected.
 *     A live gateway serves its own OpenAPI page at /docs; a static deployment
 *     (GitHub Pages) has nothing there, so it falls back to this page.
 */
window.MING_CONFIG = {
  apiBase: "",
  demoAudio: "assets/audio/demo-zh.wav",
  healthIntervalMs: 20000,
  version: "1.0.6",
  serviceWorker: true,
  apiDocs: "https://github.com/AiFLYF/ming-tts-studio/blob/main/docs/API.md"
};
