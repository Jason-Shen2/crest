// Copyright 2026, s-zx
// SPDX-License-Identifier: Apache-2.0
//
// "termblocks" registration shim.  The "term" and "termblocks" view types
// are merged (docs/terax-terminal-port.md §四 P2.7, decision D9): both
// resolve to TermViewModel and render identically through the pooled xterm
// engine, with command-block decorations on by default and the per-block
// meta key `term:blocks` (explicit false) as the opt-out.
//
// This alias exists only so serialized block.meta.view values of
// "termblocks" keep resolving through the block registry.  The former
// standalone TermBlocksViewModel (itself a shim over the same engine) was
// deleted — see git history.

export { TermViewModel as TermBlocksViewModel } from "@/view/term/term-model";
