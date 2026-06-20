# Agent Change Review Design

## Context

The current agent progress rail makes tool activity easier to scan, but code edits still lack enough review confidence. A stage such as `更新代码` can show that a file changed, yet production users need more than a changed-file list before they can trust agent-authored code.

For code changes, users need to answer two questions quickly:

- What code changed?
- What is each meaningful part trying to accomplish?

Large changes cannot explain every line by default without becoming another wall of text. The UI should instead organize changes from broad to specific: first by feature or module-level intent, then by file, then by meaningful code block. Detailed explanation remains available through a focused `Explain` entry when the user wants to go deeper.

This design is related to the agent progress checkpoint design, but it solves a different problem. Progress checkpoints describe what the agent is doing. Change review describes what the agent changed and why the change matters.

## Product Principle

Change review must be evidence-backed, not purely model-authored.

The UI can keep the rich module -> file -> code-block hierarchy from the mock, but correctness must come from system-derived code change data. The agent may organize and explain real changes; it must not invent files, hunks, or change statistics.

## Goals

- Preserve the approved complex review hierarchy: feature/module -> file -> code block -> `Explain`.
- Make code changes feel reviewable without exposing raw tool cards by default.
- Show enough semantic context for users to understand large chunks of code.
- Keep changed files, diff stats, paths, and hunk anchors grounded in system/tool/git-derived data.
- Allow agent-authored grouping, titles, summaries, and explanations only for real changes.
- Provide fallback UI when semantic grouping is missing, incomplete, or invalid.
- Keep progress rail simple while offering a richer code-review surface inside the `更新代码` stage or a linked review panel.

## Non-Goals

- Do not replace the full diff viewer.
- Do not explain every changed line by default.
- Do not expose chain-of-thought or private reasoning.
- Do not show raw tool calls as the primary review UI.
- Do not require a second model call for every file or hunk in the default path.
- Do not block rendering changed files when the agent fails to produce structured semantic grouping.

## Competitive Pattern

Mature coding products do not rely purely on free-form model output for code-change display.

- Warp uses model-authored titles or summaries for requested edits, but the file tabs, diff stats, and displayed diffs come from applied file diffs and editor diff models.
- Codex accepts model-authored patch/tool input, then parses and applies it through a strict patch grammar. The displayed diff comes from parsed patch deltas or `git diff`, not from prose.
- Claude-like editor agents, Cline, Aider, and OpenCode generally use snapshots, editor diffs, tool metadata, or git diffs for changed files and hunks. Model-authored text is used for summaries, completion notes, or commit messages.

Crest should follow the same split: system-derived change evidence is authoritative; agent-authored narrative makes it understandable.

## Mental Model

The review pipeline has three named layers:

- `ChangeSet`: the authoritative code-change inventory produced from tools, patch application, workspace snapshots, or git diff.
- `ChangeNarrative`: the agent-authored semantic organization of those changes.
- `ChangeReview`: the validated UI model produced by merging `ChangeSet` and `ChangeNarrative`.

Flow:

```text
Tool edits / patch application / git diff
  -> ChangeSet
  -> ChangeNarrative
  -> validate + merge
  -> ChangeReview
  -> Change Review UI
```

`ChangeSet` answers "what changed." `ChangeNarrative` answers "how should the user understand it." `ChangeReview` is the safe, renderable result.

## UI Hierarchy

The current complex mock remains the target shape.

### Module Layer

Modules are the default top-level units in the code-change review UI. A module represents a feature-level or architecture-level goal, not a raw tool call.

Each module should show:

- Title, such as `新增 Agent 变更审查侧栏`.
- One-sentence summary of the user-visible purpose.
- Number of files.
- Add/delete stats aggregated from real changed files.
- Expand control only when there are files to inspect.

Modules should be phrased naturally. Avoid labels such as `Why:` in the UI. The title and summary should directly explain intent.

### File Layer

Expanding a module reveals the files related to that module.

Each file row should show:

- Clickable file chip using the real path.
- Add/delete stats from `ChangeSet`.
- File-level summary from `ChangeNarrative` when valid.
- `Open file` entry.
- `View diff` entry.
- Expand control only when meaningful code-block summaries exist.

File chips should be styled as interactive code navigation, not as quoted or backtick-wrapped plain text.

### Code-Block Layer

Expanding a file reveals meaningful changed regions.

