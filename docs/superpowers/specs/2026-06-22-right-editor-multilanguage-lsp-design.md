# Right Editor Multilanguage LSP Design

Date: 2026-06-22
Status: Design draft

## Summary

Right editor currently has a multi-language editing surface, but LSP-backed IDE features are limited to the JavaScript/TypeScript family. This design upgrades the LSP architecture from hard-coded language checks to a registry-based, workspace-reused, multi-language-ready foundation. The first end-to-end sample language is Go via `gopls`.

The first implementation should not attempt to support many languages at once. It should preserve existing JS/TS behavior, add the extensibility layer, and use Go to validate the full path from file language detection to server startup, status reporting, diagnostics, and code navigation.

## Goals

- Replace hard-coded JS/TS LSP gating with a maintainable language-server registry.
- Reuse one language server per `workspaceRoot + serverId`, rather than starting servers per file or tab.
- Keep existing TypeScript and JavaScript LSP behavior unchanged.
- Add Go as the first new language sample through `gopls`.
- Make LSP availability and startup failures visible in the right editor UI.
- Keep first-version dependency and packaging risk low by discovering `gopls` from the user environment instead of bundling or auto-installing it.
- Record progress in this document and the follow-up implementation plan so the current state and next steps remain visible.

## Non-Goals

- Do not add Python, Rust, C/C++, or other languages in the first implementation.
- Do not build a full dynamic language-server installer in the first implementation.
- Do not bundle `gopls` in the application package in the first implementation.
- Do not add a marketplace or plugin system.
- Do not enable LSP for every Monaco language id.
- Do not expand formatting, rename, code action, or refactor support beyond what the connected LSP already provides.

## Current State

The right editor already maps file paths to Monaco language ids. This includes `go`, `python`, `rust`, `json`, `yaml`, `markdown`, `shell`, `css`, `html`, `typescript`, and `javascript`.

The LSP startup path is narrower:

- The frontend only starts LSP for `typescript`, `typescriptreact`, `javascript`, and `javascriptreact`.
- The backend language server manager only resolves those language ids to `typescript-language-server`.
- The application packaging config only includes `typescript-language-server` and `typescript`.
- LSP status exists as a type, but the editor UI does not clearly expose availability, startup, running, or error states.

This means Go files can be opened and edited, but advanced IDE features such as definition navigation, references, hover, and diagnostics do not currently work for Go.

## Warp Reference

Warp's public codebase uses a curated server model rather than enabling arbitrary language ids. The relevant ideas to borrow are:

- A supported server registry defines the finite list of language servers.
- Each server maps to one or more language ids.
- Server-specific candidate logic handles detection, installation, and command construction.
- Servers are registered and reused at workspace scope.
- Different servers can use different install strategies.
- Basic editor/language functionality is separate from LSP-backed intelligence.

For Crest, the first version should borrow the registry and workspace reuse patterns. Dynamic installation should be deferred until the registry and lifecycle are stable.

## Architecture

### Language Server Registry

Add a registry for right editor LSP support. The registry describes server-level capabilities rather than raw file extensions.

Each entry should contain:

- `serverId`: stable id such as `typescript-language-server` or `gopls`.
- `displayName`: user-facing label such as `TypeScript/JavaScript` or `Go`.
- `languages`: Monaco language ids handled by this server.
- `command`: backend command resolution config.
- `availability`: how to determine whether the server can run.
- `installHint`: user-facing remediation if the server is unavailable.

Existing JS/TS support becomes one registry entry:

- `serverId`: `typescript-language-server`
- `languages`: `typescript`, `typescriptreact`, `javascript`, `javascriptreact`
- command: existing packaged or app-local `typescript-language-server --stdio`

Go becomes the first new sample entry:

- `serverId`: `gopls`
- `languages`: `go`
- command: `gopls`
- availability: executable found on PATH and `gopls version` succeeds
- install hint: `go install golang.org/x/tools/gopls@latest`

### Frontend LSP Gating

Replace `shouldStartRightEditorLsp(language, workspaceRoot)` hard-coded checks with registry lookup.

The function should return true only when:

- `workspaceRoot` is present.
- The active file language maps to a registered server.

Unsupported languages remain in basic editing mode.

### Server Keying And Reuse

Change LSP lifecycle keying from `workspaceRoot + language` to `workspaceRoot + serverId`.

This avoids duplicate servers for language ids that share a server. For example:

- `.ts`, `.tsx`, `.js`, and `.jsx` share `typescript-language-server` in a workspace.
- All `.go` files share one `gopls` in a workspace.

The active document can still pass its concrete `language` to the Monaco language client document selector. The server lifecycle should be keyed by server id.

### Transport Contract

The existing WebSocket transport already carries `workspaceRoot` and `language`. It should be extended to include `serverId`, or the backend should derive `serverId` from `language`.

Preferred first-version contract:

- Frontend sends `workspaceRoot`, `language`, and `serverId`.
- Backend validates that `language` belongs to `serverId`.
- Backend resolves command by `serverId`.

