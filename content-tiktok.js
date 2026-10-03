import {
  ACCENT_COLOR_STORAGE_KEY,
  AUTO_CAPTION_MODE_STORAGE_KEY,
  BILINGUAL_STORAGE_KEY,
  DEFAULT_ACCENT_COLOR,
  DEFAULT_BILINGUAL,
  DEFAULT_SOURCE_LANGUAGE,
  DEFAULT_TARGET_LANGUAGE,
  DEFAULT_VIDEO_TRANSLATION_ENGINE,
  SOURCE_LANGUAGE_STORAGE_KEY,
  TARGET_LANGUAGES,
  TARGET_LANGUAGE_STORAGE_KEY,
  VIDEO_TRANSLATION_ENGINE_STORAGE_KEY,
  normalizeAccentColor,
} from "./shared/settings.js";
import { activeCueIndex, createPlaybackState, samplePlayback } from "./core/playback.js";
import { renderCaptionRows, renderRewriteOutput, renderSummaryList } from "./sidepanel/render.js";

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
  const REWRITE_DURATIONS = ["15 秒", "30 秒", "60 秒"];
  const REWRITE_TYPES = ["口播", "种草", "知识讲解"];
  let rewriteDuration = "30 秒";
  let rewriteType = "口播";
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
    [BILINGUAL_STORAGE_KEY]: DEFAULT_BILINGUAL,
  }).then(values => {
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
    // popup 和侧边栏是同一份设置的两个入口，任一边改动另一边立刻跟上。
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
      chrome.runtime.sendMessage({ type: "video-overlay-stop" }).catch(() => {});
      videoOverlayEnabled = false;
    }
    sidepanelOpen = false;
    sidepanelCollapsed = false;
    setPagePush(false);
    root.remove();
    dismissed = true;
  }

  const $ = (selector, parent = document) => parent.querySelector(selector);
  const text = value => String(value || "").trim();
  const number = value => new Intl.NumberFormat("zh-CN", { notation: "compact", maximumFractionDigits: 1 }).format(Number(value || 0));
  const pad = value => String(Math.floor(value)).padStart(2, "0");
  const timestamp = value => {
    const seconds = Number(value || 0);
    return `${pad(seconds / 60)}:${pad(seconds % 60)}`;
  };
  const decode = input => new DOMParser().parseFromString(input, "text/html").body.textContent || "";
  const escapeHtml = input => String(input || "").replace(/[&<>\"']/g, char => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '\"': "&quot;", "'": "&#39;" })[char]);

  // Video records arrive from inject.js, which taps TikTok's own API responses.
  const items = new Map();

  function remember(item) {
    const stats = item.stats || item.statistics || {};
    const video = item.video || {};
    const subtitleInfos = video.subtitleInfos || video.subtitle_infos || [];
    const original = video.claInfo?.originalLanguageInfo?.language || item.textLanguage || "";
    const webvtt = entry => (entry.Format || entry.format || "").toLowerCase() === "webvtt";
    const native = subtitleInfos.find(entry => webvtt(entry) && (entry.LanguageCodeName || entry.languageCodeName) === original) || subtitleInfos.find(webvtt);
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
    const title = escapeHtml(product.title || "TikTok Shop 商品");
    const image = product.image ? `<img src="${escapeHtml(product.image)}" alt="">` : "<span class=\"tcs-product-image-empty\">商品</span>";
    const destination = product.url
      ? `<a class="tcs-product-link" href="${escapeHtml(product.url)}" target="_blank" rel="noopener noreferrer">查看商品</a>`
      : "<span class=\"tcs-product-unavailable\">暂未提供商品链接</span>";
    const extra = current.products.length > 1 ? `<span class="tcs-product-count">+${current.products.length - 1}</span>` : "";
    return `<div class="tcs-product-anchor">
      <button class="tcs-product-trigger" type="button" aria-label="查看带货商品" title="查看带货商品"><span class="tcs-bag-icon" aria-hidden="true"></span>${extra}</button>
      <section class="tcs-product-popover" role="tooltip">
        ${image}<div class="tcs-product-details"><strong>${title}</strong><small>商品 ID: ${escapeHtml(product.id)}</small>${destination}</div>
      </section>
    </div>`;
  }

  // In the feed the URL does not always change, so fall back to whichever player owns the viewport.
  function visibleId() {
    let best = null;
    let bestScore = 0;
    for (const video of document.querySelectorAll("video")) {
      const rect = video.getBoundingClientRect();
      const visible = Math.max(0, Math.min(rect.bottom, innerHeight) - Math.max(rect.top, 0));
      if (!rect.width || !visible) continue;
      const score = visible * (video.paused ? 0.4 : 1);
      if (score > bestScore) { bestScore = score; best = video; }
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
    return blocks.map(block => {
      const lines = block.split("\n").filter(Boolean);
      const timeLine = lines.find(line => line.includes("-->"));
      if (!timeLine) return null;
      const [start, end] = timeLine.split("-->").map(part => part.trim().split(" ")[0]);
      const seconds = stamp => { const parts = stamp.replace(",", ".").split(":").map(Number); return parts.length === 3 ? parts[0] * 3600 + parts[1] * 60 + parts[2] : parts[0] * 60 + parts[1]; };
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
    return engine === "ai" ? "AI 模型" : "本地模型";
  }

  function translationProgressText() {
    const total = captions.length;
    const completed = translated.filter(Boolean).length;
    const engines = new Set(translationEngines.filter(Boolean));
    const label = engines.size > 1 ? "混合引擎" : engineLabel([...engines][0]);
    if (translationPending) return `${completed} / ${total} 句已翻译 · ${label}翻译中`;
    return `${completed} / ${total} 句已翻译 · ${label}`;
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
      escapeHtml,
    });
  }

  function rewriteMarkup() {
    return renderRewriteOutput({
      output: rewriteOutput,
      loading: rewriteLoading,
      error: rewriteError,
      escapeHtml,
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
    const targetOptions = TARGET_LANGUAGES.map(({ value, label }) =>
      `<option value="${value}" ${value === targetLanguage ? "selected" : ""}>${escapeHtml(label)}</option>`
    ).join("");
    const rewriteTypeOptions = REWRITE_TYPES.map(value =>
      `<option ${value === rewriteType ? "selected" : ""}>${value}</option>`
    ).join("");
    const rewriteDurationOptions = REWRITE_DURATIONS.map(value =>
      `<option ${value === rewriteDuration ? "selected" : ""}>${value}</option>`
    ).join("");
    return `
      <aside class="tcs-sidepanel ${sidepanelOpen ? "is-open" : ""} ${sidepanelCollapsed ? "is-collapsed" : ""}" aria-hidden="${!sidepanelOpen}">
        <button class="tcs-expand" type="button" aria-label="展开侧边栏">‹</button>
        <header class="tcs-sidepanel-header">
          <div class="tcs-brand"><span class="tcs-mark">E</span><strong>EchoSage</strong><small>侧边栏</small></div>
          <div class="tcs-panel-actions">
            <button class="tcs-collapse" type="button" title="收起" aria-label="收起侧边栏">»</button>
            <button class="tcs-sidepanel-close" type="button" title="关闭" aria-label="关闭侧边栏">✕</button>
          </div>
        </header>
        <nav class="tcs-side-tabs" aria-label="视频工作区">
          <button type="button" data-side-tab="captions" aria-selected="${captionsSelected}">字幕和翻译</button>
          <button type="button" data-side-tab="summary" aria-selected="${!captionsSelected}">总结和仿写</button>
        </nav>
        <section class="tcs-side-view ${captionsSelected ? "" : "is-hidden"}" data-side-view="captions">
          <div class="tcs-side-controls">
            <div class="tcs-control-row">
              <label class="tcs-lang-pill"><span class="tcs-lang-tag">译</span><select class="tcs-target-language" aria-label="译文语言">${targetOptions}</select><span class="tcs-caret" aria-hidden="true">▾</span></label>
              <label class="tcs-switch"><span class="tcs-switch-text">双语</span><input class="tcs-switch-bilingual" type="checkbox" ${bilingual ? "checked" : ""}><span class="tcs-track"></span></label>
              <button class="tcs-copy" type="button" title="复制全文" aria-label="复制全文">⧉</button>
            </div>
            <div class="tcs-control-row">
              <label class="tcs-switch"><input class="tcs-follow" type="checkbox" ${followPlayback ? "checked" : ""}><span class="tcs-track"></span><span class="tcs-switch-text">跟随播放</span></label>
              <label class="tcs-switch"><input class="tcs-video-overlay" type="checkbox" ${videoOverlayEnabled ? "checked" : ""}><span class="tcs-track"></span><span class="tcs-switch-text">悬浮窗</span></label>
              <span class="tcs-spacer"></span>
              <label class="tcs-switch"><input class="tcs-ai-engine" type="checkbox" ${currentEngine === "ai" ? "checked" : ""}><span class="tcs-track"></span><span class="tcs-switch-text">AI 翻译</span></label>
            </div>
            <div class="tcs-actions">
              <button class="tcs-load" type="button">获取字幕</button>
              ${current.subtitleUrl ? "" : `<button class="tcs-stream" type="button">${streamIsActive() ? "停止流式转写" : "开始流式转写"}</button>`}
            </div>
          </div>
          <div class="tcs-captions">${captionRows()}</div>
          <footer class="tcs-status-bar">
            <div class="tcs-status-lines">
              <strong class="tcs-progress">${escapeHtml(translationProgressText())}</strong>
              <span class="tcs-status">${escapeHtml(workspaceStatus)}</span>
            </div>
            <button class="tcs-export" type="button">导出</button>
            <button class="tcs-goto-summary" type="button">总结</button>
          </footer>
        </section>
        <section class="tcs-side-view ${captionsSelected ? "is-hidden" : ""}" data-side-view="summary">
          <div class="tcs-generation-section">
            <div class="tcs-generation-heading">
              <h2>视频要点</h2>
              <button class="tcs-generate-summary" type="button" ${captions.length ? "" : "disabled"}>${summaryOutput ? "重新生成" : "生成要点"}</button>
            </div>
            <div class="tcs-summary-result">${summaryListMarkup()}</div>
          </div>
          <div class="tcs-generation-section tcs-generation-grow">
            <div class="tcs-generation-heading">
              <h2>仿写脚本</h2>
              <div class="tcs-rewrite-controls">
                <label class="tcs-pill-select"><select class="tcs-rewrite-type" aria-label="脚本类型">${rewriteTypeOptions}</select><span class="tcs-caret" aria-hidden="true">▾</span></label>
                <label class="tcs-pill-select"><select class="tcs-rewrite-duration" aria-label="脚本时长">${rewriteDurationOptions}</select><span class="tcs-caret" aria-hidden="true">▾</span></label>
              </div>
            </div>
            <div class="tcs-rewrite-result">${rewriteMarkup()}</div>
          </div>
          <div class="tcs-summary-actions">
            <button class="tcs-copy-rewrite" type="button" ${rewriteOutput ? "" : "disabled"}>复制脚本</button>
            <button class="tcs-generate-rewrite" type="button" ${captions.length ? "" : "disabled"}>${rewriteOutput ? "再写一版" : "生成脚本"}</button>
          </div>
        </section>
      </aside>`;
  }

  function render() {
    const root = mount();
    if (!current || current.pending) {
      root.innerHTML = `
        <section class="tcs-card tcs-card-empty">
          <div class="tcs-top"><strong>EchoSage</strong><button class="tcs-close" title="关闭">×</button></div>
          <p class="tcs-placeholder">${current ? "正在读取当前视频数据…" : "未能在当前页面识别到视频。<br>请打开 TikTok 视频详情页（/@用户/video/…）后重试。"}</p>
        </section>`;
      $(".tcs-close", root).onclick = () => dismiss(root);
      publishState();
      return;
    }
    const date = current.createdAt ? new Date(Number(current.createdAt) * 1000).toLocaleDateString("zh-CN") : "--";
    root.innerHTML = `
      <section class="tcs-card">
        ${current.cover ? `<img class="tcs-cover" src="${escapeHtml(current.cover)}" alt="视频封面">` : "<div class=\"tcs-cover tcs-empty\">无封面</div>"}
        ${productAnchor()}
        <div class="tcs-top"><strong>EchoSage</strong><button class="tcs-close" title="关闭">×</button></div>
        <div class="tcs-metrics">
          <span title="播放"><b>▷</b> ${number(current.plays)}</span><span title="分享"><b>↗</b> ${number(current.shares)}</span>
          <span title="评论"><b>◌</b> ${number(current.comments)}</span><span title="点赞"><b>♡</b> ${number(current.likes)}</span>
        </div>
        <time>发布于 ${date}</time>
        <button class="tcs-open">字幕和翻译</button>
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
      escapeHtml,
    });
  }
  async function request(message) {
    const result = await chrome.runtime.sendMessage(message);
    if (!result?.ok) throw new Error(result?.error || "请求失败。");
    return result.data;
  }

  function setStatus(root, value) {
    workspaceStatus = value;
    const status = root ? $(".tcs-status", root) : null;
    if (status) status.textContent = value;
  }
  function setBusy(root, button, value) { button.disabled = value; button.dataset.label ||= button.textContent; button.textContent = value ? "处理中..." : button.dataset.label; }
  function updateRows(root) {
    const list = $(".tcs-captions", root);
    if (list) list.innerHTML = captionRows();
    // 逐条翻译是增量的，不走 render()，所以「N / M 句已翻译」必须在这里
    // 一起刷——否则设计稿上那行计数会一直停在开始时的数字。
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
        setStatus(root, "当前视频没有原生字幕。");
        publishState();
        return;
      }
      captions = parseVtt(await request({ type: "fetch-video-vtt", url: current.subtitleUrl }));
      if (!captions.length) throw new Error("未解析到原生字幕。");
      resetGeneratedContent();
      translated = [];
      translationEngines = [];
      captionSource = "native";
      updateRows(root);
      root.querySelectorAll("[data-ai]").forEach(button => button.disabled = !captions.length);
      setStatus(root, `已获取 ${captions.length} 条原生字幕，准备翻译。`);
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
      requestedEngine === "ai"
        ? "字幕已齐全，正在由 AI 整段批量翻译…"
        : "正在使用 Chrome 内置 nano 逐条即时翻译…"
    );
    publishState();
    try {
      const data = await request({
        type: "translate-video-captions",
        captions: requestedCaptions,
        sourceLanguage,
        translationEngine: requestedEngine,
      });
      // 用户已切到另一条视频时，旧请求不能把译文贴到新视频上。
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
        requestedEngine === "ai"
          ? `AI 已完成 ${translatedCount} 条字幕的整段翻译。`
          : `Chrome 内置 nano 已完成 ${translatedCount} 条即时翻译。`
      );
      publishState();
    } catch (error) {
      if (activeVideoId !== requestedVideoId || captions !== requestedCaptions) return;
      translationPending = false;
      updateRows(root);
      setStatus(root, `字幕已获取，但翻译失败：${error.message}`);
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
    const startSeconds = previous
      ? Math.max(previous.endSeconds ?? previous.startSeconds ?? 0, 0)
      : Math.max(0, now - 1.5);
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
      index,
    };
  }

  function applyStreamingRecords(records) {
    const byTurn = new Map(captions.map((caption) => [caption.streamTurnIndex, caption]));
    const next = [];
    for (let index = 0; index < records.length; index += 1) {
      const record = records[index];
      const previous = next[index - 1];
      const known = byTurn.get(record.turnIndex);
      const cue = known
        ? {
            ...known,
            text: record.text,
            translation: record.translation || "",
            translationEngine: record.translationEngine,
          }
        : cueForStreamingRecord(record, index, previous);
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
    if (state.translationError) return `转写已保留，但翻译失败：${state.translationError}`;
    if (state.ended && state.reason === "video-playthrough") {
      return "视频已播放完一轮，流式转写已自动停止。";
    }
    if (state.status === "idle") return "检测到长时间静音，已暂停上传；视频恢复说话后会自动继续。";
    if (state.status === "reconnecting") return "转写连接中断，正在自动重连…";
    if (state.status === "inactive" && state.pendingBatchCount) return "转写已结束，正在由 AI 整段批量翻译…";
    if (state.translationEngine === "ai" && state.pendingBatchCount) {
      return "正在流式转写；AI 会在视频播完一轮后整段翻译。";
    }
    if (state.status === "capturing") return "正在流式转写并使用本地模型即时翻译…";
    return "流式转写已停止。";
  }

  async function startStreaming(root) {
    if (current?.subtitleUrl) {
      setStatus(root, "当前视频已有原生字幕，优先读取原生字幕。");
      return;
    }
    if (streamIsActive()) {
      setStatus(root, "当前视频正在流式转写。");
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
    setStatus(root, "正在建立视频流式转写…");
    publishState();
    try {
      const data = await request({
        type: "start-video-capture",
        videoId: requestedVideoId,
        sourceLanguage,
        translationEngine: requestedEngine,
      });
      if (activeVideoId !== requestedVideoId) return;
      streamingSessionId = data.sessionId;
      if (streamingStopRequested) {
        await stopStreaming(root);
        return;
      }
      streamingStatus = "capturing";
      setStatus(root, requestedEngine === "ai"
        ? "正在流式转写；AI 会在视频播完一轮后整段翻译。"
        : "正在流式转写并使用本地模型即时翻译…");
      publishState();
      render();
    } catch (error) {
      if (activeVideoId !== requestedVideoId) return;
      streamingStatus = "inactive";
      translationPending = false;
      setStatus(root, `无法启动流式转写：${error.message}`);
      publishState();
    }
  }

  async function stopStreaming(root, reason = "user-stop") {
    if (!streamingSessionId) {
      streamingStopRequested = true;
      setStatus(root, "正在取消流式转写启动…");
      return;
    }
    const sessionId = streamingSessionId;
    streamingStatus = "stopping";
    setStatus(root, reason === "video-playthrough" ? "视频已播完一轮，正在结束转写…" : "正在停止流式转写…");
    try {
      await request({ type: "stop-video-capture", sessionId, reason });
    } catch (error) {
      streamingStatus = "inactive";
      setStatus(root, `停止流式转写失败：${error.message}`);
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
      paused: video.paused,
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
    root.querySelectorAll("[data-side-tab]").forEach(button => {
      button.onclick = () => {
        sidepanelTab = button.dataset.sideTab;
        render();
      };
    });
    $(".tcs-load", root).onclick = () => loadCaptions(root);
    const streamButton = $(".tcs-stream", root);
    if (streamButton) {
      streamButton.onclick = () => streamIsActive()
        ? stopStreaming(root)
        : startStreaming(root);
    }
    $(".tcs-switch-bilingual", root).onchange = event => {
      bilingual = event.target.checked;
      chrome.storage.local.set({ [BILINGUAL_STORAGE_KEY]: bilingual }).catch(() => {});
      updateRows(root);
    };
    $(".tcs-target-language", root).onchange = event => {
      targetLanguage = event.target.value;
      chrome.storage.local.set({ [TARGET_LANGUAGE_STORAGE_KEY]: targetLanguage }).catch(() => {});
      setStatus(root, "已切换译文语言；重新获取字幕后生效。");
    };
    $(".tcs-follow", root).onchange = event => {
      followPlayback = event.target.checked;
      lastFollowedCue = -1;
      refreshPlaybackPresentation(root);
    };
    $(".tcs-video-overlay", root).onchange = event => setVideoOverlayEnabled(root, event.target.checked);
    $(".tcs-ai-engine", root).onchange = event => setCurrentVideoTranslationEngine(root, event.target.checked ? "ai" : "builtin");
    $(".tcs-copy", root).onclick = () => copyCaptions(root);
    $(".tcs-export", root).onclick = () => exportCaptions(root);
    $(".tcs-generate-summary", root).onclick = () => generateSummary();
    $(".tcs-rewrite-duration", root).onchange = event => { rewriteDuration = event.target.value; };
    $(".tcs-rewrite-type", root).onchange = event => { rewriteType = event.target.value; };
    $(".tcs-generate-rewrite", root).onclick = () => generateRewrite();
    $(".tcs-copy-rewrite", root).onclick = () => copyRewrite(root);
    $(".tcs-goto-summary", root).onclick = () => {
      sidepanelTab = "summary";
      render();
      if (captions.length && !summaryOutput && !summaryLoading) generateSummary();
    };
    root.querySelectorAll(".tcs-open-options").forEach(button => {
      button.onclick = () => chrome.runtime.sendMessage({ type: "open-options" }).catch(() => {});
    });
  }

  function captionText() {
    return captions.map((caption, index) => {
      const translation = translated[index] ? `\n${translated[index]}` : "";
      return `${caption.start}-${caption.end}\n${caption.text}${translation}`;
    }).join("\n\n");
  }

  async function copyRewrite(root) {
    try {
      await navigator.clipboard.writeText(rewriteOutput);
      setStatus(root, "仿写脚本已复制。");
    } catch (error) {
      setStatus(root, `复制失败：${error.message}`);
    }
  }

  async function copyCaptions(root) {
    try {
      await navigator.clipboard.writeText(captionText());
      setStatus(root, "字幕已复制。");
    } catch (error) {
      setStatus(root, `复制失败：${error.message}`);
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
      setTimeout(() => URL.revokeObjectURL(href), 1000);
      setStatus(root, "字幕文件已导出。");
    } catch (error) {
      setStatus(root, `导出失败：${error.message}`);
    }
  }

  async function generateSummary() {
    if (!captions.length) {
      summaryError = "还没有可用于总结的字幕。";
      render();
      return;
    }
    summaryLoading = true;
    summaryError = "";
    render();
    try {
      summaryOutput = await request({ type: "video-chat", task: "summary", captions });
    } catch (error) {
      summaryError = error.message || "生成视频要点失败。";
    } finally {
      summaryLoading = false;
      render();
    }
  }

  async function generateRewrite() {
    if (!captions.length) {
      rewriteError = "还没有可用于仿写的字幕。";
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
        scriptType: rewriteType,
      });
    } catch (error) {
      rewriteError = error.message || "生成仿写脚本失败。";
    } finally {
      rewriteLoading = false;
      render();
    }
  }

  async function setCurrentVideoTranslationEngine(root, engine) {
    const previousOverride = videoTranslationEngineOverride;
    videoTranslationEngineOverride = engine;
    if (!streamingSessionId || !streamIsActive()) {
      setStatus(root, `已为当前视频选择${engineLabel(engine)}；已完成的译文保持不变。`);
      render();
      return;
    }
    try {
      await request({ type: "set-video-translation-engine", sessionId: streamingSessionId, translationEngine: engine });
      streamingTranslationEngine = engine;
      setStatus(root, `已切换到${engineLabel(engine)}；只影响之后定稿的字幕。`);
      render();
    } catch (error) {
      videoTranslationEngineOverride = previousOverride;
      setStatus(root, `无法切换翻译引擎：${error.message}`);
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
        currentCueIndex,
      },
    }).catch(() => {});
  }

  function setVideoOverlayEnabled(root, enabled) {
    videoOverlayEnabled = enabled;
    lastOverlayCueIndex = -2;
    if (enabled) {
      publishVideoOverlay(true);
      setStatus(root, "已打开视频悬浮窗；它会按当前播放进度显示双语字幕。");
    } else {
      chrome.runtime.sendMessage({ type: "video-overlay-stop" }).catch(() => {});
      setStatus(root, "已关闭视频悬浮窗。");
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
          currentCueIndex,
        },
      },
    }).catch(() => {});
    publishVideoOverlay(true);
  }

  function refresh() {
    const id = currentId();
    if (!id) return;
    const data = items.get(id);
    if (id !== activeVideoId) {
      // A different video is on screen: drop the previous video's captions.
      if (streamingSessionId && streamIsActive()) {
        chrome.runtime.sendMessage({ type: "stop-video-capture", sessionId: streamingSessionId, reason: "video-changed" }).catch(() => {});
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
      if (videoOverlayEnabled) chrome.runtime.sendMessage({ type: "video-overlay-stop" }).catch(() => {});
      videoOverlayEnabled = false;
      lastOverlayCueIndex = -2;
      sidepanelOpen = false;
      sidepanelCollapsed = false;
      setPagePush(false);
      playbackState = createPlaybackState();
      currentCueIndex = -1;
    } else if (data && current?.pending) {
      current = data; // The API response for the video already on screen just arrived.
    } else if (dismissed || document.getElementById(rootId)) {
      return;
    }
    if (!dismissed) render();
  }

  window.addEventListener("message", event => {
    if (event.source !== window || event.data?.source !== "echosage-tiktok") return;
    for (const item of event.data.items || []) remember(item);
    refresh();
  });
  window.postMessage({ source: "echosage-tiktok-content", type: "ready" }, location.origin);

  // The toolbar button toggles the panel, so the user can bring it back after closing it.
  // popup 侧只有两个动作需要页内配合：读一次字幕、重扫当前视频。
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
    // popup 可能在浮层还没渲染过的时候就按了「翻译字幕」，而 loadCaptions
    // 要在 root 里找 .tcs-load 才能显示忙碌态——先确保完整标记存在。
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
