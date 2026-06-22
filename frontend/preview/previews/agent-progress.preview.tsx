// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

import type { AgentProgress } from "@/app/term/render/agent-progress";
import type { ChangeReview, ChangeReviewFile, ChangeSetFile, ChangeSetHunk } from "@/app/term/render/agent-change-review";
import { AgentProgressView } from "@/app/term/render/agent-progress-view";
import { useState } from "react";

interface CodeChangeBlock {
    id: string;
    title: string;
    summary: string;
    impact?: string;
}

interface ChangedFile {
    path: string;
    additions: number;
    deletions: number;
    summary: string;
    blocks: CodeChangeBlock[];
}

interface ChangeModule {
    id: string;
    title: string;
    summary: string;
    additions: number;
    deletions: number;
    files: ChangedFile[];
}

const mockProgress: AgentProgress = {
    stages: [
        {
            id: "understand-task",
            title: "理解任务",
            status: "done",
            summary: "确认目标是让 agent 修改代码后，用户能按功能模块审查改动。",
            recentActions: [],
            actionGroups: [],
        },
        {
            id: "inspect-implementation",
            title: "检查实现",
            status: "done",
            summary: "定位到 progress renderer、右侧工具栏和 preview mock 的接入位置。",
            recentActions: [],
            actionGroups: [],
        },
        {
            id: "modify-files",
            title: "更新代码",
            status: "done",
            summary: "把代码改动从文件列表升级为功能模块、文件和代码块的三层审查结构。",
            recentActions: [],
            risk: "file-edit",
            actionGroups: [
                {
                    id: "modify-files-group",
                    title: "更新代码",
                    summary: "实现变更审查 UI",
                    status: "done",
                    risk: "file-edit",
                    actions: [
                        {
                            id: "edit-progress-view",
                            title: "更新 agent progress review UI",
                            summary: "更新 agent-progress-view.tsx",
                            detail: "frontend/app/term/render/agent-progress-view.tsx",
                            status: "done",
                        },
                    ],
                    toolCalls: [],
                },
            ],
        },
        {
            id: "verify-result",
            title: "验证结果",
            status: "running",
            summary: "正在验证 progress 展开、文件跳转和 review mock 的渲染结果。",
            recentActions: [],
            actionGroups: [],
            risk: "command",
        },
    ],
};

