# Code Review Open Diff Tab

## Goal

Replace the rightmost Code Review file action with an in-workspace diff action that behaves like Source Control.

## Design

- Keep the action in the existing `FileCard` button group.
- Replace the native-file icon and `Open file` tooltip with the same diff-oriented icon and wording used by Source Control.
- Call the shared `openGitDiffTab` helper with:
  - `repoRoot`: the Code Review model cwd
  - `path`: the changed file path
  - `mode`: `"-"` for the unstaged workspace diff
  - `originalPath`: the changed file's original path when present
- Preserve `stopPropagation()` so clicking the action does not expand or collapse the inline review card.
- Let `openGitDiffTab` own tab reuse, creation, activation, and concurrent-open deduplication.

## Scope

This change does not extend the git diff tab protocol to support Code Review's `MainBranch` or `Other` comparison modes. It does not change the inline Code Review diff, file selection, discard, comment, or context actions.

## Error Handling

Use the project's existing `fireAndForget` convention for the async tab-open action. Missing cwd is handled as a no-op, matching the current native-open guard.

## Testing

Add a focused Code Review panel test that clicks the rightmost file action and verifies:

- `openGitDiffTab` receives the cwd, file path, unstaged mode, and original path.
- The row click does not trigger the expand action.
- The legacy `openNativePath` path is no longer used by this action.
