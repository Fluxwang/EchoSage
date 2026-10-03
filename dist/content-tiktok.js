(() => {
  // shared/settings.js
  var CHAT_BASE_URL_STORAGE_KEY = "chatBaseUrl";
  var CHAT_API_KEY_STORAGE_KEY = "chatApiKey";
  var CHAT_MODEL_STORAGE_KEY = "chatModel";
  var ASR_MODEL_STORAGE_KEY = "asrModel";
  var DEFAULT_ASR_MODEL = "universal";
  var CHAT_DEFAULTS = {
    [CHAT_BASE_URL_STORAGE_KEY]: "",
    [CHAT_API_KEY_STORAGE_KEY]: "",
    [CHAT_MODEL_STORAGE_KEY]: "gpt-4o-mini",
    [ASR_MODEL_STORAGE_KEY]: DEFAULT_ASR_MODEL
  };
  var AUTO_CAPTION_MODE_STORAGE_KEY = "autoCaptionMode";
  var ACCENT_COLOR_STORAGE_KEY = "accentColor";
  var DEFAULT_ACCENT_COLOR = "oklch(0.58 0.14 195)";
  var LEGACY_ACCENT_COLORS = {
    "#168ea3": "oklch(0.58 0.14 195)",
    "#5d55c7": "oklch(0.55 0.16 285)",
    "#238b5d": "oklch(0.6 0.16 150)",
    "#c65b3f": "oklch(0.6 0.17 25)"
  };
  function normalizeAccentColor(value) {
    if (!value) return DEFAULT_ACCENT_COLOR;
    return LEGACY_ACCENT_COLORS[value.toLowerCase()] ?? value;
  }
  var SOURCE_LANGUAGE_STORAGE_KEY = "sourceLanguage";
  var DEFAULT_SOURCE_LANGUAGE = "es";
  var TARGET_LANGUAGE_STORAGE_KEY = "targetLanguage";
  var DEFAULT_TARGET_LANGUAGE = "zh";
  var BILINGUAL_STORAGE_KEY = "bilingual";
  var DEFAULT_BILINGUAL = true;
  var VIDEO_TRANSLATION_ENGINE_STORAGE_KEY = "videoTranslationEngine";
  var DEFAULT_VIDEO_TRANSLATION_ENGINE = "builtin";
  var TARGET_LANGUAGES = [
    { value: "zh", label: "\u7B80\u4F53\u4E2D\u6587" },
    { value: "zh-Hant", label: "\u7E41\u4F53\u4E2D\u6587" },
    { value: "en", label: "\u82F1\u8BED" },
    { value: "ja", label: "\u65E5\u8BED" }
  ];

  // core/playback.js
  var END_WINDOW_SECONDS = 1.25;
  var START_WINDOW_SECONDS = 1.25;
  var NATURAL_PROGRESS_MAX_SECONDS = 2.5;
  var END_LEAD_IN_SECONDS = 4;
  function createPlaybackState() {
    return {
      lastTime: null,
      duration: null,
      armedForLoop: false,
      naturalProgressSamples: 0,
      completedOnePlaythrough: false
    };
  }
  function samplePlayback(state, sample) {
    const currentTime = Number(sample?.currentTime);
    const duration = Number(sample?.duration);
    if (!Number.isFinite(currentTime) || !Number.isFinite(duration) || duration <= 0) {
      return { state, completedOnePlaythrough: false };
    }
    if (state.completedOnePlaythrough) {
      return {
        state: { ...state, lastTime: currentTime, duration },
        completedOnePlaythrough: false
      };
    }
    if (sample?.paused) {
      return {
        state: {
          ...state,
          lastTime: currentTime,
          duration,
          armedForLoop: false,
          naturalProgressSamples: 0
        },
        completedOnePlaythrough: false
      };
    }
    const sameDuration = state.duration === null || Math.abs(state.duration - duration) < 0.01;
    const previous = state.lastTime;
    const naturalAdvance = previous === null ? null : currentTime - previous;
    const naturalProgress = sameDuration && naturalAdvance !== null && naturalAdvance >= 0 && naturalAdvance <= NATURAL_PROGRESS_MAX_SECONDS;
    const naturalProgressSamples = naturalProgress ? (state.naturalProgressSamples ?? 0) + 1 : 0;
    const nearEnd = currentTime >= duration - END_WINDOW_SECONDS;
    const previousNearEnd = previous !== null && previous >= duration - END_WINDOW_SECONDS;
    const naturalLeadIn = sameDuration && nearEnd && previous !== null && previous >= duration - END_LEAD_IN_SECONDS && naturalProgressSamples >= 2;
    const loopedBack = sameDuration && state.armedForLoop && previousNearEnd && currentTime <= START_WINDOW_SECONDS && previous - currentTime > END_WINDOW_SECONDS;
    const completedOnePlaythrough = Boolean(loopedBack);
    return {
      state: {
        ...state,
        lastTime: currentTime,
        duration,
        armedForLoop: completedOnePlaythrough ? false : state.armedForLoop || naturalLeadIn,
        naturalProgressSamples,
        completedOnePlaythrough: state.completedOnePlaythrough || completedOnePlaythrough
      },
      completedOnePlaythrough
    };
  }
  function activeCueIndex(cues, currentTime) {
    const time = Number(currentTime);
    if (!Number.isFinite(time)) return -1;
    return (cues ?? []).findIndex(
      (cue) => Number.isFinite(cue?.startSeconds) && Number.isFinite(cue?.endSeconds) && time >= cue.startSeconds && time < cue.endSeconds
    );
  }

  // sidepanel/render.js
  function renderCaptionRows({ captions, translations, bilingual, currentCueIndex, escapeHtml }) {
    return captions.map((caption, index) => {
      const time = `${escapeHtml(caption.start)}-${escapeHtml(caption.end)}`;
      const translation = translations[index] ? `<p class="tcs-translation">${escapeHtml(translations[index])}</p>` : "";
      const source = bilingual || !translations[index] ? `<p class="tcs-source">${escapeHtml(caption.text)}</p>` : "";
      const active = index === currentCueIndex ? " is-active" : "";
      return `<article class="tcs-row${active}" data-cue-index="${index}"><time>${time}</time><div>${source}${translation}</div></article>`;
    }).join("") || '<div class="tcs-placeholder">\u70B9\u51FB\u300C\u83B7\u53D6\u5B57\u5E55\u300D\u5F00\u59CB\u3002</div>';
  }
  function renderSummaryList({ output, loading, error, escapeHtml }) {
    if (loading) return '<p class="tcs-generating">\u6B63\u5728\u63D0\u70BC\u89C6\u9891\u8981\u70B9\u2026</p>';
    if (error) return `<div class="tcs-generation-error">${escapeHtml(error)}<button class="tcs-open-options" type="button">\u6253\u5F00\u8BBE\u7F6E</button></div>`;
    if (!output) return '<p class="tcs-summary-placeholder">\u70B9\u51FB\u300C\u751F\u6210\u8981\u70B9\u300D\u540E\uFF0C\u8FD9\u91CC\u4F1A\u5217\u51FA\u89C6\u9891\u7684\u6838\u5FC3\u4FE1\u606F\u3002</p>';
    const items = output.split(/\n+/).map((line) => line.replace(/^\s*(?:\d+[.、)]|[-•])\s*/, "").trim()).filter(Boolean);
    const list = items.length ? items : [output];
    const rows = list.map((item, index) => `<div class="tcs-summary-row"><span class="tcs-summary-index">${String(index + 1).padStart(2, "0")}</span><p>${escapeHtml(item)}</p></div>`).join("");
    return `<div class="tcs-summary-list">${rows}</div>`;
  }
  function renderRewriteOutput({ output, loading, error, escapeHtml }) {
    if (loading) return '<p class="tcs-generating">\u6B63\u5728\u751F\u6210\u4EFF\u5199\u811A\u672C\u2026</p>';
    if (error) return `<div class="tcs-generation-error">${escapeHtml(error)}<button class="tcs-open-options" type="button">\u6253\u5F00\u8BBE\u7F6E</button></div>`;
    if (!output) return '<p class="tcs-summary-placeholder">\u9009\u62E9\u65F6\u957F\u548C\u7C7B\u578B\u540E\u751F\u6210\u4E00\u4EFD\u5168\u65B0\u7684\u811A\u672C\u3002</p>';
    const paragraphs = output.split(/\n{2,}/).map((block) => block.trim()).filter(Boolean).map((block) => `<p>${escapeHtml(block).replace(/\n/g, "<br>")}</p>`).join("");
    return `<div class="tcs-rewrite-output">${paragraphs}</div>`;
  }

  // content-tiktok.js
  (() => {
    if (window.__echoSageTikTokLoaded) return;
    window.__echoSageTikTokLoaded = true;
    const rootId = "echosage-video-root";
    function applyAccent(color) {
      document.documentElement.style.setProperty("--echosage-accent", normalizeAccentColor(color));
    }
    let activeVideoId = "";
    let current = null;
    let captions = [];
    let translated = [];
    let translationEngines = [];
    let translationPending = false;
    let captionSource = null;
    let workspaceStatus = "";
    let streamingSessionId = "";
    let streamingStatus = "inactive";
    let streamingStopRequested = false;
    let playbackState = createPlaybackState();
    let currentCueIndex = -1;
    let sidepanelOpen = false;
    let sidepanelCollapsed = false;
    let sidepanelTab = "captions";
    let followPlayback = true;
    let lastFollowedCue = -1;
    let videoTranslationEngineOverride = null;
    let streamingTranslationEngine = null;
    let videoOverlayEnabled = false;
    let lastOverlayCueIndex = -2;
    let summaryOutput = "";
    let summaryError = "";
    let summaryLoading = false;
    let rewriteOutput = "";
    let rewriteError = "";
    let rewriteLoading = false;
    const REWRITE_DURATIONS = ["15 \u79D2", "30 \u79D2", "60 \u79D2"];
    const REWRITE_TYPES = ["\u53E3\u64AD", "\u79CD\u8349", "\u77E5\u8BC6\u8BB2\u89E3"];
    let rewriteDuration = "30 \u79D2";
    let rewriteType = "\u53E3\u64AD";
    let summaryFocus = "summary";
    let bilingual = DEFAULT_BILINGUAL;
    let targetLanguage = DEFAULT_TARGET_LANGUAGE;
    let dismissed = false;
    let autoMode = "manual";
    let sourceLanguage = DEFAULT_SOURCE_LANGUAGE;
    let translationEngine = DEFAULT_VIDEO_TRANSLATION_ENGINE;
    let autoTriggeredFor = "";
    chrome.storage.local.get({
      [ACCENT_COLOR_STORAGE_KEY]: DEFAULT_ACCENT_COLOR,
      [AUTO_CAPTION_MODE_STORAGE_KEY]: "manual",
      [SOURCE_LANGUAGE_STORAGE_KEY]: DEFAULT_SOURCE_LANGUAGE,
      [VIDEO_TRANSLATION_ENGINE_STORAGE_KEY]: DEFAULT_VIDEO_TRANSLATION_ENGINE,
      [TARGET_LANGUAGE_STORAGE_KEY]: DEFAULT_TARGET_LANGUAGE,
      [BILINGUAL_STORAGE_KEY]: DEFAULT_BILINGUAL
    }).then((values) => {
      applyAccent(values[ACCENT_COLOR_STORAGE_KEY]);
      autoMode = values[AUTO_CAPTION_MODE_STORAGE_KEY];
      sourceLanguage = values[SOURCE_LANGUAGE_STORAGE_KEY];
      translationEngine = values[VIDEO_TRANSLATION_ENGINE_STORAGE_KEY];
      targetLanguage = values[TARGET_LANGUAGE_STORAGE_KEY];
      bilingual = values[BILINGUAL_STORAGE_KEY];
      if (autoMode === "auto" && current && !dismissed) maybeAutoRun(mount());
    });
    chrome.storage.onChanged.addListener((changes, area) => {
      if (area !== "local") return;
      if (changes[ACCENT_COLOR_STORAGE_KEY]) {
        applyAccent(changes[ACCENT_COLOR_STORAGE_KEY].newValue || DEFAULT_ACCENT_COLOR);
      }
      if (changes[AUTO_CAPTION_MODE_STORAGE_KEY]) {
        autoMode = changes[AUTO_CAPTION_MODE_STORAGE_KEY].newValue || "manual";
      }
      if (changes[SOURCE_LANGUAGE_STORAGE_KEY]) {
        sourceLanguage = changes[SOURCE_LANGUAGE_STORAGE_KEY].newValue || DEFAULT_SOURCE_LANGUAGE;
      }
      if (changes[VIDEO_TRANSLATION_ENGINE_STORAGE_KEY]) {
        translationEngine = changes[VIDEO_TRANSLATION_ENGINE_STORAGE_KEY].newValue || DEFAULT_VIDEO_TRANSLATION_ENGINE;
        publishState();
      }
      if (changes[TARGET_LANGUAGE_STORAGE_KEY]) {
        targetLanguage = changes[TARGET_LANGUAGE_STORAGE_KEY].newValue || DEFAULT_TARGET_LANGUAGE;
        render();
      }
      if (changes[BILINGUAL_STORAGE_KEY]) {
        bilingual = changes[BILINGUAL_STORAGE_KEY].newValue ?? DEFAULT_BILINGUAL;
        render();
      }
    });
    function mount() {
      let root = document.getElementById(rootId);
      if (!root) {
        root = document.createElement("div");
        root.id = rootId;
        document.documentElement.appendChild(root);
      }
      return root;
    }
    function dismiss(root) {
      if (videoOverlayEnabled) {
        chrome.runtime.sendMessage({ type: "video-overlay-stop" }).catch(() => {
        });
        videoOverlayEnabled = false;
      }
      sidepanelOpen = false;
      sidepanelCollapsed = false;
      setPagePush(false);
      root.remove();
      dismissed = true;
    }
    const $ = (selector, parent = document) => parent.querySelector(selector);
    const text = (value) => String(value || "").trim();
    const number = (value) => new Intl.NumberFormat("zh-CN", { notation: "compact", maximumFractionDigits: 1 }).format(Number(value || 0));
    const pad = (value) => String(Math.floor(value)).padStart(2, "0");
    const timestamp = (value) => {
      const seconds = Number(value || 0);
      return `${pad(seconds / 60)}:${pad(seconds % 60)}`;
    };
    const decode = (input) => new DOMParser().parseFromString(input, "text/html").body.textContent || "";
    const escapeHtml = (input) => String(input || "").replace(/[&<>\"']/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[char]);
    const items = /* @__PURE__ */ new Map();
    function remember(item) {
      const stats = item.stats || item.statistics || {};
      const video = item.video || {};
      const subtitleInfos = video.subtitleInfos || video.subtitle_infos || [];
      const original = video.claInfo?.originalLanguageInfo?.language || item.textLanguage || "";
      const webvtt = (entry) => (entry.Format || entry.format || "").toLowerCase() === "webvtt";
      const native = subtitleInfos.find((entry) => webvtt(entry) && (entry.LanguageCodeName || entry.languageCodeName) === original) || subtitleInfos.find(webvtt);
      const id = String(item.id || item.aweme_id || "");
      if (!id) return;
      items.set(id, {
        id,
        cover: video.cover || video.originCover || video.dynamicCover || "",
        plays: stats.playCount || stats.play_count || 0,
        shares: stats.shareCount || stats.share_count || 0,
        comments: stats.commentCount || stats.comment_count || 0,
        likes: stats.diggCount || stats.digg_count || 0,
        createdAt: item.createTime || item.create_time || 0,
        subtitleUrl: native?.Url || native?.url || "",
        // 设计稿的视频卡片要显示「时长 · 检测到 X 字幕轨」，所以这两个字段
        // 必须跟着 item 一起带出来，popup 无法再回头问页面。
        duration: Number(video.duration) || 0,
        subtitleLanguage: native?.LanguageCodeName || native?.languageCodeName || "",
        description: item.desc || "",
        products: Array.isArray(item.products) ? item.products : []
      });
    }
    function productAnchor() {
      const product = current.products?.[0];
      if (!product) return "";
      const title = escapeHtml(product.title || "TikTok Shop \u5546\u54C1");
      const image = product.image ? `<img src="${escapeHtml(product.image)}" alt="">` : '<span class="tcs-product-image-empty">\u5546\u54C1</span>';
      const destination = product.url ? `<a class="tcs-product-link" href="${escapeHtml(product.url)}" target="_blank" rel="noopener noreferrer">\u67E5\u770B\u5546\u54C1</a>` : '<span class="tcs-product-unavailable">\u6682\u672A\u63D0\u4F9B\u5546\u54C1\u94FE\u63A5</span>';
      const extra = current.products.length > 1 ? `<span class="tcs-product-count">+${current.products.length - 1}</span>` : "";
      return `<div class="tcs-product-anchor">
      <button class="tcs-product-trigger" type="button" aria-label="\u67E5\u770B\u5E26\u8D27\u5546\u54C1" title="\u67E5\u770B\u5E26\u8D27\u5546\u54C1"><span class="tcs-bag-icon" aria-hidden="true"></span>${extra}</button>
      <section class="tcs-product-popover" role="tooltip">
        ${image}<div class="tcs-product-details"><strong>${title}</strong><small>\u5546\u54C1 ID: ${escapeHtml(product.id)}</small>${destination}</div>
      </section>
    </div>`;
    }
    function visibleId() {
      let best = null;
      let bestScore = 0;
      for (const video of document.querySelectorAll("video")) {
        const rect = video.getBoundingClientRect();
        const visible = Math.max(0, Math.min(rect.bottom, innerHeight) - Math.max(rect.top, 0));
        if (!rect.width || !visible) continue;
        const score = visible * (video.paused ? 0.4 : 1);
        if (score > bestScore) {
          bestScore = score;
          best = video;
        }
      }
      for (let node = best; node && node !== document.body; node = node.parentElement) {
        const href = node.querySelector?.('a[href*="/video/"], a[href*="/photo/"]')?.getAttribute("href");
        const match = href?.match(/\/(?:video|photo)\/(\d+)/);
        if (match) return match[1];
      }
      return "";
    }
    function currentId() {
      return location.pathname.match(/\/(?:video|photo)\/(\d+)/)?.[1] || visibleId();
    }
    function parseVtt(vtt) {
      const blocks = vtt.replace(/\r/g, "").split("\n\n");
      return blocks.map((block) => {
        const lines = block.split("\n").filter(Boolean);
        const timeLine = lines.find((line) => line.includes("-->"));
        if (!timeLine) return null;
        const [start, end] = timeLine.split("-->").map((part) => part.trim().split(" ")[0]);
        const seconds = (stamp) => {
          const parts = stamp.replace(",", ".").split(":").map(Number);
          return parts.length === 3 ? parts[0] * 3600 + parts[1] * 60 + parts[2] : parts[0] * 60 + parts[1];
        };
        const caption = lines.slice(lines.indexOf(timeLine) + 1).map(decode).join(" ").trim();
        const startSeconds = seconds(start);
        const endSeconds = seconds(end);
        return caption ? { start: timestamp(startSeconds), end: timestamp(endSeconds), startSeconds, endSeconds, text: caption } : null;
      }).filter(Boolean);
    }
    function effectiveTranslationEngine() {
      return videoTranslationEngineOverride || streamingTranslationEngine || translationEngine;
    }
    function engineLabel(engine = effectiveTranslationEngine()) {
      return engine === "ai" ? "AI \u6A21\u578B" : "\u672C\u5730\u6A21\u578B";
    }
    function translationProgressText() {
      const total = captions.length;
      const completed = translated.filter(Boolean).length;
      const engines = new Set(translationEngines.filter(Boolean));
      const label = engines.size > 1 ? "\u6DF7\u5408\u5F15\u64CE" : engineLabel([...engines][0]);
      if (translationPending) return `${completed} / ${total} \u53E5\u5DF2\u7FFB\u8BD1 \xB7 ${label}\u7FFB\u8BD1\u4E2D`;
      return `${completed} / ${total} \u53E5\u5DF2\u7FFB\u8BD1 \xB7 ${label}`;
    }
    function setPagePush(open = sidepanelOpen, collapsed = sidepanelCollapsed) {
      const page = document.documentElement;
      if (!open) {
        page.classList.remove("echosage-sidepanel-open");
        page.style.removeProperty("--echosage-sidepanel-width");
        return;
      }
      page.classList.add("echosage-sidepanel-open");
      page.style.setProperty("--echosage-sidepanel-width", collapsed ? "48px" : "min(400px, 92vw)");
    }
    function openSidepanel(tab = "captions") {
      sidepanelOpen = true;
      sidepanelCollapsed = false;
      sidepanelTab = ["summary", "rewrite"].includes(tab) ? "summary" : "captions";
      summaryFocus = tab === "rewrite" ? "rewrite" : "summary";
      setPagePush();
      render();
      if (sidepanelTab === "summary") {
        queueMicrotask(() => {
          const root = document.getElementById(rootId);
          const target = root?.querySelector(summaryFocus === "rewrite" ? ".tcs-rewrite-duration" : ".tcs-generate-summary");
          target?.focus();
        });
      }
    }
    function closeSidepanel() {
      sidepanelOpen = false;
      sidepanelCollapsed = false;
      setPagePush(false);
      render();
    }
    function toggleSidepanelCollapsed() {
      sidepanelCollapsed = !sidepanelCollapsed;
      setPagePush();
      render();
    }
    function summaryListMarkup() {
      return renderSummaryList({
        output: summaryOutput,
        loading: summaryLoading,
        error: summaryError,
        escapeHtml
      });
    }
    function rewriteMarkup() {
      return renderRewriteOutput({
        output: rewriteOutput,
        loading: rewriteLoading,
        error: rewriteError,
        escapeHtml
      });
    }
    function resetGeneratedContent() {
      summaryOutput = "";
      summaryError = "";
      summaryLoading = false;
      rewriteOutput = "";
      rewriteError = "";
      rewriteLoading = false;
    }
    function sidepanelMarkup() {
      const captionsSelected = sidepanelTab === "captions";
      const currentEngine = effectiveTranslationEngine();
      const targetOptions = TARGET_LANGUAGES.map(
        ({ value, label }) => `<option value="${value}" ${value === targetLanguage ? "selected" : ""}>${escapeHtml(label)}</option>`
      ).join("");
      const rewriteTypeOptions = REWRITE_TYPES.map(
        (value) => `<option ${value === rewriteType ? "selected" : ""}>${value}</option>`
      ).join("");
      const rewriteDurationOptions = REWRITE_DURATIONS.map(
        (value) => `<option ${value === rewriteDuration ? "selected" : ""}>${value}</option>`
      ).join("");
      return `
      <aside class="tcs-sidepanel ${sidepanelOpen ? "is-open" : ""} ${sidepanelCollapsed ? "is-collapsed" : ""}" aria-hidden="${!sidepanelOpen}">
        <button class="tcs-expand" type="button" aria-label="\u5C55\u5F00\u4FA7\u8FB9\u680F">\u2039</button>
        <header class="tcs-sidepanel-header">
          <div class="tcs-brand"><span class="tcs-mark">E</span><strong>EchoSage</strong><small>\u4FA7\u8FB9\u680F</small></div>
          <div class="tcs-panel-actions">
            <button class="tcs-collapse" type="button" title="\u6536\u8D77" aria-label="\u6536\u8D77\u4FA7\u8FB9\u680F">\xBB</button>
            <button class="tcs-sidepanel-close" type="button" title="\u5173\u95ED" aria-label="\u5173\u95ED\u4FA7\u8FB9\u680F">\u2715</button>
          </div>
        </header>
        <nav class="tcs-side-tabs" aria-label="\u89C6\u9891\u5DE5\u4F5C\u533A">
          <button type="button" data-side-tab="captions" aria-selected="${captionsSelected}">\u5B57\u5E55\u548C\u7FFB\u8BD1</button>
          <button type="button" data-side-tab="summary" aria-selected="${!captionsSelected}">\u603B\u7ED3\u548C\u4EFF\u5199</button>
        </nav>
        <section class="tcs-side-view ${captionsSelected ? "" : "is-hidden"}" data-side-view="captions">
          <div class="tcs-side-controls">
            <div class="tcs-control-row">
              <label class="tcs-lang-pill"><span class="tcs-lang-tag">\u8BD1</span><select class="tcs-target-language" aria-label="\u8BD1\u6587\u8BED\u8A00">${targetOptions}</select><span class="tcs-caret" aria-hidden="true">\u25BE</span></label>
              <label class="tcs-switch"><span class="tcs-switch-text">\u53CC\u8BED</span><input class="tcs-switch-bilingual" type="checkbox" ${bilingual ? "checked" : ""}><span class="tcs-track"></span></label>
              <button class="tcs-copy" type="button" title="\u590D\u5236\u5168\u6587" aria-label="\u590D\u5236\u5168\u6587">\u29C9</button>
            </div>
            <div class="tcs-control-row">
              <label class="tcs-switch"><input class="tcs-follow" type="checkbox" ${followPlayback ? "checked" : ""}><span class="tcs-track"></span><span class="tcs-switch-text">\u8DDF\u968F\u64AD\u653E</span></label>
              <label class="tcs-switch"><input class="tcs-video-overlay" type="checkbox" ${videoOverlayEnabled ? "checked" : ""}><span class="tcs-track"></span><span class="tcs-switch-text">\u60AC\u6D6E\u7A97</span></label>
              <span class="tcs-spacer"></span>
              <label class="tcs-switch"><input class="tcs-ai-engine" type="checkbox" ${currentEngine === "ai" ? "checked" : ""}><span class="tcs-track"></span><span class="tcs-switch-text">AI \u7FFB\u8BD1</span></label>
            </div>
            <div class="tcs-actions">
              <button class="tcs-load" type="button">\u83B7\u53D6\u5B57\u5E55</button>
              ${current.subtitleUrl ? "" : `<button class="tcs-stream" type="button">${streamIsActive() ? "\u505C\u6B62\u6D41\u5F0F\u8F6C\u5199" : "\u5F00\u59CB\u6D41\u5F0F\u8F6C\u5199"}</button>`}
            </div>
          </div>
          <div class="tcs-captions">${captionRows()}</div>
          <footer class="tcs-status-bar">
            <div class="tcs-status-lines">
              <strong class="tcs-progress">${escapeHtml(translationProgressText())}</strong>
              <span class="tcs-status">${escapeHtml(workspaceStatus)}</span>
            </div>
            <button class="tcs-export" type="button">\u5BFC\u51FA</button>
            <button class="tcs-goto-summary" type="button">\u603B\u7ED3</button>
          </footer>
        </section>
        <section class="tcs-side-view ${captionsSelected ? "is-hidden" : ""}" data-side-view="summary">
          <div class="tcs-generation-section">
            <div class="tcs-generation-heading">
              <h2>\u89C6\u9891\u8981\u70B9</h2>
              <button class="tcs-generate-summary" type="button" ${captions.length ? "" : "disabled"}>${summaryOutput ? "\u91CD\u65B0\u751F\u6210" : "\u751F\u6210\u8981\u70B9"}</button>
            </div>
            <div class="tcs-summary-result">${summaryListMarkup()}</div>
          </div>
          <div class="tcs-generation-section tcs-generation-grow">
            <div class="tcs-generation-heading">
              <h2>\u4EFF\u5199\u811A\u672C</h2>
              <div class="tcs-rewrite-controls">
                <label class="tcs-pill-select"><select class="tcs-rewrite-type" aria-label="\u811A\u672C\u7C7B\u578B">${rewriteTypeOptions}</select><span class="tcs-caret" aria-hidden="true">\u25BE</span></label>
                <label class="tcs-pill-select"><select class="tcs-rewrite-duration" aria-label="\u811A\u672C\u65F6\u957F">${rewriteDurationOptions}</select><span class="tcs-caret" aria-hidden="true">\u25BE</span></label>
              </div>
            </div>
            <div class="tcs-rewrite-result">${rewriteMarkup()}</div>
          </div>
          <div class="tcs-summary-actions">
            <button class="tcs-copy-rewrite" type="button" ${rewriteOutput ? "" : "disabled"}>\u590D\u5236\u811A\u672C</button>
            <button class="tcs-generate-rewrite" type="button" ${captions.length ? "" : "disabled"}>${rewriteOutput ? "\u518D\u5199\u4E00\u7248" : "\u751F\u6210\u811A\u672C"}</button>
          </div>
        </section>
      </aside>`;
    }
    function render() {
      const root = mount();
      if (!current || current.pending) {
        root.innerHTML = `
        <section class="tcs-card tcs-card-empty">
          <div class="tcs-top"><strong>EchoSage</strong><button class="tcs-close" title="\u5173\u95ED">\xD7</button></div>
          <p class="tcs-placeholder">${current ? "\u6B63\u5728\u8BFB\u53D6\u5F53\u524D\u89C6\u9891\u6570\u636E\u2026" : "\u672A\u80FD\u5728\u5F53\u524D\u9875\u9762\u8BC6\u522B\u5230\u89C6\u9891\u3002<br>\u8BF7\u6253\u5F00 TikTok \u89C6\u9891\u8BE6\u60C5\u9875\uFF08/@\u7528\u6237/video/\u2026\uFF09\u540E\u91CD\u8BD5\u3002"}</p>
        </section>`;
        $(".tcs-close", root).onclick = () => dismiss(root);
        publishState();
        return;
      }
      const date = current.createdAt ? new Date(Number(current.createdAt) * 1e3).toLocaleDateString("zh-CN") : "--";
      root.innerHTML = `
      <section class="tcs-card">
        ${current.cover ? `<img class="tcs-cover" src="${escapeHtml(current.cover)}" alt="\u89C6\u9891\u5C01\u9762">` : '<div class="tcs-cover tcs-empty">\u65E0\u5C01\u9762</div>'}
        ${productAnchor()}
        <div class="tcs-top"><strong>EchoSage</strong><button class="tcs-close" title="\u5173\u95ED">\xD7</button></div>
        <div class="tcs-metrics">
          <span title="\u64AD\u653E"><b>\u25B7</b> ${number(current.plays)}</span><span title="\u5206\u4EAB"><b>\u2197</b> ${number(current.shares)}</span>
          <span title="\u8BC4\u8BBA"><b>\u25CC</b> ${number(current.comments)}</span><span title="\u70B9\u8D5E"><b>\u2661</b> ${number(current.likes)}</span>
        </div>
        <time>\u53D1\u5E03\u4E8E ${date}</time>
        <button class="tcs-open">\u5B57\u5E55\u548C\u7FFB\u8BD1</button>
      </section>
      ${sidepanelMarkup()}`;
      bind(root);
      setPagePush();
      publishState();
      maybeAutoRun(root);
    }
    async function maybeAutoRun(root) {
      if (autoMode !== "auto" || autoTriggeredFor === current.id) return;
      autoTriggeredFor = current.id;
      if (current.subtitleUrl) await loadCaptions(root);
      else await startStreaming(root);
    }
    function captionRows() {
      return renderCaptionRows({
        captions,
        translations: translated,
        bilingual,
        currentCueIndex,
        escapeHtml
      });
    }
    async function request(message) {
      const result = await chrome.runtime.sendMessage(message);
      if (!result?.ok) throw new Error(result?.error || "\u8BF7\u6C42\u5931\u8D25\u3002");
      return result.data;
    }
    function setStatus(root, value) {
      workspaceStatus = value;
      const status = root ? $(".tcs-status", root) : null;
      if (status) status.textContent = value;
    }
    function setBusy(root, button, value) {
      button.disabled = value;
      button.dataset.label ||= button.textContent;
      button.textContent = value ? "\u5904\u7406\u4E2D..." : button.dataset.label;
    }
    function updateRows(root) {
      const list = $(".tcs-captions", root);
      if (list) list.innerHTML = captionRows();
      const progress = $(".tcs-progress", root);
      if (progress) progress.textContent = translationProgressText();
    }
    function refreshPlaybackPresentation(root = document.getElementById(rootId)) {
      if (!root) return;
      root.querySelectorAll("[data-cue-index]").forEach((row) => {
        row.classList.toggle("is-active", Number(row.dataset.cueIndex) === currentCueIndex);
      });
      if (sidepanelOpen && !sidepanelCollapsed && followPlayback && currentCueIndex >= 0 && currentCueIndex !== lastFollowedCue) {
        root.querySelector(`[data-cue-index="${currentCueIndex}"]`)?.scrollIntoView({ block: "center", behavior: "smooth" });
        lastFollowedCue = currentCueIndex;
      }
    }
    async function loadCaptions(root) {
      const button = $(".tcs-load", root);
      setBusy(root, button, true);
      try {
        if (!current.subtitleUrl) {
          captions = [];
          translated = [];
          translationEngines = [];
          translationPending = false;
          captionSource = null;
          updateRows(root);
          setStatus(root, "\u5F53\u524D\u89C6\u9891\u6CA1\u6709\u539F\u751F\u5B57\u5E55\u3002");
          publishState();
          return;
        }
        captions = parseVtt(await request({ type: "fetch-video-vtt", url: current.subtitleUrl }));
        if (!captions.length) throw new Error("\u672A\u89E3\u6790\u5230\u539F\u751F\u5B57\u5E55\u3002");
        resetGeneratedContent();
        translated = [];
        translationEngines = [];
        captionSource = "native";
        updateRows(root);
        root.querySelectorAll("[data-ai]").forEach((button2) => button2.disabled = !captions.length);
        setStatus(root, `\u5DF2\u83B7\u53D6 ${captions.length} \u6761\u539F\u751F\u5B57\u5E55\uFF0C\u51C6\u5907\u7FFB\u8BD1\u3002`);
        publishState();
        await translateCaptions(root);
      } catch (error) {
        setStatus(root, error.message);
      } finally {
        setBusy(root, button, false);
      }
    }
    async function translateCaptions(root) {
      const requestedVideoId = activeVideoId;
      const requestedCaptions = captions;
      const requestedEngine = effectiveTranslationEngine();
      translationPending = true;
      translationEngines = captions.map(() => requestedEngine);
      updateRows(root);
      setStatus(
        root,
        requestedEngine === "ai" ? "\u5B57\u5E55\u5DF2\u9F50\u5168\uFF0C\u6B63\u5728\u7531 AI \u6574\u6BB5\u6279\u91CF\u7FFB\u8BD1\u2026" : "\u6B63\u5728\u4F7F\u7528 Chrome \u5185\u7F6E nano \u9010\u6761\u5373\u65F6\u7FFB\u8BD1\u2026"
      );
      publishState();
      try {
        const data = await request({
          type: "translate-video-captions",
          captions: requestedCaptions,
          sourceLanguage,
          translationEngine: requestedEngine
        });
        if (activeVideoId !== requestedVideoId || captions !== requestedCaptions) return;
        translated = Array(captions.length).fill("");
        translationEngines = Array(captions.length).fill(data.engine || requestedEngine);
        for (const result of data.translations || []) {
          if (Number.isInteger(result.index) && result.index >= 0 && result.index < translated.length) {
            translated[result.index] = result.text || "";
          }
        }
        translationPending = false;
        updateRows(root);
        const translatedCount = translated.filter(Boolean).length;
        setStatus(
          root,
          requestedEngine === "ai" ? `AI \u5DF2\u5B8C\u6210 ${translatedCount} \u6761\u5B57\u5E55\u7684\u6574\u6BB5\u7FFB\u8BD1\u3002` : `Chrome \u5185\u7F6E nano \u5DF2\u5B8C\u6210 ${translatedCount} \u6761\u5373\u65F6\u7FFB\u8BD1\u3002`
        );
        publishState();
      } catch (error) {
        if (activeVideoId !== requestedVideoId || captions !== requestedCaptions) return;
        translationPending = false;
        updateRows(root);
        setStatus(root, `\u5B57\u5E55\u5DF2\u83B7\u53D6\uFF0C\u4F46\u7FFB\u8BD1\u5931\u8D25\uFF1A${error.message}`);
        publishState();
      }
    }
    function activeVideoElement() {
      const videos = [...document.querySelectorAll("video")];
      return videos.find((video) => video.readyState > 0 && video.offsetParent !== null) || videos[0] || null;
    }
    function videoTime() {
      const video = activeVideoElement();
      return Number.isFinite(video?.currentTime) ? video.currentTime : 0;
    }
    function streamIsActive() {
      return ["connecting", "capturing", "idle", "reconnecting", "stopping"].includes(streamingStatus);
    }
    function cueForStreamingRecord(record, index, previous) {
      const now = videoTime();
      const startSeconds = previous ? Math.max(previous.endSeconds ?? previous.startSeconds ?? 0, 0) : Math.max(0, now - 1.5);
      const endSeconds = Math.max(startSeconds + 0.3, now + 0.3);
      return {
        streamTurnIndex: record.turnIndex,
        start: timestamp(startSeconds),
        end: timestamp(endSeconds),
        startSeconds,
        endSeconds,
        text: record.text,
        translation: record.translation || "",
        translationEngine: record.translationEngine,
        index
      };
    }
    function applyStreamingRecords(records) {
      const byTurn = new Map(captions.map((caption) => [caption.streamTurnIndex, caption]));
      const next = [];
      for (let index = 0; index < records.length; index += 1) {
        const record = records[index];
        const previous = next[index - 1];
        const known = byTurn.get(record.turnIndex);
        const cue = known ? {
          ...known,
          text: record.text,
          translation: record.translation || "",
          translationEngine: record.translationEngine
        } : cueForStreamingRecord(record, index, previous);
        if (previous) {
          previous.endSeconds = Math.max(previous.startSeconds + 0.3, cue.startSeconds);
          previous.end = timestamp(previous.endSeconds);
        }
        next.push(cue);
      }
      captions = next;
      translated = captions.map((caption) => caption.translation || "");
      translationEngines = captions.map((caption) => caption.translationEngine || "builtin");
    }
    function streamingStatusText(state) {
      if (state.translationError) return `\u8F6C\u5199\u5DF2\u4FDD\u7559\uFF0C\u4F46\u7FFB\u8BD1\u5931\u8D25\uFF1A${state.translationError}`;
      if (state.ended && state.reason === "video-playthrough") {
        return "\u89C6\u9891\u5DF2\u64AD\u653E\u5B8C\u4E00\u8F6E\uFF0C\u6D41\u5F0F\u8F6C\u5199\u5DF2\u81EA\u52A8\u505C\u6B62\u3002";
      }
      if (state.status === "idle") return "\u68C0\u6D4B\u5230\u957F\u65F6\u95F4\u9759\u97F3\uFF0C\u5DF2\u6682\u505C\u4E0A\u4F20\uFF1B\u89C6\u9891\u6062\u590D\u8BF4\u8BDD\u540E\u4F1A\u81EA\u52A8\u7EE7\u7EED\u3002";
      if (state.status === "reconnecting") return "\u8F6C\u5199\u8FDE\u63A5\u4E2D\u65AD\uFF0C\u6B63\u5728\u81EA\u52A8\u91CD\u8FDE\u2026";
      if (state.status === "inactive" && state.pendingBatchCount) return "\u8F6C\u5199\u5DF2\u7ED3\u675F\uFF0C\u6B63\u5728\u7531 AI \u6574\u6BB5\u6279\u91CF\u7FFB\u8BD1\u2026";
      if (state.translationEngine === "ai" && state.pendingBatchCount) {
        return "\u6B63\u5728\u6D41\u5F0F\u8F6C\u5199\uFF1BAI \u4F1A\u5728\u89C6\u9891\u64AD\u5B8C\u4E00\u8F6E\u540E\u6574\u6BB5\u7FFB\u8BD1\u3002";
      }
      if (state.status === "capturing") return "\u6B63\u5728\u6D41\u5F0F\u8F6C\u5199\u5E76\u4F7F\u7528\u672C\u5730\u6A21\u578B\u5373\u65F6\u7FFB\u8BD1\u2026";
      return "\u6D41\u5F0F\u8F6C\u5199\u5DF2\u505C\u6B62\u3002";
    }
    async function startStreaming(root) {
      if (current?.subtitleUrl) {
        setStatus(root, "\u5F53\u524D\u89C6\u9891\u5DF2\u6709\u539F\u751F\u5B57\u5E55\uFF0C\u4F18\u5148\u8BFB\u53D6\u539F\u751F\u5B57\u5E55\u3002");
        return;
      }
      if (streamIsActive()) {
        setStatus(root, "\u5F53\u524D\u89C6\u9891\u6B63\u5728\u6D41\u5F0F\u8F6C\u5199\u3002");
        return;
      }
      const requestedVideoId = activeVideoId;
      const requestedEngine = effectiveTranslationEngine();
      captions = [];
      translated = [];
      translationEngines = [];
      resetGeneratedContent();
      translationPending = requestedEngine === "ai";
      captionSource = "streaming";
      streamingStatus = "connecting";
      streamingSessionId = "";
      streamingStopRequested = false;
      streamingTranslationEngine = requestedEngine;
      playbackState = createPlaybackState();
      updateRows(root);
      setStatus(root, "\u6B63\u5728\u5EFA\u7ACB\u89C6\u9891\u6D41\u5F0F\u8F6C\u5199\u2026");
      publishState();
      try {
        const data = await request({
          type: "start-video-capture",
          videoId: requestedVideoId,
          sourceLanguage,
          translationEngine: requestedEngine
        });
        if (activeVideoId !== requestedVideoId) return;
        streamingSessionId = data.sessionId;
        if (streamingStopRequested) {
          await stopStreaming(root);
          return;
        }
        streamingStatus = "capturing";
        setStatus(root, requestedEngine === "ai" ? "\u6B63\u5728\u6D41\u5F0F\u8F6C\u5199\uFF1BAI \u4F1A\u5728\u89C6\u9891\u64AD\u5B8C\u4E00\u8F6E\u540E\u6574\u6BB5\u7FFB\u8BD1\u3002" : "\u6B63\u5728\u6D41\u5F0F\u8F6C\u5199\u5E76\u4F7F\u7528\u672C\u5730\u6A21\u578B\u5373\u65F6\u7FFB\u8BD1\u2026");
        publishState();
        render();
      } catch (error) {
        if (activeVideoId !== requestedVideoId) return;
        streamingStatus = "inactive";
        translationPending = false;
        setStatus(root, `\u65E0\u6CD5\u542F\u52A8\u6D41\u5F0F\u8F6C\u5199\uFF1A${error.message}`);
        publishState();
      }
    }
    async function stopStreaming(root, reason = "user-stop") {
      if (!streamingSessionId) {
        streamingStopRequested = true;
        setStatus(root, "\u6B63\u5728\u53D6\u6D88\u6D41\u5F0F\u8F6C\u5199\u542F\u52A8\u2026");
        return;
      }
      const sessionId = streamingSessionId;
      streamingStatus = "stopping";
      setStatus(root, reason === "video-playthrough" ? "\u89C6\u9891\u5DF2\u64AD\u5B8C\u4E00\u8F6E\uFF0C\u6B63\u5728\u7ED3\u675F\u8F6C\u5199\u2026" : "\u6B63\u5728\u505C\u6B62\u6D41\u5F0F\u8F6C\u5199\u2026");
      try {
        await request({ type: "stop-video-capture", sessionId, reason });
      } catch (error) {
        streamingStatus = "inactive";
        setStatus(root, `\u505C\u6B62\u6D41\u5F0F\u8F6C\u5199\u5931\u8D25\uFF1A${error.message}`);
      }
    }
    function applyVideoAsrUpdate(message) {
      if (!current || message.videoId !== current.id) return;
      if (streamingSessionId && message.sessionId !== streamingSessionId) return;
      const state = message.state;
      if (!state) return;
      streamingSessionId ||= message.sessionId;
      streamingStatus = state.status || streamingStatus;
      streamingTranslationEngine = state.translationEngine || streamingTranslationEngine;
      captionSource = "streaming";
      translationPending = Boolean(state.pendingBatchCount);
      applyStreamingRecords(state.records || []);
      currentCueIndex = activeCueIndex(captions, videoTime());
      const root = document.getElementById(rootId);
      if (root) {
        updateRows(root);
        setStatus(root, streamingStatusText(state));
      } else {
        workspaceStatus = streamingStatusText(state);
      }
      publishState();
      if (state.ended && !dismissed) render();
    }
    function sampleVideoPlayback() {
      if (!current) return;
      const video = activeVideoElement();
      if (!video || !Number.isFinite(video.duration) || video.duration <= 0) return;
      const result = samplePlayback(playbackState, {
        currentTime: video.currentTime,
        duration: video.duration,
        paused: video.paused
      });
      playbackState = result.state;
      const previousCueIndex = currentCueIndex;
      currentCueIndex = activeCueIndex(captions, video.currentTime);
      refreshPlaybackPresentation();
      if (currentCueIndex !== previousCueIndex) publishVideoOverlay();
      if (result.completedOnePlaythrough && streamIsActive()) {
        const root = document.getElementById(rootId);
        stopStreaming(root, "video-playthrough");
      }
    }
    function bind(root) {
      $(".tcs-close", root).onclick = () => dismiss(root);
      $(".tcs-open", root).onclick = () => openSidepanel("captions");
      $(".tcs-sidepanel-close", root).onclick = () => closeSidepanel();
      $(".tcs-collapse", root).onclick = () => toggleSidepanelCollapsed();
      $(".tcs-expand", root).onclick = () => toggleSidepanelCollapsed();
      root.querySelectorAll("[data-side-tab]").forEach((button) => {
        button.onclick = () => {
          sidepanelTab = button.dataset.sideTab;
          render();
        };
      });
      $(".tcs-load", root).onclick = () => loadCaptions(root);
      const streamButton = $(".tcs-stream", root);
      if (streamButton) {
        streamButton.onclick = () => streamIsActive() ? stopStreaming(root) : startStreaming(root);
      }
      $(".tcs-switch-bilingual", root).onchange = (event) => {
        bilingual = event.target.checked;
        chrome.storage.local.set({ [BILINGUAL_STORAGE_KEY]: bilingual }).catch(() => {
        });
        updateRows(root);
      };
      $(".tcs-target-language", root).onchange = (event) => {
        targetLanguage = event.target.value;
        chrome.storage.local.set({ [TARGET_LANGUAGE_STORAGE_KEY]: targetLanguage }).catch(() => {
        });
        setStatus(root, "\u5DF2\u5207\u6362\u8BD1\u6587\u8BED\u8A00\uFF1B\u91CD\u65B0\u83B7\u53D6\u5B57\u5E55\u540E\u751F\u6548\u3002");
      };
      $(".tcs-follow", root).onchange = (event) => {
        followPlayback = event.target.checked;
        lastFollowedCue = -1;
        refreshPlaybackPresentation(root);
      };
      $(".tcs-video-overlay", root).onchange = (event) => setVideoOverlayEnabled(root, event.target.checked);
      $(".tcs-ai-engine", root).onchange = (event) => setCurrentVideoTranslationEngine(root, event.target.checked ? "ai" : "builtin");
      $(".tcs-copy", root).onclick = () => copyCaptions(root);
      $(".tcs-export", root).onclick = () => exportCaptions(root);
      $(".tcs-generate-summary", root).onclick = () => generateSummary();
      $(".tcs-rewrite-duration", root).onchange = (event) => {
        rewriteDuration = event.target.value;
      };
      $(".tcs-rewrite-type", root).onchange = (event) => {
        rewriteType = event.target.value;
      };
      $(".tcs-generate-rewrite", root).onclick = () => generateRewrite();
      $(".tcs-copy-rewrite", root).onclick = () => copyRewrite(root);
      $(".tcs-goto-summary", root).onclick = () => {
        sidepanelTab = "summary";
        render();
        if (captions.length && !summaryOutput && !summaryLoading) generateSummary();
      };
      root.querySelectorAll(".tcs-open-options").forEach((button) => {
        button.onclick = () => chrome.runtime.sendMessage({ type: "open-options" }).catch(() => {
        });
      });
    }
    function captionText() {
      return captions.map((caption, index) => {
        const translation = translated[index] ? `
${translated[index]}` : "";
        return `${caption.start}-${caption.end}
${caption.text}${translation}`;
      }).join("\n\n");
    }
    async function copyRewrite(root) {
      try {
        await navigator.clipboard.writeText(rewriteOutput);
        setStatus(root, "\u4EFF\u5199\u811A\u672C\u5DF2\u590D\u5236\u3002");
      } catch (error) {
        setStatus(root, `\u590D\u5236\u5931\u8D25\uFF1A${error.message}`);
      }
    }
    async function copyCaptions(root) {
      try {
        await navigator.clipboard.writeText(captionText());
        setStatus(root, "\u5B57\u5E55\u5DF2\u590D\u5236\u3002");
      } catch (error) {
        setStatus(root, `\u590D\u5236\u5931\u8D25\uFF1A${error.message}`);
      }
    }
    function exportCaptions(root) {
      try {
        const blob = new Blob([captionText()], { type: "text/plain;charset=utf-8" });
        const href = URL.createObjectURL(blob);
        const link = document.createElement("a");
        link.href = href;
        link.download = `echosage-${current?.id || "captions"}.txt`;
        link.click();
        setTimeout(() => URL.revokeObjectURL(href), 1e3);
        setStatus(root, "\u5B57\u5E55\u6587\u4EF6\u5DF2\u5BFC\u51FA\u3002");
      } catch (error) {
        setStatus(root, `\u5BFC\u51FA\u5931\u8D25\uFF1A${error.message}`);
      }
    }
    async function generateSummary() {
      if (!captions.length) {
        summaryError = "\u8FD8\u6CA1\u6709\u53EF\u7528\u4E8E\u603B\u7ED3\u7684\u5B57\u5E55\u3002";
        render();
        return;
      }
      summaryLoading = true;
      summaryError = "";
      render();
      try {
        summaryOutput = await request({ type: "video-chat", task: "summary", captions });
      } catch (error) {
        summaryError = error.message || "\u751F\u6210\u89C6\u9891\u8981\u70B9\u5931\u8D25\u3002";
      } finally {
        summaryLoading = false;
        render();
      }
    }
    async function generateRewrite() {
      if (!captions.length) {
        rewriteError = "\u8FD8\u6CA1\u6709\u53EF\u7528\u4E8E\u4EFF\u5199\u7684\u5B57\u5E55\u3002";
        render();
        return;
      }
      rewriteLoading = true;
      rewriteError = "";
      render();
      try {
        rewriteOutput = await request({
          type: "video-chat",
          task: "rewrite",
          captions,
          duration: rewriteDuration,
          scriptType: rewriteType
        });
      } catch (error) {
        rewriteError = error.message || "\u751F\u6210\u4EFF\u5199\u811A\u672C\u5931\u8D25\u3002";
      } finally {
        rewriteLoading = false;
        render();
      }
    }
    async function setCurrentVideoTranslationEngine(root, engine) {
      const previousOverride = videoTranslationEngineOverride;
      videoTranslationEngineOverride = engine;
      if (!streamingSessionId || !streamIsActive()) {
        setStatus(root, `\u5DF2\u4E3A\u5F53\u524D\u89C6\u9891\u9009\u62E9${engineLabel(engine)}\uFF1B\u5DF2\u5B8C\u6210\u7684\u8BD1\u6587\u4FDD\u6301\u4E0D\u53D8\u3002`);
        render();
        return;
      }
      try {
        await request({ type: "set-video-translation-engine", sessionId: streamingSessionId, translationEngine: engine });
        streamingTranslationEngine = engine;
        setStatus(root, `\u5DF2\u5207\u6362\u5230${engineLabel(engine)}\uFF1B\u53EA\u5F71\u54CD\u4E4B\u540E\u5B9A\u7A3F\u7684\u5B57\u5E55\u3002`);
        render();
      } catch (error) {
        videoTranslationEngineOverride = previousOverride;
        setStatus(root, `\u65E0\u6CD5\u5207\u6362\u7FFB\u8BD1\u5F15\u64CE\uFF1A${error.message}`);
        render();
      }
    }
    function publishVideoOverlay(force = false) {
      if (!videoOverlayEnabled) return;
      if (!force && currentCueIndex === lastOverlayCueIndex) return;
      lastOverlayCueIndex = currentCueIndex;
      chrome.runtime.sendMessage({
        type: "video-overlay-update",
        state: {
          captions,
          translations: translated,
          currentCueIndex
        }
      }).catch(() => {
      });
    }
    function setVideoOverlayEnabled(root, enabled) {
      videoOverlayEnabled = enabled;
      lastOverlayCueIndex = -2;
      if (enabled) {
        publishVideoOverlay(true);
        setStatus(root, "\u5DF2\u6253\u5F00\u89C6\u9891\u60AC\u6D6E\u7A97\uFF1B\u5B83\u4F1A\u6309\u5F53\u524D\u64AD\u653E\u8FDB\u5EA6\u663E\u793A\u53CC\u8BED\u5B57\u5E55\u3002");
      } else {
        chrome.runtime.sendMessage({ type: "video-overlay-stop" }).catch(() => {
        });
        setStatus(root, "\u5DF2\u5173\u95ED\u89C6\u9891\u60AC\u6D6E\u7A97\u3002");
      }
    }
    function publishState() {
      chrome.runtime.sendMessage({
        type: "video-state-update",
        state: {
          video: current,
          captions,
          translations: translated,
          translationEngines,
          translationPending,
          translationEngine: effectiveTranslationEngine(),
          sourceLanguage,
          nativeCaptionsAvailable: Boolean(current?.subtitleUrl),
          nativeCaptionLanguage: current?.subtitleLanguage || "",
          source: captionSource,
          streaming: {
            sessionId: streamingSessionId || null,
            status: streamingStatus,
            currentCueIndex
          }
        }
      }).catch(() => {
      });
      publishVideoOverlay(true);
    }
    function refresh() {
      const id = currentId();
      if (!id) return;
      const data = items.get(id);
      if (id !== activeVideoId) {
        if (streamingSessionId && streamIsActive()) {
          chrome.runtime.sendMessage({ type: "stop-video-capture", sessionId: streamingSessionId, reason: "video-changed" }).catch(() => {
          });
        }
        activeVideoId = id;
        current = data || { id, pending: true };
        captions = [];
        translated = [];
        translationEngines = [];
        translationPending = false;
        captionSource = null;
        workspaceStatus = "";
        streamingSessionId = "";
        streamingStatus = "inactive";
        streamingStopRequested = false;
        streamingTranslationEngine = null;
        videoTranslationEngineOverride = null;
        resetGeneratedContent();
        if (videoOverlayEnabled) chrome.runtime.sendMessage({ type: "video-overlay-stop" }).catch(() => {
        });
        videoOverlayEnabled = false;
        lastOverlayCueIndex = -2;
        sidepanelOpen = false;
        sidepanelCollapsed = false;
        setPagePush(false);
        playbackState = createPlaybackState();
        currentCueIndex = -1;
      } else if (data && current?.pending) {
        current = data;
      } else if (dismissed || document.getElementById(rootId)) {
        return;
      }
      if (!dismissed) render();
    }
    window.addEventListener("message", (event) => {
      if (event.source !== window || event.data?.source !== "echosage-tiktok") return;
      for (const item of event.data.items || []) remember(item);
      refresh();
    });
    window.postMessage({ source: "echosage-tiktok-content", type: "ready" }, location.origin);
    function handleVideoCommand(command) {
      dismissed = false;
      if (command === "redetect") {
        activeVideoId = "";
        current = null;
        refresh();
        render();
        return;
      }
      if (command !== "load-captions") return;
      render();
      const root = document.getElementById(rootId);
      if (!current || current.pending || !$(".tcs-load", root)) return;
      loadCaptions(root);
    }
    chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
      if (message?.type === "video-asr-update") {
        applyVideoAsrUpdate(message);
        sendResponse({ ok: true });
        return true;
      }
      if (message?.type === "video-command") {
        handleVideoCommand(message.command);
        sendResponse({ ok: true });
        return true;
      }
      if (message?.type === "open-video-workspace") {
        dismissed = false;
        openSidepanel(message.view ?? "captions");
        sendResponse({ ok: true });
        return true;
      }
      if (message?.type !== "toggle-panel") return;
      const root = document.getElementById(rootId);
      if (root) dismiss(root);
      else {
        dismissed = false;
        activeVideoId = "";
        current = null;
        refresh();
        if (!document.getElementById(rootId)) render();
      }
      sendResponse({ ok: true });
      return true;
    });
    setInterval(refresh, 1200);
    setInterval(sampleVideoPlayback, 250);
    window.addEventListener("unload", () => setPagePush(false));
    refresh();
  })();
})();
