(() => {
  // shared/settings.js
  var STORAGE_KEY = "assemblyaiApiKey";
  var TRIGGER_STORAGE_KEY = "translateTrigger";
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
  var SOURCE_LANGUAGE_STORAGE_KEY = "sourceLanguage";
  var DEFAULT_SOURCE_LANGUAGE = "es";
  var VIDEO_TRANSLATION_ENGINE_STORAGE_KEY = "videoTranslationEngine";
  var DEFAULT_VIDEO_TRANSLATION_ENGINE = "builtin";
  var SOURCE_LANGUAGES = [
    { value: "es", label: "\u897F\u73ED\u7259\u8BED" },
    { value: "en", label: "\u82F1\u8BED" },
    { value: "ja", label: "\u65E5\u8BED" },
    { value: "ko", label: "\u97E9\u8BED" },
    { value: "fr", label: "\u6CD5\u8BED" },
    { value: "de", label: "\u5FB7\u8BED" },
    { value: "pt", label: "\u8461\u8404\u7259\u8BED" }
  ];

  // core/update.js
  var STABLE_VERSION = /^v?(\d+)(?:\.(\d+))?(?:\.(\d+))?$/;
  var UPDATE_CHECK_INTERVAL_MS = 24 * 60 * 60 * 1e3;
  var ACTIVE_CAPTURE_STATUSES = /* @__PURE__ */ new Set(["capturing", "idle", "reconnecting"]);
  function parseStableVersion(value) {
    if (typeof value !== "string") return null;
    const match = STABLE_VERSION.exec(value.trim());
    if (!match) return null;
    return match.slice(1).map((part) => Number(part ?? 0));
  }
  function hasAvailableUpdate(releasedVersion, runningVersion) {
    const released = parseStableVersion(releasedVersion);
    const running = parseStableVersion(runningVersion);
    if (!released || !running) return false;
    for (let index = 0; index < 3; index += 1) {
      if (released[index] !== running[index]) return released[index] > running[index];
    }
    return false;
  }
  function withView(state) {
    const availableUpdate = hasAvailableUpdate(state.releasedVersion, state.runningVersion);
    const checkButton = state.checkStatus === "checking" ? { label: "\u68C0\u67E5\u4E2D", disabled: true } : availableUpdate ? { label: "\u53D1\u73B0\u65B0\u7248\u672C", disabled: true } : { label: "\u68C0\u67E5\u66F4\u65B0", disabled: false };
    const captureActive = ACTIVE_CAPTURE_STATUSES.has(state.captureStatus);
    return {
      ...state,
      view: {
        availableUpdate,
        runningVersion: state.runningVersion,
        releasedVersion: state.releasedVersion,
        releaseUrl: state.releaseUrl,
        checkButton,
        message: state.feedback?.message ?? null,
        messageTone: state.feedback?.tone ?? null,
        updateInstructions: availableUpdate ? {
          pull: "\u7B2C 1 \u6B65\uFF1A\u5230\u4ED3\u5E93\u6839\u76EE\u5F55\u53CC\u51FB update.bat\uFF0C\u5B8C\u6210\u62C9\u53D6\u3002",
          reload: "\u7B2C 2 \u6B65\uFF1A\u62C9\u53D6\u5B8C\u6210\u540E\u56DE\u5230\u8FD9\u91CC\u91CD\u8F7D\u6269\u5C55\uFF0C\u8BA9\u78C1\u76D8\u4E0A\u7684\u65B0\u4EE3\u7801\u751F\u6548\u3002",
          badge: "\u5DE5\u5177\u680F\u89D2\u6807\u4F1A\u5728\u91CD\u8F7D\u4E4B\u540E\u6D88\u5931\uFF1B\u53EA\u5B8C\u6210\u62C9\u53D6\u65F6\u4ECD\u4F1A\u663E\u793A\u3002"
        } : null,
        reloadButton: {
          visible: availableUpdate,
          label: "\u6211\u5DF2\u62C9\u53D6\uFF0C\u91CD\u8F7D\u6269\u5C55",
          disabled: !availableUpdate || captureActive,
          reason: captureActive ? "\u6B63\u5728\u6355\u83B7\uFF1B\u91CD\u8F7D\u4F1A\u4E2D\u65AD\u6355\u83B7\u5E76\u4E22\u5931\u5F53\u524D\u5B57\u5E55\u3002\u8BF7\u5148\u505C\u6B62\u6355\u83B7\u3002" : "\u91CD\u8F7D\u4F1A\u5173\u95ED\u5F53\u524D\u8BBE\u7F6E\u9875\u3002"
        }
      }
    };
  }
  function createUpdateState(persisted = {}) {
    return withView({
      releasedVersion: persisted.releasedVersion ?? null,
      releaseUrl: persisted.releaseUrl ?? null,
      lastCheckedAt: persisted.lastCheckedAt ?? null,
      runningVersion: null,
      captureStatus: "inactive",
      checkStatus: "idle",
      checkOrigin: null,
      feedback: null
    });
  }
  function updateReducer(state, event) {
    switch (event.type) {
      case "host-started": {
        let next = withView({
          ...state,
          runningVersion: event.runningVersion,
          captureStatus: event.captureStatus
        });
        const stale = !Number.isFinite(next.lastCheckedAt) || event.now - next.lastCheckedAt > UPDATE_CHECK_INTERVAL_MS;
        const commands = [{ type: "set-badge", text: next.view.availableUpdate ? "\u2022" : "" }];
        if (stale) {
          next = withView({ ...next, checkStatus: "checking", checkOrigin: "scheduled" });
          commands.push({ type: "fetch-release" });
        }
        return { state: next, commands };
      }
      case "alarm-fired":
        if (state.checkStatus === "checking") return { state, commands: [] };
        return {
          state: withView({
            ...state,
            checkStatus: "checking",
            checkOrigin: "scheduled",
            feedback: null
          }),
          commands: [{ type: "fetch-release" }]
        };
      case "user-requested-check":
        if (state.checkStatus === "checking") {
          return state.checkOrigin === "scheduled" ? {
            state: withView({ ...state, checkOrigin: "user", feedback: null }),
            commands: []
          } : { state, commands: [] };
        }
        return {
          state: withView({
            ...state,
            checkStatus: "checking",
            checkOrigin: "user",
            feedback: null
          }),
          commands: [{ type: "fetch-release" }]
        };
      case "check-succeeded": {
        const fromUser = state.checkOrigin === "user";
        let next = withView({
          ...state,
          releasedVersion: event.releasedVersion,
          releaseUrl: event.releaseUrl,
          lastCheckedAt: event.now,
          checkStatus: "idle",
          checkOrigin: null,
          feedback: null
        });
        if (fromUser) {
          next = withView({
            ...next,
            feedback: {
              message: next.view.availableUpdate ? "\u53D1\u73B0\u53EF\u7528\u66F4\u65B0\u3002" : "\u5DF2\u662F\u6700\u65B0\u7248\u672C\u3002",
              tone: "success"
            }
          });
        }
        return {
          state: next,
          commands: [
            {
              type: "persist",
              releasedVersion: event.releasedVersion,
              releaseUrl: event.releaseUrl,
              lastCheckedAt: event.now
            },
            { type: "set-badge", text: next.view.availableUpdate ? "\u2022" : "" }
          ]
        };
      }
      case "check-failed": {
        const feedback = state.checkOrigin === "user" ? { message: `\u68C0\u67E5\u5931\u8D25\uFF1A${event.reason}`, tone: "error" } : null;
        return {
          state: withView({
            ...state,
            checkStatus: "idle",
            checkOrigin: null,
            feedback
          }),
          commands: []
        };
      }
      case "capture-status-changed":
        return {
          state: withView({ ...state, captureStatus: event.captureStatus }),
          commands: []
        };
      case "user-requested-reload":
        return state.view.reloadButton.visible && !state.view.reloadButton.disabled ? { state, commands: [{ type: "reload-extension" }] } : { state, commands: [] };
      default:
        return { state, commands: [] };
    }
  }

  // background.js
  var OFFSCREEN_DOCUMENT_PATH = "/offscreen.html";
  var UPDATE_ALARM = "release-update-check";
  var RELEASE_ENDPOINT = "https://api.github.com/repos/Fluxwang/EchoSage/releases/latest";
  var UPDATE_STORAGE = {
    releasedVersion: "updateReleasedVersion",
    releaseUrl: "updateReleaseUrl",
    lastCheckedAt: "updateLastCheckedAt"
  };
  var creatingOffscreenDocument;
  var capturedTabId = null;
  var videoStates = /* @__PURE__ */ new Map();
  var videoCaptureSessions = /* @__PURE__ */ new Map();
  var updateState = createUpdateState();
  var updateHostInitialization;
  function broadcastUpdateView() {
    chrome.runtime.sendMessage({
      type: "update-state-changed",
      view: updateState.view
    }).catch(() => {
    });
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
        [UPDATE_STORAGE.lastCheckedAt]: command.lastCheckedAt
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
        headers: { Accept: "application/vnd.github+json" }
      });
      if (!response.ok) throw new Error(`GitHub \u8FD4\u56DE HTTP ${response.status}`);
      const release = await response.json();
      if (!release.tag_name || !release.html_url) throw new Error("Release \u4FE1\u606F\u4E0D\u5B8C\u6574");
      dispatchUpdate({
        type: "check-succeeded",
        now: Date.now(),
        releasedVersion: release.tag_name,
        releaseUrl: release.html_url
      });
    } catch (error) {
      dispatchUpdate({
        type: "check-failed",
        now: Date.now(),
        reason: error.message || "\u65E0\u6CD5\u8FDE\u63A5 GitHub"
      });
    }
  }
  async function currentCaptureStatus() {
    if (!await hasOffscreenDocument()) return "inactive";
    const status = await chrome.runtime.sendMessage({ target: "offscreen", type: "get-capture-status" }).catch(() => null);
    const liveStatus = status?.liveStatus ?? "inactive";
    const videoActive = Boolean(status?.videoActive) || videoCaptureSessions.size > 0;
    return videoActive && liveStatus === "inactive" ? "capturing" : liveStatus;
  }
  function refreshUpdateCaptureStatus() {
    ensureUpdateHost().then(async () => dispatchUpdate({
      type: "capture-status-changed",
      captureStatus: await currentCaptureStatus()
    }));
  }
  async function initializeUpdateHost() {
    const stored = await chrome.storage.local.get(Object.values(UPDATE_STORAGE));
    updateState = createUpdateState({
      releasedVersion: stored[UPDATE_STORAGE.releasedVersion],
      releaseUrl: stored[UPDATE_STORAGE.releaseUrl],
      lastCheckedAt: stored[UPDATE_STORAGE.lastCheckedAt]
    });
    await chrome.alarms.create(UPDATE_ALARM, { periodInMinutes: 24 * 60 });
    dispatchUpdate({
      type: "host-started",
      now: Date.now(),
      runningVersion: chrome.runtime.getManifest().version,
      captureStatus: await currentCaptureStatus()
    });
  }
  function ensureUpdateHost() {
    updateHostInitialization ??= initializeUpdateHost();
    return updateHostInitialization;
  }
  async function hasOffscreenDocument() {
    const existingContexts = await chrome.runtime.getContexts({
      contextTypes: ["OFFSCREEN_DOCUMENT"],
      documentUrls: [chrome.runtime.getURL(OFFSCREEN_DOCUMENT_PATH)]
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
        justification: "\u9700\u8981\u5728\u79BB\u5C4F\u9875\u9762\u4E2D\u7528 AudioContext \u5904\u7406 tabCapture \u62FF\u5230\u7684\u97F3\u9891\u6D41"
      });
      await creatingOffscreenDocument;
      creatingOffscreenDocument = null;
    }
  }
  async function startCapture(requestedSourceLanguage) {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (!tab) {
      throw new Error("\u672A\u627E\u5230\u5F53\u524D\u6FC0\u6D3B\u7684\u6807\u7B7E\u9875");
    }
    const stored = await chrome.storage.local.get([
      STORAGE_KEY,
      TRIGGER_STORAGE_KEY,
      SOURCE_LANGUAGE_STORAGE_KEY
    ]);
    const apiKey = stored[STORAGE_KEY];
    if (!apiKey) {
      chrome.runtime.sendMessage({
        type: "capture-blocked",
        reason: "missing-key",
        message: "\u5C1A\u672A\u914D\u7F6E AssemblyAI API Key\u3002\u8BF7\u5230\u8BBE\u7F6E\u9875\u586B\u5199\u540E\u518D\u5F00\u59CB\u3002"
      }).catch(() => {
      });
      return;
    }
    const candidateLanguage = requestedSourceLanguage ?? stored[SOURCE_LANGUAGE_STORAGE_KEY];
    const sourceLanguage = SOURCE_LANGUAGES.some(({ value }) => value === candidateLanguage) ? candidateLanguage : DEFAULT_SOURCE_LANGUAGE;
    await setupOffscreenDocument();
    const sessionState = await chrome.runtime.sendMessage({ target: "offscreen", type: "get-state" }).catch(() => null);
    if (["capturing", "idle", "reconnecting"].includes(sessionState?.status)) {
      chrome.runtime.sendMessage({
        type: "capture-status",
        status: "\u2139\uFE0F \u5DF2\u7ECF\u5728\u6355\u83B7\u4E2D\u3002\u5148\u505C\u6B62\u518D\u91CD\u65B0\u5F00\u59CB\u3002"
      }).catch(() => {
      });
      return;
    }
    const streamId = await chrome.tabCapture.getMediaStreamId({
      targetTabId: tab.id
    });
    chrome.runtime.sendMessage({
      target: "offscreen",
      type: "start-capture",
      streamId,
      apiKey,
      // 触发模式随本次会话固定（设置页改动下次开始才生效）。与 Key 同理：
      // offscreen 没有 chrome.storage，配置读取全部收拢在 background。
      translateTrigger: stored[TRIGGER_STORAGE_KEY] ?? "pause",
      sourceLanguage
    });
    capturedTabId = tab.id;
    await ensureOverlay(tab.id);
  }
  async function ensureOverlay(tabId) {
    try {
      await chrome.tabs.sendMessage(tabId, { type: "subtitle-start" });
      return;
    } catch {
    }
    try {
      await chrome.scripting.executeScript({
        target: { tabId },
        files: ["dist/content-overlay.js"]
      });
    } catch (err) {
      console.warn("\u6CE8\u5165\u5B57\u5E55\u6D6E\u5C42\u5931\u8D25:", err.message);
    }
  }
  async function stopCapture() {
    if (capturedTabId !== null) {
      const tabId = capturedTabId;
      capturedTabId = null;
      chrome.tabs.sendMessage(tabId, { type: "subtitle-stop" }).catch(() => {
      });
    }
    chrome.runtime.sendMessage({
      target: "offscreen",
      type: "stop-capture"
    });
  }
  function handleHandshake(sender, sendResponse) {
    const capturing = capturedTabId !== null && sender.tab?.id === capturedTabId;
    sendResponse({ capturing });
  }
  function relaySubtitle(message) {
    const liveStatus = message.state?.phase ?? message.state?.status;
    if (liveStatus) {
      ensureUpdateHost().then(() => dispatchUpdate({
        type: "capture-status-changed",
        captureStatus: videoCaptureSessions.size > 0 && liveStatus === "inactive" ? "capturing" : liveStatus
      }));
    }
    if (capturedTabId === null) return;
    chrome.tabs.sendMessage(capturedTabId, {
      type: "subtitle-update",
      state: message.state
    }).catch(() => {
    });
  }
  function chatEndpoint(baseUrl) {
    return `${baseUrl.replace(/\/$/, "")}/v1/chat/completions`;
  }
  function resolveSourceLanguage(candidate) {
    return SOURCE_LANGUAGES.some(({ value }) => value === candidate) ? candidate : DEFAULT_SOURCE_LANGUAGE;
  }
  function resolveVideoTranslationEngine(candidate) {
    return candidate === "ai" ? "ai" : DEFAULT_VIDEO_TRANSLATION_ENGINE;
  }
  function parseTranslationArray(content, expectedLength) {
    const stripped = String(content ?? "").trim().replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "");
    let parsed;
    try {
      parsed = JSON.parse(stripped);
    } catch {
      throw new Error("AI \u7FFB\u8BD1\u8FD4\u56DE\u7684\u4E0D\u662F\u53EF\u7528\u7684 JSON \u6570\u7EC4\u3002\u8BF7\u68C0\u67E5\u6240\u9009\u804A\u5929\u6A21\u578B\u3002");
    }
    const values = Array.isArray(parsed) ? parsed : parsed?.translations;
    if (!Array.isArray(values) || values.length !== expectedLength || values.some((value) => typeof value !== "string")) {
      throw new Error("AI \u7FFB\u8BD1\u8FD4\u56DE\u7684\u6761\u6570\u6216\u683C\u5F0F\u4E0E\u5B57\u5E55\u4E0D\u5339\u914D\u3002");
    }
    return values;
  }
  async function translateVideoWithAi(units, config) {
    const baseUrl = config[CHAT_BASE_URL_STORAGE_KEY];
    const apiKey = config[CHAT_API_KEY_STORAGE_KEY];
    const model = config[CHAT_MODEL_STORAGE_KEY];
    if (!baseUrl || !apiKey || !model) {
      throw new Error("\u8BF7\u5148\u5728\u8BBE\u7F6E\u9875\u586B\u5199 AI \u63A5\u53E3\u7684 Base URL\u3001API Key \u548C\u804A\u5929\u6A21\u578B\u3002");
    }
    const response = await fetch(chatEndpoint(baseUrl), {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${apiKey}`
      },
      body: JSON.stringify({
        model,
        temperature: 0.2,
        messages: [
          {
            role: "system",
            content: "You translate subtitle units into Simplified Chinese. Preserve meaning, timestamps are not part of the translation, and return valid JSON only."
          },
          {
            role: "user",
            content: `Translate every item below into Simplified Chinese. Return exactly one JSON array of strings in the same order; no markdown, explanation, or omitted items.

${JSON.stringify(units.map(({ text }) => text))}`
          }
        ]
      })
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(data.error?.message || "AI \u7FFB\u8BD1\u8BF7\u6C42\u5931\u8D25\u3002");
    const content = data.choices?.[0]?.message?.content;
    return parseTranslationArray(content, units.length).map((text, index) => ({
      index: units[index].index,
      text
    }));
  }
  async function translateVideoCaptions(message) {
    const captions = Array.isArray(message.captions) ? message.captions : [];
    const units = captions.map((caption, index) => ({
      index,
      text: String(caption?.text ?? "").trim()
    }));
    if (!units.length) throw new Error("\u8FD8\u6CA1\u6709\u53EF\u7FFB\u8BD1\u7684\u89C6\u9891\u5B57\u5E55\u3002");
    const config = await chrome.storage.local.get({
      ...CHAT_DEFAULTS,
      [SOURCE_LANGUAGE_STORAGE_KEY]: DEFAULT_SOURCE_LANGUAGE,
      [VIDEO_TRANSLATION_ENGINE_STORAGE_KEY]: DEFAULT_VIDEO_TRANSLATION_ENGINE
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
        translations: await translateVideoWithAi(units, config)
      };
    }
    await setupOffscreenDocument();
    const result = await chrome.runtime.sendMessage({
      target: "offscreen",
      type: "translate-video-units",
      units,
      sourceLanguage
    });
    if (!result?.ok) throw new Error(result?.error || "\u672C\u5730\u7FFB\u8BD1\u5931\u8D25\u3002");
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
      reason
    }).catch(() => {
    });
    if (videoCaptureSessions.get(tabId)?.sessionId === session.sessionId) {
      videoCaptureSessions.delete(tabId);
      refreshUpdateCaptureStatus();
    }
    return { ok: true };
  }
  async function startVideoCapture(message, sender) {
    const tabId = sender.tab?.id;
    if (!tabId) throw new Error("\u53EA\u80FD\u4ECE TikTok \u89C6\u9891\u9875\u9762\u542F\u52A8\u6D41\u5F0F\u8F6C\u5199\u3002");
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
      [VIDEO_TRANSLATION_ENGINE_STORAGE_KEY]: DEFAULT_VIDEO_TRANSLATION_ENGINE
    });
    if (!stored[STORAGE_KEY]) {
      throw new Error("\u5C1A\u672A\u914D\u7F6E AssemblyAI API Key\u3002\u8BF7\u5230\u8BBE\u7F6E\u9875\u586B\u5199\u540E\u518D\u5F00\u59CB\u3002");
    }
    const sourceLanguage = resolveSourceLanguage(
      message.sourceLanguage ?? stored[SOURCE_LANGUAGE_STORAGE_KEY]
    );
    const translationEngine = resolveVideoTranslationEngine(
      message.translationEngine ?? stored[VIDEO_TRANSLATION_ENGINE_STORAGE_KEY]
    );
    await setupOffscreenDocument();
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
        translationEngine
      });
      if (!response?.ok) throw new Error(response?.error || "\u65E0\u6CD5\u542F\u52A8\u89C6\u9891\u8F6C\u5199\u3002");
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
    if (!session || message.sessionId && message.sessionId !== session.sessionId) {
      throw new Error("\u5F53\u524D\u89C6\u9891\u6CA1\u6709\u8FDB\u884C\u4E2D\u7684\u6D41\u5F0F\u8F6C\u5199\u3002\u5F15\u64CE\u8BBE\u7F6E\u4F1A\u7528\u4E8E\u4E0B\u4E00\u6B21\u5F00\u59CB\u3002");
    }
    const translationEngine = resolveVideoTranslationEngine(message.translationEngine);
    const response = await chrome.runtime.sendMessage({
      target: "offscreen",
      type: "set-video-translation-engine",
      sessionId: session.sessionId,
      translationEngine
    });
    if (!response?.ok) throw new Error(response?.error || "\u65E0\u6CD5\u5207\u6362\u89C6\u9891\u7FFB\u8BD1\u5F15\u64CE\u3002");
    return { ok: true, data: { sessionId: session.sessionId, translationEngine } };
  }
  async function translateVideoAsrBatch(message) {
    const units = Array.isArray(message.units) ? message.units.map((unit, index) => ({
      index: Number.isInteger(unit.turnIndex) ? unit.turnIndex : index,
      text: String(unit.text ?? "").trim()
    })) : [];
    if (!units.length) return { ok: true, data: { translations: [] } };
    const config = await chrome.storage.local.get(CHAT_DEFAULTS);
    const translated = await translateVideoWithAi(units, config);
    return {
      ok: true,
      data: {
        translations: translated.map(({ index, text }) => ({ turnIndex: index, text }))
      }
    };
  }
  function relayVideoAsrState(message) {
    if (!Number.isInteger(message.tabId)) return;
    chrome.tabs.sendMessage(message.tabId, {
      type: "video-asr-update",
      sessionId: message.sessionId,
      videoId: message.videoId,
      state: message.state
    }).catch(() => {
    });
  }
  async function relayVideoOverlay(message, sender) {
    const tabId = sender.tab?.id;
    if (!tabId) throw new Error("\u65E0\u6CD5\u5173\u8054\u5F53\u524D TikTok \u6807\u7B7E\u9875\u3002");
    await chrome.tabs.sendMessage(tabId, {
      type: message.type === "video-overlay-stop" ? "video-subtitle-stop" : "video-subtitle-update",
      state: message.state
    }).catch(() => {
    });
    return { ok: true };
  }
  async function generateVideoText({ task, captions, duration, scriptType }) {
    const config = await chrome.storage.local.get(CHAT_DEFAULTS);
    const baseUrl = config[CHAT_BASE_URL_STORAGE_KEY];
    const apiKey = config[CHAT_API_KEY_STORAGE_KEY];
    const model = config[CHAT_MODEL_STORAGE_KEY];
    if (!baseUrl || !apiKey || !model) {
      throw new Error("\u8BF7\u5148\u5728\u8BBE\u7F6E\u9875\u586B\u5199 AI \u63A5\u53E3\u7684 Base URL\u3001API Key \u548C\u804A\u5929\u6A21\u578B\u3002");
    }
    const transcript = (captions ?? []).map(({ start, end, text }) => `[${start ?? "--:--"}-${end ?? "--:--"}] ${text ?? ""}`).join("\n");
    if (!transcript.trim()) throw new Error("\u8FD8\u6CA1\u6709\u53EF\u7528\u4E8E\u751F\u6210\u7684\u5B57\u5E55\u3002");
    const instruction = task === "summary" ? "\u7528\u4E2D\u6587\u63D0\u70BC\u8FD9\u6BB5 TikTok \u5B57\u5E55\u7684\u8981\u70B9\u3002\u8FD4\u56DE\u7B80\u6D01\u7684\u7F16\u53F7\u5217\u8868\uFF0C\u5E76\u8BF4\u660E\u521B\u4F5C\u8005\u7684\u8868\u8FBE\u65B9\u5F0F\u3002" : `\u6839\u636E\u8FD9\u6BB5 TikTok \u5B57\u5E55\u7684\u4E3B\u9898\u548C\u7ED3\u6784\uFF0C\u5199\u4E00\u4EFD\u5168\u65B0\u7684\u4E2D\u6587${scriptType || "\u53E3\u64AD"}\u77ED\u89C6\u9891\u811A\u672C\uFF0C\u65F6\u957F\u7EA6${duration || "30 \u79D2"}\u3002\u4E0D\u8981\u590D\u7528\u539F\u53E5\uFF1B\u5305\u542B\u5F00\u573A\u94A9\u5B50\u30013 \u5230 5 \u4E2A\u8981\u70B9\u548C\u7ED3\u5C3E\u884C\u52A8\u53F7\u53EC\u3002`;
    const response = await fetch(chatEndpoint(baseUrl), {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${apiKey}`
      },
      body: JSON.stringify({
        model,
        temperature: task === "summary" ? 0.4 : 0.7,
        messages: [
          { role: "system", content: "You are a precise Chinese creator assistant." },
          { role: "user", content: `${instruction}

\u5B57\u5E55\uFF1A
${transcript}` }
        ]
      })
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(data.error?.message || "AI \u63A5\u53E3\u8BF7\u6C42\u5931\u8D25\u3002");
    const result = data.choices?.[0]?.message?.content?.trim();
    if (!result) throw new Error("AI \u63A5\u53E3\u6CA1\u6709\u8FD4\u56DE\u53EF\u7528\u5185\u5BB9\u3002");
    return result;
  }
  async function activeVideoState() {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    return tab?.id ? videoStates.get(tab.id) ?? null : null;
  }
  async function handleVideoMessage(message, sender) {
    switch (message.type) {
      case "video-state-update": {
        if (!sender.tab?.id) throw new Error("\u65E0\u6CD5\u5173\u8054\u5F53\u524D TikTok \u6807\u7B7E\u9875\u3002");
        const state = { ...message.state, tabId: sender.tab.id };
        videoStates.set(sender.tab.id, state);
        chrome.runtime.sendMessage({ type: "video-state-changed", state }).catch(() => {
        });
        return { ok: true };
      }
      case "get-active-video-state":
        return { ok: true, data: await activeVideoState() };
      case "fetch-video-vtt": {
        if (!message.url) throw new Error("\u539F\u751F\u5B57\u5E55\u5730\u5740\u4E3A\u7A7A\u3002");
        const response = await fetch(message.url);
        if (!response.ok) throw new Error("\u539F\u751F\u5B57\u5E55\u4E0B\u8F7D\u5931\u8D25\u3002");
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
        if (!tab?.id) throw new Error("\u672A\u627E\u5230\u5F53\u524D\u6807\u7B7E\u9875\u3002");
        await chrome.tabs.sendMessage(tab.id, {
          type: "open-video-workspace",
          view: message.view ?? "captions"
        });
        return { ok: true };
      }
      // popup 的「翻译字幕」「重新检测」需要让页内脚本动手：它持有 items
      // 缓存和当前视频，background 只做转发，不复制那套状态。
      case "video-command": {
        const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
        if (!tab?.id) throw new Error("\u672A\u627E\u5230\u5F53\u524D\u6807\u7B7E\u9875\u3002");
        await chrome.tabs.sendMessage(tab.id, { type: "video-command", command: message.command });
        return { ok: true };
      }
      default:
        return null;
    }
  }
  chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (message.type === "get-update-view") {
      ensureUpdateHost().then(async () => {
        dispatchUpdate({
          type: "capture-status-changed",
          captureStatus: await currentCaptureStatus()
        });
        sendResponse({ ok: true, data: updateState.view });
      }).catch((error) => sendResponse({ ok: false, error: error.message }));
      return true;
    }
    if (message.type === "user-requested-update-check") {
      ensureUpdateHost().then(() => sendResponse({
        ok: true,
        data: dispatchUpdate({ type: "user-requested-check", now: Date.now() })
      })).catch((error) => sendResponse({ ok: false, error: error.message }));
      return true;
    }
    if (message.type === "user-requested-extension-reload") {
      ensureUpdateHost().then(() => dispatchUpdate({ type: "user-requested-reload" })).catch(() => {
      });
      sendResponse({ ok: true });
      return;
    }
    if ([
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
      "video-command"
    ].includes(message.type)) {
      handleVideoMessage(message, sender).then(sendResponse).catch((error) => sendResponse({ ok: false, error: error.message || "\u8BF7\u6C42\u5931\u8D25\u3002" }));
      return true;
    }
    if (message.type === "content-script-handshake") {
      handleHandshake(sender, sendResponse);
      return;
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
      refreshUpdateCaptureStatus();
      return;
    }
    if (message.type === "video-asr-batch-translation-request") {
      translateVideoAsrBatch(message).then(sendResponse).catch((error) => sendResponse({ ok: false, error: error.message || "AI \u6279\u91CF\u7FFB\u8BD1\u5931\u8D25\u3002" }));
      return true;
    }
    if (message.type === "open-options") {
      const openOptions = message.section ? chrome.tabs.create({ url: chrome.runtime.getURL(`options.html#${message.section}`) }) : chrome.runtime.openOptionsPage();
      openOptions.then(() => sendResponse({ ok: true })).catch((error) => sendResponse({ ok: false, error: error.message || "\u65E0\u6CD5\u6253\u5F00\u8BBE\u7F6E\u9875\u3002" }));
      return true;
    }
    if (message.type === "session-ended") {
      if (capturedTabId !== null) {
        const tabId = capturedTabId;
        capturedTabId = null;
        chrome.tabs.sendMessage(tabId, { type: "subtitle-stop", reason: message.reason }).catch(() => {
        });
      }
      refreshUpdateCaptureStatus();
      return;
    }
    if (message.type === "start-capture-request") {
      startCapture(message.sourceLanguage).catch((err) => {
        console.error("\u542F\u52A8\u6355\u83B7\u5931\u8D25:", err);
        chrome.runtime.sendMessage({
          type: "capture-status",
          status: `\u274C \u542F\u52A8\u5931\u8D25: ${err.message}`
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
      now: Date.now()
    }));
  });
  ensureUpdateHost().catch((error) => console.warn("\u66F4\u65B0\u68C0\u67E5\u521D\u59CB\u5316\u5931\u8D25:", error));
})();
