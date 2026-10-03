// Background service worker
// 职责：管理 Offscreen Document 的生命周期，触发 tabCapture，
// 把拿到的 streamId 转发给 offscreen 页面去做实际的音频处理。
//
// 为什么需要 Offscreen Document：
// MV3 的 service worker 没有 AudioContext / getUserMedia 这些能力，
// 必须借助一个隐藏的 offscreen 页面来处理音频，这是官方推荐的标准做法。

import {
  CHAT_API_KEY_STORAGE_KEY,
  CHAT_BASE_URL_STORAGE_KEY,
  CHAT_DEFAULTS,
  CHAT_MODEL_STORAGE_KEY,
  DEFAULT_SOURCE_LANGUAGE,
  DEFAULT_VIDEO_TRANSLATION_ENGINE,
  SOURCE_LANGUAGE_STORAGE_KEY,
  SOURCE_LANGUAGES,
  STORAGE_KEY,
  TRIGGER_STORAGE_KEY,
  VIDEO_TRANSLATION_ENGINE_STORAGE_KEY,
} from "./shared/settings.js";
import { createUpdateState, updateReducer } from "./core/update.js";

const OFFSCREEN_DOCUMENT_PATH = "/offscreen.html";
const UPDATE_ALARM = "release-update-check";
const RELEASE_ENDPOINT = "https://api.github.com/repos/Fluxwang/EchoSage/releases/latest";
const UPDATE_STORAGE = {
  releasedVersion: "updateReleasedVersion",
  releaseUrl: "updateReleaseUrl",
  lastCheckedAt: "updateLastCheckedAt",
};

let creatingOffscreenDocument; // 防止并发重复创建的锁
let capturedTabId = null; // 字幕只投递给这个标签页（ticket 06）
// TikTok content script 把当前活跃视频的轻量快照放在这里。popup 是短生命
// 周期页面，不能自己持有页面数据；以 tab 为键也避免不同标签页相互覆盖。
const videoStates = new Map();
// 以 tab 为键的流式视频会话。它与 live 的 capturedTabId 完全分离，允许
// 一个直播标签页和一个 TikTok 视频标签页同时各跑一条 AssemblyAI 会话。
const videoCaptureSessions = new Map();
let updateState = createUpdateState();
let updateHostInitialization;

function broadcastUpdateView() {
  chrome.runtime.sendMessage({
    type: "update-state-changed",
    view: updateState.view,
  }).catch(() => {});
}

function dispatchUpdate(event) {
  const result = updateReducer(updateState, event);
  updateState = result.state;
  broadcastUpdateView();
  for (const command of result.commands) executeUpdateCommand(command);
  return updateState.view;
}

function executeUpdateCommand(command) {
  if (command.type === "set-badge") {
    chrome.action.setBadgeBackgroundColor({ color: "#d93025" });
    chrome.action.setBadgeText({ text: command.text });
  } else if (command.type === "persist") {
    chrome.storage.local.set({
      [UPDATE_STORAGE.releasedVersion]: command.releasedVersion,
      [UPDATE_STORAGE.releaseUrl]: command.releaseUrl,
      [UPDATE_STORAGE.lastCheckedAt]: command.lastCheckedAt,
    });
  } else if (command.type === "fetch-release") {
    fetchLatestRelease();
  } else if (command.type === "reload-extension") {
    chrome.runtime.reload();
  }
}

async function fetchLatestRelease() {
  try {
    const response = await fetch(RELEASE_ENDPOINT, {
      headers: { Accept: "application/vnd.github+json" },
    });
    if (!response.ok) throw new Error(`GitHub 返回 HTTP ${response.status}`);
    const release = await response.json();
    if (!release.tag_name || !release.html_url) throw new Error("Release 信息不完整");
    dispatchUpdate({
      type: "check-succeeded",
      now: Date.now(),
      releasedVersion: release.tag_name,
      releaseUrl: release.html_url,
    });
  } catch (error) {
    dispatchUpdate({
      type: "check-failed",
      now: Date.now(),
      reason: error.message || "无法连接 GitHub",
    });
  }
}

