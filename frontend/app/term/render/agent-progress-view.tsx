// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

import { useWaveEnv, type WaveEnv } from "@/app/waveenv/waveenv";
import { cn, fireAndForget } from "@/util/util";
import { useState } from "react";

import type { ChangeReview, ChangeReviewFile, ChangeReviewModule, ChangeSetHunk } from "./agent-change-review";
import type { AgentProgress, AgentProgressAction, AgentProgressActionGroup, AgentProgressStage } from "./agent-progress";

export interface AgentProgressViewProps {
    progress: AgentProgress;
    showTechnicalDetails?: boolean;
    onExplainChange?: (params: { filePath: string; hunkIds: string[] }) => void;
    onViewDiff?: (params: { filePath: string; hunkIds?: string[] }) => void;
}

function ChevronIcon({ open }: { open: boolean }) {
    return (
        <svg
            viewBox="0 0 16 16"
            fill="none"
            className="h-3 w-3"
            aria-hidden="true"
            data-agent-progress-chevron-icon="true"
        >
            <path
                d={open ? "M4 6l4 4 4-4" : "M6 4l4 4-4 4"}
                stroke="currentColor"
                strokeWidth="2"
                strokeLinecap="round"
                strokeLinejoin="round"
            />
        </svg>
    );
}

function FileIcon() {
    return (
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
    );
}

function basename(path: string): string {
    const normalized = path.replaceAll("\\", "/");
    return normalized.split("/").filter(Boolean).at(-1) ?? path;
}

export function AgentProgressView({
    progress,
    showTechnicalDetails = false,
    onExplainChange,
    onViewDiff,
}: AgentProgressViewProps) {
    const env = useWaveEnv<Pick<WaveEnv, "createBlock">>();
    const changeReviewStageId = firstChangeReviewStageId(progress.stages, progress.changeReview);
    const [openStageIds, setOpenStageIds] = useState<Set<string>>(
        () =>
            new Set(
                showTechnicalDetails
                    ? progress.stages
                          .filter((stage) => stageHasDetails(stage, stage.id === changeReviewStageId ? progress.changeReview : undefined))
                          .map((stage) => stage.id)
                    : []
            )
    );

    if (progress.stages.length === 0) {
        return (
            <section className="py-1 text-sm text-secondary" data-agent-progress-view="true">
                No agent activity yet.
            </section>
        );
    }

    const toggleStage = (stageId: string) => {
        setOpenStageIds((current) => {
            const next = new Set(current);
            if (next.has(stageId)) {
                next.delete(stageId);
                return next;
            }
            next.add(stageId);
            return next;
        });
    };

    const openFile = (path: string) => {
        if (!env?.createBlock) return;
        fireAndForget(() => env.createBlock({ meta: { view: "preview", file: path, connection: "" } }));
    };

    return (
        <section className="py-1" data-agent-progress-view="true" data-agent-progress-rail="true">
            <div className="relative" data-agent-progress-overview="true">
                <div
                    className="absolute bottom-3 left-[3px] top-3 w-px bg-secondary/20"
                    data-agent-progress-stage-rail-line="true"
                    aria-hidden="true"
                />
                <div className="space-y-0.5">
                    {progress.stages.map((stage) => (
                        <StageOverview
                            key={stage.id}
                            stage={stage}
                            changeReview={stage.id === changeReviewStageId ? progress.changeReview : undefined}
                            isOpen={openStageIds.has(stage.id)}
                            onToggle={() => toggleStage(stage.id)}
                            onOpenFile={openFile}
                            onExplainChange={onExplainChange}
                            onViewDiff={onViewDiff}
                        />
                    ))}
                </div>
            </div>
        </section>
    );
}

