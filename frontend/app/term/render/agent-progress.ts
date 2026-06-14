// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

import type { PiAgentMessage, PiRun } from "@/app/store/use-pi-chat";

export type AgentProgressStatus = "pending" | "running" | "done" | "failed" | "skipped";
export type AgentRiskLevel = "read-only" | "file-edit" | "command" | "network" | "external" | "destructive";

export interface AgentProgressAction {
    id: string;
    title: string;
    status: AgentProgressStatus;
}

export interface AgentTechnicalCall {
    id: string;
    name: string;
    input: unknown;
    status: AgentProgressStatus;
    result?: AgentTechnicalResult;
}

export interface AgentTechnicalResult {
    content?: Array<{ type: string; text?: string; [field: string]: unknown }>;
    details?: unknown;
    isError?: boolean;
}

export interface AgentProgressActionGroup {
    id: string;
    title: string;
    summary: string;
    status: AgentProgressStatus;
    risk?: AgentRiskLevel;
    toolCalls: AgentTechnicalCall[];
}

export interface AgentProgressStage {
    id: string;
    title: string;
    status: AgentProgressStatus;
    summary: string;
    currentAction?: string;
    recentActions: AgentProgressAction[];
    actionGroups: AgentProgressActionGroup[];
    risk?: AgentRiskLevel;
}

export interface AgentProgress {
    stages: AgentProgressStage[];
}

interface StageDescriptor {
    id: string;
    title: string;
    actionTitle: string;
    groupTitle: string;
    doneSummary: string;
    failedSummary: string;
    risk: AgentRiskLevel;
}

interface ClassifiedCall {
    descriptor: StageDescriptor;
    call: AgentTechnicalCall;
}

const ExploreStage: StageDescriptor = {
    id: "explore-implementation",
    title: "Explore implementation",
    actionTitle: "Inspecting project files.",
    groupTitle: "Inspected project files",
    doneSummary: "Inspected project files and existing implementation.",
    failedSummary: "Could not inspect project files.",
    risk: "read-only",
};

const ModifyStage: StageDescriptor = {
    id: "modify-files",
    title: "Modify files",
    actionTitle: "Updating files.",
    groupTitle: "Updated files",
    doneSummary: "Updated files.",
    failedSummary: "File update failed.",
    risk: "file-edit",
};

const VerifyStage: StageDescriptor = {
    id: "verify-result",
    title: "Verify result",
    actionTitle: "Running validation.",
    groupTitle: "Ran validation",
    doneSummary: "Ran validation.",
    failedSummary: "Validation failed.",
    risk: "command",
};

const CommandStage: StageDescriptor = {
    id: "run-command",
    title: "Run command",
    actionTitle: "Running command.",
    groupTitle: "Ran command",
    doneSummary: "Ran command.",
    failedSummary: "Command failed.",
    risk: "command",
};

const ExternalStage: StageDescriptor = {
    id: "gather-external-context",
    title: "Gather external context",
    actionTitle: "Gathering external context.",
    groupTitle: "Gathered external context",
    doneSummary: "Gathered external context.",
    failedSummary: "External context lookup failed.",
    risk: "network",
};

const GenericStage: StageDescriptor = {
    id: "agent-work",
    title: "Work on task",
    actionTitle: "Working on task.",
    groupTitle: "Completed task activity",
    doneSummary: "Completed task activity.",
    failedSummary: "Task activity failed.",
    risk: "external",
};

const ValidationCommandRe = /\b(test|tests|vitest|jest|lint|typecheck|tsc|build)\b/i;

export function deriveAgentProgress(run: PiRun): AgentProgress {
    const resultsByCallId = indexToolResults(run.responseMessages);
    const calls = collectToolCalls(run.responseMessages, resultsByCallId);
    const classified = calls.map((call) => ({ descriptor: classifyCall(call), call }));
    return { stages: buildStages(classified) };
}

function buildStages(classified: ClassifiedCall[]): AgentProgressStage[] {
    const stages: AgentProgressStage[] = [];
    const stageIdCounts = new Map<string, number>();
    for (const item of classified) {
        const prev = stages[stages.length - 1];
        if (prev?.title === item.descriptor.title) {
            const group = prev.actionGroups[prev.actionGroups.length - 1];
            group.toolCalls.push(item.call);
            group.status = mergeStatus(group.toolCalls);
            group.summary = summarizeGroup(item.descriptor, group.status);
            applyStageDerivedFields(prev, item.descriptor);
            continue;
        }

        const id = makeStageId(item.descriptor.id, stageIdCounts);
        const group: AgentProgressActionGroup = {
            id: `${id}-group-1`,
            title: item.descriptor.groupTitle,
            summary: summarizeGroup(item.descriptor, item.call.status),
            status: item.call.status,
            risk: item.descriptor.risk,
            toolCalls: [item.call],
        };
        const stage: AgentProgressStage = {
            id,
            title: item.descriptor.title,
            status: item.call.status,
            summary: summarizeStage(item.descriptor, item.call.status),
            recentActions: [],
            actionGroups: [group],
            risk: item.descriptor.risk,
        };
        applyStageDerivedFields(stage, item.descriptor);
        stages.push(stage);
    }
    return stages;
}

