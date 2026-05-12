// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0
//
// Top-level public API.  Most consumers import individual modules, but the
// shorthand `import { TerminalView } from "@/app/term"` is handy.

export * from "./engine";
export * from "./render";
export { TerminalModel } from "./terminal-model";
export type { ScrollPosition } from "./terminal-model";
