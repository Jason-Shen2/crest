# Terax 终端架构移植 — Handoff 文档

**目标**: 用 terax-ai 的 xterm.js + WebGL 终端架构（渲染池 / DormantRing / OSC 133 块 decorations）**直接替换** crest 自研 cell-grid 终端引擎。
**日期**: 2026-07-26（方案）/ 2026-07-27（实施更新）
**状态**: **P0-P3 已完成**，P4 大部完成。旧引擎已删除（commit `0f35c73c`）。分阶段进度：
- ✅ P0 全部（OSC 133 双发、8ms/64KB 合帧、ControllerHasForegroundJob RPC、durable Tracker）
- ✅ P1 全部（依赖、纯函数移植、pty-bridge、renderer-pool + theme、xterm-session、XtermView/XtermPaneModel、四渲染点切换、旧引擎删除 −10,833 行；tsc/vitest 门禁与基线零差异）
- ✅ P2 全部（P2.2 find-bar over SearchAddon、P2.5 pty_read seam、P2.6 上下文换源、P2.7/D9 视图合并 + term:blocks meta 键）。唯一 deferred：liveGitBranch（ContextChipModel 失去宿主，需新 cwd/命令驱动）
- ✅ P3 全部（decorations + cmdblock:row 增强、BlockOverlay/Watermark、CmdBlockInput 接线 + 三项输入 bug 修复、.bt-match CSS）
- ✅ P4.2/P4.3/P4.4/P4.5（cmdblock:chunk 与 agent 穿插清除 + 迁移 000017、NLD 惰性化、文档收尾）；⬜ P4.1 性能基准
- ⬜ **P1 运行时人工冒烟未做**（bash/vim/中文 IME/池驱逐/冷恢复——需真实 Electron 环境，代码侧门禁已全绿）
**策略**: 项目处于 POC/MVP 阶段（见 CLAUDE.md"不考虑向后兼容"），**不做双引擎共存、不做灰度开关**——在分支上完成核心替换并通过验收清单后整体合入，回退手段就是 git revert。
**参考仓库**: `/Users/bytedance/Documents/terax-ai`（Tauri v2 + React，只读参考，Apache-2.0，与 crest 同许可）
**被替换并删除**: `frontend/app/term/engine/`、`frontend/app/term/render/` 的渲染层、`terminal-model.ts`（约 16.8k LOC 非测试 + 6k 测试）
**前置阅读**: `docs/term-engine-migration.md`（旧引擎架构与决策日志；其 Phase 表已过期——Track A/D 实际已完成）

---

## TL;DR

crest 自研引擎存在一批已验证的正确性问题（50ms 视口钳制销毁滚动回看、chunk 丢失永久冻结 block、IME 全链路缺失、alt-screen 硬编码 30 行等）和永久性维护税（VT 兼容长尾、逐码点解析吞吐、每字形一个堆对象）。terax-ai 在成熟的 xterm.js 6 + WebGL 上实现了同样的产品形态（OSC 133 命令块 + 编辑器输入栏 + 正确的后台流），其核心模块通过窄接口与传输层解耦，可移植。

**这次移植风险低的根本原因**: crest 的 Go 后端从 5 月迁移起就**双路并行**——原始 PTY 流仍写入 `term` blockfile 并发布 `Event_BlockFile` wps 事件（`pkg/blockcontroller/blockcontroller.go:445-456`），cmdblock 元数据事件只是并行的 sidecar。移植的 xterm 宿主直接消费原始流通道，后端几乎零改动。

**保留**: Go 后端全部（blockcontroller / cmdblock Tracker / blockfile / 快照）、CmdBlockInput 输入栏及其 completion / NLD / contextchip 子模块、agent surface、view model 外壳。
**移植**: rendererPool、DormantRing、osc-handlers、blockDecorations + BlockOverlay、休眠状态机。
**重写**: pty-bridge（74 行）→ crest 传输适配层。
**删除**: 自研引擎全部，在 P1 验收通过后立即删（先换后删，同分支）。

预估总工期 **2.5-3 周单人**，四个阶段。P1 完成即为不可回头点（合入即旧引擎消失），P1 验收清单是唯一守门。

---

## 一、架构对比

### 现状（自研引擎）