This makes logs, status, and process reuse easier to reason about.

### Backend Command Resolution

Replace backend `resolveCommand(language)` with a registry-backed resolution path:

1. Resolve `language -> serverId` if `serverId` was not provided.
2. Resolve `serverId -> command`.
3. Validate availability.
4. Return an executable command and args.

For first-version Go:

- Run `gopls` from PATH.
- Use no additional stdio args, because `gopls` defaults to stdio behavior when started as an LSP server.
- If unavailable, return a structured error with the install hint.

For existing JS/TS:

- Preserve current packaged command resolution for production.
- Preserve fallback to app-local `node_modules/.bin/typescript-language-server`.

### UI Status

Expose LSP status in the right editor status area.

Supported states:

- `Basic editing`: file language has no registered LSP.
- `LSP: <name> starting`: server startup in progress.
- `LSP: <name> ready`: server running.
- `LSP: <name> unavailable`: registered server cannot be found.
- `LSP: <name> error`: server failed to start or transport failed.

Go-specific unavailable message should include:

```text
Install gopls: go install golang.org/x/tools/gopls@latest
```

This avoids the current failure mode where advanced IDE features appear broken without a visible reason.

### Dependency And Packaging

Do not bundle `gopls` in the first version.

Reasons:

- `gopls` depends on the user's Go toolchain and module environment.
- Bundling would require platform and architecture-specific binary handling.
- Warp also treats `gopls` differently from servers with downloadable release binaries.
- A PATH-based first version validates the LSP architecture without introducing packaging risk.

The existing `typescript-language-server` packaging rules remain unchanged.

## Error Handling

- Unsupported language: do not attempt to start LSP; show basic editing or no LSP status.
- Registered server unavailable: show `unavailable` with install hint; do not retry aggressively.
- Server startup failure: show `error` with a concise message.
- WebSocket failure: show `error` and allow retry when active file or workspace changes.
- Server exits: mark stopped/error and clean up references.

Errors should be visible to users and logged for debugging.

## Testing Strategy

### Unit Tests

- Registry maps JS/TS language ids to `typescript-language-server`.
- Registry maps `go` to `gopls`.
- Unsupported languages return no server.
- Frontend LSP gating starts for `go` with workspace root.
- Frontend LSP gating still starts for JS/TS.
- Frontend LSP gating does not start without workspace root.
- Backend command resolution returns existing TS command behavior unchanged.
- Backend command resolution returns `gopls` when available.
- Backend command resolution returns unavailable error when `gopls` is missing.

### Lifecycle Tests

- Multiple Go files in one workspace acquire one `gopls` lifecycle entry.
- Go and TS files in one workspace acquire separate server entries.
- Closing the last file for a server releases that server.
- Switching active files does not restart an already running server.

### UI Tests

- Basic editing state appears for unsupported languages.
- Starting/running/error/unavailable states render in the status area.
- Go unavailable state includes the `go install` hint.

### Integration Validation

Use a minimal Go workspace:

```text
go.mod
main.go
pkg/foo.go
```

Validate:

- Opening `main.go` starts `gopls`.
- Diagnostics appear as Monaco markers.
- Go to definition reaches a symbol in `pkg/foo.go`.
- The server is reused when switching between Go files.

## Implementation Phases And Progress

Progress is tracked here until an implementation plan is written. After implementation planning begins, the plan document should continue the same phase checklist.

| Phase | Status | Notes |
| --- | --- | --- |
| Phase 0: Research | Done | Current Crest LSP chain and Warp LSP architecture reviewed. |
| Phase 1: Design | Done | Registry, workspace reuse, Go sample, and status UI decisions captured. |
| Phase 2: Plan | Done | Implementation checklist created in `docs/superpowers/plans/2026-06-22-right-editor-multilanguage-lsp.md`. |
| Phase 3: Registry Refactor | Done | Frontend and backend registry paths replace JS/TS hard-coding. |
| Phase 4: Go Sample | Done | `gopls` PATH discovery and unavailable-status behavior are covered by automated tests; `gopls` was present in the verification shell. |
| Phase 5: UI Status | Done | Right editor shows basic, starting, ready, unavailable, and error states. |
| Phase 6: Verification | Done | Focused automated tests and `build:dev` passed; manual GUI Go available/unavailable validation was not performed. |

## First-Version Decisions

- The WebSocket query includes `serverId` explicitly.
- Server shutdown is immediate when the last reference is released; idle timeout can be added later if needed.
- Go LSP starts for any `.go` file when `gopls` is available on PATH. Workspaces with `go.mod` should behave best, but `go.mod` is not required for first-version startup.

## Success Criteria

- Existing TS/JS LSP behavior is unchanged.
- Go files can start `gopls` when it is available on PATH.
- Missing `gopls` produces a visible, actionable status message.
- LSP lifecycle is keyed by `workspaceRoot + serverId`.
- Multiple files sharing a server do not start duplicate server processes.
- Unsupported languages remain usable in basic editing mode.
- The design and follow-up plan make progress and next steps visible.