function StageOverview({
    stage,
    changeReview,
    isOpen,
    onToggle,
    onOpenFile,
    onExplainChange,
    onViewDiff,
}: {
    stage: AgentProgressStage;
    changeReview?: ChangeReview;
    isOpen: boolean;
    onToggle: () => void;
    onOpenFile: (path: string) => void;
    onExplainChange?: (params: { filePath: string; hunkIds: string[] }) => void;
    onViewDiff?: (params: { filePath: string; hunkIds?: string[] }) => void;
}) {
    const statusLabel = readableStatusLabel(stage.status);
    const hasDetails = stageHasDetails(stage, changeReview);

    return (
        <div className="py-1" data-agent-progress-stage-row={stage.id} data-agent-progress-status={stage.status}>
            <div className="flex items-start gap-2">
                <span
                    className={cn(
                        "mt-2 h-1.5 w-1.5 shrink-0 rounded-full",
                        stage.status === "failed" && "bg-rose-400",
                        stage.status === "running" && "bg-[var(--ansi-yellow)]",
                        stage.status === "done" && "bg-[var(--ansi-green)]",
                        (stage.status === "pending" || stage.status === "skipped") && "bg-secondary"
                    )}
                    aria-hidden="true"
                />
                <div className="min-w-0 flex-1">
                    <div
                        className="flex flex-wrap items-center gap-x-1.5 gap-y-1"
                        data-agent-progress-stage-title-row={stage.id}
                    >
                        {hasDetails ? (
                            <button
                                type="button"
                                aria-expanded={isOpen}
                                data-agent-progress-stage-toggle={stage.id}
                                onClick={onToggle}
                                className="flex cursor-pointer items-center gap-1.5 text-left text-sm font-medium text-[#f0f3f3] transition-colors hover:text-white"
                            >
                                <span>{stage.title}</span>
                                <span
                                    className="inline-flex h-4 w-4 items-center justify-center text-secondary transition-colors"
                                    data-agent-progress-stage-chevron={stage.id}
                                    aria-hidden="true"
                                >
                                    <ChevronIcon open={isOpen} />
                                </span>
                            </button>
                        ) : (
                            <span className="text-sm font-medium text-[#f0f3f3]" data-agent-progress-stage-title={stage.id}>
                                {stage.title}
                            </span>
                        )}
                        {statusLabel && (
                            <span
                                className={cn(
                                    "rounded-full px-1.5 py-0.5 text-[11px] font-medium",
                                    stage.status === "failed" && "bg-rose-400/10 text-rose-300",
                                    stage.status === "running" && "bg-[var(--ansi-yellow)]/10 text-[var(--ansi-yellow)]"
                                )}
                                data-agent-progress-status-label={stage.id}
                            >
                                {statusLabel}
                            </span>
                        )}
                    </div>
                    <p className="mt-1 text-sm text-secondary">{stage.summary}</p>
                    {stage.currentAction && (
                        <p className="mt-2 text-xs text-secondary" data-agent-progress-current-action="true">
                            {stage.currentAction}
                        </p>
                    )}
                    {hasDetails && isOpen && (
                        <ul className="mt-2 space-y-1" data-agent-progress-stage-details={stage.id}>
                            {stage.actionGroups.map((group) => (
                                <StageActionGroup key={group.id} group={group} onOpenFile={onOpenFile} />
                            ))}
                            {shouldRenderChangeReview(stage, changeReview) && (
                                <ChangeReviewDetails
                                    changeReview={changeReview}
                                    onOpenFile={onOpenFile}
                                    onExplainChange={onExplainChange}
                                    onViewDiff={onViewDiff}
                                />
                            )}
                        </ul>
                    )}
                    {stage.recentActions.length > 0 && (
                        <ul className="mt-2 space-y-1">
                            {stage.recentActions.map((action) => (
                                <li
                                    key={action.id}
                                    className="text-xs text-secondary"
                                    data-agent-progress-recent-action={action.id}
                                    data-agent-progress-recent-action-status={action.status}
                                >
                                    {action.title}
                                </li>
                            ))}
                        </ul>
                    )}
                </div>
            </div>
        </div>
    );
}

function stageHasDetails(stage: AgentProgressStage, changeReview?: ChangeReview): boolean {
    return stage.actionGroups.length > 0 || shouldRenderChangeReview(stage, changeReview);
}

function shouldRenderChangeReview(stage: AgentProgressStage, changeReview?: ChangeReview): changeReview is ChangeReview {
    return stage.risk === "file-edit" && changeReview != null && hasChangeReviewItems(changeReview);
}

function hasChangeReviewItems(changeReview: ChangeReview): boolean {
    return changeReview.modules.length > 0 || changeReview.ungroupedFiles.length > 0 || changeReview.warnings.length > 0;
}

function firstChangeReviewStageId(stages: AgentProgressStage[], changeReview?: ChangeReview): string {
    if (changeReview == null || !hasChangeReviewItems(changeReview)) return "";
    return stages.find((stage) => stage.risk === "file-edit")?.id ?? "";
}

function StageActionGroup({
    group,
    onOpenFile,
}: {
    group: AgentProgressActionGroup;
    onOpenFile: (path: string) => void;
}) {
    if (group.risk !== "file-edit" || group.actions.length === 0) {
        return <li className="text-xs text-secondary">{group.summary}</li>;
    }
    return (
        <>
            {group.actions.map((action) => (
                <li
                    key={action.id}
                    className="space-y-1 text-xs text-secondary"
                    data-agent-progress-action-status={action.status}
                >
                    <div className="flex min-w-0 items-center gap-1.5">
                        <span className="shrink-0 text-secondary/70" aria-hidden="true">
                            •
                        </span>
                        <span className="min-w-0 truncate" data-agent-progress-action-summary={action.id}>
                            <ActionSummary action={action} onOpenFile={onOpenFile} />
                        </span>
                    </div>
                </li>
            ))}
        </>
    );
}