```
PTY → Go ShellController(4KB read) ─┬→ term blockfile + Event_BlockFile（无人消费）
                                    └→ cmdblock.Tracker → cmdblock:row/chunk/altscreen/clear
                                                                │ (base64+JSON, 每 tab 一条 ws)
                                     TerminalModel → AnsiParser(自研) → 每命令 Block Grid
                                                                │ revisionAtom（每 chunk 全量失效）
                                     React DOM 渲染（div 行 + span run，无虚拟化，无 GPU）
```

### 目标（terax 架构）

```
PTY → Go ShellController(4KB read, P0 加 8ms 合帧) ─┬→ term blockfile + Event_BlockFile ──┐
                                                    └→ cmdblock.Tracker（不变，元数据 sidecar）│
                                                                                           │
      ┌────────────────────────────────────────────────────────────────────────────────────┘
      │  getFileSubject(blockId, "term") → base64 decode → Uint8Array
      ▼
  XtermSession（每 block 一个，模块级 Map，React 外）
      ├─ 有 slot：slot.term.write(bytes)            ← xterm.js 解析 + WebGL 渲染
      └─ 无 slot：DormantRing.push(bytes)           ← 1MiB 有界环形缓冲
      ▲
  rendererPool（每 renderer 最多 5 个共享 xterm+WebGL 实例，动态绑定/park/释放）
      ├─ blockDecorations：OSC 133 marker → 块覆盖层（exit 徽章/复制/AI/块内搜索/重跑）
      └─ 模式机：prompt ↔ running ↔ alt → 驱动 CmdBlockInput 显隐与 raw 直通
```

关键差异：xterm buffer 是唯一的终端状态源（连续流），块只是 decoration 元数据；后台 pane 零渲染成本（ring 缓冲）；恢复 = blockfile 回放或 serialize 快照。

---

## 二、terax 模块清单与移植分类

terax 终端模块共约 6.5k LOC（含测试）。逐文件处置：

### A. 原样移植（改 import 路径即可，连测试一起搬）

| terax 文件 | LOC | 落位（crest） | 说明 |
|---|---|---|---|
| `lib/dormantRing.ts` (+test) | 84 | `frontend/app/xterm/dormant-ring.ts` | 纯 TS，零依赖。1MiB 上限 / 16KiB 块 / 溢出丢最旧并从下一 LF 边界续 |
| `lib/cursorBlink.ts` (+test) | — | `frontend/app/xterm/cursor-blink.ts` | 纯函数 |
| `lib/quoteShellPath.ts` (+test) | — | `frontend/app/xterm/quote-shell-path.ts` | 纯函数 |
| `block/lib/modeMachine.ts` (+test) | 36 | `frontend/app/xterm/block/mode-machine.ts` | prompt/running/alt reducer，纯函数 |
| `block/lib/blockRange.ts` / `outputCap.ts` / `readBlock.ts` (+tests) | ~75 | `frontend/app/xterm/block/` | 纯函数 |

### B. 移植 + 小适配（依赖注入替换，逻辑不动）

| terax 文件 | LOC | 落位 | 需要替换的依赖 |
|---|---|---|---|
| `lib/rendererPool.ts` | 1073 | `frontend/app/xterm/renderer-pool.ts` | ①`@tauri-apps/plugin-opener` 的 `openUrl` → `getApi().openExternal`；②zustand prefs → crest settings atoms（`getSettingsKeyAtom`）；③`buildTerminalTheme`/`resolveFontFamily` → crest 主题 CSS 变量映射。**核心逻辑（slot 绑定/park/释放/WebGL 生命周期/评分驱逐）零改动** |
| `lib/osc-handlers.ts` (+test) | 146 | `frontend/app/xterm/osc-handlers.ts` | 纯 xterm API。OSC 7 cwd（带 inCommand 防伪造）、OSC 52 剪贴板（1MiB 上限 + base64 校验）、OSC 133 → 模式机事件 |
| `lib/terminalClipboard.ts` (+test) | — | `frontend/app/xterm/terminal-clipboard.ts` | Tauri clipboard → navigator.clipboard / Electron |
| `lib/keymap.ts` (+test) | — | `frontend/app/xterm/keymap.ts` | 纯函数（word/line 导航序列、删除序列） |
| `block/lib/blockDecorations.ts` (+test) | 548 | `frontend/app/xterm/block/block-decorations.ts` | 纯 xterm marker/decoration API。上限 1000 块。改动点：块元数据来源可选接入 cmdblock:row 事件（拿 Go 侧持久化的 cmd/exitcode/duration，比纯前端 OSC 解析更丰富） |
| `block/BlockOverlay.tsx` | 388 | `frontend/app/xterm/block/block-overlay.tsx` | UI 库替换：hugeicons → crest UIcon；dropdown → crest 组件；`useChatStore`（AI 按钮）→ crest agent 派发（对齐现 BlockElement 的 onAskAI）；Tauri homeDir → `getApi()` |
| `block/BlockWatermark.tsx` | 102 | 同上目录 | 同类 UI 替换 |
| `lib/agentActivity.ts` | — | `frontend/app/xterm/agent-activity.ts` | OSC 777 agent 活跃信号 → 否决休眠。crest 侧信号源改为 pi-agent 状态 atom |

