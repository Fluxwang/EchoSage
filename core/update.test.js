import assert from "node:assert/strict";
import test from "node:test";

import { createUpdateState, updateReducer } from "./update.js";

const NOW = Date.UTC(2026, 8, 20, 12);

function startWith(releasedVersion, runningVersion = "1.2.0") {
  return updateReducer(
    createUpdateState({
      releasedVersion,
      releaseUrl: "https://github.com/Fluxwang/EchoSage/releases/latest",
      lastCheckedAt: NOW,
    }),
    {
      type: "host-started",
      now: NOW,
      runningVersion,
      captureStatus: "inactive",
    },
  );
}

test("宿主启动时用缓存版本立即投影角标且不联网", () => {
  const result = startWith("v1.3.0");

  assert.equal(result.state.view.availableUpdate, true);
  assert.deepEqual(result.commands, [{ type: "set-badge", text: "•" }]);
});

test("版本比较容忍 v 前缀和缺失位，并且只接受稳定发布版本严格大于运行版本", () => {
  const cases = [
    ["v1.3", "1.2.9", true],
    ["1.2", "1.2.0", false],
    ["1.1.9", "1.2.0", false],
    ["2.0.0-beta.1", "1.2.0", false],
    ["not-a-version", "1.2.0", false],
    [undefined, "1.2.0", false],
    ["1.3.0", "broken", false],
  ];

  for (const [releasedVersion, runningVersion, availableUpdate] of cases) {
    const result = startWith(releasedVersion, runningVersion);
    assert.equal(
      result.state.view.availableUpdate,
      availableUpdate,
      `${releasedVersion} > ${runningVersion}`,
    );
    assert.deepEqual(result.commands, [
      { type: "set-badge", text: availableUpdate ? "•" : "" },
    ]);
  }
});

test("宿主启动时只有缓存超过 24 小时才补做更新检查", () => {
  const fresh = startWith("1.2.0");
  assert.equal(fresh.state.view.checkButton.label, "检查更新");

  const stale = updateReducer(
    createUpdateState({ releasedVersion: "1.2.0", lastCheckedAt: NOW - 86_400_001 }),
    {
      type: "host-started",
      now: NOW,
      runningVersion: "1.2.0",
      captureStatus: "inactive",
    },
  );
  assert.equal(stale.state.view.checkButton.label, "检查中");
  assert.deepEqual(stale.commands, [
    { type: "set-badge", text: "" },
    { type: "fetch-release" },
  ]);
});

test("定时检查不会重复发请求，成功后持久化结果并重算角标", () => {
  const started = startWith("1.2.0").state;
  const checking = updateReducer(started, { type: "alarm-fired", now: NOW + 1 });
  assert.deepEqual(checking.commands, [{ type: "fetch-release" }]);
  assert.deepEqual(
    updateReducer(checking.state, { type: "alarm-fired", now: NOW + 2 }).commands,
    [],
  );

  const succeeded = updateReducer(checking.state, {
    type: "check-succeeded",
    now: NOW + 3,
    releasedVersion: "v1.3.0",
    releaseUrl: "https://github.com/Fluxwang/EchoSage/releases/tag/v1.3.0",
  });
  assert.equal(succeeded.state.view.availableUpdate, true);
  assert.equal(succeeded.state.view.checkButton.label, "发现新版本");
  assert.deepEqual(succeeded.commands, [
    {
      type: "persist",
      releasedVersion: "v1.3.0",
      releaseUrl: "https://github.com/Fluxwang/EchoSage/releases/tag/v1.3.0",
      lastCheckedAt: NOW + 3,
    },
    { type: "set-badge", text: "•" },
  ]);
});

