# @crest/agent

In-tree fork of [`@earendil-works/pi-agent-core`](https://github.com/badlogic/pi-mono)
(pi-mono `packages/agent`). The file set mirrors upstream `src/`: `index.ts`, `node.ts`,
`types.ts`, `agent.ts`, `agent-loop.ts`, `proxy.ts`, `harness/`.

Sync by diffing against `~/Documents/pi-reference/packages/agent/src` (last checked
upstream: pi main `a597371b`). The last full upstream sync predates this extraction — the next sync
should start from that diff.

Known deviations from upstream:

- No `stream-fn.ts`; no `harness/tools/` (crest's tools live in `@crest/coding-agent`).
- Crest adds SQLite session storage (`harness/session/sqlite-*`).
- `harness/messages.ts` augments `../types` CustomAgentMessages with crest message kinds.
- Crest adds cross-session context projection-report types in `harness/types.ts` (consumed by the coding-agent context layer).

Boundary rule: nothing in this package may import `electron`, `emain/`, or `frontend/`
(enforced by `packages/boundary.test.ts`).