### C. 重写（terax 版本仅作结构参考）

| terax 文件 | LOC | crest 新文件 | 说明 |
|---|---|---|---|
| `lib/pty-bridge.ts` | 74 | `frontend/app/xterm/pty-bridge.ts` | 全部重写，见 §四.P1。terax 是前端拥有 PTY（pty_open/close/Channel），crest 是后端拥有（blockcontroller + wps 订阅 + RPC） |
| `lib/useTerminalSession.ts` | 1118 | `frontend/app/xterm/xterm-session.ts` | 半重写。保留：模块级 session Map、SlotAdapter 实现、休眠决策逻辑、drain 顺序、alt-screen kick。重写：生命周期挂钩（leafId→blockId；spawn/respawn→ControllerResync；exit→shell 事件）、前置输入队列（crest 的 ws 层已有排队） |
| `TerminalPane.tsx` | — | `frontend/app/xterm/xterm-view.tsx` | 新组件 XtermView：挂载 slot host、驱动模式机 ↔ CmdBlockInput 显隐、raw 直通键路由（**必须带 pane focus 门控**——修掉自研引擎的双发 bug）。props 形状对齐现 TerminalView，三个 view model 直接换渲染目标 |

### D. 不移植

| terax 文件 | 原因 |
|---|---|
| `TerminalStack.tsx` / `PaneTreeView.tsx` / `lib/panes.ts` | terax 的 pane 树布局。crest 有自己的 tile layout + block 体系 |
| `lib/liveTerminals.ts` | 冷 tab 不 spawn PTY 的登记表。crest 后端拥有 PTY 生命周期，语义不同；等价逻辑并入 xterm-session.ts |
| `block/ShellInput.tsx` + `block/lib/shellEditor.ts`（CodeMirror 6） | **保留 crest 的 CmdBlockInput**（2301 行，含 completion/NLD/contextchip/model picker/slash 命令，且已验证与引擎解耦）。见决策日志 D3。shellEditor 作为后续把 contentEditable 内核换成 CodeMirror 的参考（可选后续项） |
| `block/lib/pathComplete.ts` / `historyPopover.ts` / `inlineSuggest.ts` | crest completion 引擎已有等价物 |
| Rust `src-tauri/src/modules/pty/*` | crest 的 Go 后端等价物已存在。仅两个能力需在 Go 侧补：前台任务检查、合帧（见 P0） |

---

## 三、传输与生命周期映射表