test("定时检查进行中被用户主动查看时不重复请求，但后续失败会展示", () => {
  const scheduled = updateReducer(startWith("1.2.0").state, {
    type: "alarm-fired",
    now: NOW + 1,
  });
  const requested = updateReducer(scheduled.state, {
    type: "user-requested-check",
    now: NOW + 2,
  });
  assert.deepEqual(requested.commands, []);

  const failed = updateReducer(requested.state, {
    type: "check-failed",
    now: NOW + 3,
    reason: "offline",
  });
  assert.equal(failed.state.view.message, "检查失败：offline");
});

test("定时检查失败静默保留缓存，主动检查失败才进入用户可见错误态", () => {
  const started = startWith("1.2.0").state;
  const scheduled = updateReducer(started, { type: "alarm-fired", now: NOW + 1 });
  const silentFailure = updateReducer(scheduled.state, {
    type: "check-failed",
    now: NOW + 2,
    reason: "offline",
  });
  assert.equal(silentFailure.state.lastCheckedAt, NOW);
  assert.equal(silentFailure.state.view.message, null);
  assert.deepEqual(silentFailure.commands, []);

  const requested = updateReducer(silentFailure.state, {
    type: "user-requested-check",
    now: NOW + 3,
  });
  assert.equal(requested.state.view.checkButton.label, "检查中");
  assert.deepEqual(requested.commands, [{ type: "fetch-release" }]);

  const visibleFailure = updateReducer(requested.state, {
    type: "check-failed",
    now: NOW + 4,
    reason: "无法连接 GitHub",
  });
  assert.equal(visibleFailure.state.view.message, "检查失败：无法连接 GitHub");
  assert.equal(visibleFailure.state.view.messageTone, "error");
  assert.deepEqual(visibleFailure.commands, []);
});

test("主动检查已是最新时给出明确回执", () => {
  const requested = updateReducer(startWith("1.2.0").state, {
    type: "user-requested-check",
    now: NOW + 1,
  });
  const succeeded = updateReducer(requested.state, {
    type: "check-succeeded",
    now: NOW + 2,
    releasedVersion: "1.2.0",
    releaseUrl: "https://github.com/Fluxwang/EchoSage/releases/tag/v1.2.0",
  });

  assert.equal(succeeded.state.view.message, "已是最新版本。");
  assert.equal(succeeded.state.view.messageTone, "success");
});

test("捕获进行中或重连中时禁用重载，停止捕获后立即恢复", () => {
  const started = startWith("1.3.0").state;

  for (const captureStatus of ["capturing", "idle", "reconnecting"]) {
    const active = updateReducer(started, {
      type: "capture-status-changed",
      captureStatus,
    });
    assert.equal(active.state.view.reloadButton.disabled, true);
    assert.match(active.state.view.reloadButton.reason, /中断.*字幕/);
    assert.deepEqual(
      updateReducer(active.state, { type: "user-requested-reload" }).commands,
      [],
    );
  }

  const inactive = updateReducer(started, {
    type: "capture-status-changed",
    captureStatus: "inactive",
  });
  assert.equal(inactive.state.view.reloadButton.disabled, false);
  assert.equal(inactive.state.view.reloadButton.reason, "重载会关闭当前设置页。");
  assert.deepEqual(
    updateReducer(inactive.state, { type: "user-requested-reload" }).commands,
    [{ type: "reload-extension" }],
  );
});

test("没有可用更新时不显示重载流程，也不响应重载请求", () => {
  const state = startWith("1.2.0").state;

  assert.equal(state.view.reloadButton.visible, false);
  assert.equal(state.view.updateInstructions, null);
  assert.deepEqual(
    updateReducer(state, { type: "user-requested-reload" }).commands,
    [],
  );
});

test("运行版本追上发布版本后清除角标", () => {
  const restarted = updateReducer(
    createUpdateState({ releasedVersion: "v1.3.0", lastCheckedAt: NOW }),
    {
      type: "host-started",
      now: NOW,
      runningVersion: "1.3.0",
      captureStatus: "inactive",
    },
  );

  assert.equal(restarted.state.view.availableUpdate, false);
  assert.deepEqual(restarted.commands, [{ type: "set-badge", text: "" }]);
});