Each code block should show:

- Short title.
- Brief explanation of what the changed region does.
- Optional impact text when it materially improves review confidence.
- `Explain` entry for a focused follow-up explanation.

The block layer is not a replacement for line-by-line diff review. It is a semantic guide over real diff hunks.

### Detailed Diff

`View diff` should open the authoritative diff view for that file or hunk. The diff content and line numbers come from `ChangeSet`, not from `ChangeNarrative`.

## Data Model

The exact TypeScript names can evolve during implementation, but the domain boundaries should remain stable.

```ts
interface ChangeSet {
    id: string;
    source: "tool-edits" | "patch" | "snapshot" | "git-diff";
    baseRef?: string;
    headRef?: string;
    files: ChangeSetFile[];
}

interface ChangeSetFile {
    path: string;
    previousPath?: string;
    status: "added" | "modified" | "deleted" | "renamed";
    additions: number;
    deletions: number;
    hunks: ChangeSetHunk[];
}

interface ChangeSetHunk {
    id: string;
    filePath: string;
    oldStart: number;
    oldLines: number;
    newStart: number;
    newLines: number;
    additions: number;
    deletions: number;
    diffPreview?: string;
}
```

```ts
interface ChangeNarrative {
    changeSetId: string;
    modules: ChangeNarrativeModule[];
}

interface ChangeNarrativeModule {
    id?: string;
    title: string;
    summary: string;
    files: ChangeNarrativeFile[];
}

interface ChangeNarrativeFile {
    path: string;
    summary?: string;
    hunkGroups?: ChangeNarrativeHunkGroup[];
}

interface ChangeNarrativeHunkGroup {
    title: string;
    summary: string;
    impact?: string;
    hunkIds: string[];
}
```

```ts
interface ChangeReview {
    changeSetId: string;
    modules: ChangeReviewModule[];
    ungroupedFiles: ChangeReviewFile[];
    warnings: ChangeReviewWarning[];
}

interface ChangeReviewModule {
    id: string;
    title: string;
    summary: string;
    additions: number;
    deletions: number;
    files: ChangeReviewFile[];
}

interface ChangeReviewFile {
    path: string;
    previousPath?: string;
    status: "added" | "modified" | "deleted" | "renamed";
    additions: number;
    deletions: number;
    summary?: string;
    hunkGroups: ChangeReviewHunkGroup[];
}

interface ChangeReviewHunkGroup {
    id: string;
    title: string;
    summary: string;
    impact?: string;
    hunkIds: string[];
    additions: number;
    deletions: number;
}

interface ChangeReviewWarning {
    kind: "missing-narrative" | "unknown-file" | "unknown-hunk" | "empty-module" | "stale-narrative";
    message: string;
}
```

## Source Of Truth

`ChangeSet` is authoritative for:

- Changed file paths.
- Rename/delete/add/modify status.
- Add/delete counts.
- Hunk IDs and line ranges.
- Diff previews and full diff lookup.
- Whether a file can be opened.

`ChangeNarrative` is allowed to provide:

- Module grouping.
- Module titles and summaries.
- File summaries.
- Hunk group titles, summaries, and impact text.
- Suggested focus for `Explain`.

`ChangeNarrative` is not allowed to provide:

- New file paths that are not in `ChangeSet`.
- Add/delete counts.
- Diff content.
- Line numbers as authority.
- Claims that a file changed if the system did not observe it.

## Merge And Validation

The merge step converts `ChangeSet + ChangeNarrative` into `ChangeReview`.

Validation rules:

- Ignore narrative files whose paths do not exist in `ChangeSet`.
- Ignore hunk IDs that do not exist for that file.
- Drop modules that contain no valid files after validation.
- Compute module and hunk-group stats from `ChangeSet`, never from narrative.
- Put valid changed files that are not referenced by any valid module into `ungroupedFiles`.
- If the whole narrative is missing or invalid, synthesize a conservative `ChangeReview` grouped by changed file.
- If the narrative references a stale `changeSetId`, render the `ChangeSet` fallback and record a `stale-narrative` warning.

Fallback copy must stay conservative. It may say `Updated frontend/app/term/render/agent-progress-view.tsx`; it must not infer feature intent that the agent did not provide.

## Agent Authoring Contract

The agent should produce `ChangeNarrative` after meaningful code edits, preferably near the same boundary where it would emit a progress checkpoint for `更新代码`.

