# @crest/ai

In-tree fork of [`@earendil-works/pi-ai`](https://github.com/badlogic/pi-mono), started
from **v0.75.5**. Exports TypeScript source directly; the app bundle inlines it.

Upstream mapping: `pi-mono/packages/ai`. Sync by diffing against
`~/Documents/pi-reference/packages/ai` (last checked upstream: v0.82.1).

Known deviations from upstream:

- Image generation, Bedrock, Vertex, Azure, Codex, Mistral, and Faux providers are
  stripped — re-add by copying back from upstream.
- `models-dev-overlay.ts` is crest-only and lives in `emain/` (Electron-coupled).

Boundary rule: nothing in this package may import `electron`, `emain/`, or `frontend/`
(enforced by `packages/boundary.test.ts`).
