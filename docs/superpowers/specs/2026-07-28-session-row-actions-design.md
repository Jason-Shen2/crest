# Session Row Actions Design

## Goal

Reduce visual noise in the `/session` selector while keeping row actions stable and keyboard-accessible.

## Design

- Remove the message-count value from every session row. Keep the relative age as the only trailing metadata.
- Show **Resume** and **Add context** only on the active row. A row becomes active through the existing keyboard navigation or pointer hover behavior.
- Reserve fixed-width columns for Resume, Add context, and age on every row. Hidden actions remain in the layout without accepting pointer or keyboard input, so titles and timestamps do not shift when the active row changes.
- Preserve existing disabled states, click behavior, keyboard action selection, and context-reference availability rules.

## Testing

- Assert inactive rows do not expose visible or focusable action buttons.
- Assert the active row exposes aligned Resume and Add context actions.
- Assert changing the active row transfers action visibility without changing the reserved action layout.
- Assert session rows no longer render message-count metadata.

## Scope

This change is renderer-only. It does not alter session metadata, backend APIs, resume behavior, or context-reference preparation.