const changeModules: ChangeModule[] = [
    {
        id: "review-sidebar",
        title: "新增 Agent 变更审查侧栏",
        summary:
            "让用户在 agent 修改代码后，可以按功能模块查看改动、打开文件、查看 diff，并针对具体代码块请求解释。",
        additions: 412,
        deletions: 38,
        files: [
            {
                path: "frontend/app/workspace/right-tool-panel.tsx",
                additions: 126,
                deletions: 12,
                summary: "新增右侧审查面板容器，承载模块列表、文件列表和改动详情。",
                blocks: [
                    {
                        id: "review-panel-layout",
                        title: "增加 ReviewPanel 布局",
                        summary: "新增标题区、模块导航区和详情区，复用现有右侧工具栏宽度和滚动样式。",
                        impact: "用户可以在不离开 terminal 的情况下查看本次 agent 改动。",
                    },
                    {
                        id: "active-module-rendering",
                        title: "接入当前选中的变更模块",
                        summary: "根据 activeChangeModuleId 渲染对应文件和代码块，避免一次性展示全部 diff。",
                        impact: "大改动时默认保持聚焦，用户可以逐个模块 review。",
                    },
                ],
            },
            {
                path: "frontend/app/workspace/right-tool-panel-model.ts",
                additions: 84,
                deletions: 4,
                summary: "增加审查面板状态，记录当前打开的模块、文件和代码块。",
                blocks: [
                    {
                        id: "selection-state",
                        title: "新增 selection state",
                        summary: "用 atom 保存 activeModuleId、activeFilePath 和 activeChangeBlockId。",
                        impact: "文件切换和代码块定位可以保持可控状态，而不是依赖 DOM 滚动副作用。",
                    },
                    {
                        id: "run-reset",
                        title: "增加 run 切换时的 reset 行为",
                        summary: "当 agent run 切换时清空旧选择，避免展示上一次任务的 diff。",
                        impact: "降低用户误读旧改动的风险。",
                    },
                ],
            },
            {
                path: "frontend/app/workspace/workspace.tsx",
                additions: 47,
                deletions: 9,
                summary: "把右侧审查面板接入 workspace 主布局。",
                blocks: [
                    {
                        id: "mount-review-panel",
                        title: "挂载右侧 panel",
                        summary: "在 workspace split layout 中加入 review panel slot，并保持 terminal 主区域宽度自适应。",
                    },
                ],
            },
        ],
    },
    {
        id: "progress-review-layer",
        title: "改造 Agent Progress 的变更说明",
        summary: "把“更新代码”从文件名列表升级成 review layer，让用户先理解大块改动，再逐层深入。",
        additions: 238,
        deletions: 21,
        files: [
            {
                path: "frontend/app/term/render/agent-progress.ts",
                additions: 92,
                deletions: 6,
                summary: "扩展 progress 数据结构，支持模块、文件和代码改动块。",
                blocks: [
                    {
                        id: "change-modules",
                        title: "新增 changeModules",
                        summary: "每个模块描述一组相关代码变更，例如 UI 容器、状态管理、测试覆盖。",
                        impact: "顶层叙事从文件列表变成用户可理解的功能目标。",
                    },
                    {
                        id: "fallback-actions",
                        title: "保留 actionGroups fallback",
                        summary: "没有结构化 changeModules 时继续显示现有文件 chip。",
                        impact: "旧 agent run 不会因为新模型字段缺失而变空。",
                    },
                ],
            },
            {
                path: "frontend/app/term/render/agent-progress-view.tsx",
                additions: 118,
                deletions: 11,
                summary: "渲染功能模块、文件和代码块的三层 review UI。",
                blocks: [
                    {
                        id: "module-layer",
                        title: "模块层默认展示",
                        summary: "默认只展示功能模块摘要、涉及文件数和变更规模，避免大 diff 直接压到用户面前。",
                    },
                    {
                        id: "file-layer",
                        title: "文件层按需展开",
                        summary: "展开模块后显示相关文件，每个文件提供 Open file 和 View diff。",
                    },
                    {
                        id: "explain-entry",
                        title: "代码块层提供 Explain",
                        summary: "具体代码块只给简短说明，复杂细节通过 Explain 入口进一步询问 agent。",
                    },
                ],
            },
            {
                path: "frontend/app/term/render/agent-block-element.tsx",
                additions: 28,
                deletions: 4,
                summary: "把 agent run 中的结构化变更说明传给 progress view。",
                blocks: [
                    {
                        id: "pass-review-data",
                        title: "传递 review 数据",
                        summary: "在保持现有 assistant content 渲染的同时，把 change review 数据交给 progress UI。",
                    },
                ],
            },
        ],
    },
    {
        id: "interaction-tests",
        title: "补充交互和测试覆盖",
        summary: "确保审查侧栏、progress 展开、文件跳转和 Explain 入口在复杂场景下稳定。",
        additions: 196,
        deletions: 5,
        files: [
            {
                path: "frontend/app/term/render/agent-progress.test.ts",
                additions: 74,
                deletions: 0,
                summary: "覆盖模块级变更说明、文件层展开和 Explain 入口。",
                blocks: [
                    {
                        id: "default-module-test",
                        title: "验证默认层级",
                        summary: "默认只展示模块摘要，不暴露全部文件 diff 和 raw tool 信息。",
                    },
                    {
                        id: "file-layer-test",
                        title: "验证文件层",
                        summary: "展开模块后展示文件 chip、变更规模和 View diff 入口。",
                    },
                ],
            },
            {
                path: "frontend/app/workspace/right-tool-panel.test.tsx",
                additions: 89,
                deletions: 3,
                summary: "覆盖右侧审查面板的打开、切换和重置逻辑。",
                blocks: [
                    {
                        id: "selection-sync-test",
                        title: "验证选择同步",
                        summary: "点击 progress 中的 View diff 后，右侧面板定位到对应文件。",
                    },
                ],
            },
            {
                path: "frontend/preview/previews/agent-progress.preview.tsx",
                additions: 33,
                deletions: 2,
                summary: "新增复杂 mock，验证多模块、多文件和多代码块的视觉表现。",
                blocks: [
                    {
                        id: "complex-preview",
                        title: "增加复杂前端功能示例",
                        summary: "用真实复杂度的前端功能替换 two-sum 示例，方便评估生产场景下的掌控感。",
                    },
                ],
            },
        ],
    },
];

