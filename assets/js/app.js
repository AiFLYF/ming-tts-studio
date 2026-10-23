/* =========================================================
   Ming TTS Studio — application logic
   Vanilla JS, no build step. Talks to the Ming TTS gateway.
   ========================================================= */

(function () {
  "use strict";

  const DATA = window.MingData || {};
  const TASKS = DATA.TASKS || [];
  const ICONS = DATA.ICONS || {};
  const LANGUAGE_LABELS = DATA.LANGUAGE_LABELS || {};
  const EMOTIONS = DATA.EMOTIONS || [];
  const VOICE_GROUPS = DATA.VOICE_GROUPS || [];

  // Flattened, de-duplicated view of the official catalog. Entries are
  // [name, note, "情绪1,情绪2"]; an empty emotion list means the bare name is
  // the identifier, while a non-empty one must be invoked as "名字_情绪".
  const VOICE_INDEX = new Map();
  VOICE_GROUPS.forEach(([, voices]) => {
    (voices || []).forEach(([name, note, emotions]) => {
      if (!VOICE_INDEX.has(name)) {
        VOICE_INDEX.set(name, { note, emotions: emotions ? emotions.split(",").filter(Boolean) : [] });
      }
    });
  });
  const VOICE_BASE_COUNT = VOICE_INDEX.size;
  const VOICE_SOUND_COUNT = Array.from(VOICE_INDEX.values())
    .reduce((sum, voice) => sum + (voice.emotions.length || 1), 0);
  const PODCAST_EXAMPLE_LINES = DATA.PODCAST_EXAMPLE_LINES || [];
  const API = window.MingAPI || {};
  const TTSClient = API.TTSClient;
  const normalizeBase = API.normalizeBase || (value => String(value || ""));
  const readWavMeta = API.readWavMeta || (() => ({}));
  const CONFIG = window.MING_CONFIG || {};

  const UI = {
    play: '<svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M8 5.4v13.2c0 .9 1 1.4 1.7.9l10-6.6a1.1 1.1 0 0 0 0-1.8l-10-6.6A1.1 1.1 0 0 0 8 5.4Z"/></svg>',
    pause: '<svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><rect x="6" y="5" width="4" height="14" rx="1"/><rect x="14" y="5" width="4" height="14" rx="1"/></svg>',
    upload: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 16V4m0 0L8 8m4-4 4 4"/><path d="M4 16v2a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-2"/></svg>',
    music: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M9 18V5l10-2v13"/><circle cx="6" cy="18" r="3"/><circle cx="16" cy="16" r="3"/></svg>',
    wave: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" aria-hidden="true"><path d="M3 12h2M7 8v8M11 4v16M15 7v10M19 10v4M22 12h-1"/></svg>',
    close: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" aria-hidden="true"><path d="M18 6 6 18M6 6l12 12"/></svg>',
    download: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 4v11m0 0 4-4m-4 4-4-4"/><path d="M4 17v2a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-2"/></svg>',
    refresh: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M20 11a8 8 0 1 0-2.3 6.7"/><path d="M20 4v7h-7"/></svg>',
    spark: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m12 3 .8 4.2L17 8l-4.2.8L12 13l-.8-4.2L7 8l4.2-.8L12 3Z"/><path d="M18 15v4M16 17h4"/></svg>',
    plus: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true"><path d="M12 5v14M5 12h14"/></svg>'
  };

  const STYLE_PRESETS = [
    ["纪录片旁白", "低沉克制的中年男声，语速偏慢，吐字清晰，带一点颗粒感和空间感。"],
    ["深夜电台", "温柔成熟的女性声音，贴近耳边轻声诉说，气息自然，句子之间有停顿。"],
    ["活力广告", "明亮有弹性的年轻声线，节奏轻快，重音清晰，充满能量。"],
    ["故事叙述", "温和亲切的旁白声线，娓娓道来，情绪有细微起伏，适合长篇故事。"]
  ];

  const INSTRUCTION_PRESETS = [
    ["深夜电台", "用温柔贴近耳边的气声慢慢说，像深夜电台，句子之间留出自然的停顿。"],
    ["轻快分享", "节奏明快、语气上扬，像在分享一件让人开心的小事。"],
    ["克制情绪", "压低声音，带着克制的怒意，把重音落在关键词上。"],
    ["纪录片", "沉稳克制，语速均匀，在段末稍作停顿。"]
  ];

  const state = {
    taskId: "",
    drafts: Object.create(null),
    refs: Object.create(null),
    podcast: [createSpeaker(), createSpeaker()],
    results: Object.create(null),
    generating: false,
    generatingTask: null,
    startedAt: 0,
    elapsedTimer: 0,
    mode: "checking",
    appliedMode: "checking",
    health: null,
    healthError: "",
    healthPromise: null,
    lastHealthAt: 0,
    libraryFiles: [],
    libraryQuery: "",
    libraryError: "",
    libraryLoading: false,
    modal: "",
    lastFocus: null,
    pendingDelete: null,
    pendingDeleteTimer: 0,
    miniAudio: null,
    miniSrc: "",
    resultAudio: null,
    playerTaskId: "",
    audioContext: null,
    resizeFrame: 0
  };

  const dom = {};
  let client = null;

  function createSpeaker() {
    return { upload: null, text: "" };
  }

  function $(selector, root) {
    return (root || document).querySelector(selector);
  }

  function $$(selector, root) {
    return Array.from((root || document).querySelectorAll(selector));
  }

  function escapeHtml(value) {
    return String(value == null ? "" : value).replace(/[&<>"']/g, ch => ({
      "&": "&amp;",
      "<": "&lt;",
      ">": "&gt;",
      '"': "&quot;",
      "'": "&#39;"
    })[ch]);
  }

  function getTask(id) {
    return TASKS.find(task => task.id === id) || null;
  }

  function currentTask() {
    return getTask(state.taskId) || TASKS[0];
  }

  function createDraft(task) {
    const draft = {
      text: "",
      promptText: "",
      language: "",
      instruction: "",
      style: "",
      ip: "灵小柔",
      ipEmotion: ""
    };
    if (task.languages && task.languages.length) {
      draft.language = task.defaultLanguage || task.languages[0];
    }
    if (task.defaults) Object.assign(draft, task.defaults);
    return draft;
  }

  function getDraft(task) {
    if (!state.drafts[task.id]) state.drafts[task.id] = createDraft(task);
    return state.drafts[task.id];
  }

  function workerAvailable() {
    const value = state.health && Number(state.health.workers_available);
    return Number.isFinite(value) ? value : null;
  }

  function workerTotal() {
    const value = state.health && Number(state.health.workers_total);
    return Number.isFinite(value) ? value : null;
  }

  function apiHost() {
    try {
      return new URL(client.baseUrl).host;
    } catch (error) {
      return client.baseUrl;
    }
  }

  /** Explicit `behavior` wins over the CSS `scroll-behavior` override, so the
   *  preference has to be read here too. */
  function scrollBehavior() {
    return window.matchMedia("(prefers-reduced-motion: reduce)").matches ? "auto" : "smooth";
  }

  function formatClock(seconds) {
    const total = Math.max(0, Math.round(Number(seconds) || 0));
    const minutes = Math.floor(total / 60);
    const rest = String(total % 60).padStart(2, "0");
    return `${minutes}:${rest}`;
  }

  function formatSeconds(value) {
    const number = Number(value);
    if (!Number.isFinite(number) || number <= 0) return "";
    return `${number.toFixed(2)} s`;
  }

  function formatElapsed(value) {
    const number = Number(value);
    if (!Number.isFinite(number) || number < 0) return "—";
    return `${number.toFixed(1)} s`;
  }

  function formatSampleRate(rate) {
    const number = Number(rate);
    if (!Number.isFinite(number) || number <= 0) return "—";
    const kHz = number / 1000;
    return `${Number.isInteger(kHz) ? kHz : kHz.toFixed(1)} kHz`;
  }

  function formatSize(kb) {
    const number = Number(kb);
    if (!Number.isFinite(number) || number <= 0) return "";
    if (number >= 1024) return `${(number / 1024).toFixed(1)} MB`;
    return `${number >= 10 ? Math.round(number) : number.toFixed(1)} KB`;
  }

  function formatShortTime(value) {
    const date = value instanceof Date ? value : new Date(value);
    if (Number.isNaN(date.getTime())) return "";
    return date.toLocaleString("zh-CN", {
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      hour12: false
    });
  }

  function formatClockOfDay(value) {
    const date = value instanceof Date ? value : new Date(value);
    if (Number.isNaN(date.getTime())) return "";
    return date.toLocaleTimeString("zh-CN", { hour: "2-digit", minute: "2-digit", hour12: false });
  }

  function timestampForFile(date) {
    const pad = number => String(number).padStart(2, "0");
    return [
      date.getFullYear(), pad(date.getMonth() + 1), pad(date.getDate()), "-",
      pad(date.getHours()), pad(date.getMinutes()), pad(date.getSeconds())
    ].join("");
  }

  function truncate(value, length) {
    const text = String(value || "").replace(/\s+/g, " ").trim();
    return text.length > length ? `${text.slice(0, length)}…` : text;
  }

  function displayFileName(filename) {
    const name = String(filename || "");
    return name.replace(/^[a-f0-9]{10}_/i, "") || "参考音频";
  }

  function mediaUrl(upload) {
    return upload && upload.url ? client.url(upload.url) : "";
  }

  /** What goes into `prompt_wav`: an upload reference the backend can resolve.
   *  Prefer `url` ("/uploads/…") so the page never handles server filesystem
   *  paths; fall back to `path` for older backends that only returned that. */
  function speakerReference(upload) {
    if (!upload) return "";
    return upload.url || upload.path || "";
  }

  /** Status strings Ming's gateway actually reports. A bare {"status":"ok"} from
   *  an unrelated reverse proxy must not be mistaken for a Ming instance. */
  const MING_STATUSES = ["healthy", "degraded", "loading", "offline", "unhealthy"];

  function looksLikeMingHealth(payload) {
    if (!payload || typeof payload !== "object") return false;
    const has = key => Object.prototype.hasOwnProperty.call(payload, key);

    // Any Ming-specific counter is strong evidence on its own.
    if (has("model_loaded") || has("workers_available") || has("workers_total") || has("requests_in_flight")) {
      return true;
    }
    // Minimal gateways may only report a status field; accept it only when the
    // value is one of the statuses this API documents.
    if (has("status")) {
      return MING_STATUSES.includes(String(payload.status || "").toLowerCase());
    }
    return false;
  }

  function isValidHttpUrl(value) {
    try {
      const url = new URL(value);
      return url.protocol === "http:" || url.protocol === "https:";
    } catch (error) {
      return false;
    }
  }

  /* ---------------- Boot ---------------- */

  function cacheDom() {
    dom.menuBtn = $("#menuBtn");
    dom.sidebar = $("#sidebar");
    dom.sidebarScrim = $("#sidebarScrim");
    dom.taskNav = $("#taskNav");
    dom.sidebarSettingsBtn = $("#sidebarSettingsBtn");
    dom.apiBaseLabel = $("#apiBaseLabel");
    dom.endpointLight = $("#endpointLight");
    dom.demoBanner = $("#demoBanner");
    dom.demoRetryBtn = $("#demoRetryBtn");
    dom.demoSettingsBtn = $("#demoSettingsBtn");
    dom.statusPill = $("#statusPill");
    dom.statusLabel = $(".status-label", dom.statusPill);
    dom.statusMeta = $(".status-meta", dom.statusPill);
    dom.docsLink = $("#docsLink");
    dom.libraryBtn = $("#libraryBtn");
    dom.libraryCount = $("#libraryCount");
    dom.settingsBtn = $("#settingsBtn");
    dom.taskHero = $("#taskHero");
    dom.composerPanel = $("#composerPanel");
    dom.outputState = $("#outputState");
    dom.outputBody = $("#outputBody");
    dom.libraryModal = $("#libraryModal");
    dom.librarySearch = $("#librarySearch");
    dom.refreshLibraryBtn = $("#refreshLibraryBtn");
    dom.libraryCountLabel = $("#libraryCountLabel");
    dom.libraryDrop = $("#libraryDrop");
    dom.libraryFileInput = $("#libraryFileInput");
    dom.libraryPickBtn = $("#libraryPickBtn");
    dom.libraryList = $("#libraryList");
    dom.settingsModal = $("#settingsModal");
    dom.settingsForm = $("#settingsForm");
    dom.apiBaseInput = $("#apiBaseInput");
    dom.defaultBaseHint = $("#defaultBaseHint");
    dom.connectionResult = $("#connectionResult");
    dom.testConnectionBtn = $("#testConnectionBtn");
    dom.resetApiBtn = $("#resetApiBtn");
    dom.saveSettingsBtn = $("#saveSettingsBtn");
    dom.toastStack = $("#toastStack");
    dom.footerVersion = $("#footerVersion");
  }

  function init() {
    cacheDom();
    if (!TTSClient) {
      dom.composerPanel.innerHTML = '<div class="lib-empty is-error"><strong>前端资源加载失败</strong><span>请确认 assets/js/api.js 已正确加载。</span></div>';
      return;
    }

    client = new TTSClient(CONFIG);

    const override = new URLSearchParams(window.location.search).get("api");
    if (override) client.setBase(override, false);

    state.resultAudio = new Audio();
    state.resultAudio.preload = "auto";
    state.miniAudio = new Audio();
    state.miniAudio.preload = "auto";

    bindAudioEvents();
    bindStaticEvents();
    buildNav();
    updateApiLabels();
    syncBodyLock();

    const initialId = window.location.hash.replace(/^#/, "");
    selectTask(getTask(initialId) ? initialId : "seed", { scroll: false, updateHash: false });

    state.appliedMode = "checking";
    applyMode();
    refreshHealth();

    window.setInterval(() => {
      if (document.visibilityState === "visible") refreshHealth({ silent: true });
    }, Math.max(8000, Number(CONFIG.healthIntervalMs) || 20000));

    if (dom.footerVersion) dom.footerVersion.textContent = `v${String(CONFIG.version || "1.0.1")}`;
    registerServiceWorker();
  }

  /** Caches the static shell so the workbench opens offline.
   *  The API itself is never cached — sw.js only touches same-origin assets. */
  function registerServiceWorker() {
    if (CONFIG.serviceWorker === false) return;
    if (!("serviceWorker" in navigator)) return;
    if (window.location.protocol !== "http:" && window.location.protocol !== "https:") return;
    window.addEventListener("load", () => {
      navigator.serviceWorker.register("sw.js").catch(() => {
        /* Registration fails on http:// hosts that are not localhost; the app still works. */
      });
    });
  }

  /* ---------------- Navigation / hero ---------------- */

  function buildNav() {
    const groups = [];
    TASKS.forEach(task => {
      let group = groups.find(item => item.name === task.group);
      if (!group) {
        group = { name: task.group, tasks: [] };
        groups.push(group);
      }
      group.tasks.push(task);
    });

    dom.taskNav.innerHTML = groups.map(group => `
      <div class="nav-group">
        <div class="nav-group-head">
          <span>${escapeHtml(group.name)}</span>
          <span>${String(group.tasks.length).padStart(2, "0")}</span>
        </div>
        ${group.tasks.map(task => `
          <button class="task-link" type="button" data-task-id="${escapeHtml(task.id)}" title="${escapeHtml(task.en)}">
            <span class="task-icon">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${ICONS[task.id] || ""}</svg>
            </span>
            <span class="task-copy">
              <span class="task-name">${escapeHtml(task.name)}</span>
              <span class="task-en">${escapeHtml(task.en)}</span>
            </span>
            <span class="task-arrow">→</span>
          </button>
        `).join("")}
      </div>
    `).join("");

    renderNavActive();
  }

  function renderNavActive() {
    $$(".task-link", dom.taskNav).forEach(button => {
      const active = button.dataset.taskId === state.taskId;
      button.classList.toggle("is-active", active);
      if (active) button.setAttribute("aria-current", "page");
      else button.removeAttribute("aria-current");
    });
  }

  function heroTitle(name) {
    const chars = Array.from(String(name || ""));
    if (chars.length <= 2) return `<span class="accent">${escapeHtml(name)}</span>`;
    return `${escapeHtml(chars.slice(0, -2).join(""))}<span class="accent">${escapeHtml(chars.slice(-2).join(""))}</span>`;
  }

  function renderHero() {
    const task = currentTask();
    const wave = Array.from({ length: 42 }, (_, index) => {
      const seed = Number(task.index || 1) * 11;
      const value = 18 + Math.round(Math.abs(Math.sin((index + seed) * 0.73)) * 56 + (index % 5) * 3);
      return `<span style="--h:${Math.min(92, value)};--i:${index}"></span>`;
    }).join("");

    dom.taskHero.innerHTML = `
      <div class="hero-copy">
        <div class="hero-eyebrow">
          <span class="hero-group">${escapeHtml(task.group)}</span>
          <span class="sep">/</span>
          <span>${escapeHtml(task.en)}</span>
          <span class="sep">/</span>
          <span>Ming-3.0-tts-tiny</span>
        </div>
        <div class="hero-title-row">
          <h1 id="taskTitle">${heroTitle(task.name)}</h1>
          <span class="hero-index">${escapeHtml(task.index)}</span>
        </div>
        <p class="hero-desc">${escapeHtml(task.desc)}</p>
        <div class="tag-row">
          ${(task.tags || []).map(tag => `<span class="tag">${escapeHtml(tag)}</span>`).join("")}
        </div>
      </div>
      <div class="hero-visual" aria-hidden="true">
        <span class="ghost-index">${escapeHtml(task.index)}</span>
        <div class="hero-wave">${wave}</div>
        <div class="hero-specs"><span>44.1 kHz</span><span>Mono</span><span>WAV</span></div>
      </div>
    `;
  }

  function updateHash(id) {
    try {
      const url = new URL(window.location.href);
      url.hash = id;
      window.history.replaceState(null, "", url.toString());
    } catch (error) {
      /* file:// can reject history updates. */
    }
  }

  function selectTask(id, options = {}) {
    const task = getTask(id);
    if (!task) return;
    closeSidebar();
    if (state.taskId === task.id) return;

    stopMiniAudio();
    if (state.resultAudio) state.resultAudio.pause();
    state.taskId = task.id;
    getDraft(task);

    renderNavActive();
    renderHero();
    renderComposer();
    renderOutput();
    document.title = `${task.name} · Ming TTS Studio`;

    if (options.updateHash !== false) updateHash(task.id);
    if (options.scroll) window.scrollTo({ top: 0, behavior: scrollBehavior() });
  }

  /* ---------------- Composer ---------------- */

  function textPlaceholder(task) {
    if (task.id === "podcast") return "speaker_1: 第一句台词\nspeaker_2: 第二句台词";
    if (task.id === "freeform") return "写下你想让声音说出的内容…";
    if (task.id === "voice_design") return "输入适合这个声音的台词…";
    return "在这里输入要合成的文本，标点会影响停顿…";
  }

  function textMetaText(task, text) {
    const chars = Array.from(String(text || "")).length;
    if (task.id === "podcast") {
      const lines = String(text || "").split(/\r?\n/).filter(line => line.trim()).length;
      return `${chars} 字 · ${lines} 行`;
    }
    return `${chars} 字`;
  }

  // One source of truth for "speaker_N:" script lines, so the live counter and
  // the submit-time validation can never disagree. Accepts full-width colons.
  const PODCAST_LINE_RE = /^\s*speaker_(\d+)\s*[:：]/i;

  function podcastCoverage(text) {
    const count = state.podcast.length;
    const lines = String(text || "").split(/\r?\n/).filter(line => line.trim());
    if (!lines.length) return `覆盖 0/${count} 位说话人`;
    const ids = new Set();
    let invalid = 0;
    lines.forEach(line => {
      const match = line.match(PODCAST_LINE_RE);
      if (!match) invalid += 1;
      else ids.add(Number(match[1]));
    });
    if (invalid) return `${invalid} 行缺少 speaker_N: 前缀`;
    const covered = Array.from(ids).filter(id => id >= 1 && id <= count).length;
    return `覆盖 ${covered}/${count} 位说话人`;
  }

  function sectionMarkup(index, title, english, body) {
    return `
      <section class="form-section">
        <header class="section-head">
          <span class="section-index">${String(index).padStart(2, "0")}</span>
          <h3>${escapeHtml(title)}</h3>
          <span class="section-en">${escapeHtml(english)}</span>
        </header>
        ${body}
      </section>
    `;
  }

  function requirementBadge(optional) {
    return optional ? '<span class="opt">演示可跳过</span>' : '<span class="req">必填</span>';
  }

  function textField(task, draft) {
    const tags = task.insertTags ? `
      <div class="tag-chips">
        <span class="chip-label">插入标签</span>
        ${task.insertTags.map(tag => `<button class="chip" type="button" data-tag="${escapeHtml(tag)}">${escapeHtml(tag)}</button>`).join("")}
      </div>
    ` : "";

    const rightHint = task.id === "podcast"
      ? `<span class="hint" id="podcastCoverage">${escapeHtml(podcastCoverage(draft.text))}</span>`
      : "";

    return `
      <div class="field">
        <div class="field-head">
          <label for="textInput">目标文本 <span class="req">必填</span></label>
          <button class="text-btn" type="button" data-action="fill-example">填入示例</button>
        </div>
        <div class="textarea-wrap">
          <textarea class="textarea" id="textInput" data-field="text" rows="6" placeholder="${escapeHtml(textPlaceholder(task))}" spellcheck="false">${escapeHtml(draft.text)}</textarea>
          <span class="textarea-meta" id="textMeta">${escapeHtml(textMetaText(task, draft.text))}</span>
        </div>
        ${tags}
        <div class="field-foot">
          <span class="hint">${escapeHtml(task.textHint || "标点会影响停顿，建议使用完整句子。")}</span>
          ${rightHint}
        </div>
      </div>
    `;
  }

  function uploadZoneMarkup(isDemo) {
    return `
      <div class="upload-zone${isDemo ? " is-demo" : ""}" data-ref-zone role="button" tabindex="0" aria-label="上传参考音频">
        <input type="file" data-ref-input accept=".wav,.mp3,.flac,audio/wav,audio/mpeg,audio/flac" hidden>
        <span class="upload-icon">${UI.upload}</span>
        <span class="upload-copy">
          <strong class="upload-title">${isDemo ? "演示模式下无法上传" : "上传参考音频"}</strong>
          <small class="upload-sub">${isDemo ? "连接 API 后可上传 WAV / MP3 / FLAC" : "拖拽或点击选择 · WAV / MP3 / FLAC · 最大 50 MB"}</small>
        </span>
        <span class="upload-action">${isDemo ? "连接 API" : "选择文件"}</span>
      </div>
    `;
  }

  function miniPlayerMarkup(src, duration, label) {
    const total = Number(duration) || 0;
    return `
      <div class="mini-player" data-mini-src="${escapeHtml(src)}" data-mini-duration="${total}">
        <button class="mini-play" type="button" aria-label="播放 ${escapeHtml(label || "音频")}">${UI.play}</button>
        <div class="mini-track" role="slider" tabindex="0" aria-label="播放进度" aria-valuemin="0" aria-valuemax="${Math.round(total)}" aria-valuenow="0">
          <span class="mini-fill"></span>
        </div>
        <span class="mini-time">${formatClock(total)}</span>
      </div>
    `;
  }

  function refCardMarkup(task, upload) {
    const name = upload.original_name || displayFileName(upload.filename);
    const meta = [formatSeconds(upload.duration), formatSize(upload.size_kb)].filter(Boolean).join(" · ");
    return `
      <div class="ref-card">
        <div class="ref-top">
          <div class="ref-file">
            <span class="file-icon">${UI.music}</span>
            <div class="ref-info">
              <div class="ref-name" title="${escapeHtml(name)}">${escapeHtml(name)}</div>
              <div class="ref-meta">${escapeHtml(meta || "参考音频已上传")}</div>
            </div>
          </div>
          <div class="ref-actions">
            <span class="ok-pill">就绪</span>
            <button class="ref-remove" type="button" data-clear-ref aria-label="移除参考音频">${UI.close}</button>
          </div>
        </div>
        ${miniPlayerMarkup(mediaUrl(upload), upload.duration, name)}
      </div>
    `;
  }

  function promptTextField(draft, isDemo) {
    return `
      <div class="field">
        <div class="field-head">
          <label for="promptTextInput">参考文本 ${requirementBadge(isDemo)}</label>
          <span class="field-note">必须与音频逐字一致</span>
        </div>
        <textarea class="textarea compact" id="promptTextInput" data-field="promptText" rows="3" placeholder="输入参考音频中实际说出的内容…">${escapeHtml(draft.promptText)}</textarea>
        ${isDemo ? '<p class="field-help">演示模式下可留空，输出仍为内置示例音频。</p>' : ""}
      </div>
    `;
  }

  function referenceField(task, draft, isDemo) {
    const upload = state.refs[task.id];
    const note = upload ? "已就绪" : (isDemo ? "演示模式 · 无需上传" : "建议 3–15 秒清晰人声");
    return `
      <div class="field">
        <div class="field-head">
          <label>参考音频 ${requirementBadge(isDemo)}</label>
          <span class="field-note">${escapeHtml(note)}</span>
        </div>
        ${upload ? refCardMarkup(task, upload) : uploadZoneMarkup(isDemo)}
        ${isDemo ? '<p class="field-help">演示模式可跳过上传，生成结果会使用仓库内置示例音频。</p>' : ""}
      </div>
      ${task.promptText ? promptTextField(draft, isDemo) : ""}
    `;
  }

  function speakerUploadMarkup(index, isDemo) {
    return `
      <div class="mini-upload${isDemo ? " is-demo" : ""}" data-speaker-zone="${index}" role="button" tabindex="0" aria-label="上传角色 ${index + 1} 的参考音频">
        <input type="file" data-speaker-input="${index}" accept=".wav,.mp3,.flac,audio/wav,audio/mpeg,audio/flac" hidden>
        <span class="mini-upload-icon">${UI.upload}</span>
        <span>
          <strong>${isDemo ? "演示模式下跳过上传" : "上传参考音频"}</strong>
          <small>${isDemo ? "连接 API 后可上传" : "WAV / MP3 / FLAC"}</small>
        </span>
      </div>
    `;
  }

  function speakerCardMarkup(speaker, index, isDemo) {
    const upload = speaker.upload;
    const name = upload ? (upload.original_name || displayFileName(upload.filename)) : "";
    const left = upload ? `
      <div class="mini-ref">
        <div class="mini-ref-head">
          <span class="file-dot"></span>
          <strong title="${escapeHtml(name)}">${escapeHtml(name)}</strong>
          <button class="text-btn" type="button" data-speaker-clear="${index}">移除</button>
        </div>
        ${miniPlayerMarkup(mediaUrl(upload), upload.duration, `角色 ${index + 1} 的参考音频`)}
      </div>
    ` : speakerUploadMarkup(index, isDemo);

    return `
      <div class="speaker-card">
        <div class="speaker-head">
          <span class="speaker-badge">SPEAKER ${index + 1}</span>
          ${state.podcast.length > 2 ? `<button class="speaker-remove" type="button" data-remove-speaker="${index}">移除</button>` : ""}
        </div>
        <div class="speaker-grid">
          ${left}
          <div class="speaker-text">
            <span class="mini-label">参考文本</span>
            <input class="input" type="text" data-speaker-text="${index}" value="${escapeHtml(speaker.text)}" placeholder="这段音频里说了什么？" aria-label="角色 ${index + 1} 的参考文本">
          </div>
        </div>
      </div>
    `;
  }

  function podcastField(isDemo) {
    return `
      <div class="field">
        <div class="field-head">
          <label>说话人 ${requirementBadge(isDemo)}</label>
          <span class="field-note">2–4 位</span>
        </div>
        <div class="speaker-list">
          ${state.podcast.map((speaker, index) => speakerCardMarkup(speaker, index, isDemo)).join("")}
        </div>
        <div class="tag-chips">
          <button class="chip" type="button" data-add-speaker ${state.podcast.length >= 4 ? "disabled" : ""}>+ 添加说话人</button>
          <span class="chip-label">${isDemo ? "演示模式使用内置示例，无需上传" : "每位角色需要一段参考音频与参考文本"}</span>
        </div>
        <p class="field-help">${isDemo ? "演示模式可跳过上传；脚本仍建议以 speaker_N: 开头。" : "脚本中的 speaker_1…speaker_N 需要与上方角色一一对应。"}</p>
      </div>
    `;
  }

  function instructionField(draft, isDemo) {
    return `
      <div class="field">
        <div class="field-head">
          <label for="instructionInput">表达指令 ${requirementBadge(isDemo)}</label>
          <span class="field-note">语气 · 节奏 · 场景</span>
        </div>
        <div class="textarea-wrap">
          <textarea class="textarea" id="instructionInput" data-field="instruction" rows="4" placeholder="例如：用温柔的气声慢慢说，像深夜电台，句子之间留出自然的停顿。">${escapeHtml(draft.instruction)}</textarea>
        </div>
        <div class="tag-chips">
          <span class="chip-label">快速补充</span>
          ${INSTRUCTION_PRESETS.map(([label, text]) => `<button class="chip" type="button" data-action="append-preset" data-target="instruction" data-text="${escapeHtml(text)}">${escapeHtml(label)}</button>`).join("")}
        </div>
        <p class="field-help">${isDemo ? "演示模式仍需文本；指令会被保留，重新连接后可继续使用。" : "没有参考音频时，声音完全由这段指令与文本共同决定。"}</p>
      </div>
    `;
  }

  function styleField(draft, isDemo) {
    return `
      <div class="field">
        <div class="field-head">
          <label for="styleInput">声音描述 ${requirementBadge(isDemo)}</label>
          <span class="field-note">无需参考音频</span>
        </div>
        <div class="textarea-wrap">
          <textarea class="textarea" id="styleInput" data-field="style" rows="4" placeholder="例如：低沉克制的中年男声，语速偏慢，吐字清晰，适合纪录片旁白。">${escapeHtml(draft.style)}</textarea>
        </div>
        <div class="tag-chips">
          <span class="chip-label">灵感</span>
          ${STYLE_PRESETS.map(([label, text]) => `<button class="chip" type="button" data-action="append-preset" data-target="style" data-text="${escapeHtml(text)}">${escapeHtml(label)}</button>`).join("")}
        </div>
        <p class="field-help">${isDemo ? "演示模式仍需文本；声音描述会被保留，重新连接后即可真实合成。" : "描述年龄、性别、音色、语速、空间感与使用场景，越具体越稳定。"}</p>
      </div>
    `;
  }

  function voiceEmotions(name) {
    const voice = VOICE_INDEX.get(name);
    return voice ? voice.emotions : [];
  }

  function emotionOptionsMarkup(name, current) {
    return voiceEmotions(name)
      .map(emotion => `<option value="${escapeHtml(emotion)}" ${emotion === current ? "selected" : ""}>${escapeHtml(emotion)}</option>`)
      .join("");
  }

  function ipField(draft) {
    const groups = VOICE_GROUPS.map(([group, voices]) => `
      <optgroup label="${escapeHtml(group)}">
        ${voices.map(([name, note]) => `<option value="${escapeHtml(name)}" ${name === draft.ip ? "selected" : ""}>${escapeHtml(name)} · ${escapeHtml(note)}</option>`).join("")}
      </optgroup>
    `).join("");

    const quick = (VOICE_GROUPS[0] && VOICE_GROUPS[0][1] ? VOICE_GROUPS[0][1] : []).slice(0, 4);
    const emotions = voiceEmotions(draft.ip);
    const current = emotions.includes(draft.ipEmotion) ? draft.ipEmotion : (emotions[0] || "");
    draft.ipEmotion = current;

    return `
      <div class="field">
        <div class="field-head">
          <label for="voiceSelect">内置配音员</label>
          <span class="field-note">${VOICE_BASE_COUNT} 个音色 · ${VOICE_SOUND_COUNT} 个可选声音</span>
        </div>
        <select class="select" id="voiceSelect" data-field="ip">${groups}</select>
        <div class="voice-emotion-row" id="voiceEmotionRow"${emotions.length ? "" : " hidden"}>
          <label for="voiceEmotionSelect">情绪变体</label>
          <select class="select" id="voiceEmotionSelect" data-field="ipEmotion">${emotionOptionsMarkup(draft.ip, current)}</select>
        </div>
        <div class="tag-chips">
          <span class="chip-label">常用</span>
          ${quick.map(([name, note]) => `<button class="chip${name === draft.ip ? " is-active" : ""}" type="button" data-action="pick-voice" data-value="${escapeHtml(name)}" title="${escapeHtml(note)}">${escapeHtml(name)}</button>`).join("")}
        </div>
        <p class="field-help">官方音色表里有 62 个声音带情绪变体，必须选定情绪——后端会收到 <code>灵信远_高兴</code> 这样的完整标识，只传基名会被拒绝。</p>
      </div>
    `;
  }

  /** Swap the emotion options in place so changing the voice does not rebuild
   *  (and lose focus in) the whole form. */
  function syncVoiceEmotionField(draft) {
    const row = $("#voiceEmotionRow", dom.composerPanel);
    const select = $("#voiceEmotionSelect", dom.composerPanel);
    if (!row || !select) return;
    const emotions = voiceEmotions(draft.ip);
    row.hidden = !emotions.length;
    if (!emotions.length) {
      draft.ipEmotion = "";
      select.innerHTML = "";
      return;
    }
    const current = emotions.includes(draft.ipEmotion) ? draft.ipEmotion : emotions[0];
    draft.ipEmotion = current;
    select.innerHTML = emotionOptionsMarkup(draft.ip, current);
  }

  function languageField(task, draft) {
    const selected = draft.language || task.defaultLanguage || (task.languages && task.languages[0]) || "";
    return `
      <div class="field">
        <div class="field-head">
          <label for="languageSelect">目标语言</label>
          <span class="field-note">参考音频建议使用同一语言</span>
        </div>
        <select class="select" id="languageSelect" data-field="language">
          ${(task.languages || []).map(language => `<option value="${escapeHtml(language)}" ${language === selected ? "selected" : ""}>${escapeHtml(LANGUAGE_LABELS[language] || language)}</option>`).join("")}
        </select>
        <p class="field-help">参考文本与目标文本应保持一致的语言，以获得更稳定的发音。</p>
      </div>
    `;
  }

  function segmentedField(name, label, values, current) {
    return `
      <div class="field">
        <div class="field-head"><label>${escapeHtml(label)}</label></div>
        <div class="segmented" data-seg="${escapeHtml(name)}" role="group" aria-label="${escapeHtml(label)}">
          ${values.map(value => `<button class="${value === current ? "is-active" : ""}" type="button" data-value="${escapeHtml(value)}">${escapeHtml(value)}</button>`).join("")}
        </div>
      </div>
    `;
  }

  function basicControls(draft) {
    return `
      <div class="control-grid">
        ${segmentedField("speed", "语速", ["慢速", "中速", "快速"], draft.speed || "中速")}
        ${segmentedField("pitch", "音调", ["低", "中", "高"], draft.pitch || "中")}
        ${segmentedField("volume", "音量", ["低", "中", "高"], draft.volume || "中")}
      </div>
    `;
  }

  function emotionField(draft) {
    const selected = draft.emotion || "中性";
    return `
      <div class="field">
        <div class="field-head">
          <label>情绪</label>
          <span class="field-note">7 种可选</span>
        </div>
        <div class="emotion-grid" data-seg="emotion" role="group" aria-label="情绪">
          ${EMOTIONS.map(([name, color]) => `
            <button class="emotion-btn${name === selected ? " is-active" : ""}" type="button" data-value="${escapeHtml(name)}">
              <span class="emotion-dot" style="--dot:${color}"></span>${escapeHtml(name)}
            </button>
          `).join("")}
        </div>
      </div>
    `;
  }

  function dialectField(draft) {
    const selected = draft.dialect || "川渝话";
    const choices = [
      ["川渝话", "四川话 · 重庆话"],
      ["广粤话", "粤语 · 广府话"]
    ];
    return `
      <div class="field">
        <div class="field-head">
          <label>方言</label>
          <span class="field-note">保持参考音色</span>
        </div>
        <div class="choice-grid" data-seg="dialect" role="group" aria-label="方言">
          ${choices.map(([value, note]) => `
            <button class="choice-btn${value === selected ? " is-active" : ""}" type="button" data-value="${escapeHtml(value)}">
              <strong>${escapeHtml(value)}</strong>
              <span>${escapeHtml(note)}</span>
            </button>
          `).join("")}
        </div>
      </div>
    `;
  }

  function generateNoteInfo() {
    const available = workerAvailable();
    const total = workerTotal();
    if (state.mode === "checking") {
      return { title: "正在检测 API", sub: "首次连接可能需要几秒", tone: "" };
    }
    if (state.mode === "demo") {
      return { title: "演示模式", sub: "输出仓库内置示例音频 · 不调用 API", tone: "is-demo" };
    }
    if (state.mode === "degraded") {
      return {
        title: "部分副本可用",
        sub: `${apiHost()} · ${available != null ? `${available}/${total != null ? total : "?"}` : "已连接"} 副本`,
        tone: "is-degraded"
      };
    }
    return {
      title: state.health && state.health.model_loaded === false ? "模型加载中" : "API 已连接",
      sub: `${apiHost()}${available != null ? ` · ${available}/${total != null ? total : "?"} 副本` : ""}`,
      tone: ""
    };
  }

  function generateBarMarkup(task) {
    const note = generateNoteInfo();
    const loadingCurrent = state.generating && state.generatingTask === task.id;
    const label = state.generating
      ? (loadingCurrent ? "生成中…" : "其他任务生成中")
      : "生成语音";

    return `
      <div class="generate-bar">
        <div class="generate-note${note.tone ? ` ${note.tone}` : ""}" id="generateNote">
          <span class="generate-status-dot"></span>
          <div>
            <strong id="generateNoteTitle">${escapeHtml(note.title)}</strong>
            <small id="generateNoteSub">${escapeHtml(note.sub)}</small>
          </div>
        </div>
        <div class="generate-actions">
          <span class="shortcut">Ctrl / ⌘ + Enter</span>
          <button class="generate-btn${loadingCurrent ? " is-loading" : ""}" id="generateBtn" type="submit" ${state.generating ? "disabled" : ""}>
            <span class="btn-spinner"></span>
            ${UI.spark}
            <span class="btn-label">${label}</span>
          </button>
        </div>
      </div>
    `;
  }

  function renderComposer() {
    const task = currentTask();
    const draft = getDraft(task);
    const isDemo = state.mode === "demo";
    let sectionNo = 0;

    const addSection = (title, english, body) => {
      sectionNo += 1;
      return sectionMarkup(sectionNo, title, english, body);
    };

    let html = '<form id="generatorForm" novalidate>';
    html += addSection("文本内容", "Script", textField(task, draft));

    if (task.id === "podcast") {
      html += addSection("说话人", "Speakers", podcastField(isDemo));
    } else if (task.id === "voice_design") {
      html += addSection("声音设计", "Voice design", styleField(draft, isDemo));
    } else if (task.id === "ip") {
      html += addSection("内置配音员", "Voice cast", ipField(draft));
    } else if (task.id === "freeform") {
      html += addSection("表达指令", "Direction", instructionField(draft, isDemo));
    } else {
      html += addSection("参考音频", "Reference", referenceField(task, draft, isDemo));
    }

    let controls = "";
    let controlsTitle = "参数";
    let controlsEn = "Controls";
    if (task.languages) {
      controls += languageField(task, draft);
      controlsTitle = "语言设置";
      controlsEn = "Language";
    }
    if (task.id === "basic") {
      controls += basicControls(draft);
      controlsTitle = "语速 · 音调 · 音量";
      controlsEn = "Performance";
    }
    if (task.id === "emotion") {
      controls += emotionField(draft);
      controlsTitle = "情绪";
      controlsEn = "Emotion";
    }
    if (task.id === "dialect") {
      controls += dialectField(draft);
      controlsTitle = "方言";
      controlsEn = "Dialect";
    }
    if (controls) html += addSection(controlsTitle, controlsEn, controls);

    html += generateBarMarkup(task);
    html += "</form>";

    dom.composerPanel.innerHTML = html;
    bindComposerUploads(task);
    updateTextMeta();
    syncMiniIcons();
    updateMiniUI();
  }

  function updateTextMeta() {
    const task = currentTask();
    const input = $("#textInput", dom.composerPanel);
    if (!input) return;
    const meta = $("#textMeta");
    if (meta) meta.textContent = textMetaText(task, input.value);
    const coverage = $("#podcastCoverage");
    if (coverage) coverage.textContent = podcastCoverage(input.value);
  }

  function bindComposerUploads(task) {
    $$("[data-ref-zone]", dom.composerPanel).forEach(zone => {
      const input = $("[data-ref-input]", zone);
      bindDropZone(zone, input, file => uploadReference(task, file, zone));
    });

    $$("[data-speaker-zone]", dom.composerPanel).forEach(zone => {
      const index = Number(zone.dataset.speakerZone);
      const input = $("[data-speaker-input]", zone);
      bindDropZone(zone, input, file => uploadSpeaker(task, index, file, zone));
    });
  }

  function bindDropZone(zone, input, onFile) {
    if (!zone || !input) return;
    const openPicker = () => {
      if (state.mode === "demo") {
        showDemoUploadHint();
        return;
      }
      input.click();
    };

    zone.addEventListener("click", event => {
      if (event.target.closest("input")) return;
      openPicker();
    });
    zone.addEventListener("keydown", event => {
      if (event.key === "Enter" || event.key === " ") {
        event.preventDefault();
        openPicker();
      }
    });
    ["dragenter", "dragover"].forEach(type => {
      zone.addEventListener(type, event => {
        event.preventDefault();
        zone.classList.add("is-dragging");
      });
    });
    zone.addEventListener("dragleave", () => zone.classList.remove("is-dragging"));
    zone.addEventListener("drop", event => {
      event.preventDefault();
      zone.classList.remove("is-dragging");
      if (state.mode === "demo") {
        showDemoUploadHint();
        return;
      }
      const file = event.dataTransfer && event.dataTransfer.files && event.dataTransfer.files[0];
      if (file) onFile(file);
    });
    input.addEventListener("change", () => {
      const file = input.files && input.files[0];
      input.value = "";
      if (file) onFile(file);
    });
  }

  function showDemoUploadHint() {
    toast("演示模式无法上传，请先连接 API。", "info");
    openSettings();
  }

  function validateAudioFile(file) {
    if (!file) return "请选择音频文件。";
    const ext = String(file.name || "").split(".").pop().toLowerCase();
    if (!["wav", "mp3", "flac"].includes(ext)) {
      return "仅支持 WAV、MP3、FLAC 格式。";
    }
    if (!file.size) return "文件为空，请重新选择。";
    if (file.size > 50 * 1024 * 1024) return "文件不能超过 50 MB。";
    return "";
  }

  function markZoneBusy(zone, busy) {
    if (!zone) return;
    const title = zone.querySelector("strong");
    const action = zone.querySelector(".upload-action");
    if (busy) {
      if (title) {
        zone.dataset.idleLabel = title.textContent || "";
        title.textContent = "正在上传…";
      }
      if (action) {
        zone.dataset.idleAction = action.textContent || "";
        action.textContent = "上传中…";
      }
      zone.classList.add("is-loading");
      zone.setAttribute("aria-busy", "true");
    } else {
      if (title && zone.dataset.idleLabel) title.textContent = zone.dataset.idleLabel;
      if (action && zone.dataset.idleAction) action.textContent = zone.dataset.idleAction;
      zone.classList.remove("is-loading");
      zone.removeAttribute("aria-busy");
      // The saved label was captured before the request; if the connection
      // flipped to demo mode meanwhile, restoring it would advertise an upload
      // path that no longer works. Re-apply the mode-aware copy instead.
      updateComposerModeCopy();
    }
  }

  async function uploadReference(task, file, zone) {
    const problem = validateAudioFile(file);
    if (problem) {
      toast(problem, "error");
      return;
    }
    markZoneBusy(zone, true);
    try {
      const payload = await client.upload(file);
      state.refs[task.id] = payload;
      if (state.taskId === task.id) renderComposer();
      refreshLibraryCount();
      if (state.modal === "library") refreshLibrary();
      toast(`参考音频「${payload.original_name || file.name}」已上传。`, "success");
    } catch (error) {
      markZoneBusy(zone, false);
      toast(error.message || "上传失败", "error", 5200);
      if (/无法连接|超时/.test(error.message || "")) refreshHealth({ silent: true });
    }
  }

  async function uploadSpeaker(task, index, file, zone) {
    const speaker = state.podcast[index];
    if (!speaker) return;
    const problem = validateAudioFile(file);
    if (problem) {
      toast(problem, "error");
      return;
    }
    markZoneBusy(zone, true);
    try {
      const payload = await client.upload(file);
      speaker.upload = payload;
      if (state.taskId === task.id) renderComposer();
      refreshLibraryCount();
      if (state.modal === "library") refreshLibrary();
      toast(`角色 ${index + 1} 的参考音频已上传。`, "success");
    } catch (error) {
      markZoneBusy(zone, false);
      toast(error.message || "上传失败", "error", 5200);
      if (/无法连接|超时/.test(error.message || "")) refreshHealth({ silent: true });
    }
  }

  function handleComposerInput(event) {
    const fieldInput = event.target.closest("[data-field]");
    if (fieldInput) {
      const draft = getDraft(currentTask());
      draft[fieldInput.dataset.field] = fieldInput.value;
      if (fieldInput.dataset.field === "ip") {
        syncVoiceEmotionField(draft);
        $$("[data-action='pick-voice']", dom.composerPanel).forEach(button => {
          button.classList.toggle("is-active", button.dataset.value === draft.ip);
        });
      }
      if (fieldInput.id === "textInput") updateTextMeta();
      return;
    }
    const speakerInput = event.target.closest("[data-speaker-text]");
    if (speakerInput) {
      const index = Number(speakerInput.dataset.speakerText);
      if (state.podcast[index]) state.podcast[index].text = speakerInput.value;
      updateTextMeta();
    }
  }

  function insertTag(button) {
    const textarea = $("#textInput", dom.composerPanel);
    if (!textarea) return;
    const tag = button.dataset.tag || "";
    const start = typeof textarea.selectionStart === "number" ? textarea.selectionStart : textarea.value.length;
    const end = typeof textarea.selectionEnd === "number" ? textarea.selectionEnd : start;
    const before = textarea.value.slice(0, start);
    const leading = before && !/\s$/.test(before) ? " " : "";
    textarea.setRangeText(`${leading}${tag} `, start, end, "end");
    getDraft(currentTask()).text = textarea.value;
    updateTextMeta();
    textarea.focus();
  }

  function appendPreset(button) {
    const target = button.dataset.target === "style" ? "style" : "instruction";
    const text = button.dataset.text || "";
    if (!text) return;
    const draft = getDraft(currentTask());
    const existing = String(draft[target] || "").trim();
    draft[target] = existing ? `${existing.replace(/[。；;，,\s]+$/, "")}。${text}` : text;
    const textarea = $(`[data-field="${target}"]`, dom.composerPanel);
    if (textarea) {
      textarea.value = draft[target];
      textarea.focus();
      textarea.setSelectionRange(textarea.value.length, textarea.value.length);
    }
  }

  function fillExample() {
    const task = currentTask();
    const draft = getDraft(task);
    let exampleText = task.examples && task.examples.text ? task.examples.text : "";
    if (task.id === "podcast") {
      const count = state.podcast.length;
      const lines = PODCAST_EXAMPLE_LINES.slice(0, count === 2 ? 4 : 8);
      if (lines.length) {
        exampleText = lines.map((line, index) => `speaker_${(index % count) + 1}: ${line}`).join("\n");
      }
    }
    draft.text = exampleText;
    if (task.examples && task.examples.instruction) draft.instruction = task.examples.instruction;
    if (task.examples && task.examples.style) draft.style = task.examples.style;
    renderComposer();
    const textarea = $("#textInput", dom.composerPanel);
    if (textarea) {
      textarea.focus();
      textarea.setSelectionRange(textarea.value.length, textarea.value.length);
    }
    toast("已填入示例内容，可以直接生成。", "success");
  }

  function handleComposerClick(event) {
    const actionButton = event.target.closest("[data-action]");
    if (actionButton) {
      const action = actionButton.dataset.action;
      if (action === "fill-example") {
        fillExample();
        return;
      }
      if (action === "append-preset") {
        appendPreset(actionButton);
        return;
      }
      if (action === "pick-voice") {
        const value = actionButton.dataset.value;
        const draft = getDraft(currentTask());
        draft.ip = value;
        const select = $("#voiceSelect", dom.composerPanel);
        if (select) select.value = value;
        syncVoiceEmotionField(draft);
        $$("[data-action='pick-voice']", dom.composerPanel).forEach(button => {
          button.classList.toggle("is-active", button.dataset.value === value);
        });
        return;
      }
    }

    const tagButton = event.target.closest("[data-tag]");
    if (tagButton) {
      insertTag(tagButton);
      return;
    }

    const segmentButton = event.target.closest("[data-seg] button[data-value]");
    if (segmentButton) {
      const group = segmentButton.closest("[data-seg]");
      const draft = getDraft(currentTask());
      draft[group.dataset.seg] = segmentButton.dataset.value;
      $$("button[data-value]", group).forEach(button => {
        button.classList.toggle("is-active", button === segmentButton);
      });
      return;
    }

    const addSpeaker = event.target.closest("[data-add-speaker]");
    if (addSpeaker) {
      if (state.podcast.length >= 4) return;
      state.podcast.push(createSpeaker());
      renderComposer();
      const inputs = $$("[data-speaker-text]", dom.composerPanel);
      if (inputs.length) inputs[inputs.length - 1].focus();
      return;
    }

    const removeSpeaker = event.target.closest("[data-remove-speaker]");
    if (removeSpeaker) {
      const index = Number(removeSpeaker.dataset.removeSpeaker);
      if (state.podcast.length <= 2 || Number.isNaN(index)) return;
      const speaker = state.podcast[index];
      if (speaker && speaker.upload && state.miniSrc === mediaUrl(speaker.upload)) stopMiniAudio();
      state.podcast.splice(index, 1);
      renderComposer();
      return;
    }

    const clearSpeaker = event.target.closest("[data-speaker-clear]");
    if (clearSpeaker) {
      const index = Number(clearSpeaker.dataset.speakerClear);
      const speaker = state.podcast[index];
      if (!speaker) return;
      if (speaker.upload && state.miniSrc === mediaUrl(speaker.upload)) stopMiniAudio();
      speaker.upload = null;
      renderComposer();
      return;
    }

    const clearRef = event.target.closest("[data-clear-ref]");
    if (clearRef) {
      const task = currentTask();
      const upload = state.refs[task.id];
      if (upload && state.miniSrc === mediaUrl(upload)) stopMiniAudio();
      delete state.refs[task.id];
      renderComposer();
    }
  }

  /* ---------------- Generation ---------------- */

  /** Parse "speaker_N:" script lines. Accepts both ASCII and full-width colons. */
  function parsePodcastScript(text) {
    const lines = String(text || "").split(/\r?\n/).filter(line => line.trim());
    if (!lines.length) throw new Error("请先输入对话脚本。");
    const speakerIds = new Set();
    for (const line of lines) {
      const match = line.match(PODCAST_LINE_RE);
      if (!match) throw new Error("脚本每一行都必须以 speaker_N: 开头。");
      speakerIds.add(Number(match[1]));
    }
    return speakerIds;
  }

  function assertContiguousSpeakers(speakerIds, count) {
    const expected = new Set(Array.from({ length: count }, (_, index) => index + 1));
    const valid = speakerIds.size === expected.size && Array.from(expected).every(id => speakerIds.has(id));
    if (!valid) throw new Error(`脚本需要覆盖 speaker_1 到 speaker_${count}。`);
  }

  function buildRequest(task) {
    const draft = getDraft(task);
    const text = String(draft.text || "").trim();
    if (!text) throw new Error("请先输入目标文本。");

    const demo = state.mode === "demo";
    const request = { task: task.id, text };

    if (task.id === "podcast") {
      const speakerIds = parsePodcastScript(text);
      if (demo) {
        // No uploads in demo mode, but the script itself still has to be valid —
        // otherwise the UI claims success on input a real gateway would reject.
        assertContiguousSpeakers(speakerIds, Math.max(1, ...speakerIds));
        return request;
      }

      if (state.podcast.length < 2) throw new Error("多人对话至少需要 2 位说话人。");
      assertContiguousSpeakers(speakerIds, state.podcast.length);

      const promptWavs = [];
      const promptTexts = [];
      state.podcast.forEach((speaker, index) => {
        if (!speaker.upload) throw new Error(`请上传角色 ${index + 1} 的参考音频。`);
        if (!speaker.text.trim()) throw new Error(`请填写角色 ${index + 1} 的参考文本。`);
        promptWavs.push(speakerReference(speaker.upload));
        promptTexts.push(speaker.text.trim());
      });

      request.prompt_wav = promptWavs;
      request.prompt_text = promptTexts;
      return request;
    }

    if (task.id === "freeform") {
      const instruction = String(draft.instruction || "").trim();
      if (!instruction && !demo) throw new Error("请填写表达指令。");
      if (instruction) request.instruction = instruction;
      return request;
    }

    if (task.ref === "required" && !demo) {
      if (!state.refs[task.id]) throw new Error("请先上传参考音频。");
      request.prompt_wav = speakerReference(state.refs[task.id]);
    }

    if (task.promptText && !demo) {
      const promptText = String(draft.promptText || "").trim();
      if (!promptText) throw new Error("请填写与参考音频一致的参考文本。");
      request.prompt_text = promptText;
    }

    if (task.languages) {
      request.target_language = draft.language || task.defaultLanguage || task.languages[0];
    }
    if (task.id === "basic") {
      request.speed = draft.speed || "中速";
      request.pitch = draft.pitch || "中";
      request.volume = draft.volume || "中";
    }
    if (task.id === "emotion") request.emotion = draft.emotion || "中性";
    if (task.id === "dialect") request.dialect = draft.dialect || "川渝话";
    if (task.id === "voice_design") {
      const style = String(draft.style || "").trim();
      if (!style && !demo) throw new Error("请填写声音描述。");
      if (style) request.style = style;
    }
    if (task.id === "ip") {
      const base = draft.ip || "灵小柔";
      const emotions = voiceEmotions(base);
      if (emotions.length) {
        const emotion = emotions.includes(draft.ipEmotion) ? draft.ipEmotion : emotions[0];
        request.ip = `${base}_${emotion}`;
      } else {
        request.ip = base;
      }
    }

    return request;
  }

  function focusValidationTarget(message) {
    let selector = "";
    if (message.includes("参考文本")) selector = "#promptTextInput";
    else if (message.includes("参考音频") || message.includes("说话人")) selector = "[data-ref-zone], [data-speaker-zone]";
    else if (message.includes("指令")) selector = "#instructionInput";
    else if (message.includes("声音描述")) selector = "#styleInput";
    else if (message.includes("文本")) selector = "#textInput";
    const target = selector ? $(selector, dom.composerPanel) : null;
    if (!target) return;
    target.scrollIntoView({ block: "center", behavior: scrollBehavior() });
    window.setTimeout(() => target.focus({ preventScroll: true }), 160);
  }

  function updateGenerateButton() {
    const button = $("#generateBtn", dom.composerPanel);
    if (!button) return;
    const current = state.generating && state.generatingTask === state.taskId;
    button.disabled = state.generating;
    button.classList.toggle("is-loading", current);
    const label = $(".btn-label", button);
    if (label) {
      label.textContent = state.generating
        ? (current ? "生成中…" : "其他任务生成中")
        : "生成语音";
    }
    const form = $("#generatorForm", dom.composerPanel);
    if (form) form.setAttribute("aria-busy", state.generating ? "true" : "false");
  }

  function updateElapsed() {
    const chip = $("#elapsedChip");
    if (!chip) return;
    const seconds = Math.max(0, (performance.now() - state.startedAt) / 1000);
    chip.textContent = `已用时 ${seconds.toFixed(1)} s`;
  }

  function startElapsedTimer() {
    stopElapsedTimer();
    updateElapsed();
    state.elapsedTimer = window.setInterval(updateElapsed, 100);
  }

  function stopElapsedTimer() {
    if (state.elapsedTimer) {
      window.clearInterval(state.elapsedTimer);
      state.elapsedTimer = 0;
    }
  }

  function delay(ms) {
    return new Promise(resolve => window.setTimeout(resolve, ms));
  }

  async function hydrateAudioMeta(result) {
    if (result.duration && result.sampleRate) return;
    try {
      const meta = readWavMeta(await result.blob.arrayBuffer());
      if (!result.duration && meta.duration) result.duration = meta.duration;
      if (!result.sampleRate && meta.sampleRate) result.sampleRate = meta.sampleRate;
    } catch (error) {
      /* Duration also self-heals from the audio element's metadata. */
    }
  }

  async function handleGenerate() {
    if (state.generating) {
      toast("已有任务正在生成，请稍候。", "info");
      return;
    }

    const task = currentTask();
    let request;
    try {
      request = buildRequest(task);
    } catch (error) {
      toast(error.message || "请检查生成参数。", "error");
      focusValidationTarget(error.message || "");
      return;
    }

    closeSidebar();
    const demoMode = state.mode === "demo";
    state.generating = true;
    state.generatingTask = task.id;
    state.startedAt = performance.now();
    state.resultAudio.pause();
    startElapsedTimer();
    updateGenerateButton();
    renderOutput();

    let generated = false;
    try {
      let outcome;
      if (demoMode) {
        await delay(1200);
        outcome = await client.demoGenerate();
      } else {
        outcome = await client.generate(request);
      }

      const elapsed = Math.max(0.1, (performance.now() - state.startedAt) / 1000);
      const result = {
        blob: outcome.blob,
        duration: Number(outcome.duration) || 0,
        sampleRate: Number(outcome.sampleRate) || 0,
        taskId: task.id,
        demo: demoMode,
        createdAt: new Date(),
        elapsed,
        text: request.text,
        request
      };
      await hydrateAudioMeta(result);
      result.audioUrl = URL.createObjectURL(result.blob);

      const previous = state.results[task.id];
      if (previous && previous.audioUrl) URL.revokeObjectURL(previous.audioUrl);
      state.results[task.id] = result;
      generated = true;
    } catch (error) {
      let message = error.message || "生成失败，请稍后重试。";
      if (/无法连接|请求超时|Failed to fetch|NetworkError/i.test(message)) {
        await refreshHealth({ silent: true });
        if (state.mode === "demo") message += " 已切换为演示模式，可再次点击生成示例音频。";
      }
      toast(message, "error", 6200);
    } finally {
      state.generating = false;
      state.generatingTask = null;
      stopElapsedTimer();
      updateGenerateButton();

      if (state.taskId === task.id) {
        renderOutput({ autoplay: generated });
        if (generated) toast(demoMode ? "演示音频已就绪。" : "语音生成完成。", demoMode ? "info" : "success");
      } else if (generated) {
        toast(`「${task.name}」已生成，切换到该任务即可试听。`, "success");
      }
    }
  }

  /* ---------------- Output panel ---------------- */

  function setOutputState(label, className) {
    dom.outputState.textContent = label;
    dom.outputState.className = `state-chip${className ? ` ${className}` : ""}`;
  }

  function emptyDescription(task) {
    if (task.id === "ip") return "选择一个内置声音，输入文本，然后点击生成语音。";
    if (task.id === "voice_design") return "描述你想要的声音，模型会用文字把它创造出来。";
    if (task.id === "podcast") return "为每位说话人准备参考音频，写下一段多角色对话。";
    if (task.ref === "required") return "上传一段参考音频，填写文本，然后点击生成语音。";
    return "输入文本并选择声音，生成结果会出现在这里。";
  }

  function emptyOutputMarkup(task) {
    return `
      <div class="output-empty">
        <div class="output-art">
          <span class="art-pulse"></span>
          ${UI.wave}
        </div>
        <h3>等待你的第一段声音</h3>
        <p>${escapeHtml(emptyDescription(task))}</p>
        <div class="empty-hints">
          <span>${escapeHtml(task.en)}</span>
          <span>44.1 kHz</span>
          <span>Mono</span>
          <span>WAV</span>
        </div>
      </div>
    `;
  }

  function loadingOutputMarkup(task) {
    return `
      <div class="output-loading">
        <div class="eq" aria-hidden="true">
          <span></span><span></span><span></span><span></span><span></span><span></span><span></span>
        </div>
        <h3>正在合成「${escapeHtml(task.name)}」</h3>
        <p>${state.mode === "demo" ? "正在准备内置示例音频，不会调用 API。" : "模型正在推理，通常需要几秒到十几秒。"}</p>
        <span class="elapsed-chip" id="elapsedChip">已用时 0.0 s</span>
      </div>
    `;
  }

  function resultMarkup(task, result) {
    const durationText = formatSeconds(result.duration) || "—";
    const note = result.demo
      ? "演示模式：播放的是仓库内置示例音频，并非当前文本的真实合成结果。"
      : `文本 · ${truncate(result.text, 76)}`;

    return `
      <div class="result-content">
        <div class="result-topline">
          <div class="result-badges">
            <span class="badge badge-wav">WAV</span>
            ${result.sampleRate ? `<span class="badge badge-ok">${escapeHtml(formatSampleRate(result.sampleRate))}</span>` : ""}
            ${result.demo ? '<span class="badge badge-demo">演示音频</span>' : ""}
          </div>
          <span class="result-clock">${escapeHtml(formatClockOfDay(result.createdAt))}</span>
        </div>

        <div class="player-card">
          <div class="player-top">
            <button class="play-btn" id="playBtn" type="button" aria-label="播放">${UI.play}</button>
            <div class="player-main">
              <canvas class="waveform" id="waveCanvas" width="640" height="116" role="slider" tabindex="0" aria-label="音频播放进度" aria-valuemin="0" aria-valuemax="${Math.max(0, Math.round(result.duration || 0))}" aria-valuenow="0"></canvas>
              <div class="player-times">
                <span class="current" id="currentTime">0:00</span>
                <span id="totalTime">${formatClock(result.duration)}</span>
              </div>
            </div>
          </div>
        </div>

        <div class="result-meta">
          <div class="meta-cell"><span>时长</span><strong id="metaDuration">${escapeHtml(durationText)}</strong></div>
          <div class="meta-cell"><span>采样率</span><strong>${escapeHtml(formatSampleRate(result.sampleRate))}</strong></div>
          <div class="meta-cell"><span>任务</span><strong>${escapeHtml(task.name)}</strong></div>
          <div class="meta-cell"><span>耗时</span><strong>${escapeHtml(formatElapsed(result.elapsed))}</strong></div>
        </div>

        <div class="result-actions">
          <button class="btn lime wide" id="downloadBtn" type="button">${UI.download}<span>下载 WAV</span></button>
          <button class="btn ghost wide" id="regenerateBtn" type="button">${UI.refresh}<span>再生成</span></button>
        </div>
        <p class="result-note${result.demo ? " is-demo" : ""}">${escapeHtml(note)}</p>
      </div>
    `;
  }

  function renderOutput(options = {}) {
    const task = currentTask();
    const loading = state.generating && state.generatingTask === task.id;
    dom.outputBody.setAttribute("aria-busy", loading ? "true" : "false");

    if (loading) {
      state.resultAudio.pause();
      state.playerTaskId = "";
      dom.outputBody.innerHTML = loadingOutputMarkup(task);
      setOutputState("合成中", "is-loading");
      updateElapsed();
      return;
    }

    const result = state.results[task.id];
    if (result) {
      dom.outputBody.innerHTML = resultMarkup(task, result);
      setOutputState(result.demo ? "演示音频" : "已完成", result.demo ? "is-demo" : "is-ready");
      setupResultPlayer(result, !!options.autoplay);
      return;
    }

    resetResultAudio();
    dom.outputBody.innerHTML = emptyOutputMarkup(task);
    setOutputState("待生成", "");
  }

  function resetResultAudio() {
    if (!state.resultAudio) return;
    state.resultAudio.pause();
    state.resultAudio.removeAttribute("src");
    state.resultAudio.load();
    state.playerTaskId = "";
    syncResultPlayIcon();
  }

  function setupResultPlayer(result, autoplay) {
    const audio = state.resultAudio;
    audio.pause();
    audio.src = result.audioUrl;
    audio.load();
    state.playerTaskId = result.taskId;

    const total = $("#totalTime");
    if (total) total.textContent = formatClock(result.duration);
    const current = $("#currentTime");
    if (current) current.textContent = "0:00";
    syncResultPlayIcon();

    const canvas = $("#waveCanvas");
    if (canvas) {
      drawWaveform(canvas, placeholderPeaks(result), 0);
      decodeResultPeaks(result, canvas);
      canvas.addEventListener("click", event => seekFromPointer(event, canvas));
      canvas.addEventListener("keydown", event => handleCanvasKey(event, canvas));
    }

    if (autoplay) {
      pauseMiniAudio();
      attemptPlay(audio, true);
    }
  }

  function placeholderPeaks(result) {
    if (result.placeholderPeaks) return result.placeholderPeaks;
    let seed = 0;
    String(result.taskId || "ming").split("").forEach(ch => { seed += ch.charCodeAt(0); });
    seed += Math.round((result.elapsed || 1) * 10);
    const peaks = [];
    for (let index = 0; index < 160; index += 1) {
      const slow = Math.abs(Math.sin((index + seed) * 0.21));
      const fast = Math.abs(Math.sin((index + seed) * 1.37));
      peaks.push(0.16 + Math.min(0.8, slow * 0.58 + fast * 0.26));
    }
    result.placeholderPeaks = peaks;
    return peaks;
  }

  function getAudioContext() {
    if (state.audioContext) return state.audioContext;
    const AudioContextClass = window.AudioContext || window.webkitAudioContext;
    if (!AudioContextClass) return null;
    try {
      state.audioContext = new AudioContextClass();
    } catch (error) {
      state.audioContext = null;
    }
    return state.audioContext;
  }

  async function decodeResultPeaks(result, canvas) {
    if (result.peaks || result.peaksPending) return;
    result.peaksPending = true;
    try {
      const context = getAudioContext();
      if (!context) return;
      const buffer = await result.blob.arrayBuffer();
      const audioBuffer = await new Promise((resolve, reject) => {
        context.decodeAudioData(buffer, resolve, reject);
      });
      const channel = audioBuffer.getChannelData(0);
      const count = 160;
      const bucket = Math.max(1, Math.floor(channel.length / count));
      const peaks = [];
      let maximum = 0;
      for (let index = 0; index < count; index += 1) {
        let peak = 0;
        const start = index * bucket;
        const end = Math.min(channel.length, start + bucket);
        for (let cursor = start; cursor < end; cursor += 1) {
          const value = Math.abs(channel[cursor]);
          if (value > peak) peak = value;
        }
        peaks.push(peak);
        if (peak > maximum) maximum = peak;
      }
      result.peaks = maximum > 0 ? peaks.map(peak => peak / maximum) : peaks;
      if (canvas.isConnected && state.results[state.taskId] === result) updateResultProgress();
    } catch (error) {
      /* The decorative placeholder stays if decoding is unavailable. */
    } finally {
      result.peaksPending = false;
    }
  }

  function drawWaveform(canvas, peaks, progress) {
    const width = Math.max(220, Math.round(canvas.clientWidth || canvas.getBoundingClientRect().width || 320));
    const height = Math.max(40, Math.round(canvas.clientHeight || 58));
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    if (canvas.width !== Math.round(width * dpr) || canvas.height !== Math.round(height * dpr)) {
      canvas.width = Math.round(width * dpr);
      canvas.height = Math.round(height * dpr);
    }

    const context = canvas.getContext("2d");
    context.setTransform(dpr, 0, 0, dpr, 0, 0);
    context.clearRect(0, 0, width, height);

    const bars = Math.max(32, Math.min(peaks.length, Math.floor(width / 4)));
    const step = peaks.length / bars;
    const barWidth = Math.max(1.5, width / bars - 2.2);
    const center = height / 2;
    const played = Math.max(0, Math.min(1, progress || 0));

    const gradient = context.createLinearGradient(0, 0, width, 0);
    gradient.addColorStop(0, "rgba(214, 243, 106, 0.92)");
    gradient.addColorStop(0.6, "rgba(174, 238, 122, 0.92)");
    gradient.addColorStop(1, "rgba(116, 231, 208, 0.92)");

    for (let index = 0; index < bars; index += 1) {
      const value = peaks[Math.min(peaks.length - 1, Math.floor(index * step))] || 0.05;
      const barHeight = Math.max(2, value * (height - 12));
      const x = index * (width / bars);
      const isPlayed = (index + 0.5) / bars <= played;
      context.fillStyle = isPlayed ? gradient : "rgba(232, 242, 226, 0.13)";
      if (typeof context.roundRect === "function") {
        context.beginPath();
        context.roundRect(x, center - barHeight, barWidth, barHeight * 2, Math.min(barWidth / 2, 1.4));
        context.fill();
      } else {
        context.fillRect(x, center - barHeight, barWidth, barHeight * 2);
      }
    }
  }

  function updateResultProgress() {
    const canvas = $("#waveCanvas");
    const result = state.results[state.taskId];
    if (!canvas || !result) return;
    const audio = state.resultAudio;
    const duration = Number(audio.duration) || Number(result.duration) || 0;
    const current = Number(audio.currentTime) || 0;
    const progress = duration > 0 ? Math.min(1, current / duration) : 0;

    const currentLabel = $("#currentTime");
    if (currentLabel) currentLabel.textContent = formatClock(current);
    const totalLabel = $("#totalTime");
    if (totalLabel && duration > 0) totalLabel.textContent = formatClock(duration);

    canvas.setAttribute("aria-valuenow", String(Math.round(current)));
    canvas.setAttribute("aria-valuemax", String(Math.max(0, Math.round(duration))));
    canvas.setAttribute("aria-valuetext", `${formatClock(current)} / ${formatClock(duration)}`);
    drawWaveform(canvas, result.peaks || placeholderPeaks(result), progress);
  }

  function seekFromPointer(event, canvas) {
    const result = state.results[state.taskId];
    if (!result) return;
    const duration = Number(state.resultAudio.duration) || Number(result.duration) || 0;
    if (!duration) return;
    const rect = canvas.getBoundingClientRect();
    if (!rect.width) return;
    const ratio = Math.max(0, Math.min(1, (event.clientX - rect.left) / rect.width));
    state.resultAudio.currentTime = ratio * duration;
    updateResultProgress();
  }

  function handleCanvasKey(event, canvas) {
    const result = state.results[state.taskId];
    if (!result) return;
    const duration = Number(state.resultAudio.duration) || Number(result.duration) || 0;
    if (!duration) return;
    let target = state.resultAudio.currentTime;
    if (event.key === "ArrowRight") target += 5;
    else if (event.key === "ArrowLeft") target -= 5;
    else if (event.key === "Home") target = 0;
    else if (event.key === "End") target = duration;
    else if (event.key === " " || event.key === "Enter") {
      event.preventDefault();
      toggleResultAudio();
      return;
    } else {
      return;
    }
    event.preventDefault();
    state.resultAudio.currentTime = Math.max(0, Math.min(duration, target));
    updateResultProgress();
  }

  function syncResultPlayIcon() {
    const button = $("#playBtn");
    if (!button) return;
    const playing = !!state.playerTaskId && !state.resultAudio.paused && !state.resultAudio.ended;
    button.innerHTML = playing ? UI.pause : UI.play;
    // Preserve the file name written by miniPlayerMarkup, otherwise five
    // players on one page all announce themselves as "播放".
    const current = button.getAttribute("aria-label") || "";
    const name = current.replace(/^(播放|暂停)\s*/, "").trim() || "音频";
    button.setAttribute("aria-label", `${playing ? "暂停" : "播放"} ${name}`);
  }

  function attemptPlay(audio, quiet) {
    try {
      const promise = audio.play();
      if (promise && typeof promise.catch === "function") {
        promise.catch(error => {
          if (quiet || error.name === "NotAllowedError" || error.name === "AbortError") return;
          toast("无法播放音频，请重试。", "error");
        });
      }
    } catch (error) {
      if (!quiet) toast("无法播放音频，请重试。", "error");
    }
  }

  function pauseResultAudio() {
    if (state.resultAudio && !state.resultAudio.paused) state.resultAudio.pause();
    syncResultPlayIcon();
  }

  function toggleResultAudio() {
    const result = state.results[state.taskId];
    if (!result || !state.playerTaskId) return;
    const audio = state.resultAudio;
    if (audio.ended || (audio.duration && audio.currentTime >= audio.duration - 0.01)) {
      audio.currentTime = 0;
    }
    if (audio.paused) {
      pauseMiniAudio();
      attemptPlay(audio, false);
    } else {
      audio.pause();
    }
  }

  function downloadResult() {
    const task = currentTask();
    const result = state.results[task.id];
    if (!result) return;
    const link = document.createElement("a");
    link.href = result.audioUrl;
    link.download = `ming-${task.id}${result.demo ? "-demo" : ""}-${timestampForFile(new Date())}.wav`;
    document.body.appendChild(link);
    link.click();
    link.remove();
    toast("音频已开始下载。", "success");
  }

  function bindAudioEvents() {
    const resultAudio = state.resultAudio;
    resultAudio.addEventListener("timeupdate", () => {
      if (!state.playerTaskId) return;
      updateResultProgress();
    });
    resultAudio.addEventListener("loadedmetadata", () => {
      if (!state.playerTaskId) return;
      const result = state.results[state.playerTaskId];
      if (result && (!result.duration || result.duration <= 0) && Number.isFinite(resultAudio.duration)) {
        result.duration = resultAudio.duration;
        const meta = $("#metaDuration");
        if (meta) meta.textContent = formatSeconds(result.duration) || "—";
      }
      updateResultProgress();
    });
    resultAudio.addEventListener("play", () => {
      pauseMiniAudio();
      syncResultPlayIcon();
    });
    resultAudio.addEventListener("pause", syncResultPlayIcon);
    resultAudio.addEventListener("ended", () => {
      syncResultPlayIcon();
      updateResultProgress();
    });
    resultAudio.addEventListener("error", () => {
      if (!state.playerTaskId || !resultAudio.src) return;
      toast("音频播放失败，请重新生成。", "error");
    });

    const mini = state.miniAudio;
    mini.addEventListener("timeupdate", updateMiniUI);
    mini.addEventListener("play", () => {
      syncMiniIcons();
      updateMiniUI();
    });
    mini.addEventListener("pause", () => {
      syncMiniIcons();
      updateMiniUI();
    });
    mini.addEventListener("ended", () => {
      syncMiniIcons();
      updateMiniUI();
    });
    mini.addEventListener("loadedmetadata", updateMiniUI);
  }

  /* ---------------- Mini audio players ---------------- */

  function syncMiniIcons() {
    $$(".mini-player").forEach(player => {
      const isActive = !!state.miniSrc && player.dataset.miniSrc === state.miniSrc;
      const playing = isActive && !state.miniAudio.paused && !state.miniAudio.ended;
      const button = $(".mini-play", player);
      if (button) {
        button.innerHTML = playing ? UI.pause : UI.play;
        button.setAttribute("aria-label", playing ? "暂停" : "播放");
      }
    });
  }

  function updateMiniUI() {
    if (!state.miniSrc) return;
    const audio = state.miniAudio;
    const hasDuration = Number.isFinite(audio.duration) && audio.duration > 0;
    const current = Number(audio.currentTime) || 0;
    $$(".mini-player").forEach(player => {
      if (player.dataset.miniSrc !== state.miniSrc) return;
      const fallback = Number(player.dataset.miniDuration) || 0;
      const total = hasDuration ? audio.duration : fallback;
      const fill = $(".mini-fill", player);
      if (fill) fill.style.width = total ? `${Math.min(100, (current / total) * 100).toFixed(2)}%` : "0%";
      const time = $(".mini-time", player);
      if (time) {
        const showCurrent = current > 0 && !audio.ended;
        time.textContent = formatClock(showCurrent ? current : total);
      }
      const track = $(".mini-track", player);
      if (track) {
        track.setAttribute("aria-valuenow", String(Math.round(current)));
        track.setAttribute("aria-valuemax", String(Math.max(0, Math.round(total))));
      }
    });
  }

  function resetMiniProgress() {
    $$(".mini-player").forEach(player => {
      const fill = $(".mini-fill", player);
      if (fill) fill.style.width = "0%";
      const time = $(".mini-time", player);
      if (time) time.textContent = formatClock(Number(player.dataset.miniDuration) || 0);
      const track = $(".mini-track", player);
      if (track) track.setAttribute("aria-valuenow", "0");
    });
  }

  function pauseMiniAudio() {
    if (state.miniAudio && !state.miniAudio.paused) state.miniAudio.pause();
    syncMiniIcons();
  }

  function stopMiniAudio() {
    if (!state.miniAudio) return;
    state.miniAudio.pause();
    state.miniAudio.removeAttribute("src");
    state.miniAudio.load();
    state.miniSrc = "";
    resetMiniProgress();
    syncMiniIcons();
  }

  function toggleMini(player) {
    const src = player.dataset.miniSrc;
    if (!src || !state.miniAudio) return;
    const audio = state.miniAudio;

    if (state.miniSrc === src) {
      if (audio.ended || (audio.duration && audio.currentTime >= audio.duration - 0.01)) {
        audio.currentTime = 0;
      }
      if (audio.paused) {
        pauseResultAudio();
        attemptPlay(audio, false);
      } else {
        audio.pause();
      }
      syncMiniIcons();
      updateMiniUI();
      return;
    }

    resetMiniProgress();
    state.miniSrc = src;
    audio.src = src;
    audio.load();
    pauseResultAudio();
    attemptPlay(audio, false);
    syncMiniIcons();
    updateMiniUI();
  }

  function seekMini(player, event) {
    const src = player.dataset.miniSrc;
    if (!src) return;
    const track = $(".mini-track", player);
    if (!track) return;
    const rect = track.getBoundingClientRect();
    if (!rect.width) return;
    const ratio = Math.max(0, Math.min(1, (event.clientX - rect.left) / rect.width));
    const audio = state.miniAudio;
    const applySeek = () => {
      if (Number.isFinite(audio.duration) && audio.duration > 0) {
        audio.currentTime = ratio * audio.duration;
      }
    };

    if (state.miniSrc !== src) {
      resetMiniProgress();
      state.miniSrc = src;
      audio.src = src;
      audio.load();
      pauseResultAudio();
      audio.addEventListener("loadedmetadata", () => {
        applySeek();
        updateMiniUI();
      }, { once: true });
      attemptPlay(audio, false);
      syncMiniIcons();
    } else {
      applySeek();
      updateMiniUI();
    }
  }

  function handleMiniTrackKey(event, track) {
    const player = track.closest(".mini-player");
    if (!player) return;
    const src = player.dataset.miniSrc;
    if (!src || state.miniSrc !== src) return;
    const audio = state.miniAudio;
    if (!Number.isFinite(audio.duration) || !audio.duration) return;
    let target = audio.currentTime;
    if (event.key === "ArrowRight") target += 5;
    else if (event.key === "ArrowLeft") target -= 5;
    else if (event.key === "Home") target = 0;
    else if (event.key === "End") target = audio.duration;
    else if (event.key === " " || event.key === "Enter") {
      event.preventDefault();
      toggleMini(player);
      return;
    } else {
      return;
    }
    event.preventDefault();
    audio.currentTime = Math.max(0, Math.min(audio.duration, target));
    updateMiniUI();
  }

  /* ---------------- Audio library ---------------- */

  function setLibraryCount(count) {
    const total = Math.max(0, Number(count) || 0);
    if (dom.libraryCount) dom.libraryCount.textContent = String(total);
    updateLibraryCountLabel();
  }

  function filteredLibraryFiles() {
    const query = state.libraryQuery.trim().toLowerCase();
    if (!query) return state.libraryFiles;
    return state.libraryFiles.filter(file => {
      const name = `${file.filename || ""} ${file.original_name || ""}`.toLowerCase();
      return name.includes(query);
    });
  }

  function updateLibraryCountLabel() {
    if (!dom.libraryCountLabel) return;
    const total = state.libraryFiles.length;
    const query = state.libraryQuery.trim();
    if (query) dom.libraryCountLabel.textContent = `${filteredLibraryFiles().length} / ${total} 个文件`;
    else dom.libraryCountLabel.textContent = `${total} 个文件`;
  }

  async function refreshLibraryCount() {
    if (!client) return;
    if (state.mode === "demo") {
      setLibraryCount(0);
      return;
    }
    try {
      const payload = await client.listUploads();
      setLibraryCount(payload.count);
    } catch (error) {
      /* The library badge is best-effort; leave the last value untouched. */
    }
  }

  function libraryLoadingMarkup() {
    return `
      <div class="lib-empty">
        <strong>正在读取音频库</strong>
        <span>GET /uploads</span>
      </div>
    `;
  }

  function libraryDemoMarkup() {
    return `
      <div class="lib-empty">
        <strong>演示模式无法读取音频库</strong>
        <span>连接 API 后，这里会列出服务端已上传的参考音频，可试听、复用或删除。</span>
        <button class="btn small lime" type="button" data-open-settings>连接 API</button>
      </div>
    `;
  }

  function libraryErrorMarkup(message) {
    return `
      <div class="lib-empty is-error">
        <strong>音频库读取失败</strong>
        <span>${escapeHtml(message || "请确认 API 服务正在运行。")}</span>
        <button class="btn small ghost" type="button" data-refresh-library>重试</button>
      </div>
    `;
  }

  function libraryItemMarkup(file, index) {
    const name = displayFileName(file.filename);
    const meta = [
      formatSeconds(file.duration),
      formatSize(file.size_kb),
      file.sample_rate ? formatSampleRate(file.sample_rate) : "",
      formatShortTime(file.uploaded_at)
    ].filter(Boolean).join(" · ") || "服务端音频";
    return `
      <div class="lib-item">
        <span class="lib-index">${String(index + 1).padStart(2, "0")}</span>
        <div class="lib-main">
          <div class="lib-name" title="${escapeHtml(file.filename || name)}">${escapeHtml(name)}</div>
          <div class="lib-meta">${escapeHtml(meta)}</div>
          ${miniPlayerMarkup(client.url(file.url), file.duration, name)}
        </div>
        <button class="btn small danger-ghost" type="button" data-delete-url="${escapeHtml(file.url)}" data-delete-file="${escapeHtml(file.filename)}">删除</button>
      </div>
    `;
  }

  function renderLibrary() {
    resetPendingDelete();
    if (!dom.libraryList) return;

    if (state.mode === "demo") {
      dom.libraryList.innerHTML = libraryDemoMarkup();
      setLibraryCount(0);
      return;
    }
    if (state.libraryError) {
      dom.libraryList.innerHTML = libraryErrorMarkup(state.libraryError);
      updateLibraryCountLabel();
      return;
    }

    const files = filteredLibraryFiles();
    updateLibraryCountLabel();
    if (!state.libraryFiles.length) {
      dom.libraryList.innerHTML = `
        <div class="lib-empty">
          <strong>音频库还是空的</strong>
          <span>上传一段参考音频，就可以在这里试听、复用或删除。</span>
        </div>
      `;
      return;
    }
    if (!files.length) {
      dom.libraryList.innerHTML = `
        <div class="lib-empty">
          <strong>没有匹配的音频</strong>
          <span>换一个文件名试试，或清空搜索关键词。</span>
        </div>
      `;
      return;
    }

    dom.libraryList.innerHTML = files.map((file, index) => libraryItemMarkup(file, index)).join("");
    syncMiniIcons();
    updateMiniUI();
  }

  async function refreshLibrary() {
    if (!dom.libraryList) return;
    if (state.mode === "demo") {
      state.libraryFiles = [];
      state.libraryError = "";
      renderLibrary();
      return;
    }
    if (state.libraryLoading) return;

    state.libraryLoading = true;
    state.libraryError = "";
    dom.libraryList.innerHTML = libraryLoadingMarkup();
    if (dom.refreshLibraryBtn) dom.refreshLibraryBtn.disabled = true;

    try {
      const payload = await client.listUploads();
      state.libraryFiles = payload.files;
      state.libraryError = "";
      setLibraryCount(payload.count);
      renderLibrary();
    } catch (error) {
      state.libraryError = error.message || "请确认 API 服务正在运行。";
      renderLibrary();
    } finally {
      state.libraryLoading = false;
      if (dom.refreshLibraryBtn) dom.refreshLibraryBtn.disabled = false;
    }
  }

  function openLibrary() {
    openModal("library", () => {
      updateLibraryDemoState();
      refreshLibrary();
    });
  }

  function updateLibraryDemoState() {
    if (!dom.libraryDrop) return;
    const isDemo = state.mode === "demo";
    dom.libraryDrop.classList.toggle("is-demo", isDemo);
    const title = $(".drop-copy strong", dom.libraryDrop);
    const sub = $(".drop-copy small", dom.libraryDrop);
    if (title) title.textContent = isDemo ? "演示模式下无法上传" : "拖拽音频到这里，或点击选择";
    if (sub) sub.textContent = isDemo ? "连接 API 后可上传与管理参考音频" : "WAV / MP3 / FLAC · 最大 50 MB";
  }

  function bindLibraryDrop() {
    const drop = dom.libraryDrop;
    const input = dom.libraryFileInput;
    if (!drop || !input) return;

    const openPicker = () => {
      if (state.mode === "demo") {
        showDemoUploadHint();
        return;
      }
      input.click();
    };

    drop.addEventListener("click", event => {
      if (event.target.closest("input")) return;
      openPicker();
    });
    drop.addEventListener("keydown", event => {
      if (event.key === "Enter" || event.key === " ") {
        event.preventDefault();
        openPicker();
      }
    });
    ["dragenter", "dragover"].forEach(type => {
      drop.addEventListener(type, event => {
        event.preventDefault();
        drop.classList.add("is-dragging");
      });
    });
    drop.addEventListener("dragleave", () => drop.classList.remove("is-dragging"));
    drop.addEventListener("drop", event => {
      event.preventDefault();
      drop.classList.remove("is-dragging");
      if (state.mode === "demo") {
        showDemoUploadHint();
        return;
      }
      const file = event.dataTransfer && event.dataTransfer.files && event.dataTransfer.files[0];
      if (file) handleLibraryUpload(file);
    });
    input.addEventListener("change", () => {
      const file = input.files && input.files[0];
      input.value = "";
      if (file) handleLibraryUpload(file);
    });
  }

  async function handleLibraryUpload(file) {
    const problem = validateAudioFile(file);
    if (problem) {
      toast(problem, "error");
      return;
    }
    markZoneBusy(dom.libraryDrop, true);
    try {
      const payload = await client.upload(file);
      await refreshLibrary();
      refreshLibraryCount();
      toast(`「${payload.original_name || file.name}」已加入音频库。`, "success");
    } catch (error) {
      toast(error.message || "上传失败", "error", 5200);
      if (/无法连接|超时/.test(error.message || "")) refreshHealth({ silent: true });
    } finally {
      markZoneBusy(dom.libraryDrop, false);
    }
  }

  function resetPendingDelete() {
    if (state.pendingDeleteTimer) {
      window.clearTimeout(state.pendingDeleteTimer);
      state.pendingDeleteTimer = 0;
    }
    if (state.pendingDelete && state.pendingDelete.isConnected) {
      state.pendingDelete.dataset.armed = "";
      state.pendingDelete.textContent = "删除";
      state.pendingDelete.disabled = false;
    }
    state.pendingDelete = null;
  }

  function armDelete(button) {
    resetPendingDelete();
    state.pendingDelete = button;
    button.dataset.armed = "1";
    button.textContent = "确认删除";
    state.pendingDeleteTimer = window.setTimeout(() => {
      resetPendingDelete();
    }, 3000);
  }

  async function deleteLibraryFile(button) {
    const url = button.dataset.deleteUrl;
    const filename = button.dataset.deleteFile;
    if (!url) return;

    if (state.pendingDeleteTimer) {
      window.clearTimeout(state.pendingDeleteTimer);
      state.pendingDeleteTimer = 0;
    }
    state.pendingDelete = null;
    button.disabled = true;
    button.textContent = "删除中…";

    try {
      await client.deleteUpload(url);
      state.libraryFiles = state.libraryFiles.filter(file => file.filename !== filename);
      setLibraryCount(state.libraryFiles.length);
      clearRefsForUrl(url);
      if (state.miniSrc === client.url(url)) stopMiniAudio();
      renderLibrary();
      refreshLibraryCount();
      toast("音频已从服务端删除。", "success");
    } catch (error) {
      button.disabled = false;
      button.dataset.armed = "";
      button.textContent = "删除";
      toast(error.message || "删除失败", "error", 5200);
    }
  }

  function handleLibraryClick(event) {
    const button = event.target.closest("[data-delete-url]");
    if (!button) return;
    if (button.dataset.armed === "1") deleteLibraryFile(button);
    else armDelete(button);
  }

  function clearRefsForUrl(url) {
    let currentAffected = false;
    const task = currentTask();
    Object.keys(state.refs).forEach(id => {
      if (state.refs[id] && state.refs[id].url === url) {
        delete state.refs[id];
        if (id === task.id) currentAffected = true;
      }
    });
    state.podcast.forEach(speaker => {
      if (speaker.upload && speaker.upload.url === url) {
        speaker.upload = null;
        if (task.id === "podcast") currentAffected = true;
      }
    });
    if (currentAffected) renderComposer();
  }

  /* ---------------- Settings & connection ---------------- */

  function updateApiLabels() {
    if (!client) return;
    if (dom.apiBaseLabel) {
      dom.apiBaseLabel.textContent = client.baseUrl;
      dom.apiBaseLabel.title = client.baseUrl;
    }
    if (dom.docsLink) dom.docsLink.href = client.docsUrl();
    if (dom.apiBaseInput) dom.apiBaseInput.placeholder = client.defaultBaseUrl;
    if (dom.defaultBaseHint) {
      dom.defaultBaseHint.innerHTML = `默认地址：<code>${escapeHtml(client.defaultBaseUrl)}</code> · 当前页面：<code>${escapeHtml(window.location.origin)}</code>`;
    }
  }

  function openSettings() {
    if (state.modal === "settings") return;
    if (state.modal) closeModal(state.modal, true);
    closeSidebar();
    if (dom.connectionResult) dom.connectionResult.hidden = true;
    if (dom.testConnectionBtn) dom.testConnectionBtn.disabled = false;
    if (dom.apiBaseInput) dom.apiBaseInput.value = client.baseUrl;
    updateApiLabels();
    openModal("settings", null, dom.apiBaseInput);
  }

  function resetBaseField() {
    if (!dom.apiBaseInput) return;
    dom.apiBaseInput.value = client.defaultBaseUrl;
    if (dom.connectionResult) dom.connectionResult.hidden = true;
    dom.apiBaseInput.focus();
    dom.apiBaseInput.select();
    toast("已填入默认地址，点击「保存并连接」生效。", "info");
  }

  function showConnectionResult(kind, message) {
    if (!dom.connectionResult) return;
    dom.connectionResult.hidden = false;
    dom.connectionResult.className = `connection-result${kind ? ` is-${kind}` : ""}`;
    dom.connectionResult.textContent = message;
  }

  async function testConnection() {
    if (!dom.apiBaseInput) return;
    const raw = dom.apiBaseInput.value.trim();
    const target = normalizeBase(raw) || client.defaultBaseUrl;
    if (!isValidHttpUrl(target)) {
      showConnectionResult("error", "请输入有效的 http(s) 地址。");
      dom.apiBaseInput.focus();
      return;
    }

    const button = dom.testConnectionBtn;
    if (button) {
      button.disabled = true;
      button.textContent = "测试中…";
    }
    showConnectionResult("loading", "正在连接 API…");

    try {
      const result = await client.testConnection(target);
      if (!looksLikeMingHealth(result.payload)) {
        throw new Error("该地址返回了非 Ming TTS API 响应，请检查端口。");
      }
      const available = Number(result.payload.workers_available);
      const total = Number(result.payload.workers_total);
      const workers = Number.isFinite(available) && Number.isFinite(total)
        ? `${available}/${total} 个副本`
        : "连接正常";
      showConnectionResult("ok", `连接成功 · ${result.latency} ms · ${workers}${result.payload.model_loaded === false ? " · 模型加载中" : ""}`);
    } catch (error) {
      showConnectionResult("error", error.message || "无法连接该地址。");
    } finally {
      if (button) {
        button.disabled = false;
        button.textContent = "测试连接";
      }
    }
  }

  function clearUploadedReferences() {
    state.refs = Object.create(null);
    state.podcast.forEach(speaker => { speaker.upload = null; });
    state.libraryFiles = [];
    state.libraryError = "";
    setLibraryCount(0);
    stopMiniAudio();
  }

  async function saveSettings(event) {
    if (event) event.preventDefault();
    if (!dom.apiBaseInput) return;
    const raw = dom.apiBaseInput.value.trim();
    const target = normalizeBase(raw) || client.defaultBaseUrl;
    if (!isValidHttpUrl(target)) {
      showConnectionResult("error", "请输入有效的 http(s) 地址，例如 http://192.168.1.20:8081。");
      dom.apiBaseInput.focus();
      return;
    }

    const changed = target !== client.baseUrl;
    client.setBase(target);
    updateApiLabels();
    if (changed) clearUploadedReferences();
    closeModal("settings");

    if (changed) {
      toast("API 地址已更新，正在检测连接…", "info");
      renderComposer();
      const mode = await refreshHealth();
      if (mode === "demo") toast("地址已保存，但暂时无法连接该 API。", "error", 5200);
      else toast("API 已连接。", "success");
    } else {
      toast("连接设置已保存。", "success");
      refreshHealth({ silent: true });
    }
  }

  function retryConnection() {
    const button = dom.demoRetryBtn;
    if (button) {
      button.disabled = true;
      button.textContent = "检测中…";
    }
    refreshHealth().then(mode => {
      if (button) {
        button.disabled = false;
        button.textContent = "重新检测";
      }
      if (mode === "demo") {
        toast(state.healthError || "仍无法连接 API，请检查地址与服务状态。", "error", 5200);
      } else {
        toast("API 已连接。", "success");
      }
    });
  }

  function handleModeTransition(previous, mode) {
    const isDemo = mode === "demo";
    if (isDemo) {
      state.libraryFiles = [];
      state.libraryError = "";
      setLibraryCount(0);
    } else if (previous === "demo" || previous === "checking") {
      refreshLibraryCount();
    }

    if (state.modal === "library") {
      if (isDemo) renderLibrary();
      else refreshLibrary();
    }

    rerenderComposerSafely();
  }

  function applyMode() {
    if (!client) return;
    const previous = state.appliedMode;
    const mode = state.mode;
    const health = state.health || {};
    const available = workerAvailable();
    const total = workerTotal();

    dom.statusPill.classList.remove("is-online", "is-degraded", "is-demo", "is-checking");
    let pillClass = "is-checking";
    let label = "正在检测";
    let meta = "";

    if (mode === "online" || mode === "degraded") {
      pillClass = mode === "degraded" ? "is-degraded" : "is-online";
      label = mode === "degraded"
        ? "部分可用"
        : (health.model_loaded === false ? "模型加载中" : "API 已连接");
      meta = available != null && total != null ? `${available}/${total}` : "";
    } else if (mode === "demo") {
      pillClass = "is-demo";
      label = "演示模式";
      meta = "内置示例";
    }

    dom.statusPill.classList.add(pillClass);
    dom.statusLabel.textContent = label;
    dom.statusMeta.textContent = meta;
    dom.statusPill.title = mode === "demo"
      ? `${state.healthError || "未连接到 API"} · 点击配置连接`
      : `API: ${client.baseUrl}${health.requests_in_flight ? ` · 在途 ${health.requests_in_flight}` : ""}`;

    dom.demoBanner.hidden = mode !== "demo";
    dom.endpointLight.className = "endpoint-light" + (
      mode === "online" ? " is-online" :
      mode === "demo" || mode === "degraded" ? " is-demo" : ""
    );

    dom.docsLink.href = client.docsUrl();
    dom.docsLink.classList.toggle("is-disabled", mode === "demo");
    dom.docsLink.setAttribute("aria-disabled", mode === "demo" ? "true" : "false");
    dom.docsLink.title = mode === "demo" ? "连接 API 后可访问 Swagger 文档" : "打开 Swagger API 文档";

    updateApiLabels();
    updateLibraryDemoState();
    updateGenerateNote();

    state.appliedMode = mode;
    if (previous !== mode) handleModeTransition(previous, mode);
  }

  function updateGenerateNote() {
    const note = $("#generateNote", dom.composerPanel);
    if (!note) return;
    const info = generateNoteInfo();
    note.classList.toggle("is-demo", info.tone === "is-demo");
    note.classList.toggle("is-degraded", info.tone === "is-degraded");
    const title = $("#generateNoteTitle", note);
    const sub = $("#generateNoteSub", note);
    if (title) title.textContent = info.title;
    if (sub) sub.textContent = info.sub;
  }

  function rerenderComposerSafely() {
    const active = document.activeElement;
    const editing = active && active.matches && active.matches("input, textarea, select") && active.closest("#composerPanel");
    if (state.generating || editing) updateComposerModeCopy();
    else renderComposer();
  }

  function updateComposerModeCopy() {
    const isDemo = state.mode === "demo";
    $$("[data-ref-zone]", dom.composerPanel).forEach(zone => {
      zone.classList.toggle("is-demo", isDemo);
      const title = $(".upload-title", zone);
      const sub = $(".upload-sub", zone);
      const action = $(".upload-action", zone);
      if (title) title.textContent = isDemo ? "演示模式下无法上传" : "上传参考音频";
      if (sub) sub.textContent = isDemo ? "连接 API 后可上传 WAV / MP3 / FLAC" : "拖拽或点击选择 · WAV / MP3 / FLAC · 最大 50 MB";
      if (action) action.textContent = isDemo ? "连接 API" : "选择文件";
    });
    $$("[data-speaker-zone]", dom.composerPanel).forEach(zone => {
      zone.classList.toggle("is-demo", isDemo);
      const title = zone.querySelector("strong");
      const sub = zone.querySelector("small");
      if (title) title.textContent = isDemo ? "演示模式下跳过上传" : "上传参考音频";
      if (sub) sub.textContent = isDemo ? "连接 API 后可上传" : "WAV / MP3 / FLAC";
    });
    updateLibraryDemoState();
    updateGenerateNote();
  }

  async function refreshHealth(options = {}) {
    const base = client.baseUrl;

    // Reuse an in-flight probe only for the same endpoint. Switching the API
    // address while a 20s poll is in flight used to hand back the old server's
    // answer, which then showed "API 已连接" for an address never tested.
    if (state.healthPromise && state.healthBase === base) return state.healthPromise;

    if (!options.silent) {
      state.mode = "checking";
      applyMode();
    }

    state.healthBase = base;
    const probe = (async () => {
      try {
        const payload = await client.health();
        if (client.baseUrl !== base) return state.mode;
        if (!looksLikeMingHealth(payload)) {
          throw new Error("该地址不是 Ming TTS API。");
        }
        state.health = payload;
        state.healthError = "";
        state.lastHealthAt = Date.now();
        state.healthFailures = 0;

        const available = Number(payload.workers_available);
        const total = Number(payload.workers_total);
        if (available === 0 || payload.status === "offline") {
          state.mode = "demo";
        } else if (Number.isFinite(available) && Number.isFinite(total) && available < total) {
          state.mode = "degraded";
        } else {
          state.mode = "online";
        }
      } catch (error) {
        if (client.baseUrl !== base) return state.mode;
        state.healthFailures += 1;
        state.healthError = error.message || "无法连接 API。";
        state.lastHealthAt = Date.now();
        // A single failed probe during a long generation (server busy, laptop
        // suspended, one dropped packet) must not tear the whole page down into
        // demo mode mid-workflow — only two consecutive failures do.
        const keepMode = state.generating ? state.mode !== "checking" : false;
        if (!keepMode && state.healthFailures < 2 && state.mode === "online" && !options.force) {
          return state.mode;
        }
        state.health = null;
        state.mode = "demo";
      }

      applyMode();
      return state.mode;
    })();

    state.healthPromise = probe;
    try {
      return await probe;
    } finally {
      if (state.healthPromise === probe) state.healthPromise = null;
    }
  }

  /* ---------------- Modals, sidebar, toast ---------------- */

  /** Off-canvas sidebar must not be focusable, but on wide screens the same
   *  element is a permanent column, so this only applies in drawer mode. */
  function syncSidebarInert() {
    if (!dom.sidebar) return;
    const drawer = window.matchMedia("(max-width: 1040px)").matches;
    dom.sidebar.inert = drawer && !dom.sidebar.classList.contains("is-open");
  }

  function syncBodyLock() {
    const locked = !!state.modal || dom.sidebar.classList.contains("is-open");
    document.body.classList.toggle("is-locked", locked);
    syncSidebarInert();
  }

  function openSidebar() {
    dom.sidebar.classList.add("is-open");
    dom.sidebarScrim.classList.add("is-open");
    dom.menuBtn.setAttribute("aria-expanded", "true");
    syncBodyLock();
  }

  function closeSidebar() {
    if (!dom.sidebar.classList.contains("is-open")) return;
    dom.sidebar.classList.remove("is-open");
    dom.sidebarScrim.classList.remove("is-open");
    dom.menuBtn.setAttribute("aria-expanded", "false");
    syncBodyLock();
  }

  function openModal(name, onOpen, focusTarget) {
    const modal = name === "library" ? dom.libraryModal : dom.settingsModal;
    if (!modal) return;
    const trigger = document.activeElement;
    if (state.modal) closeModal(state.modal, true);
    state.lastFocus = trigger;
    state.modal = name;
    modal.classList.add("is-open");
    modal.setAttribute("aria-hidden", "false");
    syncBodyLock();
    if (typeof onOpen === "function") onOpen();

    const target = focusTarget || (name === "library" ? dom.librarySearch : dom.apiBaseInput);
    window.setTimeout(() => {
      if (!target) return;
      target.focus({ preventScroll: true });
      if (typeof target.select === "function" && name === "settings") target.select();
    }, 40);
  }

  function closeModal(name, silent) {
    const modalName = name || state.modal;
    if (!modalName) return;
    const modal = modalName === "library" ? dom.libraryModal : dom.settingsModal;
    if (modal) {
      modal.classList.remove("is-open");
      modal.setAttribute("aria-hidden", "true");
    }
    if (modalName === "library") {
      stopMiniAudio();
      state.libraryQuery = "";
      if (dom.librarySearch) dom.librarySearch.value = "";
    }
    state.modal = "";
    resetPendingDelete();
    syncBodyLock();
    if (!silent && state.lastFocus && state.lastFocus.isConnected) {
      state.lastFocus.focus({ preventScroll: true });
    }
    state.lastFocus = null;
  }

  function trapFocus(event) {
    const modal = state.modal === "library" ? dom.libraryModal : dom.settingsModal;
    if (!modal) return;
    const focusable = $$('a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])', modal)
      .filter(element => element.getClientRects().length > 0);
    if (!focusable.length) return;
    const first = focusable[0];
    const last = focusable[focusable.length - 1];
    if (!modal.contains(document.activeElement)) {
      event.preventDefault();
      first.focus();
      return;
    }
    if (event.shiftKey && document.activeElement === first) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault();
      first.focus();
    }
  }

  function toast(message, type, duration) {
    if (!dom.toastStack) return;
    const text = String(message || "").trim();
    if (!text) return;

    while (dom.toastStack.children.length >= 4) {
      dom.toastStack.firstElementChild.remove();
    }

    const node = document.createElement("div");
    node.className = `toast${type ? ` is-${type}` : ""}`;
    node.textContent = text;
    node.setAttribute("role", type === "error" ? "alert" : "status");
    dom.toastStack.appendChild(node);

    window.setTimeout(() => {
      node.classList.add("is-leaving");
      window.setTimeout(() => node.remove(), 240);
    }, duration || (type === "error" ? 5200 : 3600));
  }

  /* ---------------- Events ---------------- */

  function bindStaticEvents() {
    dom.menuBtn.addEventListener("click", () => {
      if (dom.sidebar.classList.contains("is-open")) closeSidebar();
      else openSidebar();
    });
    dom.sidebarScrim.addEventListener("click", closeSidebar);
    dom.sidebarSettingsBtn.addEventListener("click", openSettings);
    dom.statusPill.addEventListener("click", openSettings);
    dom.settingsBtn.addEventListener("click", openSettings);
    dom.libraryBtn.addEventListener("click", openLibrary);
    dom.demoSettingsBtn.addEventListener("click", openSettings);
    dom.demoRetryBtn.addEventListener("click", retryConnection);
    dom.docsLink.addEventListener("click", event => {
      if (state.mode === "demo") {
        event.preventDefault();
        toast("演示模式下无法打开接口文档。", "info");
        openSettings();
      }
    });

    dom.taskNav.addEventListener("click", event => {
      const button = event.target.closest("[data-task-id]");
      if (button) selectTask(button.dataset.taskId, { scroll: true });
    });

    dom.composerPanel.addEventListener("submit", event => {
      event.preventDefault();
      // Enter in a single-line speaker field means "done with this line", not
      // "generate" — submitting there used to raise a confusing upload error.
      const active = document.activeElement;
      if (active && active.matches && active.matches("[data-speaker-text]")) return;
      handleGenerate();
    });
    dom.composerPanel.addEventListener("input", handleComposerInput);
    dom.composerPanel.addEventListener("change", handleComposerInput);
    dom.composerPanel.addEventListener("click", handleComposerClick);

    dom.outputBody.addEventListener("click", event => {
      if (event.target.closest("#playBtn")) toggleResultAudio();
      else if (event.target.closest("#downloadBtn")) downloadResult();
      else if (event.target.closest("#regenerateBtn")) handleGenerate();
    });

    dom.librarySearch.addEventListener("input", () => {
      state.libraryQuery = dom.librarySearch.value;
      renderLibrary();
    });
    dom.refreshLibraryBtn.addEventListener("click", refreshLibrary);
    dom.libraryList.addEventListener("click", handleLibraryClick);
    bindLibraryDrop();

    dom.settingsForm.addEventListener("submit", saveSettings);
    dom.testConnectionBtn.addEventListener("click", testConnection);
    dom.resetApiBtn.addEventListener("click", resetBaseField);

    $$("#libraryModal [data-close], #settingsModal [data-close]").forEach(element => {
      element.addEventListener("click", () => closeModal(element.dataset.close));
    });

    document.addEventListener("click", event => {
      const miniPlay = event.target.closest(".mini-play");
      if (miniPlay) {
        const player = miniPlay.closest(".mini-player");
        if (player) toggleMini(player);
        return;
      }
      const miniTrack = event.target.closest(".mini-track");
      if (miniTrack) {
        const player = miniTrack.closest(".mini-player");
        if (player) seekMini(player, event);
        return;
      }
      if (event.target.closest("[data-open-settings]")) {
        openSettings();
        return;
      }
      if (event.target.closest("[data-refresh-library]")) {
        refreshLibrary();
      }
    });

    document.addEventListener("keydown", event => {
      if (state.modal) {
        if (event.key === "Escape") {
          event.preventDefault();
          closeModal(state.modal);
        } else if (event.key === "Tab") {
          trapFocus(event);
        }
        return;
      }
      if (event.key === "Escape") {
        if (dom.sidebar.classList.contains("is-open")) {
          event.preventDefault();
          closeSidebar();
        }
        return;
      }
      const keyTarget = event.target instanceof Element ? event.target : null;
      const miniTrack = keyTarget ? keyTarget.closest(".mini-track") : null;
      if (miniTrack) {
        handleMiniTrackKey(event, miniTrack);
        return;
      }
      if ((event.ctrlKey || event.metaKey) && event.key === "Enter") {
        event.preventDefault();
        handleGenerate();
      }
    });

    window.addEventListener("hashchange", () => {
      const id = window.location.hash.replace(/^#/, "");
      if (getTask(id) && id !== state.taskId) selectTask(id, { scroll: false, updateHash: false });
    });

    window.addEventListener("resize", () => {
      if (window.innerWidth > 1040) closeSidebar();
      syncSidebarInert();
      if (state.resizeFrame) return;
      state.resizeFrame = window.requestAnimationFrame(() => {
        state.resizeFrame = 0;
        updateResultProgress();
      });
    });

    window.addEventListener("online", () => refreshHealth({ silent: true }));

    document.addEventListener("visibilitychange", () => {
      if (document.visibilityState !== "visible") return;
      if (Date.now() - state.lastHealthAt > 12000) refreshHealth({ silent: true });
    });
  }

  init();
})();