| 能力 | terax（Tauri/Rust） | crest 等价物 | 状态 |
|---|---|---|---|
| PTY 打开 | `invoke("pty_open", {cols, rows, cwd, onData: Channel})` | 后端拥有：block 创建即 `ControllerResync`（`RpcApi.ControllerResyncCommand`） | ✅ 已有 |
| 数据下行 | `Channel<ArrayBuffer>` 二进制直达 | `getFileSubject(blockId, "term")` 订阅 `Event_BlockFile`，`WSFileEventData.data64` base64 解码（`frontend/app/store/wps.ts:111`） | ✅ 已有，至今双路并行在发 |
| 键入上行 | `invoke("pty_write", bytes, {headers})` 原始体 | `RpcApi.ControllerInputCommand({blockid, inputdata64})`（`pkg/wshrpc/wshrpctypes.go:339-344`） | ✅ 已有 |
| resize | `invoke("pty_resize", {id, cols, rows})` | `ControllerInputCommand({blockid, termsize: {rows, cols}})` | ✅ 已有 |
| SIGWINCH kick | `kickPty`: +1 行再恢复（内核抑制同尺寸 ioctl） | 同法：连续两次 ControllerInput termsize（rows+1 → rows） | ✅ 组合即可 |
| PTY 关闭/重启 | `pty_close` / respawn | `ControllerDestroyCommand` + `ControllerResync(forcerestart)` | ✅ 已有 |
| 前台任务检查（休眠否决） | `pty_has_foreground_job`（tcgetpgrp，`mod.rs:216-236`） | **缺失** → P0 新增 RPC `ControllerHasForegroundJobCommand` | ⛔ 待补 |
| 输出合帧 | Rust flusher 4ms 窗口（`session.rs:20-21`）+ 4MiB 背压上限 | **缺失** → P0 在 shellcontroller 读循环加 8ms/64KB 合帧 | ⛔ 待补 |
| 冷恢复（scrollback） | serialize 快照（内存，5000 行上限） | **更优**：2MB 环形 `term` blockfile 后端回放（`fetchWaveFile(blockId, "term")`，legacy 路径健在）+ pool 的 retained-slot 热切换 | ✅ 已有 |
| shell 集成标记 | OSC 133 A/B/C/D（rc 脚本注入） | OSC 16162（`pkg/util/shellutil/shellintegration/*.sh`）→ P0 rc 脚本**改发/双发** 133 | ⛔ 一行级改动 ×4 脚本 |
| exit 通知 | `Channel<number>` onExit | shell 状态 wps 事件 / cmdblock:row state=done | ✅ 已有 |

---

## 四、分阶段实施

> 无灰度：P1 在分支上做到验收清单全绿后合入 main，合入即完成引擎替换与删除。P2/P3 在此之上补齐功能面。

### P0 — Go 侧准备（2-3 天，可直接合 main）

无论移植进度如何，这些改动独立有价值，且不影响现引擎。

1. **rc 脚本发 OSC 133**。四个文件：`pkg/util/shellutil/shellintegration/{zsh_zshrc.sh, bash_bashrc.sh, fish_wavefish.sh, pwsh_wavepwsh.sh}`——在发 16162 A/B/C/D 的位置并行发标准 `\e]133;A\a` 等（双发；等 P3 稳定后可评估让 Tracker 改吃 133、退役 16162）。注意 `shellutil.go:643` 的 reset 序列同步处理。
2. **PTY 读循环合帧**。`pkg/blockcontroller/shellcontroller.go:600-618` 读循环：改为聚合 8ms 或 64KB 先到为准再 `HandleAppendBlockFile` + `Tracker.OnBytes`。对齐 terax `session.rs` FLUSH_COALESCE 的设计。事件量降一个量级。
3. **新 RPC `ControllerHasForegroundJobCommand`**：`unix.IoctlGetInt(fd, unix.TIOCGPGRP)` 对比 shell pgid，返回 bool。按 `.kilocode/skills/add-rpc/SKILL.md` 流程加到 `wshrpctypes.go` + `wshserver.go`，`task generate`。
4. **修 durable 路径无 cmdblock 事件**：`pkg/jobcontroller/jobcontroller.go:815-861` 的 runOutputLoop 补建 Tracker。xterm 宿主走原始流不受影响，但块 decorations 元数据需要它。
5. （可选，性能储备）web/ws.go 二进制帧路径调研 spike，不阻塞后续阶段。

**验收**: `printf` 手动验证 rc 注入后 OSC 133 出现在 blockfile 里；合帧后 `yes` 场景 wps 事件速率 ≤125/s。

### P1 — 核心替换 + 删除旧引擎（约 1 周，单分支，合入即切换）

新目录 `frontend/app/xterm/`。依赖：`npm i @xterm/xterm @xterm/addon-fit @xterm/addon-search @xterm/addon-serialize @xterm/addon-web-links @xterm/addon-webgl`（lockfile 里已有 tsunami 拉过的版本段，保持一致）。

1. **`pty-bridge.ts`（重写，~120 行）**。契约对齐 terax 的 `PtySession`：

