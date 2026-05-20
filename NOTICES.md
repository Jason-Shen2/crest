# Third-party notices

This project contains code whose structure and design are derived from
open-source projects. Per each project's license terms, the required
copyright notices and license texts are reproduced below.

---

## Warp Terminal

Several agent-related modules in this project port data shapes,
interface contracts, behavioral semantics, and UX patterns from
[Warp Terminal](https://github.com/warpdotdev/Warp). The Go and
TypeScript code is original implementation in crest's idioms (Go vs
Rust, React + Tailwind + jotai vs warp's `warpui` GPU framework); the
Warp source informed the structural design only.

Each derived file carries a top-of-file attribution header pointing at
the specific Warp source path it references. The canonical inventory
is at the end of this section.

Warp is distributed under the MIT License. Required copyright notice
and license text:

> Copyright (C) 2020-2026 Denver Technologies, Inc.
>
> Permission is hereby granted, free of charge, to any person obtaining
> a copy of this software and associated documentation files (the
> "Software"), to deal in the Software without restriction, including
> without limitation the rights to use, copy, modify, merge, publish,
> distribute, sublicense, and/or sell copies of the Software, and to
> permit persons to whom the Software is furnished to do so, subject to
> the following conditions:
>
> The above copyright notice and this permission notice shall be
> included in all copies or substantial portions of the Software.
>
> THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND,
> EXPRESS OR IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF
> MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT.
> IN NO EVENT SHALL THE AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY
> CLAIM, DAMAGES OR OTHER LIABILITY, WHETHER IN AN ACTION OF CONTRACT,
> TORT OR OTHERWISE, ARISING FROM, OUT OF OR IN CONNECTION WITH THE
> SOFTWARE OR THE USE OR OTHER DEALINGS IN THE SOFTWARE.

### Files in crest derived from Warp

| Crest file | Warp source reference |
|---|---|
| `pkg/aiusechat/uctypes/uctypes.go` (Citation, AskUserQuestion\* types) | `crates/ai/src/agent/citation.rs`, `crates/ai/src/agent/action/mod.rs:611-657` |
| `pkg/agent/tools/ask_user_question.go` | `crates/ai/src/agent/action/mod.rs:167-169, 611-657` |
| `pkg/agent/tools/long_running_read.go` | `crates/ai/src/agent/action/mod.rs:126-129, 756-760` |
| `pkg/agent/tools/long_running_write.go` | `crates/ai/src/agent/action/mod.rs:61-65, 762-812` (AIAgentPtyWriteMode + decorate_bytes) |
| `pkg/agent/tools/transfer_to_user.go` | `crates/ai/src/agent/action/mod.rs:161-165` |
| `frontend/app/term/render/agent-block-element.tsx` | `app/src/ai/blocklist/agent_view/agent_view_block.rs`, `app/src/ai/blocklist/agent_view/inline_agent_view_header.rs` |
| `frontend/app/term/render/agent-chat-host.tsx` | `app/src/ai/blocklist/controller/response_stream.rs:45-117`, `app/src/ai/blocklist/history_model.rs:2177-2203` |
| `frontend/app/term/render/citation-chips.tsx` | `app/src/ai/blocklist/inline_action/requested_command_attribution.rs`, `app/src/ai/blocklist/block/view_impl.rs:655-728` |
| `frontend/app/term/render/tool-use-card.tsx` | `app/src/ai/blocklist/inline_action/inline_action_header.rs`, `requested_command.rs`, `code_diff_view.rs`, `app/src/ai/blocklist/block/view_impl.rs:78` (ACCEPT_PROMPT_SUGGESTION_KEYBINDING) |
| `frontend/app/term/render/tool-action-header.tsx` | `app/src/ai/blocklist/inline_action/inline_action_header.rs` |
| `frontend/app/term/render/tool-command-card.tsx` | `app/src/ai/blocklist/inline_action/requested_command.rs` |
| `frontend/app/term/render/tool-diff-card.tsx` | `app/src/ai/blocklist/inline_action/code_diff_view.rs` |
| `frontend/app/term/render/tool-ask-card.tsx` | `app/src/ai/blocklist/inline_action/ask_user_question_view.rs` (UX patterns: ← → nav, ^A cancel, completed-state render); `crates/ai/src/agent/action/mod.rs:611-657` (data shape) |

Files in `frontend/app/view/cmdblock/` also contain inline
`// warp <path>` reference comments at specific design decisions; the
underlying component layout there is a separate authoring effort and
not listed individually here.

### Audit status

Structural correspondence between crest's port and Warp's source was
audited on 2026-05-20. Strict-port fixes were applied where the crest
implementation deviated from Warp's published shapes (see `A1`–`A4`
in `docs/warp-agent-improvement-plan.md` → "Audit findings"). A short
list of deliberate deviations (crest extensions, stack-driven
divergences) is recorded in the same document under "C-class
decisions".
