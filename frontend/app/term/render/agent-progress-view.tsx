// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

import { cn } from "@/util/util";
import { useState } from "react";

import type { AgentProgress, AgentProgressActionGroup, AgentProgressStage } from "./agent-progress";

export interface AgentProgressViewProps {
    progress: AgentProgress;
    showTechnicalDetails?: boolean;
}

export function AgentProgressView({ progress, showTechnicalDetails = false }: AgentProgressViewProps) {
    const [openStageIds, setOpenStageIds] = useState<Set<string>>(
        () => new Set(showTechnicalDetails ? progress.stages.map((stage) => stage.id) : [])
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
                            isOpen={openStageIds.has(stage.id)}
                            onToggle={() => toggleStage(stage.id)}
                        />
                    ))}
                </div>
            </div>
        </section>
    );
}

function StageOverview({
    stage,
    isOpen,
    onToggle,
}: {
    stage: AgentProgressStage;
    isOpen: boolean;
    onToggle: () => void;
}) {
    const statusLabel = readableStatusLabel(stage.status);

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
                        <button
                            type="button"
                            aria-expanded={isOpen}
                            data-agent-progress-stage-toggle={stage.id}
                            onClick={onToggle}
                            className="flex cursor-pointer items-center gap-1.5 text-left text-sm font-medium text-[#f0f3f3] transition-colors hover:text-white"
                        >
                            <span>{stage.title}</span>
                            <span
                                className="text-xs leading-none text-secondary transition-colors"
                                data-agent-progress-stage-chevron={stage.id}
                                aria-hidden="true"
                            >
                                {isOpen ? "v" : ">"}
                            </span>
                        </button>
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
                    {isOpen && (
                        <ul className="mt-2 space-y-1" data-agent-progress-stage-details={stage.id}>
                            {stage.actionGroups.map((group) => (
                                <StageActionGroup key={group.id} group={group} />
                            ))}
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

function StageActionGroup({ group }: { group: AgentProgressActionGroup }) {
    if (group.risk !== "file-edit" || group.actions.length === 0) {
        return <li className="text-xs text-secondary">{group.summary}</li>;
    }
    return (
        <>
            {group.actions.map((action) => (
                <li
                    key={action.id}
                    className="space-y-0.5 text-xs text-secondary"
                    data-agent-progress-action-status={action.status}
                >
                    <div className="flex min-w-0 items-center gap-2">
                        <span className="min-w-0 truncate" data-agent-progress-action-summary={action.id}>
                            {action.summary}
                        </span>
                    </div>
                    {action.detail && (
                        <div
                            className="truncate font-mono text-[11px] text-secondary/70"
                            data-agent-progress-action-detail={action.id}
                            data-agent-progress-action-evidence={action.id}
                        >
                            {action.detail}
                        </div>
                    )}
                </li>
            ))}
        </>
    );
}

function readableStatusLabel(status: AgentProgressStage["status"]): string {
    if (status === "failed") return "Failed";
    if (status === "running") return "Running";
    return "";
}