```ts
// frontend/app/xterm/pty-bridge.ts
export type PtyHandlers = {
    onData: (bytes: Uint8Array) => void;
    onShellExit?: () => void;
};

export type PtySession = {
    blockId: string;
    write: (data: string) => Promise<void>;
    resize: (cols: number, rows: number) => Promise<void>;
    kick: (cols: number, rows: number) => Promise<void>;
    dispose: () => void;
};

export function attachPty(blockId: string, handlers: PtyHandlers): PtySession {
    // 1. getFileSubject(blockId, "term") 订阅 Event_BlockFile
    //    fileop=="append" → base64ToArray(data64) → handlers.onData
    //    fileop=="truncate" → term.reset 信号
    // 2. write: ControllerInputCommand({blockid, inputdata64: base64Encode(data)})
    // 3. resize: ControllerInputCommand({blockid, termsize: {rows, cols}})
    // 4. kick: resize(cols, rows+1) 然后 resize(cols, rows)
    // 5. dispose: 退订
}
```

   base64 用 `frontend/util/util.ts` 的编解码（禁 atob/btoa）。
2. **`renderer-pool.ts` 移植**（B 类适配）。POOL_MAX_SIZE=5 保持——crest 每 tab 一个 renderer 进程，池是 per-renderer 的，5 个槽覆盖 tab 内分屏 + right terminal 富余。WebGL 生命周期代码（context-loss 250ms 重试、30s/45s 分级回收、`WEBGL_lose_context` 销毁）原样保留。
3. **`xterm-session.ts`**（C 类半重写）。模块级 `Map<string /*blockId*/, XtermSession>`；实现 `SlotAdapter`（resolveLeaf→按 blockId、isLeafVisible→pane 可见性 atom、isLeafFocused→crest focus 体系、storeSnapshot→内存 Map）与 `LeafBridge`（三个方法直连 pty-bridge）。休眠决策链保留 terax 语义：300ms 空闲 → 非 alt/blocks/agent-active/前台任务（新 RPC）→ 释放 slot；数据到达且无 slot → DormantRing。
4. **冷恢复路径**：session 首次绑定 slot 时 `fetchWaveFile(blockId, "term")` 拉环形文件全量 → `term.write` 回放 → pty-bridge 衔接后续 append（顺序：先订阅 → ring 缓冲订阅期间到达的 append → 拉全量回放 → drain ring）。
5. **`xterm-view.tsx` 直接替换 TerminalView**：三个 view model（`term-model.tsx:197` / `termblocks.tsx:70` / `agent-model.tsx:62`）的 viewComponent 全部指向 XtermView（agent 视图不渲染终端内容，仅换壳）。VDom slots（topSlot/replaceContent）保留同款 props。
6. **薄模型替代 TerminalModel**：新 `XtermPaneModel`（每 block）只承载存活的外部契约——`notificationAtom`（agent surface 消费）、focus 请求、session 注册表（`getPtyScreenSnapshot` 用，见 P2.5）。**除此之外的 TerminalModel 全部逻辑不迁移。**
7. **删除旧引擎（同分支收尾提交）**：`git rm -r frontend/app/term/engine frontend/app/term/render/{grid-element,cell-run,block-element,block-list-element,selection-layer,selection,cursor-overlay,find-bar,find-highlight-layer,key-bindings,mouse,terminal-view}.tsx*` + `terminal-model.ts` + 相关测试。保留 `frontend/app/term/render/agent-*`、`assistant-ui/`（改依赖 XtermPaneModel）与 `completion/ nld/ contextchip/`。tsc 全绿为准。

**P1 验收清单（合入 main 的唯一守门）**:
- `bash` 提示符可见可输入；↑ 历史、Ctrl+C 生效
- `vim` / `htop` / `less` 正常（alt-screen 进出、resize 重绘）
- `seq 10000` 滚动顺畅且 **scrollback 完整**（旧引擎 50ms 钳制 bug 的对照验证）
- `python` REPL、`ssh` 会话正常
- 中文 IME 在提示符与 vim 内可输入（xterm 自带 composition）
- tab 切走再切回秒恢复（retained-slot）；开 6 分屏触发池驱逐 + serialize 恢复无花屏
- `yes` 运行 30s UI 不卡、停止后终端可用
- 渲染进程重启后 scrollback 从 blockfile 回放恢复
- agent 视图、right terminal、durable flyover 挂载不报错

### P2 — 功能对齐 + seam 重接（约 1 周）