const mockChangeReview = buildMockChangeReview(changeModules);
mockProgress.changeReview = mockChangeReview;

function buildMockChangeReview(modules: ChangeModule[]): ChangeReview {
    const reviewModules = modules.map((module) => ({
        id: module.id,
        title: module.title,
        summary: module.summary,
        files: module.files.map(toReviewFile),
    }));
    const reviewFiles = reviewModules.flatMap((module) => module.files);

    return {
        changeSetId: "agent-progress-preview-change-review",
        changeSet: {
            id: "agent-progress-preview-change-review",
            files: reviewFiles.map(toChangeSetFile),
            totals: {
                files: reviewFiles.length,
                hunks: reviewFiles.reduce((total, file) => total + file.stats.hunks, 0),
                additions: modules.reduce((total, module) => total + module.additions, 0),
                deletions: modules.reduce((total, module) => total + module.deletions, 0),
            },
        },
        modules: reviewModules,
        ungroupedFiles: [],
        warnings: [],
    };
}

function toReviewFile(file: ChangedFile): ChangeReviewFile {
    const hunks = file.blocks.map((block, index) => toHunk(file, block, index));
    return {
        path: file.path,
        status: "modified",
        hunks,
        stats: {
            hunks: hunks.length,
            additions: file.additions,
            deletions: file.deletions,
        },
    };
}

function toChangeSetFile(file: ChangeReviewFile): ChangeSetFile {
    return {
        ...file,
        operations: [],
    };
}

function toHunk(file: ChangedFile, block: CodeChangeBlock, index: number): ChangeSetHunk {
    const blockCount = Math.max(file.blocks.length, 1);
    const additions = distribute(file.additions, index, blockCount);
    const deletions = distribute(file.deletions, index, blockCount);
    const startLine = 24 + index * 32;
    return {
        id: `${file.path}:${block.id}`,
        path: file.path,
        oldStart: startLine,
        oldLines: Math.max(deletions, 1),
        newStart: startLine,
        newLines: Math.max(additions, 1),
        header: block.title,
        additions,
        deletions,
    };
}

function distribute(total: number, index: number, count: number): number {
    const base = Math.floor(total / count);
    return base + (index < total % count ? 1 : 0);
}

function statText(additions: number, deletions: number): string {
    return `+${additions} -${deletions}`;
}

function fileName(path: string): string {
    return path.split("/").at(-1) ?? path;
}