Authoring rules:

- Group by user-understandable feature or module goal.
- Keep module summaries short and outcome-oriented.
- Include only files that were actually changed.
- Attach hunk groups only when they map to known hunk IDs.
- Prefer a few meaningful code-block groups over many tiny line-level notes.
- Use `Explain` for details that would make the default UI too verbose.

The system prompt should frame this as a review aid, not as an opportunity to narrate private reasoning:

> When you finish meaningful code edits, organize the real changed files into user-facing change review modules. Use only file paths and hunk IDs supplied by the system. Explain the purpose of each module and meaningful code region briefly. Do not invent files, diff stats, or line numbers.

## Relationship To Agent Progress

The progress rail remains lightweight:

- `理解任务`, `检查实现`, `更新代码`, and `验证结果` stay as high-level progress stages.
- The `更新代码` stage may show a compact summary and a preview of changed modules.
- Expanding `更新代码` can reveal the change review layer, or link to a right-side review panel.
- Raw tool cards remain hidden unless the user opens deeper technical trace.

This keeps progress and review separate:

- Progress answers "where is the agent in the work?"
- Change review answers "what code changed, and why should I trust it?"

## Interaction Behavior

Default state:

- Show modules collapsed or with the most relevant module expanded.
- Avoid expanding all files and code blocks by default.
- Show changed-file counts and stats at module level.

Module expansion:

- Reveals related files.
- Preserves scroll position and open state while the user reviews the current run.

File actions:

- `Open file` opens the file through existing Crest workspace/block behavior.
- `View diff` opens the authoritative diff for that file.
- `Show changes` expands code-block summaries only when they exist.

Explain action:

- Starts a focused follow-up prompt using the selected file path and hunk IDs.
- The follow-up explanation can be richer, but it should still reference system-derived diff context.

Run switching:

- Clear selection state when the active agent run changes.
- Do not show stale change review content from a previous run.

## Error Handling

Missing narrative:

- Render changed files from `ChangeSet` with conservative summaries.
- Keep `View diff` and `Open file` available.

Partial narrative:

- Render valid modules.
- Put unreferenced changed files into an `Other changes` section.
- Do not show warnings prominently unless they affect user action.

Invalid paths or hunks:

- Drop invalid references.
- Record warnings for diagnostics.
- Never render a file or hunk solely because the agent mentioned it.

Large changes:

- Cap default visible code-block summaries per file.
- Keep full file diff one click away.
- Use `Explain` for local detail rather than expanding all explanation text.

## Testing Strategy

Model and merge tests:

- Builds `ChangeReview` from a complete valid narrative.
- Drops unknown file paths.
- Drops unknown hunk IDs.
- Computes all stats from `ChangeSet`.
- Places ungrouped files into fallback sections.
- Falls back cleanly when narrative is missing or stale.

Renderer tests:

- Shows module -> file -> code-block hierarchy.
- Renders file names as clickable chips.
- Shows expand controls only when expandable content exists.
- Opens files through the existing Crest file/block mechanism.
- Routes `View diff` to system-derived diff data.
- Shows `Explain` with file path and hunk IDs attached.

Regression tests:

- Does not render raw tool names as default progress UI.
- Does not accept narrative-only invented files.
- Does not duplicate review content as assistant markdown.

## Implementation Boundaries

First implementation should focus on a single stable path:

- Derive `ChangeSet` from the existing edit/diff source available after agent file changes.
- Allow `ChangeNarrative` to be supplied by agent content or run metadata.
- Add a pure merge function that returns `ChangeReview`.
- Render `ChangeReview` in the existing progress surface or previewed review panel.
- Keep the current mock hierarchy intact while replacing mock data with validated data.

The implementation plan can decide whether the richer review UI lives inside `AgentProgressView`, a new child component, or a right-side panel. The product contract is independent of that placement.

## Open Questions For Implementation Plan

- Which existing Crest layer should own `ChangeSet` extraction for each edit mechanism?
- Whether `ChangeNarrative` should be emitted inline with assistant content or stored as run metadata.
- Whether `View diff` initially opens file-level diff only or supports hunk-level anchoring in the first version.
- How many code-block summaries should be visible per file before collapsing behind `Show more`.

These are implementation choices. The design requirement is fixed: rich review hierarchy stays, while file and diff truth comes from system-derived change evidence.