async function currentCaptureStatus() {
  if (!(await hasOffscreenDocument())) return "inactive";
  const status = await chrome.runtime
    .sendMessage({ target: "offscreen", type: "get-capture-status" })
    .catch(() => null);
  const liveStatus = status?.liveStatus ?? "inactive";
  const videoActive = Boolean(status?.videoActive) || videoCaptureSessions.size > 0;
  return videoActive && liveStatus === "inactive"
    ? "capturing"
    : liveStatus;
}

function refreshUpdateCaptureStatus() {
  ensureUpdateHost().then(async () => dispatchUpdate({
    type: "capture-status-changed",
    captureStatus: await currentCaptureStatus(),
  }));
}

async function initializeUpdateHost() {
  const stored = await chrome.storage.local.get(Object.values(UPDATE_STORAGE));
  updateState = createUpdateState({
    releasedVersion: stored[UPDATE_STORAGE.releasedVersion],
    releaseUrl: stored[UPDATE_STORAGE.releaseUrl],
    lastCheckedAt: stored[UPDATE_STORAGE.lastCheckedAt],
  });
  await chrome.alarms.create(UPDATE_ALARM, { periodInMinutes: 24 * 60 });
  dispatchUpdate({
    type: "host-started",
    now: Date.now(),
    runningVersion: chrome.runtime.getManifest().version,
    captureStatus: await currentCaptureStatus(),
  });
}

function ensureUpdateHost() {
  updateHostInitialization ??= initializeUpdateHost();
  return updateHostInitialization;
}

async function hasOffscreenDocument() {
  const existingContexts = await chrome.runtime.getContexts({
    contextTypes: ["OFFSCREEN_DOCUMENT"],
    documentUrls: [chrome.runtime.getURL(OFFSCREEN_DOCUMENT_PATH)],
  });
  return existingContexts.length > 0;
}

async function setupOffscreenDocument() {
  if (await hasOffscreenDocument()) return;

  if (creatingOffscreenDocument) {
    await creatingOffscreenDocument;
  } else {
    creatingOffscreenDocument = chrome.offscreen.createDocument({
      url: OFFSCREEN_DOCUMENT_PATH,
      reasons: ["USER_MEDIA"],
      justification: "需要在离屏页面中用 AudioContext 处理 tabCapture 拿到的音频流",
    });
    await creatingOffscreenDocument;
    creatingOffscreenDocument = null;
  }
}

async function startCapture(requestedSourceLanguage) {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab) {
    throw new Error("未找到当前激活的标签页");
  }

  // 未填 Key 时明确拦住并引导去设置页，而不是让捕获跑起来后在转写一步
  // 静默失败（换 token 的请求是启动链路里第一个用到 Key 的地方）
  const stored = await chrome.storage.local.get([
    STORAGE_KEY,
    TRIGGER_STORAGE_KEY,
    SOURCE_LANGUAGE_STORAGE_KEY,
  ]);
  const apiKey = stored[STORAGE_KEY];
  if (!apiKey) {
    chrome.runtime.sendMessage({
      type: "capture-blocked",
      reason: "missing-key",
      message: "尚未配置 AssemblyAI API Key。请到设置页填写后再开始。",
    }).catch(() => {}); // popup 可能已关闭
    return;
  }

  const candidateLanguage = requestedSourceLanguage ?? stored[SOURCE_LANGUAGE_STORAGE_KEY];
  const sourceLanguage = SOURCE_LANGUAGES.some(({ value }) => value === candidateLanguage)
    ? candidateLanguage
    : DEFAULT_SOURCE_LANGUAGE;

  await setupOffscreenDocument();

  // 先问 offscreen 是否已在捕获：socket 失败后捕获本身仍在跑（等待重连），
  // 此时再取流会撞 "Cannot capture a tab with an active stream"——
  // 重复开始应该被温和挡住，不是抛错
  const sessionState = await chrome.runtime
    .sendMessage({ target: "offscreen", type: "get-state" })
    .catch(() => null);
  if (["capturing", "idle", "reconnecting"].includes(sessionState?.status)) {
    chrome.runtime.sendMessage({
      type: "capture-status",
      status: "ℹ️ 已经在捕获中。先停止再重新开始。",
    }).catch(() => {});
    return;
  }

  // tabCapture.getMediaStreamId 必须在用户手势触发的调用链里执行，
  // 不能延迟到后台任意时机调用，否则会报权限错误。
  const streamId = await chrome.tabCapture.getMediaStreamId({
    targetTabId: tab.id,
  });

  // Key 随消息传入：offscreen document 里没有 chrome.storage（实测
  // chrome.storage 为 undefined），配置读取收拢在有存储访问的 background。
  chrome.runtime.sendMessage({
    target: "offscreen",
    type: "start-capture",
    streamId,
    apiKey,
    // 触发模式随本次会话固定（设置页改动下次开始才生效）。与 Key 同理：
    // offscreen 没有 chrome.storage，配置读取全部收拢在 background。
    translateTrigger: stored[TRIGGER_STORAGE_KEY] ?? "pause",
    sourceLanguage,
  });

  // 先置位再通知：补注入的 content script 一加载就会握手，
  // 那时 capturedTabId 必须已经是这个标签页，否则它会当成"与我无关"退出。
  capturedTabId = tab.id;
  await ensureOverlay(tab.id);
}