function ChangeReviewMock() {
    const [openModuleIds, setOpenModuleIds] = useState<Set<string>>(() => new Set(["review-sidebar"]));
    const [openFileIds, setOpenFileIds] = useState<Set<string>>(
        () => new Set(["frontend/app/workspace/right-tool-panel.tsx"])
    );

    const toggleModule = (id: string) => {
        setOpenModuleIds((current) => {
            const next = new Set(current);
            if (next.has(id)) next.delete(id);
            else next.add(id);
            return next;
        });
    };

    const toggleFile = (path: string) => {
        setOpenFileIds((current) => {
            const next = new Set(current);
            if (next.has(path)) next.delete(path);
            else next.add(path);
            return next;
        });
    };

    return (
        <div className="space-y-3" data-agent-change-review-mock="true">
            <div className="mb-4">
                <div className="text-sm font-medium text-[#f0f3f3]">更新代码</div>
                <p className="mt-1 max-w-[760px] text-sm leading-6 text-secondary">
                    这次改动按功能模块组织，而不是按工具调用或文件列表展开。默认展示每个模块做了什么，展开后再进入文件和代码块。
                </p>
            </div>

            {changeModules.map((module) => {
                const isOpen = openModuleIds.has(module.id);
                return (
                    <section
                        key={module.id}
                        className="rounded-xl border border-white/8 bg-white/[0.025] px-3 py-3"
                        data-change-module={module.id}
                    >
                        <button
                            type="button"
                            className="flex w-full items-start gap-2 text-left"
                            aria-expanded={isOpen}
                            onClick={() => toggleModule(module.id)}
                            data-change-module-toggle={module.id}
                        >
                            <span className="mt-1.5 inline-flex h-4 w-4 items-center justify-center text-secondary">
                                <svg viewBox="0 0 16 16" fill="none" className="h-3 w-3" aria-hidden="true">
                                    <path
                                        d={isOpen ? "M4 6l4 4 4-4" : "M6 4l4 4-4 4"}
                                        stroke="currentColor"
                                        strokeWidth="2"
                                        strokeLinecap="round"
                                        strokeLinejoin="round"
                                    />
                                </svg>
                            </span>
                            <span className="min-w-0 flex-1">
                                <span className="flex flex-wrap items-center gap-x-2 gap-y-1">
                                    <span className="text-sm font-medium text-[#f0f3f3]">{module.title}</span>
                                    <span className="rounded-md bg-white/[0.045] px-1.5 py-0.5 font-mono text-[11px] text-secondary">
                                        {module.files.length} files
                                    </span>
                                    <span className="font-mono text-[11px] text-emerald-300/90">
                                        {statText(module.additions, module.deletions)}
                                    </span>
                                </span>
                                <span className="mt-1 block text-sm leading-6 text-secondary">{module.summary}</span>
                            </span>
                        </button>

                        {isOpen && (
                            <div className="mt-3 space-y-2 pl-6" data-change-module-files={module.id}>
                                {module.files.map((file) => {
                                    const fileOpen = openFileIds.has(file.path);
                                    return (
                                        <div
                                            key={file.path}
                                            className="rounded-lg border border-white/7 bg-[#071518]/40 px-3 py-2"
                                            data-change-file={file.path}
                                        >
                                            <div className="flex min-w-0 flex-wrap items-center gap-2">
                                                <button
                                                    type="button"
                                                    disabled
                                                    aria-disabled="true"
                                                    className="inline-flex max-w-[280px] cursor-default items-center gap-1 rounded-md border border-secondary/20 bg-white/[0.04] px-1.5 py-1 font-mono text-[11px] leading-none text-[#dcebed]/75"
                                                    title={`Design reference only; Open file is disabled for ${file.path}.`}
                                                >
                                                    <svg viewBox="0 0 16 16" fill="none" className="h-3 w-3 shrink-0" aria-hidden="true">
                                                        <path
                                                            d="M5 2.5h4.5L13 6v7.5H5z"
                                                            stroke="currentColor"
                                                            strokeWidth="1.8"
                                                            strokeLinecap="round"
                                                            strokeLinejoin="round"
                                                        />
                                                        <path
                                                            d="M9.5 2.5V6H13"
                                                            stroke="currentColor"
                                                            strokeWidth="1.8"
                                                            strokeLinecap="round"
                                                            strokeLinejoin="round"
                                                        />
                                                    </svg>
                                                    <span className="truncate">{fileName(file.path)}</span>
                                                </button>
                                                <span className="font-mono text-[11px] text-emerald-300/90">
                                                    {statText(file.additions, file.deletions)}
                                                </span>
                                                <button
                                                    type="button"
                                                    disabled
                                                    aria-disabled="true"
                                                    className="cursor-default rounded-md px-1.5 py-0.5 text-[11px] text-secondary/70"
                                                    title="Design reference only; View diff is disabled."
                                                >
                                                    View diff
                                                </button>
                                                {file.blocks.length > 0 && (
                                                    <button
                                                        type="button"
                                                        className="rounded-md px-1.5 py-0.5 text-[11px] text-secondary transition-colors hover:bg-white/[0.06] hover:text-white"
                                                        aria-expanded={fileOpen}
                                                        onClick={() => toggleFile(file.path)}
                                                    >
                                                        {fileOpen ? "Hide changes" : "Show changes"}
                                                    </button>
                                                )}
                                            </div>
                                            <p className="mt-2 text-sm leading-6 text-secondary">{file.summary}</p>

                                            {fileOpen && (
                                                <div className="mt-3 space-y-2 border-l border-white/10 pl-3" data-change-file-blocks={file.path}>
                                                    {file.blocks.map((block) => (
                                                        <div key={block.id} className="group rounded-md px-2 py-1.5 hover:bg-white/[0.03]">
                                                            <div className="flex min-w-0 flex-wrap items-center gap-2">
                                                                <span className="text-sm font-medium text-[#e8eeee]">{block.title}</span>
                                                                <button
                                                                    type="button"
                                                                    disabled
                                                                    aria-disabled="true"
                                                                    className="cursor-default rounded-md border border-white/10 px-1.5 py-0.5 text-[11px] text-secondary/70"
                                                                    title="Design reference only; Explain is disabled."
                                                                >
                                                                    Explain
                                                                </button>
                                                            </div>
                                                            <p className="mt-1 text-sm leading-6 text-secondary">{block.summary}</p>
                                                            {block.impact && (
                                                                <p className="mt-1 text-xs leading-5 text-secondary/75">{block.impact}</p>
                                                            )}
                                                        </div>
                                                    ))}
                                                </div>
                                            )}
                                        </div>
                                    );
                                })}
                            </div>
                        )}
                    </section>
                );
            })}
        </div>
    );
}

