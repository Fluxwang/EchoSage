# EchoSage

一个 Chrome 扩展（MV3）：捕获标签页音频/视频字幕来源，实时转写、翻译成中文、以双轨字幕呈现。覆盖两个场景——**任意网站的直播实时字幕**和 **TikTok 视频的字幕/总结/仿写**——共用转写、翻译、字幕呈现三层基础设施。

由两个原本互不相关的独立扩展合并而来：**EchoCap**（直播实时字幕）负责任意标签页的实时语音转写，**TikTok Caption Studio**（视频字幕）负责 TikTok 视频详情页的字幕获取与内容生成。合并动机、决策过程见 [`.scratch/echosage-merge/spec.md`](.scratch/echosage-merge/spec.md) 与 [`docs/adr/`](docs/adr/)。

## 功能

**直播实时（Live Scene）**——面向任意标签页：

- 一键捕获当前标签页音频，`tabCapture` 静音原标签页后原样回放，不影响正常观看
- AssemblyAI 实时流式转写，源语言可选（不写死西班牙语），目标语言固定简体中文
- 转写产出立即用 Chrome 内置 Translator（Gemini Nano，端侧模型）翻译，零云端翻译开销
- 页面悬浮双轨字幕：原文轨弱化仅作活跃度提示，译文轨为主视觉
- 长静音（60s）自动断连、会话硬上限（1 小时）双重花钱保险丝，详见 [ADR-0005](docs/adr/0005-session-lifecycle-and-spend-control.md)

**视频字幕（Video Scene）**——面向 TikTok 视频：

- 优先读取 TikTok 原生 WebVTT 字幕轨；没有原生字幕时才触发 AssemblyAI 流式转写，转写会在视频播完一轮后自动停止（不会因为 TikTok 默认循环播放而无限计费）
- 翻译引擎二选一：Chrome 内置 nano（默认，逐句/逐话轮即时翻译）或 AI 模型（整段批量翻译，需自行配置 OpenAI 兼容的 Base URL / API Key / 模型）——引擎选择权只属于这个场景，直播实时场景固定端侧翻译
- 侧边栏工作区：完整字幕列表（跟随播放高亮、双语显示、悬浮窗开关、导出）+ 视频要点总结 + 按口播时长/类型生成仿写脚本
- 商品链接/购物袋相关功能原样保留

两个场景共享一个入口（popup 两个 Tab）、一份设置页（四个分区：直播实时 / 视频字幕 / 叠加层外观 / 关于）、一套译文触发时机设置（停顿模式 / 句子模式，[ADR-0007](docs/adr/0007-sentence-level-translate-trigger.md)）。完整的领域词汇见 [`CONTEXT.md`](CONTEXT.md)。

## 快速开始

```sh
git clone https://github.com/Fluxwang/EchoSage.git
```

然后在 Chrome 里打开 `chrome://extensions`，开启「开发者模式」，选择「加载已解压的扩展程序」，指向克隆下来的仓库根目录。仓库已经包含构建产物，使用者不需要安装 Node 或运行构建命令。

首次使用需要在扩展设置页（点击工具栏图标 → ⚙）里填入 AssemblyAI API Key（两个场景共用一把），并按提示下载对应语言对的 Chrome 内置翻译模型。视频字幕场景若要使用 AI 模型翻译引擎或总结/仿写功能，还需额外配置 Base URL / API Key / 聊天模型（任何 OpenAI 兼容的 chat completions 接口均可）。

### 更新

有可用更新时，工具栏会显示红色角标，popup 品牌栏也会出现小红点。点击小红点进入设置页「关于」分区，然后严格按两步操作：

1. 双击仓库根目录的 `update.bat` 完成拉取。脚本会让工作副本与远端 `main` 完全一致，因此被跟踪文件里的本地修改会被覆盖。
2. 回到设置页点击「我已拉取，重载扩展」，让 Chrome 从磁盘重新载入代码。角标会在重载之后消失，而不是在拉取之后消失。

脚本仅面向 Windows。macOS / Linux 用户可在仓库根目录运行 `git fetch origin main && git reset --hard origin/main`，再到设置页重载扩展。

