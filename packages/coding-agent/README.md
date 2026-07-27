# @crest/coding-agent

Crest's counterpart to pi-mono `packages/coding-agent`: the layer that tells the LLM how
to use tools — tool definitions, system prompt assembly, sessions, permissions, commands,
context management, change review, observability, eval.

Sync by diffing against `~/Documents/pi-reference/packages/coding-agent` (last checked
upstream: pi main `a597371b`). This package deviates from upstream by design:

- pi-tui render layer stripped (crest has its own renderer).
- `find`/`grep` are pure-Node (upstream shells out to fd/ripgrep); `web_fetch` is crest-only.
- The PTY tool family (`pty-read`/`pty-write`/`pty-transfer`/`spawn-cli-agent`) is
  Electron-host-provided and lives in `emain/agent-tools/`, injected via factory options.

Boundary rule: nothing in this package may import `electron`, `emain/`, or `frontend/`
(enforced by `packages/boundary.test.ts`).