1. **osc-handlers 移植**：OSC 7（cwd）、OSC 52、OSC 133 → 模式机。OSC 0/2 标题：挂 pane 级不挂 document 级（修掉旧引擎的多 pane 竞态）。
2. **搜索**：SearchAddon 接 crest 现有 find-bar UI（Cmd+F）。
3. **链接**：WebLinksAddon → `getApi().openExternal`。
4. **剪贴板/选择**：xterm 原生选择 + keymap 移植（Cmd+C/V、word/line 导航）。
5. **`getPtyScreenSnapshot` seam 重实现**：`wave.ts:59` 的 window global 契约不变，实现改为从 session 的 slot term buffer 读屏（xterm buffer API 逐行 + `<|cursor|>` 标记），emain 的 pty_read 零改动。无 slot 时从 serialize 快照/DormantRing 兜底。
6. **上下文 feed 换源**：`AgentSurfaceContext`（workspaceDir/gitBranch/recentCmds/inAltScreen）改从 cmdblock:row 事件 + 模式机取；顺手把 `tabrpcclient.ts:125-142` 的 placeholder（shellIntegrationStatus/lastCommand）接成真数据。
7. **视图类型合并**：`termblocks` 注册项直接指向 `term` 同款（xterm 宿主下两者只差 blocks decorations 开关）；序列化 meta 兼容保留注册名即可。

**验收**: 旧引擎迁移文档 §Testing plan 的 11 项 smoke 全过（按块分解项换成 P3 验收）；另加：OSC 52 复制、Cmd+F 搜索跳转、CLI subagent `pty_read` screen 分支回归、agent surface 上下文 chips 数据正确。

### P3 — 块 UX：decorations + 输入栏接线（约 1 周）

1. **blockDecorations 移植**：OSC 133 marker 驱动，上限 1000。数据增强：订阅 `cmdblock:row`（已有事件）把 Go 侧持久化的 `cmd`/`exitcode`/`durationms` 挂到对应 decoration（按时序宽松对齐 oid ↔ marker，不匹配时降级为纯 marker 块）。
2. **BlockOverlay 移植 + 视觉对齐**：exit 徽章、per-command 复制（`readBlock` 从 buffer 范围提取）、Ask AI（接现 agent 派发路径）、块内搜索、重跑、块间跳转导航（对齐原 selectPreviousBlock/selectNextBlock 快捷键）。
3. **CmdBlockInput 接线**：模式机 `prompt` → 显示 CmdBlockInput（现组件原样，completion/NLD/contextchip 全保留）；`running`/`alt` → 隐藏输入栏、raw 直通（**带 pane focus 门控**）。提交路径 = bracketed paste 包裹 + CR（对齐 terax `useTerminalSession.ts:161-171`）。
4. **顺手修输入栏存量 bug**（与移植正交但同一片代码）：多行提取用 `innerText` 替代 `textContent`；`!` 前缀按模式门控；补全接真实 caret（`getEditorCaretOffset` 已存在）。

**验收**: 块头部/徽章/工具带视觉达标；`false` 后 exit 徽章=1；块复制内容正确；Ask AI 携带正确命令输出上下文；多行粘贴/输入不丢换行。

### P4 — 收尾（2-3 天）

1. 性能基准（§六）跑完留档，两项不达标则开专项（预期不会：WebGL + 合帧的余量很大）。
2. 删除 `pkg/cmdblock` 中仅服务旧前端的 `cmdblock:chunk` 发布路径（row/altscreen/clear 保留）；评估 Tracker 改吃 OSC 133 后退役 16162。
3. **NLD 按 D11 执行**：不接线、模块保留；把 `wave.ts` 启动时的 EdgeFlowEmbedder 预热（HEAD 探测 + worker 启动）惰性化或挂到设置开关后，停止无消费方的模型加载。
4. **清除 agent 时间线穿插的 legacy 支撑（D12）**：Go 侧 `cmdblock.AppendAgentRun`（`store.go:100`）、`KindAgent` 行与 `agent_session_path`/`agent_user_entry_id` 列、`AppendAgentRunCommand` RPC + `CommandAppendAgentRunData`（`wshrpctypes.go:101,394`，删后 `task generate`）；前端侧随 P1 引擎删除已消失，此处只清后端。
5. `docs/term-engine-migration.md` 头部加"已被 terax-terminal-port.md 取代"横幅；本文档状态表更新。

---

## 五、风险与缓解