// 让被捕获标签页的浮层立刻出现。
// content script 是声明式注入的，页面加载时就跑完了握手——而正常用法是
// 页面先开着、之后才点开始，所以开始捕获这一刻必须由 background 主动
// 通知，不能指望页面那边自己发现（浮层从来不出现的原因）。
// sendMessage 失败 = 那个页面里没有活的 content script（开发期 reload
// 扩展后声明式注入的那份已成孤儿，或页面早于扩展安装），补一次注入；
// 注入进去的脚本自己会握手，拿到 capturing: true 后建浮层。
async function ensureOverlay(tabId) {
  try {
    await chrome.tabs.sendMessage(tabId, { type: "subtitle-start" });
    return;
  } catch {
    // 没有接收端，往下走注入
  }
  try {
    await chrome.scripting.executeScript({
      target: { tabId },
      files: ["dist/content-overlay.js"],
    });
  } catch (err) {
    // chrome:// 等受限页面注入不了：捕获照常跑，只是没有浮层（popup 仍可看）
    console.warn("注入字幕浮层失败:", err.message);
  }
}

async function stopCapture() {
  // 先通知浮层移除自己再清 capturedTabId——顺序反了 guard 永远不成立，
  // subtitle-stop 从未发出（review 抓出的 bug）
  if (capturedTabId !== null) {
    const tabId = capturedTabId;
    capturedTabId = null;
    chrome.tabs.sendMessage(tabId, { type: "subtitle-stop" }).catch(() => {});
  }
  chrome.runtime.sendMessage({
    target: "offscreen",
    type: "stop-capture",
  });
}

// ---- content script 的握手与字幕投递 ----

// content script 在每个页面加载（ADR-0006），可能在捕获进行中被硬导航
// 重新注入、对状态一无所知——加载时主动来问，这是状态恢复的关键路径。
// 必须比对 sender.tab.id：捕获只属于那一个标签页，同期加载的其他页面
// 要立即退出。
function handleHandshake(sender, sendResponse) {
  const capturing =
    capturedTabId !== null && sender.tab?.id === capturedTabId;
  sendResponse({ capturing });
}

// offscreen 的字幕状态经这里转发给被捕获的标签页（唯一投递对象）
function relaySubtitle(message) {
  const liveStatus = message.state?.phase ?? message.state?.status;
  if (liveStatus) {
    ensureUpdateHost().then(() => dispatchUpdate({
      type: "capture-status-changed",
      captureStatus: videoCaptureSessions.size > 0 && liveStatus === "inactive"
        ? "capturing"
        : liveStatus,
    }));
  }
  if (capturedTabId === null) return;
  chrome.tabs
    .sendMessage(capturedTabId, {
      type: "subtitle-update",
      state: message.state,
    })
    .catch(() => {}); // 标签页可能没有 content script（如 chrome:// 页）
}

function chatEndpoint(baseUrl) {
  return `${baseUrl.replace(/\/$/, "")}/v1/chat/completions`;
}

function resolveSourceLanguage(candidate) {
  return SOURCE_LANGUAGES.some(({ value }) => value === candidate)
    ? candidate
    : DEFAULT_SOURCE_LANGUAGE;
}

