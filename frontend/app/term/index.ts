// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0
//
// Top-level public API.  The old cell-grid engine (engine/, terminal-model)
// was deleted with the terax xterm port (docs/terax-terminal-port.md §四
// P1.7); what remains here is the agent surface render layer plus the
// completion / nld / contextchip modules, which consumers import directly.

export * from "./render";