| 风险 | 面 | 缓解 |
|---|---|---|
| P1 是不可回头点，替换期间分支上终端不可用 | 流程 | P1 全程在分支进行，验收清单全绿才合 main；main 上始终有可用终端。回退 = git revert 合入提交 |
| base64+JSON websocket 吃掉 terax 二进制 IPC 的性能优势 | 传输 | P0 合帧先把事件率降一个量级；xterm.write 有内部写队列。基准不达标再加 ws 二进制帧（P0.5 已 spike） |
| `Event_BlockFile` append 与 `fetchWaveFile` 全量拉取之间的衔接竞态 | 恢复 | 先订阅→ring 缓冲→拉全量→回放→drain（terax dormant drain 同款顺序）；以"订阅时序 + 全量替换"为准，不做字节 offset 对账（**规避了旧引擎 offset 冻结 bug 的整个类别**） |
| 池驱逐时 serialize 快照丢高频输出 | 池 | terax 已处理（释放前 flush + retained-slot 优先）；照搬其顺序，移植其测试 |
| decorations 与 cmdblock:row 的 oid 对齐错位（乱序/重连） | 块 UX | decoration 以前端 OSC 133 marker 为准（自足），row 元数据仅做增强；不匹配时优雅降级 |
| Electron 下 WebGL context 上限/GPU 进程崩溃 | 渲染 | terax 的 context-loss 恢复 + DOM 渲染器回退已覆盖；`disableHardwareAcceleration` 场景验证一次 |
| agent-surface / assistant-ui 对 TerminalModel 的残留引用导致 P1 删除时 tsc 大面积飘红 | 删除 | 先落 XtermPaneModel 承接 notificationAtom 等窄契约、改完引用再删引擎（P1.6 在 P1.7 之前是硬顺序） |
| tsunami 子项目已 pin `@xterm/xterm ^6.0.0` | 依赖 | 根 package.json 用同版本段，避免 lockfile 分叉 |

---

## 六、性能基准（P4 留档）

工具：`frontend/app/xterm/bench/`（Playwright 驱动或手动脚本），记录 p50/p99 帧时间、总耗时、常驻内存（旧引擎数据在 P1 删除前先采一轮作对照）：

1. `yes | head -c 100M`（吞吐洪水）
2. `cat 50MB.log`（大文件一次性）
3. `seq 100000` 后滚动到顶再到底（scrollback 交互）
4. `vim` 大文件 hjkl 连打 30s（alt-screen 延迟）
5. 8 pane 并发 `tail -f`（多会话）
6. 后台 tab 跑 `yes` 60s，前台 tab 帧率 + 进程 CPU（后台成本）

通过线：所有场景 p99 帧时间 ≤16.7ms；场景 6 后台 renderer CPU 较旧引擎降 ≥80%；场景 3 scrollback 完整（旧引擎因 50ms 钳制必挂，对照留档）。

---

## 七、回滚策略

无运行时开关。三级：

1. **P1 合入前**: 分支废弃即可，main 无感。
2. **P1 合入后短期**: `git revert` 合入提交（P1 作为单个 merge 提交合入，保证可整体 revert）。
3. **P2+ 之后**: 只进不退——后续阶段是增量功能，单独 revert 各自提交即可，不存在"回到自研引擎"的路径（引擎代码已删，历史里永远可考古）。

---

## 八、决策日志

