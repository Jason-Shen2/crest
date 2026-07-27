// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0
//
// Public API of the React render layer.  The cell-grid renderer exports
// (GridElement / BlockElement / TerminalView / selection / key-bindings /
// …) were deleted with the old engine (docs/terax-terminal-port.md §四
// P1.7); terminal rendering lives in frontend/app/xterm/ now.

export { TerminalNotification } from "./terminal-notification";