## 开发

```sh
npm run watch   # esbuild 增量构建，改完手动去 chrome://extensions 重新加载
npm test        # node --test 跑 core/ 下的纯逻辑单元测试
npm run check   # build + test
```

日常 `build` / `watch` 会保留 sourcemap。发布必须从干净工作区执行唯一入口（需要已登录的 `git` 与 GitHub CLI）：

```sh
npm run release -- 0.2.0
```

该命令会同步更新 `manifest.json`、`package.json` 与锁文件版本，执行无 sourcemap 的发版构建，提交 `dist/`，创建并推送 `v` 前缀标签，最后创建带自动生成说明的 GitHub Release。不要手工打发布标签。

### 项目结构

```
background.js         service worker：会话生命周期、AssemblyAI 连接、消息路由
offscreen.js/.html     离屏文档：双 AudioContext（回放链路 + 转写链路）、AudioWorklet 挂载
asr-worklet.js         AudioWorklet：PCM16 切片 + RMS 静音检测
inject.js              MAIN world，document_start 打补丁 fetch/XHR 拦截 TikTok 接口响应
content-tiktok.js/.css TikTok 专属，隔离世界：数据卡片、字幕列表、商品弹层、侧边栏挂载
content-overlay.js     <all_urls>，隔离世界：双轨悬浮字幕层
popup.html/.js         紧凑视图：直播实时 / 视频字幕 两个 Tab
options.html/.js       设置页：直播实时 / 视频字幕 / 叠加层外观 / 关于
sidepanel/             视频字幕场景专属工作区：字幕列表 + 总结/仿写
shared/                跨入口公共模块，经 esbuild 打包
core/                  纯逻辑状态机（会话/音频/播放判定），不经构建，node --test 直接跑
docs/adr/              编号架构决策记录
CONTEXT.md             领域词汇表
.scratch/              issue/spec 文件（无远程 issue tracker，见 docs/agents/issue-tracker.md）
```

`core/` 是本项目唯一的测试 seam：任何不碰浏览器 API 的状态机/判定逻辑都放这里，用 Node 内置 test runner 测，不 mock 浏览器全局对象。

## 权限说明

| 权限 | 用途 |
| --- | --- |
| `tabCapture` | 捕获当前标签页音频用于转写与回放 |
| `offscreen` | MV3 service worker 没有 `MediaRecorder`/`AudioContext`，转写与回放都跑在离屏文档里 |
| `storage` | 保存 API Key、语言、引擎等设置 |
| `scripting` | 按需向标签页注入脚本 |
| `alarms` | 每 24 小时检查一次 GitHub 发布版本 |
| `host_permissions: <all_urls>` | 直播实时场景要支持任意网站；TikTok 专属逻辑靠 URL match pattern 限定，不依赖这条权限收窄范围 |

所有 API Key 只保存在 `chrome.storage.local`，不经过任何第三方服务器中转；AssemblyAI 按 WebSocket 连接时长计费，AI 翻译/总结引擎按你自己配置的接口计费。

## 文档索引

- [`CONTEXT.md`](CONTEXT.md) —— 领域词汇表（场景/音频与转写/翻译/呈现），改代码前先读，用里面的词
- [`docs/adr/`](docs/adr/) —— 编号架构决策记录，尤其是 [0003](docs/adr/0003-builtin-translator-only-no-cloud-fallback.md)（直播场景只用内置 Translator）、[0005](docs/adr/0005-session-lifecycle-and-spend-control.md)（花钱保险丝）、[0007](docs/adr/0007-sentence-level-translate-trigger.md)（译文触发时机）
- [`.scratch/echosage-merge/spec.md`](.scratch/echosage-merge/spec.md) —— 合并的完整规格（问题/方案/user stories/实现决定/范围外）
- [`docs/agents/`](docs/agents/) —— 面向 agent 协作的流程文档（issue tracker、triage 标签、domain docs 维护）

## 状态

EchoCap 与 TikTok Caption Studio 的合并（`.scratch/echosage-merge/issues/01`–`09`）已全部完成，两个场景的核心功能均可用。

## License

[MIT](LICENSE)
