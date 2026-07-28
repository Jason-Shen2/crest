# Agent Sessions Panel Style Design

## Goal

Polish the workspace's left Agent Sessions panel using the compact visual language of assistant-ui's Thread List while preserving crest's existing session data flow and behavior.

## Scope

The change is limited to visual classes and presentation in `frontend/app/agent/agent-sessions-panel.tsx`.

The implementation will:

- Add consistent inset spacing around the session list.
- Render each session as a compact rounded row with a 34-pixel minimum height.
- Use a soft neutral background and brighter text for the active session.
- Use lower-contrast neutral backgrounds for hover and keyboard-focused states.
- Reduce the visual weight of relative timestamps.
- Improve spacing for loading and empty states.
- Reuse the existing sidebar color tokens so the panel remains consistent with the file explorer.

The implementation will not:

- Add assistant-ui Thread List primitives or another runtime.
- Change session loading, sorting, creation, selection, renaming, archiving, deletion, or cancellation.
- Add an ellipsis button or a new action menu.
- Replace or modify the existing right-click context menu.
- Change keyboard navigation.
- Add grouping, search, filtering, or pagination.
- Change the panel header height or controls.

## Visual States

### Default

Rows use transparent backgrounds, rounded corners, compact horizontal padding, normal foreground text, and low-contrast timestamps.

### Hover

The hovered row uses a subtle neutral sidebar background. No colored accent or outline is shown.

### Keyboard Focus

The keyboard-focused row uses a neutral background that is slightly clearer than hover while remaining weaker than the active state.

### Active Session

The active session uses a soft neutral gray background and higher-contrast foreground text. It has no blue indicator, colored border, or accent-colored fill.

## Architecture and Data Flow

No architecture or data-flow changes are required. `AgentSessionsPanel` continues to load sessions from `AgentRuntimeClient`, derive the active row from `WorkspaceAgentModel`, and invoke the existing workspace and context-menu actions.

## Error Handling

Existing loading failure behavior remains unchanged. The panel will continue to log the failure and display the empty state.

## Verification

- Run the focused `AgentSessionsPanel` test suite to confirm creation, selection, active-state signaling, and context-menu actions remain intact.
- Run the relevant frontend type check.
- Inspect the rendered panel to confirm neutral active, hover, and keyboard-focused states and to ensure no blue accent was introduced.
