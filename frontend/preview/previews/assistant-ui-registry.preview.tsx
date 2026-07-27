// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

import {
    AssistantRuntimeProvider,
    useExternalStoreRuntime,
    type ExternalStoreAdapter,
    type ThreadMessageLike,
} from "@assistant-ui/react";
import type { FC, PropsWithChildren } from "react";

import { Thread } from "@/app/agent/assistant-ui";

const messages: ThreadMessageLike[] = [
    {
        role: "user",
        content: [
            {
                type: "text",
                text: "把 Agent 内容区和输入框换成 assistant-ui 官方 registry 的对话态组件，不要再像自研 UI。",
            },
        ],
    },
    {
        role: "assistant",
        content: [
            {
                type: "reasoning",
                text: "我会保留 Crest 的 Pi runtime 和 session 数据源，只把对话态组件替换为 assistant-ui registry 的 Thread / Composer / Message / ToolGroup。",
            },
            {
                type: "text",
                text: "直接使用 assistant-ui 官方 `Thread` 组件，对话态 UI 完全对齐 registry 样式，仅保留 testid、model picker、image alt 三处项目级定制。\n\n- Markdown 使用官方 `MarkdownText`\n- Reasoning 使用官方 `Reasoning` + shadcn Collapsible\n- Tool calls 使用官方 `ToolGroup` + `ToolFallback`\n- Composer 使用官方 floating shell（含 ActionBar、BranchPicker、ScrollToBottom、Attachments、Dictation 等完整功能）",
            },
            {
                type: "tool-call",
                toolCallId: "call-read-thread",
                toolName: "read_file",
                args: { path: "frontend/app/term/render/assistant-ui/registry-thread.tsx" },
                argsText: JSON.stringify(
                    { path: "frontend/app/term/render/assistant-ui/registry-thread.tsx" },
                    null,
                    2
                ),
                result: "Loaded assistant-ui registry Thread source.",
            },
            {
                type: "tool-call",
                toolCallId: "call-run-tests",
                toolName: "run_tests",
                args: { command: "npm test -- assistant-ui --run" },
                argsText: JSON.stringify({ command: "npm test -- assistant-ui --run" }, null, 2),
                result: "All assistant-ui tests passed.",
            },
            {
                type: "text",
                text: "这就是后续接入真实 AgentPane 后的目标视觉：不是手写 HTML 仿品，而是同一套 React 组件在 mock runtime 下的真实渲染。",
            },
        ],
        status: { type: "complete", reason: "stop" },
    },
    {
        role: "user",
        content: [{ type: "text", text: "运行中的 reasoning 和 tool call 是什么样？" }],
    },
    {
        role: "assistant",
        content: [
            {
                type: "reasoning",
                text: "正在把当前请求映射到 registry Thread 的 grouped parts。运行时 reasoning 会展开，完成后用户仍可点击查看。",
            },
            {
                type: "tool-call",
                toolCallId: "call-preview",
                toolName: "preview_server",
                args: { url: "http://127.0.0.1:5173/frontend/preview/index.html?preview=assistant-ui-registry" },
                argsText: JSON.stringify(
                    { url: "http://127.0.0.1:5173/frontend/preview/index.html?preview=assistant-ui-registry" },
                    null,
                    2
                ),
            },
            {
                type: "text",
                text: "运行中的状态会显示 active 的 reasoning 和 tool group；停止生成时 Composer 右侧会切换为 cancel 按钮。",
            },
        ],
    },
    {
        role: "user",
        content: [{ type: "text", text: "需要授权和被取消的 tool call 又长什么样？" }],
    },
    {
        role: "assistant",
        content: [
            {
                type: "text",
                text: "需要人工确认时，`ToolFallback` 会自动展开并渲染官方 approval 按钮；被取消的调用则会显示删除线标题。",
            },
            {
                type: "tool-call",
                toolCallId: "call-approval",
                toolName: "run_command",
                args: { command: "rm -rf ./dist" },
                argsText: JSON.stringify({ command: "rm -rf ./dist" }, null, 2),
            },
            {
                type: "tool-call",
                toolCallId: "call-cancelled",
                toolName: "web_search",
                args: { query: "assistant-ui tool ui registry" },
                argsText: JSON.stringify({ query: "assistant-ui tool ui registry" }, null, 2),
            },
        ],
    },
] as ThreadMessageLike[];

const RuntimeProvider: FC<PropsWithChildren> = ({ children }) => {
    const runtime = useExternalStoreRuntime<ThreadMessageLike>({
        messages,
        isRunning: true,
        convertMessage: (message) => message,
        onNew: async () => {},
        onCancel: async () => {},
    } satisfies ExternalStoreAdapter<ThreadMessageLike>);

    return <AssistantRuntimeProvider runtime={runtime}>{children}</AssistantRuntimeProvider>;
};

export default function AssistantUiRegistryPreview() {
    return (
        <div className="flex h-[calc(100vh-4rem)] w-[min(1100px,calc(100vw-3rem))] overflow-hidden rounded-2xl border border-border bg-background shadow-2xl">
            <aside className="hidden w-60 shrink-0 border-r border-border bg-panel/70 p-4 md:block">
                <div className="mb-6 text-sm font-semibold tracking-tight text-foreground">Crest Agent</div>
                <div className="space-y-2 text-xs text-muted">
                    <div className="rounded-lg bg-accentbg px-3 py-2 text-foreground">assistant-ui registry</div>
                    <div className="rounded-lg px-3 py-2">ExternalStoreRuntime</div>
                    <div className="rounded-lg px-3 py-2">Mock Pi session</div>
                </div>
            </aside>
            <div className="flex min-w-0 flex-1 flex-col">
                <div className="flex h-11 shrink-0 items-center justify-between border-b border-border px-4">
                    <div className="text-xs font-medium text-muted">真实 React 预览 · registry Thread</div>
                    <div className="rounded-full border border-border px-2.5 py-1 text-[11px] text-muted">
                        Claude Sonnet 4
                    </div>
                </div>
                <RuntimeProvider>
                    <Thread modelLabel="Claude Sonnet 4" onOpenModelPicker={() => undefined} />
                </RuntimeProvider>
            </div>
        </div>
    );
}
