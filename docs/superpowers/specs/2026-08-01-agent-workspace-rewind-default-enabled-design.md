# Agent Workspace Rewind 默认启用设计

## 背景

当前 Workspace Rewind 只有在 Electron 主进程环境变量 `CREST_AGENT_WORKSPACE_REWIND` 精确等于 `1` 时才启用。关闭时，界面仍可触发 `/rewind`，但 IPC 会在进入 rewind service 前返回 `Workspace rewind is unavailable`。

该环境开关是开发阶段的 rollout gate。产品现阶段不再需要这个 gate，rewind 应在具备平台与存储能力时直接可用。

## 决策

彻底删除环境变量 gate，而不是将它替换成永远为真的函数或新的产品配置项。

- macOS 和 Linux 默认初始化 Workspace Rewind。
- IPC 始终注册并调用 rewind service 与 maintenance service。
- Windows 及其他真实能力限制继续由 checkpoint store、文件系统安全检查和平台实现返回明确的 `unavailable` 原因。
- 存储权限、workspace 身份变化、恢复冻结、配额和并发写入保护保持不变。
- 初始化失败不得静默降级为可用，也不得放宽任何文件恢复安全检查。

## 代码边界

### Feature 初始化

`emain/agent-rewind-feature.ts` 不再读取环境变量，也不再返回 `disabled`。打开 feature 的结果只有：

- `enabled`：进程所有者身份、canonical workspace identity 和 snapshot store 均成功建立。
- `unavailable`：平台或基础设施检查失败，并携带具体错误消息。

### Runtime 与冷 Session

Agent runtime 和 cold session state builder 每次都尝试打开 rewind feature：

- 成功时创建 checkpoint manager，并发布 `enabled: true`。
- 失败时使用 disabled/no-op checkpoint manager 防止不完整 capture，同时发布不可用/frozen 状态和诊断消息。

现有 checkpoint、recovery journal、workspace lock 和 session mutation barrier 的生命周期不变。

### IPC

删除 `requireRewindService()` 与 `requireRewindMaintenance()` 中的环境变量拒绝逻辑。IPC 仍先完成 workspace sender、session ownership、schema 和 writable gate 验证，再进入 service。

Service 在解析 workspace 时打开 feature；真实能力失败继续返回具体错误，而不再返回笼统的 rollout-gate 错误。

## 兼容与数据

无需迁移 Session 或 checkpoint 数据。之前在 gate 关闭时创建的 Session 没有 workspace checkpoint，因此旧 turn 不会被错误标记为可回退；开启后的新 turn 从正常 turn-boundary capture 开始产生 checkpoint。

## 测试

- 删除“只有环境变量精确为 `1` 才启用”和“关闭时不做任何工作”的测试。
- 新增无环境变量时仍打开 identity/store 的 feature 测试。
- 更新 runtime、cold-state、recovery gate 和 IPC 测试，证明它们不再依赖环境变量 mock。
- 保留并运行平台 unavailable、存储失败、Windows hard-block、恢复冻结、并发 Session、drift/Force 和 E2E 测试。
- 运行开发构建与完整 Vitest 套件。

## 非目标

- 不改变 Windows 的安全能力范围。
- 不新增 Settings 开关、命令行参数或其他 rollout 机制。
- 不改变 Revert/Redo UI、快照格式、恢复协议或配额策略。