function ActionSummary({ action, onOpenFile }: { action: AgentProgressAction; onOpenFile: (path: string) => void }) {
    if (!action.detail) {
        return <>{action.summary}</>;
    }

    const filename = basename(action.detail);
    const filenameIndex = action.summary.indexOf(filename);
    if (filenameIndex === -1) {
        return (
            <>
                {action.summary} <FileLink action={action} filename={filename} onOpenFile={onOpenFile} />
            </>
        );
    }

    const before = action.summary.slice(0, filenameIndex);
    const after = action.summary.slice(filenameIndex + filename.length);
    return (
        <>
            {before}
            <FileLink action={action} filename={filename} onOpenFile={onOpenFile} />
            {after}
        </>
    );
}

function FileLink({
    action,
    filename,
    onOpenFile,
}: {
    action: AgentProgressAction;
    filename: string;
    onOpenFile: (path: string) => void;
}) {
    const path = action.detail;
    if (!path) {
        return null;
    }

    return (
        <button
            type="button"
            title={`Open ${path}`}
            onClick={() => onOpenFile(path)}
            className="inline-flex max-w-[180px] items-center gap-1 rounded-md border border-secondary/20 bg-white/[0.04] px-1.5 py-0.5 font-mono text-[11px] leading-none text-[#dcebed] no-underline transition-colors hover:border-[var(--accent-color)]/50 hover:bg-[var(--accent-color)]/10 hover:text-white"
            data-agent-progress-file-link={action.id}
            data-agent-progress-file-path={path}
            data-agent-progress-action-evidence={action.id}
        >
            <FileIcon />
            <span className="min-w-0 truncate">{filename}</span>
        </button>
    );
}

function ChangeReviewDetails({
    changeReview,
    onOpenFile,
    onExplainChange,
    onViewDiff,
}: {
    changeReview: ChangeReview;
    onOpenFile: (path: string) => void;
    onExplainChange?: (params: { filePath: string; hunkIds: string[] }) => void;
    onViewDiff?: (params: { filePath: string; hunkIds?: string[] }) => void;
}) {
    return (
        <li className="space-y-2 pt-1 text-xs text-secondary" data-agent-progress-change-review={changeReview.changeSetId}>
            {changeReview.modules.map((module) => (
                <ChangeReviewModuleBlock
                    key={module.id}
                    module={module}
                    onOpenFile={onOpenFile}
                    onExplainChange={onExplainChange}
                    onViewDiff={onViewDiff}
                />
            ))}
            {changeReview.ungroupedFiles.length > 0 && (
                <ChangeReviewModuleBlock
                    module={{ id: "ungrouped", title: "Other changes", files: changeReview.ungroupedFiles }}
                    onOpenFile={onOpenFile}
                    onExplainChange={onExplainChange}
                    onViewDiff={onViewDiff}
                />
            )}
            {changeReview.warnings.map((warning) => (
                <div
                    key={`${warning.code}:${warning.message}`}
                    className="rounded-md border border-[var(--ansi-yellow)]/30 bg-[var(--ansi-yellow)]/10 px-2 py-1 text-[var(--ansi-yellow)]"
                    data-agent-progress-change-warning={warning.code}
                >
                    {warning.message}
                </div>
            ))}
        </li>
    );
}

function ChangeReviewModuleBlock({
    module,
    onOpenFile,
    onExplainChange,
    onViewDiff,
}: {
    module: ChangeReviewModule;
    onOpenFile: (path: string) => void;
    onExplainChange?: (params: { filePath: string; hunkIds: string[] }) => void;
    onViewDiff?: (params: { filePath: string; hunkIds?: string[] }) => void;
}) {
    return (
        <div className="space-y-1.5 rounded-lg border border-secondary/15 bg-white/[0.02] p-2" data-agent-progress-change-module={module.id}>
            <div className="space-y-0.5">
                <div className="font-medium text-[#f0f3f3]">{module.title}</div>
                {module.summary && <div className="text-secondary/80">{module.summary}</div>}
            </div>
            <div className="space-y-1.5">
                {module.files.map((file) => (
                    <ChangeReviewFileBlock
                        key={`${module.id}:${file.path}`}
                        file={file}
                        onOpenFile={onOpenFile}
                        onExplainChange={onExplainChange}
                        onViewDiff={onViewDiff}
                    />
                ))}
            </div>
        </div>
    );
}