function resolveVideoTranslationEngine(candidate) {
  return candidate === "ai" ? "ai" : DEFAULT_VIDEO_TRANSLATION_ENGINE;
}

function parseTranslationArray(content, expectedLength) {
  const stripped = String(content ?? "")
    .trim()
    .replace(/^```(?:json)?\s*/i, "")
    .replace(/\s*```$/, "");
  let parsed;
  try {
    parsed = JSON.parse(stripped);
  } catch {
    throw new Error("AI 翻译返回的不是可用的 JSON 数组。请检查所选聊天模型。");
  }
  const values = Array.isArray(parsed) ? parsed : parsed?.translations;
  if (
    !Array.isArray(values) ||
    values.length !== expectedLength ||
    values.some((value) => typeof value !== "string")
  ) {
    throw new Error("AI 翻译返回的条数或格式与字幕不匹配。");
  }
  return values;
}

async function translateVideoWithAi(units, config) {
  const baseUrl = config[CHAT_BASE_URL_STORAGE_KEY];
  const apiKey = config[CHAT_API_KEY_STORAGE_KEY];
  const model = config[CHAT_MODEL_STORAGE_KEY];
  if (!baseUrl || !apiKey || !model) {
    throw new Error("请先在设置页填写 AI 接口的 Base URL、API Key 和聊天模型。");
  }
  const response = await fetch(chatEndpoint(baseUrl), {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      model,
      temperature: 0.2,
      messages: [
        {
          role: "system",
          content: "You translate subtitle units into Simplified Chinese. Preserve meaning, timestamps are not part of the translation, and return valid JSON only.",
        },
        {
          role: "user",
          content: `Translate every item below into Simplified Chinese. Return exactly one JSON array of strings in the same order; no markdown, explanation, or omitted items.\n\n${JSON.stringify(units.map(({ text }) => text))}`,
        },
      ],
    }),
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data.error?.message || "AI 翻译请求失败。");
  const content = data.choices?.[0]?.message?.content;
  return parseTranslationArray(content, units.length).map((text, index) => ({
    index: units[index].index,
    text,
  }));
}

async function translateVideoCaptions(message) {
  const captions = Array.isArray(message.captions) ? message.captions : [];
  const units = captions.map((caption, index) => ({
    index,
    text: String(caption?.text ?? "").trim(),
  }));
  if (!units.length) throw new Error("还没有可翻译的视频字幕。");

  const config = await chrome.storage.local.get({
    ...CHAT_DEFAULTS,
    [SOURCE_LANGUAGE_STORAGE_KEY]: DEFAULT_SOURCE_LANGUAGE,
    [VIDEO_TRANSLATION_ENGINE_STORAGE_KEY]: DEFAULT_VIDEO_TRANSLATION_ENGINE,
  });
  const engine = resolveVideoTranslationEngine(
    message.translationEngine ?? config[VIDEO_TRANSLATION_ENGINE_STORAGE_KEY]
  );
  const sourceLanguage = resolveSourceLanguage(
    message.sourceLanguage ?? config[SOURCE_LANGUAGE_STORAGE_KEY]
  );
  if (engine === "ai") {
    return {
      engine,
      translations: await translateVideoWithAi(units, config),
    };
  }

  await setupOffscreenDocument();
  const result = await chrome.runtime.sendMessage({
    target: "offscreen",
    type: "translate-video-units",
    units,
    sourceLanguage,
  });
  if (!result?.ok) throw new Error(result?.error || "本地翻译失败。");
  return { engine, translations: result.data?.translations ?? [] };
}