function makeStageId(baseId: string, counts: Map<string, number>): string {
    const next = (counts.get(baseId) ?? 0) + 1;
    counts.set(baseId, next);
    return next === 1 ? baseId : `${baseId}-${next}`;
}

function applyStageDerivedFields(stage: AgentProgressStage, descriptor: StageDescriptor): void {
    stage.status = mergeStatus(stage.actionGroups);
    stage.summary = summarizeStage(descriptor, stage.status);
    stage.currentAction = stage.status === "running" ? descriptor.actionTitle : undefined;
    stage.recentActions =
        stage.status === "running"
            ? stage.actionGroups
                  .flatMap((group) =>
                      group.toolCalls.map((call) => ({
                          id: call.id,
                          title: descriptor.actionTitle,
                          status: call.status,
                      }))
                  )
                  .slice(-3)
            : [];
}

function summarizeStage(descriptor: StageDescriptor, status: AgentProgressStatus): string {
    if (status === "failed") return descriptor.failedSummary;
    if (status === "running") return descriptor.actionTitle;
    return descriptor.doneSummary;
}

function summarizeGroup(descriptor: StageDescriptor, status: AgentProgressStatus): string {
    if (status === "failed") return descriptor.failedSummary;
    if (status === "running") return descriptor.actionTitle;
    return descriptor.doneSummary;
}

function mergeStatus(items: Array<{ status: AgentProgressStatus }>): AgentProgressStatus {
    if (items.some((item) => item.status === "running")) return "running";
    if (items.some((item) => item.status === "failed")) return "failed";
    if (items.length === 0) return "pending";
    return "done";
}

function collectToolCalls(
    messages: PiAgentMessage[],
    resultsByCallId: Map<string, AgentTechnicalResult>
): AgentTechnicalCall[] {
    const calls: AgentTechnicalCall[] = [];
    for (const message of messages) {
        if (message.role !== "assistant") continue;
        for (const content of message.content ?? []) {
            if (content.type !== "toolCall") continue;
            const id = String(content.id ?? "");
            const result = resultsByCallId.get(id);
            calls.push({
                id,
                name: String(content.name ?? ""),
                input: content.input != null ? content.input : content.arguments,
                status: result == null ? "running" : result.isError ? "failed" : "done",
                result,
            });
        }
    }
    return calls;
}

function indexToolResults(messages: PiAgentMessage[]): Map<string, AgentTechnicalResult> {
    const map = new Map<string, AgentTechnicalResult>();
    for (const message of messages) {
        if (message.role !== "toolResult") continue;
        const messageToolUseId = stringField(message, "toolUseId") || stringField(message, "toolCallId");
        if (messageToolUseId) {
            map.set(messageToolUseId, {
                content: message.content as AgentTechnicalResult["content"],
                details: message.details,
                isError: message.isError === true,
            });
            continue;
        }
        for (const content of message.content ?? []) {
            if (content.type !== "toolResult") continue;
            const toolUseId = stringField(content, "toolUseId") || stringField(content, "toolCallId");
            if (!toolUseId) continue;
            map.set(toolUseId, {
                content: content.content as AgentTechnicalResult["content"],
                details: content.details,
                isError: content.isError === true,
            });
        }
    }
    return map;
}

function classifyCall(call: AgentTechnicalCall): StageDescriptor {
    const name = call.name.toLowerCase();
    if (isEditTool(name)) return ModifyStage;
    if (isCommandTool(name)) {
        return ValidationCommandRe.test(inputCommand(call.input)) ? VerifyStage : CommandStage;
    }
    if (isExternalTool(name)) return ExternalStage;
    if (isReadOnlyTool(name)) return ExploreStage;
    return GenericStage;
}

function isReadOnlyTool(name: string): boolean {
    return [
        /^read$/,
        /(^|[._:-])read([_-]?(text|file))*$/,
        /^grep$/,
        /(^|[._:-])grep$/,
        /^find$/,
        /^glob$/,
        /^ls$/,
        /(^|[._:-])search/,
        /(^|[._:-])list/,
        /(^|[._:-])cmd[_-]?history$/,
    ].some((pattern) => pattern.test(name));
}

function isEditTool(name: string): boolean {
    return [
        /^write$/,
        /^edit$/,
        /(^|[._:-])write/,
        /(^|[._:-])edit/,
        /(^|[._:-])apply[_-]?patch$/,
    ].some((pattern) => pattern.test(name));
}

function isCommandTool(name: string): boolean {
    return [
        /^bash$/,
        /^exec$/,
        /(^|[._:-])exec[_-]?command$/,
        /(^|[._:-])run[_-]?command$/,
        /(^|[._:-])shell[_-]?exec$/,
    ].some((pattern) => pattern.test(name));
}

function isExternalTool(name: string): boolean {
    return /^mcp__/.test(name) || /(^|[._:-])web[_-]?fetch$/.test(name) || /(^|[._:-])fetch$/.test(name);
}

function inputCommand(input: unknown): string {
    if (typeof input === "string") return input;
    if (!input || typeof input !== "object") return "";
    return stringField(input, "command") || stringField(input, "cmd");
}

function stringField(input: unknown, field: string): string {
    if (!input || typeof input !== "object") return "";
    const value = (input as Record<string, unknown>)[field];
    return typeof value === "string" ? value : "";
}