function ChangeReviewFileBlock({
    file,
    onOpenFile,
    onExplainChange,
    onViewDiff,
}: {
    file: ChangeReviewFile;
    onOpenFile: (path: string) => void;
    onExplainChange?: (params: { filePath: string; hunkIds: string[] }) => void;
    onViewDiff?: (params: { filePath: string; hunkIds?: string[] }) => void;
}) {
    return (
        <div className="space-y-1 rounded-md bg-black/10 p-1.5" data-agent-progress-change-file={file.path}>
            <div className="flex flex-wrap items-center gap-1.5">
                <ChangeReviewFileChip file={file} onOpenFile={onOpenFile} />
                <span className="rounded-full bg-white/[0.04] px-1.5 py-0.5 text-[10px] uppercase tracking-wide text-secondary/80">
                    {file.status}
                </span>
                <ChangeReviewStats additions={file.stats.additions} deletions={file.stats.deletions} hunks={file.stats.hunks} />
            </div>
            {file.hunks.length > 0 && (
                <div className="space-y-1">
                    {file.hunks.map((hunk) => (
                        <ChangeReviewHunk
                            key={hunk.id}
                            hunk={hunk}
                            filePath={file.path}
                            onExplainChange={onExplainChange}
                            onViewDiff={onViewDiff}
                        />
                    ))}
                </div>
            )}
            {file.patchStatus === "unavailable" && file.patchUnavailableReason && (
                <div className="text-secondary/70">{file.patchUnavailableReason}</div>
            )}
        </div>
    );
}

function ChangeReviewFileChip({
    file,
    onOpenFile,
}: {
    file: ChangeReviewFile;
    onOpenFile: (path: string) => void;
}) {
    return (
        <button
            type="button"
            title={`Open ${file.path}`}
            onClick={() => onOpenFile(file.path)}
            className="inline-flex max-w-[220px] cursor-pointer items-center gap-1 rounded-md border border-secondary/20 bg-white/[0.04] px-1.5 py-0.5 font-mono text-[11px] leading-none text-[#dcebed] transition-colors hover:border-[var(--accent-color)]/50 hover:bg-[var(--accent-color)]/10 hover:text-white"
            data-agent-progress-change-file-chip={file.path}
        >
            <FileIcon />
            <span className="min-w-0 truncate">{basename(file.path)}</span>
        </button>
    );
}

function ChangeReviewStats({ additions, deletions, hunks }: { additions: number; deletions: number; hunks: number }) {
    return (
        <span className="inline-flex items-center gap-1 text-[11px] text-secondary/80">
            <span>{hunks} hunks</span>
            <span className="text-[var(--ansi-green)]">+{additions}</span>
            <span className="text-rose-300">-{deletions}</span>
        </span>
    );
}

function ChangeReviewHunk({
    hunk,
    filePath,
    onExplainChange,
    onViewDiff,
}: {
    hunk: ChangeSetHunk;
    filePath: string;
    onExplainChange?: (params: { filePath: string; hunkIds: string[] }) => void;
    onViewDiff?: (params: { filePath: string; hunkIds?: string[] }) => void;
}) {
    const lineRange = `-${hunk.oldStart},${hunk.oldLines} +${hunk.newStart},${hunk.newLines}`;
    return (
        <div className="rounded-md border border-secondary/10 bg-black/10 px-2 py-1" data-agent-progress-change-hunk={hunk.id}>
            <div className="flex flex-wrap items-center gap-1.5">
                <span className="font-mono text-[11px] text-secondary/70">{lineRange}</span>
                {hunk.header && <span className="min-w-0 truncate text-secondary">{hunk.header}</span>}
                <span className="text-[var(--ansi-green)]">+{hunk.additions}</span>
                <span className="text-rose-300">-{hunk.deletions}</span>
            </div>
            {(onViewDiff || onExplainChange) && (
                <div className="mt-1 flex flex-wrap gap-1">
                    {onViewDiff && (
                        <button
                            type="button"
                            title="View diff for this hunk."
                            onClick={() => onViewDiff({ filePath, hunkIds: [hunk.id] })}
                            className="rounded-md border border-secondary/20 px-1.5 py-0.5 text-[11px] cursor-pointer text-secondary transition-colors hover:border-[var(--accent-color)]/50 hover:text-white"
                            data-agent-progress-change-hunk-diff={hunk.id}
                        >
                            View diff
                        </button>
                    )}
                    {onExplainChange && (
                        <button
                            type="button"
                            title="Explain this hunk."
                            onClick={() => onExplainChange({ filePath, hunkIds: [hunk.id] })}
                            className="rounded-md border border-secondary/20 px-1.5 py-0.5 text-[11px] cursor-pointer text-secondary transition-colors hover:border-[var(--accent-color)]/50 hover:text-white"
                            data-agent-progress-change-hunk-explain={hunk.id}
                        >
                            Explain
                        </button>
                    )}
                </div>
            )}
        </div>
    );
}

function readableStatusLabel(status: AgentProgressStage["status"]): string {
    if (status === "failed") return "Failed";
    if (status === "running") return "Running";
    return "";
}