function createVideoSessionId(tabId, videoId) {
  return `video-${tabId}-${videoId || "unknown"}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

async function stopVideoCapture(tabId, reason = "user-stop") {
  const session = videoCaptureSessions.get(tabId);
  if (!session) return { ok: true };
  await chrome.runtime.sendMessage({
    target: "offscreen",
    type: "stop-video-capture",
    sessionId: session.sessionId,
    reason,
  }).catch(() => {});
  // offscreen 已在同步 reducer 调用里释放音频图；现在即可让同一标签页的
  // 新视频建立新的 streamId。旧会话若有 AI 批量翻译仍会用其 sessionId 完成。
  if (videoCaptureSessions.get(tabId)?.sessionId === session.sessionId) {
    videoCaptureSessions.delete(tabId);
    refreshUpdateCaptureStatus();
  }
  return { ok: true };
}

async function startVideoCapture(message, sender) {
  const tabId = sender.tab?.id;
  if (!tabId) throw new Error("只能从 TikTok 视频页面启动流式转写。");
  const videoId = String(message.videoId || "");
  const existing = videoCaptureSessions.get(tabId);
  if (existing?.videoId === videoId) {
    return { ok: true, data: { sessionId: existing.sessionId, alreadyRunning: true } };
  }
  if (existing) await stopVideoCapture(tabId, "video-changed");

  const stored = await chrome.storage.local.get({
    [STORAGE_KEY]: "",
    [TRIGGER_STORAGE_KEY]: "pause",
    [SOURCE_LANGUAGE_STORAGE_KEY]: DEFAULT_SOURCE_LANGUAGE,
    [VIDEO_TRANSLATION_ENGINE_STORAGE_KEY]: DEFAULT_VIDEO_TRANSLATION_ENGINE,
  });
  if (!stored[STORAGE_KEY]) {
    throw new Error("尚未配置 AssemblyAI API Key。请到设置页填写后再开始。");
  }
  const sourceLanguage = resolveSourceLanguage(
    message.sourceLanguage ?? stored[SOURCE_LANGUAGE_STORAGE_KEY]
  );
  const translationEngine = resolveVideoTranslationEngine(
    message.translationEngine ?? stored[VIDEO_TRANSLATION_ENGINE_STORAGE_KEY]
  );

  await setupOffscreenDocument();
  // 和直播一样，此调用必须保持在按钮/自动触发消息抵达 worker 的调用链中；
  // 不把它延迟给 offscreen，否则 Chrome 会拒绝 tabCapture 权限。
  const streamId = await chrome.tabCapture.getMediaStreamId({ targetTabId: tabId });
  const sessionId = createVideoSessionId(tabId, videoId);
  videoCaptureSessions.set(tabId, { sessionId, videoId });
  refreshUpdateCaptureStatus();
  try {
    const response = await chrome.runtime.sendMessage({
      target: "offscreen",
      type: "start-video-capture",
      sessionId,
      tabId,
      videoId,
      streamId,
      apiKey: stored[STORAGE_KEY],
      sourceLanguage,
      translateTrigger: stored[TRIGGER_STORAGE_KEY],
      translationEngine,
    });
    if (!response?.ok) throw new Error(response?.error || "无法启动视频转写。");
  } catch (error) {
    if (videoCaptureSessions.get(tabId)?.sessionId === sessionId) {
      videoCaptureSessions.delete(tabId);
      refreshUpdateCaptureStatus();
    }
    throw error;
  }
  return { ok: true, data: { sessionId } };
}

async function setVideoTranslationEngine(message, sender) {
  const tabId = sender.tab?.id;
  const session = tabId ? videoCaptureSessions.get(tabId) : null;
  if (!session || (message.sessionId && message.sessionId !== session.sessionId)) {
    throw new Error("当前视频没有进行中的流式转写。引擎设置会用于下一次开始。");
  }
  const translationEngine = resolveVideoTranslationEngine(message.translationEngine);
  const response = await chrome.runtime.sendMessage({
    target: "offscreen",
    type: "set-video-translation-engine",
    sessionId: session.sessionId,
    translationEngine,
  });
  if (!response?.ok) throw new Error(response?.error || "无法切换视频翻译引擎。");
  return { ok: true, data: { sessionId: session.sessionId, translationEngine } };
}

async function translateVideoAsrBatch(message) {
  const units = Array.isArray(message.units) ? message.units.map((unit, index) => ({
    index: Number.isInteger(unit.turnIndex) ? unit.turnIndex : index,
    text: String(unit.text ?? "").trim(),
  })) : [];
  if (!units.length) return { ok: true, data: { translations: [] } };
  const config = await chrome.storage.local.get(CHAT_DEFAULTS);
  const translated = await translateVideoWithAi(units, config);
  return {
    ok: true,
    data: {
      translations: translated.map(({ index, text }) => ({ turnIndex: index, text })),
    },
  };
}

function relayVideoAsrState(message) {
  if (!Number.isInteger(message.tabId)) return;
  chrome.tabs.sendMessage(message.tabId, {
    type: "video-asr-update",
    sessionId: message.sessionId,
    videoId: message.videoId,
    state: message.state,
  }).catch(() => {});
}

async function relayVideoOverlay(message, sender) {
  const tabId = sender.tab?.id;
  if (!tabId) throw new Error("无法关联当前 TikTok 标签页。");
  await chrome.tabs.sendMessage(tabId, {
    type: message.type === "video-overlay-stop" ? "video-subtitle-stop" : "video-subtitle-update",
    state: message.state,
  }).catch(() => {});
  return { ok: true };
}

async function generateVideoText({ task, captions, duration, scriptType }) {
  const config = await chrome.storage.local.get(CHAT_DEFAULTS);
  const baseUrl = config[CHAT_BASE_URL_STORAGE_KEY];
  const apiKey = config[CHAT_API_KEY_STORAGE_KEY];
  const model = config[CHAT_MODEL_STORAGE_KEY];
  if (!baseUrl || !apiKey || !model) {
    throw new Error("请先在设置页填写 AI 接口的 Base URL、API Key 和聊天模型。");
  }

  const transcript = (captions ?? [])
    .map(({ start, end, text }) => `[${start ?? "--:--"}-${end ?? "--:--"}] ${text ?? ""}`)
    .join("\n");
  if (!transcript.trim()) throw new Error("还没有可用于生成的字幕。");

  const instruction = task === "summary"
    ? "用中文提炼这段 TikTok 字幕的要点。返回简洁的编号列表，并说明创作者的表达方式。"
    : `根据这段 TikTok 字幕的主题和结构，写一份全新的中文${scriptType || "口播"}短视频脚本，时长约${duration || "30 秒"}。不要复用原句；包含开场钩子、3 到 5 个要点和结尾行动号召。`;
  const response = await fetch(chatEndpoint(baseUrl), {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      model,
      temperature: task === "summary" ? 0.4 : 0.7,
      messages: [
        { role: "system", content: "You are a precise Chinese creator assistant." },
        { role: "user", content: `${instruction}\n\n字幕：\n${transcript}` },
      ],
    }),
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data.error?.message || "AI 接口请求失败。");
  const result = data.choices?.[0]?.message?.content?.trim();
  if (!result) throw new Error("AI 接口没有返回可用内容。");
  return result;
}

async function activeVideoState() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  return tab?.id ? videoStates.get(tab.id) ?? null : null;
}

async function handleVideoMessage(message, sender) {
  switch (message.type) {
    case "video-state-update": {
      if (!sender.tab?.id) throw new Error("无法关联当前 TikTok 标签页。");
      const state = { ...message.state, tabId: sender.tab.id };
      videoStates.set(sender.tab.id, state);
      chrome.runtime.sendMessage({ type: "video-state-changed", state }).catch(() => {});
      return { ok: true };
    }
    case "get-active-video-state":
      return { ok: true, data: await activeVideoState() };
    case "fetch-video-vtt": {
      if (!message.url) throw new Error("原生字幕地址为空。");
      const response = await fetch(message.url);
      if (!response.ok) throw new Error("原生字幕下载失败。");
      return { ok: true, data: await response.text() };
    }
    case "video-chat":
      return { ok: true, data: await generateVideoText(message) };
    case "translate-video-captions":
      return { ok: true, data: await translateVideoCaptions(message) };
    case "start-video-capture":
      return startVideoCapture(message, sender);
    case "stop-video-capture":
      return stopVideoCapture(sender.tab?.id, message.reason);
    case "set-video-translation-engine":
      return setVideoTranslationEngine(message, sender);
    case "video-overlay-update":
    case "video-overlay-stop":
      return relayVideoOverlay(message, sender);
    case "open-video-workspace": {
      const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
      if (!tab?.id) throw new Error("未找到当前标签页。");
      await chrome.tabs.sendMessage(tab.id, {
        type: "open-video-workspace",
        view: message.view ?? "captions",
      });
      return { ok: true };
    }
    // popup 的「翻译字幕」「重新检测」需要让页内脚本动手：它持有 items
    // 缓存和当前视频，background 只做转发，不复制那套状态。
    case "video-command": {
      const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
      if (!tab?.id) throw new Error("未找到当前标签页。");
      await chrome.tabs.sendMessage(tab.id, { type: "video-command", command: message.command });
      return { ok: true };
    }
    default:
      return null;
  }
}

// 监听 popup 发来的控制指令
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.type === "get-update-view") {
    ensureUpdateHost()
      .then(async () => {
        dispatchUpdate({
          type: "capture-status-changed",
          captureStatus: await currentCaptureStatus(),
        });
        sendResponse({ ok: true, data: updateState.view });
      })
      .catch((error) => sendResponse({ ok: false, error: error.message }));
    return true;
  }

  if (message.type === "user-requested-update-check") {
    ensureUpdateHost()
      .then(() => sendResponse({
        ok: true,
        data: dispatchUpdate({ type: "user-requested-check", now: Date.now() }),
      }))
      .catch((error) => sendResponse({ ok: false, error: error.message }));
    return true;
  }

  if (message.type === "user-requested-extension-reload") {
    ensureUpdateHost()
      .then(() => dispatchUpdate({ type: "user-requested-reload" }))
      .catch(() => {});
    sendResponse({ ok: true });
    return;
  }

  if (
    [
      "video-state-update",
      "get-active-video-state",
      "fetch-video-vtt",
      "video-chat",
      "translate-video-captions",
      "start-video-capture",
      "stop-video-capture",
      "set-video-translation-engine",
      "video-overlay-update",
      "video-overlay-stop",
      "open-video-workspace",
      "video-command",
    ].includes(message.type)
  ) {
    handleVideoMessage(message, sender)
      .then(sendResponse)
      .catch((error) => sendResponse({ ok: false, error: error.message || "请求失败。" }));
    return true;
  }

  if (message.type === "content-script-handshake") {
    handleHandshake(sender, sendResponse);
    return; // sendResponse 是同步的
  }

  if (message.type === "subtitle-relay") {
    relaySubtitle(message);
    return;
  }

  if (message.type === "video-asr-state") {
    relayVideoAsrState(message);
    return;
  }

  if (message.type === "video-asr-session-ended") {
    const session = videoCaptureSessions.get(message.tabId);
    if (session?.sessionId === message.sessionId) {
      videoCaptureSessions.delete(message.tabId);
    }
    // service worker 可能在视频会话期间重启，此时内存 map 为空；无论是否
    // 找到条目都从 offscreen 的权威状态重算，保证停止后按钮立即恢复。
    refreshUpdateCaptureStatus();
    return;
  }

  if (message.type === "video-asr-batch-translation-request") {
    translateVideoAsrBatch(message)
      .then(sendResponse)
      .catch((error) => sendResponse({ ok: false, error: error.message || "AI 批量翻译失败。" }));
    return true;
  }

  if (message.type === "open-options") {
    const openOptions = message.section
      ? chrome.tabs.create({ url: chrome.runtime.getURL(`options.html#${message.section}`) })
      : chrome.runtime.openOptionsPage();
    openOptions
      .then(() => sendResponse({ ok: true }))
      .catch((error) => sendResponse({ ok: false, error: error.message || "无法打开设置页。" }));
    return true;
  }

  // offscreen 的会话终止通知转发给浮层（一次性提示，浮层随即移除）
  if (message.type === "session-ended") {
    if (capturedTabId !== null) {
      const tabId = capturedTabId;
      capturedTabId = null;
      chrome.tabs.sendMessage(tabId, { type: "subtitle-stop", reason: message.reason }).catch(() => {});
    }
    refreshUpdateCaptureStatus();
    return;
  }

  if (message.type === "start-capture-request") {
    startCapture(message.sourceLanguage).catch((err) => {
      console.error("启动捕获失败:", err);
      chrome.runtime.sendMessage({
        type: "capture-status",
        status: `❌ 启动失败: ${err.message}`,
      });
    });
  } else if (message.type === "stop-capture-request") {
    stopCapture();
  }
});

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name !== UPDATE_ALARM) return;
  ensureUpdateHost().then(() => dispatchUpdate({
    type: "alarm-fired",
    now: Date.now(),
  }));
});

ensureUpdateHost().catch((error) => console.warn("更新检查初始化失败:", error));
