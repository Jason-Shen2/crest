# Turn Context Multi-Select Design

## Goal

Allow users to select multiple turns from a source session, apply one representation to the selection, and add the references to the current conversation without losing keyboard-only operation.

## Selection Page

- The header contains `← Back` on the left and the selected count plus `Next →` on the right.
- `Next` is disabled when no selectable turn is selected.
- Turn rows no longer contain an `Add context` action.
- Mouse click or `Space` toggles the focused row.
- `ArrowUp` and `ArrowDown` move focus and skip turns already present in the composer.
- `Enter` opens the configuration page when at least one turn is selected.
- `Escape` returns to the session list.
- Selection and keyboard focus are separate visual states:
  - selected rows show a checked marker and selection highlight;
  - the focused row keeps the existing navigation highlight.
- The turn list exposes multi-selection semantics with `aria-multiselectable`, `aria-selected`, and `aria-disabled`.

## Existing Context State

The session selector request exposes a read-only snapshot function for the current composer context. The selector derives added turn IDs from draft and pinned reference provenance using:

- source session path;
- source kind `turn`;
- source turn ID.

Turns already represented in the composer are disabled, visually muted, and display `Added`. They cannot be selected by pointer or keyboard. Reopening `/session` reads the latest composer state, so removing a reference from the composer makes its turn selectable again.

The backend reference-point listing remains source-only and does not receive target-composer state.

## Configuration Page

- All selected turns use one representation: `Full`, `Summary`, or `Metadata`.
- The existing configuration page remains the only representation chooser.
- `Back` returns to the selection page and preserves the current selection.
- The configuration state stores an ordered list of selected turn IDs rather than one turn ID.

## Batch Preparation

The existing per-turn preparation API remains the unit of work. The UI processes every not-yet-successful selected turn and records success or failure per turn.

- All turns are attempted even when one preparation fails.
- If every turn succeeds, the selector closes and the composer shows the new context items.
- If some turns fail, the configuration page stays open and reports `Added N, failed M`.
- Retrying processes only failed turns, preventing duplicate references.
- Returning to the selection page shows successful turns as disabled `Added` rows while failed turns remain selected and available.

## State Reset

- Changing the source session clears the selected turn set and batch result state.
- Closing the selector discards transient selection and failure state.
- Composer reference state remains authoritative across selector openings.
- If source turns disappear while the selector is open, they are removed from the selection before `Next` can proceed.

## Testing

Tests cover:

- pointer and `Space` multi-selection;
- arrow navigation skipping added turns;
- `Enter` and the `Next` button opening configuration;
- disabled `Next` with an empty selection;
- accessible selected and disabled state;
- one shared representation for all selected turns;
- complete batch success;
- partial failure, successful-item preservation, and failed-only retry;
- reopening the selector after composer add/remove operations;
- Back and Escape behavior across both steps.
