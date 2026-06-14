// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

import { cn } from "@/util/util";

import type { AgentProgress, AgentProgressActionGroup, AgentProgressStage } from "./agent-progress";
import { ToolCallCard } from "./tool-call-card";

export interface AgentProgressViewProps {
    progress: AgentProgress;
    showTechnicalDetails?: boolean;
}

export function AgentProgressView({ progress, showTechnicalDetails = false }: AgentProgressViewProps) {
    if (progress.stages.length === 0) {
        return (
            <section className="rounded-xl border border-[#25434a] bg-[#16282d] p-4" data-agent-progress-view="true">
                <p className="text-sm text-secondary">No agent activity yet.</p>
            </section>
        );
    }

    return (
        <section className="space-y-3" data-agent-progress-view="true">
            <div className="space-y-2" data-agent-progress-overview="true">
                {progress.stages.map((stage) => (
                    <StageOverview key={stage.id} stage={stage} />
                ))}
            </div>
            {showTechnicalDetails && (
                <div className="space-y-3" data-agent-progress-technical-details="true">
                    <div className="text-xs font-medium uppercase tracking-[0.18em] text-secondary">
                        Technical details
                    </div>
                    {progress.stages.flatMap((stage) =>
                        stage.actionGroups.map((group) => (
                            <TechnicalGroup key={group.id} group={group} />
                        ))
                    )}
                </div>
            )}
        </section>
    );
}

function StageOverview({ stage }: { stage: AgentProgressStage }) {
    return (
        <article
            className="rounded-xl border border-[#25434a] bg-[#16282d] p-4"
            data-agent-progress-stage={stage.id}
            data-agent-progress-status={stage.status}
        >
            <div className="flex items-start gap-3">
                <span
                    className={cn(
                        "mt-1 h-2.5 w-2.5 shrink-0 rounded-full",
                        stage.status === "failed" && "bg-rose-400",
                        stage.status === "running" && "bg-[var(--ansi-yellow)]",
                        stage.status === "done" && "bg-[var(--ansi-green)]",
                        (stage.status === "pending" || stage.status === "skipped") && "bg-secondary"
                    )}
                    aria-hidden="true"
                />
                <div className="min-w-0 flex-1">
                    <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
                        <h3 className="text-sm font-medium text-[#f0f3f3]">{stage.title}</h3>
                        <span className="rounded-full border border-[#25434a] px-2 py-0.5 text-[11px] text-secondary">
                            {statusLabel(stage.status)}
                        </span>
                    </div>
                    <p className="mt-1 text-sm text-secondary">{stage.summary}</p>
                    {stage.currentAction && (
                        <p className="mt-2 text-xs text-secondary" data-agent-progress-current-action="true">
                            {stage.currentAction}
                        </p>
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
        </article>
    );
}

function TechnicalGroup({ group }: { group: AgentProgressActionGroup }) {
    return (
        <section className="rounded-xl border border-[#25434a] bg-[#102024] p-3" data-agent-progress-group={group.id}>
            <div className="px-1 pb-1">
                <div className="text-sm font-medium text-[#f0f3f3]">{group.title}</div>
                <div className="text-xs text-secondary">{group.summary}</div>
            </div>
            {group.toolCalls.map((call) => (
                <ToolCallCard key={call.id} call={call} result={call.result} />
            ))}
        </section>
    );
}

function statusLabel(status: AgentProgressStage["status"]): string {
    switch (status) {
        case "failed":
            return "Failed";
        case "running":
            return "Running";
        case "pending":
            return "Pending";
        case "skipped":
            return "Skipped";
        case "done":
            return "Done";
    }
}
