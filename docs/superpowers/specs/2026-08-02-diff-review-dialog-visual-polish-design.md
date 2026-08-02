# Diff Review Dialog Visual Polish Design

## Goal

Polish the shared `DiffReviewDialog` so Review, Undo, Redo, Revert, and conversation Redo all use a focused, magnified diff-review surface without introducing a second component or a separate visual language.

## Approved Direction

Use the approved **A · Magnified Dialog** direction:

- keep the interaction as a modal rather than a full-screen route;
- expand the desktop surface to `96vw × 94vh` from the `sm` breakpoint upward;
- retain a restrained corner radius and deep shadow so the surface remains visibly modal;
- remove the bright outer border;
- preserve the existing header, split file/diff body, and caller-owned footer structure.

Below the `sm` breakpoint, use `calc(100vw - 1rem) × calc(100vh - 1rem)` and retain the existing stacked file-list/diff layout.

## Visual Structure

### Dialog shell

- Override the shared `DialogContent` border with `border-0` only for `DiffReviewDialog`.
- Use a near-full-viewport width and height on desktop, with viewport-safe bounds on smaller screens.
- Keep `overflow-hidden`, the existing rounded shell, and a strong but neutral shadow.
- Do not modify the global shadcn dialog defaults; other dialogs must remain unchanged.

### Header and footer

- Keep both regions compact and fixed while the body scrolls.
- Continue using subtle `border-border` separators inside the dialog. The requested border removal applies to the bright outer shell, not the internal hierarchy.
- Do not add more controls, labels, or decorative chrome.

### Review body

- Give the file list roughly one quarter of the desktop width, with a practical minimum width.
- Let the diff surface consume the remaining space and height.
- Preserve independent scrolling for the file list and diff body.
- Retain the approved muted-gray hover/selection treatment; do not introduce blue selection backgrounds.

## File Icon Consistency

The left file list already resolves icons through `getFileIcon(basename, false, false)`. The right diff header currently renders a legacy extension badge such as `MD` through the shared `FileCard`.

Replace that badge with the same `getFileIcon()` result used by the file list:

- resolve from the filename basename, not the full path;
- use the existing icon size and color supplied by the resolver;
- preserve `showIcon={false}` behavior;
- apply the change in shared `FileCard` so every agent diff card uses consistent repository file icons.

No new icon mapping or duplicate icon component will be introduced.

## Component Boundaries

- `DiffReviewDialog` owns only its magnified modal sizing and split-pane presentation.
- `FileCard` owns the shared diff-header file icon.
- `DiffViewer` continues to parse and render patches without dialog-specific knowledge.
- The shared shadcn `DialogContent` remains unchanged.

## Testing

Renderer tests will lock down:

1. the dialog shell has no outer border and uses the magnified viewport sizing;
2. the internal header/footer/file-pane separators remain present;
3. the file pane retains muted-gray hover and selection styles;
4. `FileCard` calls `getFileIcon()` with the basename and renders the resolved icon instead of an extension badge;
5. `showIcon={false}` still suppresses the icon;
6. existing selection, keyboard navigation, conflict, warning, and footer behavior remains unchanged.

Focused visual regression tests will cover `DiffReviewDialog`, `DiffViewer`, and `FileCard` consumers.

## Out of Scope

- changing diff colors, syntax highlighting, or patch semantics;
- creating a dedicated full-screen route;
- adding a magnify toggle;
- changing global dialog styling;
- redesigning Undo, Redo, Force, or Review behavior.
