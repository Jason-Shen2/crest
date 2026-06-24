// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0
//
// Public API of the terminal engine.  Consumers (TerminalModel, renderers,
// tests) import from here rather than reaching into individual modules.

export * from "./types";
export { Grid } from "./grid";
export type { CursorPos } from "./grid";
export { BlockGrid } from "./block-grid";
export { HeaderGrid } from "./header-grid";
export type { HeaderReceivingMode } from "./header-grid";
export { AltScreen } from "./alt-screen";
export { Block } from "./block";
export type { BlockInit } from "./block";
export { Blocks } from "./blocks";
export type { VisibleRange } from "./blocks";
export type { AnsiHandler } from "./handler";
export { AnsiParser } from "./ansi-parser";
export { BlockHandler } from "./block-handler";
export type { TerminalContext } from "./block-handler";
export { detectCLIAgent, terminalCaptureActive } from "./terminal-state";
export type {
    CLIAgent,
    CLIAgentInputState,
    CLIAgentSession,
    CLIAgentSessionStatus,
    CursorRenderState,
    TerminalInputState,
    TerminalSurfaceState,
} from "./terminal-state";
export { applySgr, withLink } from "./style";