const failedProgress: AgentProgress = {
    stages: [
        {
            id: "verify-failed",
            title: "验证结果",
            status: "failed",
            summary: "验证失败，因为期望输出和实际返回值不一致。",
            recentActions: [],
            actionGroups: [],
            risk: "command",
        },
    ],
};

export default function AgentProgressPreview() {
    return (
        <div className="flex w-full max-w-[1100px] flex-col gap-8 px-6 py-8">
            <div>
                <h1 className="text-2xl font-semibold tracking-tight text-foreground">Agent Progress Mock</h1>
                <p className="mt-2 max-w-[760px] text-sm leading-6 text-secondary">
                    Complex frontend feature mock for validating the next change-review layer: module → file → code block.
                </p>
            </div>

            <section className="rounded-2xl border border-border bg-panel/60 p-5">
                <div className="mb-4 font-mono text-xs text-secondary">production AgentProgressView output</div>
                <div className="rounded-xl bg-background px-4 py-3">
                    <AgentProgressView progress={mockProgress} showTechnicalDetails />
                </div>
            </section>

            <section className="rounded-2xl border border-border bg-panel/60 p-5">
                <div className="mb-4 font-mono text-xs text-secondary">
                    design reference only: custom ChangeReviewMock, not the primary production path
                </div>
                <div className="rounded-xl bg-background px-4 py-4">
                    <ChangeReviewMock />
                </div>
            </section>

            <section className="rounded-2xl border border-border bg-panel/60 p-5">
                <div className="mb-4 font-mono text-xs text-secondary">failure state</div>
                <div className="rounded-xl bg-background px-4 py-3">
                    <AgentProgressView progress={failedProgress} />
                </div>
            </section>
        </div>
    );
}
