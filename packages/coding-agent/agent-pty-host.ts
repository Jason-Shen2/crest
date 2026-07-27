// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

import type { AgentExecutionContext } from "./agent-execution-context";

export const MaxAgentPtyCols = 500;
export const MaxAgentPtyRows = 200;

export interface AgentPtyScreenCell {
    char: string;
}

export interface AgentPtyScreenRow {
    text: string;
    cells: AgentPtyScreenCell[];
}

export interface AgentPtyCursor {
    row: number;
    col: number;
    visible: boolean;
    shape: "block" | "underline" | "bar";
    blink: boolean;
}

export interface AgentPtySnapshot {
    commandId: string;
    command: string;
    cwd: string;
    tail: string;
    screen: {
        rows: AgentPtyScreenRow[];
        cursor: AgentPtyCursor;
        isAltScreenActive: boolean;
    };
    running: boolean;
    exitCode?: number;
    cols: number;
    rows: number;
    needsUserInput: boolean;
}

export interface AgentPtyCommandPort {
    commandId: string;
    read(): AgentPtySnapshot;
    write(input: string): Promise<void>;
    resize(cols: number, rows: number): void;
    requestUserInput(reason: string): void;
    stop(): Promise<void>;
}

export interface AgentPtyHost {
    start(command: string, context: AgentExecutionContext): Promise<AgentPtySnapshot>;
    read(commandId: string): AgentPtySnapshot;
    write(commandId: string, input: string): Promise<void>;
    resize(commandId: string, cols: number, rows: number): void;
    stop(commandId: string): Promise<void>;
    getCommandPort(commandId: string): AgentPtyCommandPort;
    snapshots(): AgentPtySnapshot[];
    hasRunningCommands(): boolean;
    setOnUpdate?(listener: (snapshot: AgentPtySnapshot) => void): void;
    dispose(): Promise<void>;
}

function unavailable(): never {
    throw new Error("hosted PTY support is not configured");
}

export function makeUnavailableAgentPtyHost(): AgentPtyHost {
    return {
        start: async () => unavailable(),
        read: unavailable,
        write: async () => unavailable(),
        resize: unavailable,
        stop: async () => unavailable(),
        getCommandPort: unavailable,
        snapshots: () => [],
        hasRunningCommands: () => false,
        dispose: async () => {},
    };
}
