// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

import * as path from "node:path";

export interface AgentExecutionContext {
    workspaceId: string;
    workspaceDir: string;
    sessionPath?: string;
    environment: Record<string, string>;
    gitBranch?: string;
}

interface WorkspaceSenderView {
    waveWindowId: string;
    initOpts?: { workspaceId: string; generation: number };
}

interface WorkspaceSenderWindow {
    waveWindowId: string;
    workspaceView: WorkspaceSenderView;
}

export async function resolveAuthenticatedWorkspaceSender(
    senderId: number,
    deps: {
        getWorkspaceView: (senderId: number) => WorkspaceSenderView | undefined;
        getWindow: (windowId: string) => WorkspaceSenderWindow | undefined;
        loadWorkspace: (workspaceId: string) => Promise<{ meta?: Record<string, unknown> } | undefined>;
        canonicalizeDirectory: (workspaceDir: string) => Promise<string>;
    }
) {
    const view = deps.getWorkspaceView(senderId);
    if (!view?.initOpts) {
        return undefined;
    }
    const window = deps.getWindow(view.waveWindowId);
    if (!window || window.workspaceView !== view) {
        return undefined;
    }
    const identity = {
        windowId: window.waveWindowId,
        workspaceId: view.initOpts.workspaceId,
        generation: view.initOpts.generation,
    };
    const workspace = await deps.loadWorkspace(identity.workspaceId);
    const configuredDir = workspace?.meta?.["workspace:dir"];
    if (typeof configuredDir !== "string" || !configuredDir) {
        return undefined;
    }
    const workspaceDir = await deps.canonicalizeDirectory(configuredDir);
    if (
        window.workspaceView !== view ||
        view.initOpts?.workspaceId !== identity.workspaceId ||
        view.initOpts?.generation !== identity.generation
    ) {
        return undefined;
    }
    return {
        ...identity,
        workspaceDir,
    };
}

const AgentExecutionContextKeys = new Set([
    "workspaceId",
    "workspaceDir",
    "sessionPath",
    "environment",
    "gitBranch",
]);

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === "object" && value != null && !Array.isArray(value);
}

function requireNonEmptyString(value: unknown, fieldName: string): string {
    if (typeof value !== "string" || !value.trim()) {
        throw new Error(`agent context: ${fieldName} must be a non-empty string`);
    }
    return value;
}

function optionalString(value: unknown, fieldName: string): string | undefined {
    if (value == null) {
        return undefined;
    }
    return requireNonEmptyString(value, fieldName);
}

export async function parseAgentExecutionContext(value: unknown): Promise<AgentExecutionContext> {
    if (!isRecord(value)) {
        throw new Error("agent context: value must be an object");
    }
    for (const key of Reflect.ownKeys(value)) {
        if (typeof key !== "string" || !AgentExecutionContextKeys.has(key)) {
            throw new Error(`agent context: unexpected key ${String(key)}`);
        }
    }
    const workspaceId = requireNonEmptyString(value.workspaceId, "workspaceId");
    const workspaceDir = requireNonEmptyString(value.workspaceDir, "workspaceDir");
    if (!path.isAbsolute(workspaceDir)) {
        throw new Error("agent context: workspaceDir must be absolute");
    }
    const sessionPath = optionalString(value.sessionPath, "sessionPath");
    if (sessionPath && !path.isAbsolute(sessionPath)) {
        throw new Error("agent context: sessionPath must be absolute");
    }
    if (!isRecord(value.environment)) {
        throw new Error("agent context: environment must contain string values");
    }
    const environment: Record<string, string> = {};
    for (const [key, entry] of Object.entries(value.environment)) {
        if (!key || typeof entry !== "string") {
            throw new Error("agent context: environment must contain string values");
        }
        environment[key] = entry;
    }
    const gitBranch = optionalString(value.gitBranch, "gitBranch");
    return {
        workspaceId,
        workspaceDir,
        sessionPath,
        environment,
        gitBranch,
    };
}