| # | 决策 | 理由 | 备选 |
|---|---|---|---|
| D1 | 数据源用 `Event_BlockFile` 原始流，不用 `cmdblock:chunk` | xterm 需要连续字节流；原始流通道自迁移起从未断供；规避 per-oid offset 对账的整个 bug 类别 | 改造 chunk 事件——徒增一层已知有 bug 的间接 |
| D2 | PTY 生命周期保持后端拥有 | crest 的 durable/远程/恢复语义都在 Go 侧；前端拥有制（terax）在 Electron 多 renderer 下反而复杂 | 移植 pty_open/close——推翻 blockcontroller，不可取 |
| D3 | 保留 CmdBlockInput，不移植 shellEditor(CodeMirror) | 2301 行输入栏承载 completion/NLD/contextchip/slash/model-picker 产品面，且已验证引擎无关；换 CodeMirror 内核是正交的后续优化 | 整包换 shellEditor——丢产品面，重建成本 > 收益 |
| D4 | rc 脚本双发 OSC 133 + 16162，Tracker 暂不动 | 前端模式机直接吃标准 133（terax 代码零改）；Go 侧持久化链路零风险；P4 再评估合一 | Tracker 转发翻译——多一跳、加延迟 |
| D5 | 冷恢复走 blockfile 后端回放，serialize 快照仅作热切换加速 | 2MB 环形文件比 5000 行内存快照更完整且免费（已在写）；terax 评估原话："crest 的 blockfile 实际上简化了恢复" | 纯 serialize——renderer 死亡即丢 scrollback |
| D6 | 池上限保持 5/renderer | crest 每 tab 独立 renderer，池天然按 tab 分区；tab 内分屏 >5 是极端场景，驱逐机制兜底 | 全局池——跨 renderer 不可行 |
| D7 | 块折叠 / find 过滤隐藏块暂不复刻 | decorations 模型下输出在连续 buffer 里，折叠=区域隐藏需 xterm 上游能力；用"跳转导航 + 块内搜索"替代 | 自研 buffer 区域折叠——高风险 fork xterm |
| D8 | **直接替换，不做双引擎共存/灰度** | 项目为未发布 POC/MVP（CLAUDE.md 明示不考虑向后兼容）；共存开关、双注册、meta 逃生舱的工程成本纯属浪费；P1 验收清单 + 分支开发 + 可整体 revert 的 merge 提交已足够兜底 | v1.0 的 `term:engine` 灰度方案——为不存在的存量用户付成本 |
| D9 | `termblocks`/`term` 视图类型合并（P2.7） | xterm 宿主下两者只差 decorations 开关；POC 阶段无序列化兼容包袱 | 维持双注册——无意义的分叉 |
| D10 | `clear` 跟随 xterm 语义（清屏保留 scrollback） | 2026-07-26 拍板。标准终端行为，零额外工作；观感不佳再考虑 decorations 分隔线 | 复刻旧引擎"隐藏历史块"——decorations 模型下成本高收益存疑 |
| D11 | NLD 暂不接入 | 2026-07-26 拍板。模块与挂点保留（未来接线成本不变），但 P4 惰性化启动预热，停止无消费方的 ONNX 加载 | 立即接线（增加 P3 范围）或整删（丢弃已建资产） |
| D12 | agent 时间线穿插退役为 legacy，支撑代码清除 | 2026-07-26 拍板。agent 面已由独立 agent 视图（assistant-ui）承载；穿插自 5 月起休眠无消费方。同时解除了 decorations 模型最大的设计约束（无需为非终端内容设计 marker 锚定） | 保留休眠代码等未来复活——无主代码只会烂掉 |

---

## 九、已决问题（2026-07-26 全部拍板）

原 v1.1 的三个未决问题已由 Owner 决定，正式记录为决策日志 D10 / D11 / D12：

- ~~Q1 `clear` 语义~~ → **跟随 xterm**（D10）。
- ~~Q2 NLD 接线还是删除~~ → **暂不接入**，保留模块、惰性化预热（D11，P4.3 执行）。
- ~~Q3 agent 时间线穿插~~ → **退役为 legacy，清除支撑代码**（D12，P4.4 执行）。方案再无未决依赖，可直接开工 P0。

---

## 十、术语表

- **Slot** — 池中一个 xterm Terminal 实例 + 宿主 div + addons，动态绑定到 leaf。
- **Leaf / Session** — 一个终端会话；crest 语境 = 一个 block（blockId 即 leafId）。
- **Park** — slot 保持绑定但 `display:none`，xterm 停渲染、buffer 照常 parse。
- **Release** — slot 解绑；buffer 尽量原地保留（retained），被抢占时 serialize 成快照。
- **DormantRing** — 无 slot 会话的 PTY 字节环形缓冲（1MiB，丢最旧，LF 边界续）。
- **Kick** — +1 行再恢复的 resize 抖动，强迫 TUI 全量重绘（内核抑制同尺寸 SIGWINCH）。
- **blockDecorations** — 用 xterm marker + decoration API 把 OSC 133 命令边界渲染成覆盖层块 UI。
- **Event_BlockFile** — Go 侧每次 append `term` blockfile 时发布的 wps 事件，携带 base64 数据；本方案的前端数据源。
- **XtermPaneModel** — 替代 TerminalModel 的薄模型，只承载 notificationAtom / focus / session 注册表等存活契约。

---

_文档版本 1.2 — 直接重构版（去灰度）+ D10-D12 拍板，无未决依赖。执行时按阶段更新状态表。_
