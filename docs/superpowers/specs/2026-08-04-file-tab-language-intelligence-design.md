# File Tab Language Intelligence Design

- Date: 2026-08-04
- Status: Design approved; written spec review pending
- Scope: Workspace File Top Tabs

## Summary

Workspace File Top Tabs should use Monaco's bundled language registrations for syntax highlighting instead of a short handwritten extension allowlist. They should also reuse Crest's existing workspace-scoped LSP transport for TypeScript/JavaScript and Go.

The first delivery provides broad syntax highlighting plus read-only language intelligence: diagnostics, completion, hover, signature help, symbols, references, and definition navigation. LSP operations that can modify more than the active document, such as rename and some code actions, remain a second milestone because Crest does not yet have a workspace-edit owner for unopened File Top Tabs.

This work extends the current File Top Tab runtime. It does not bring back Wave Tab or `codeeditor` Block ownership for files.

## Goals

- Highlight every language already registered by the bundled Monaco build when its filename or extension is recognized.
- Fix `.tsx` and `.jsx` highlighting by using Monaco's real language ids: `typescript` and `javascript`.
- Preserve special shell-dotfile handling for names Monaco does not infer, including `.zshrc`, `.bashrc`, and `.profile`.
- Reuse one LSP client per `workspaceRoot + serverId` for File Top Tabs.
- Enable existing TypeScript/JavaScript and Go language intelligence in File Top Tabs.
- Open definition and reference targets in an existing or new File Top Tab and reveal the requested position.
- Surface `starting`, `ready`, `unavailable`, and `error` LSP states without blocking basic editing.
- Keep model, dirty-buffer, view-state, rename, delete, and close-guard behavior owned by the current Workspace File runtime.

## Non-Goals

- Do not add Python, Rust, Java, C/C++, or additional language servers in this delivery.
- Do not bundle or install `gopls`; continue using PATH discovery and the existing install hint.
- Do not promise LSP for SSH or remote files whose filesystem is not visible to the Electron language-server process.
- Do not replace Monaco, add a VS Code extension marketplace, or load arbitrary TextMate grammars.
- Do not implement resource-creating, resource-renaming, or resource-deleting LSP workspace edits in the first milestone.
- Do not silently write unopened files in response to rename or code actions.

## Current State

`getRightEditorLanguage()` is shared by File Top Tabs, the right editor, `codeeditor` views, and Git Diff. It recognizes only a small set of extensions. Unknown files are forced to `plaintext` even though the imported Monaco entry point already registers many more languages.

The current React mappings are also invalid for standalone Monaco:

- `.tsx` maps to `typescriptreact`, but Monaco registers `.ts` and `.tsx` under `typescript`.
- `.jsx` maps to `javascriptreact`, but Monaco registers `.js` and `.jsx` under `javascript`.

The right editor and `codeeditor` view already acquire clients from `LanguageClientManager`. The current server registry contains:

- `typescript-language-server` for the TypeScript/JavaScript family.
- `gopls` for Go.

File Top Tabs do not acquire an LSP client. Their models use a `wave://workspace/...` URI, while the language client selects `file://` documents. This prevents the existing LSP providers from attaching and prevents language servers from resolving the model to a real filesystem path.

## Architecture

### 1. Monaco Language Resolution

Replace the handwritten extension allowlist with a shared resolver based on `monaco.languages.getLanguages()`.

The resolver matches in this order:

1. Crest basename overrides for shell dotfiles.
2. Monaco exact `filenames` entries, such as `Dockerfile`.
3. Monaco extensions, longest suffix first.
4. `plaintext` fallback.

The matching helper should be pure and accept language definitions as input so tests do not depend on Monaco global state. A thin runtime wrapper supplies the bundled Monaco definitions.

The resolver returns the actual Monaco model language id. In particular:

- `.tsx` returns `typescript`.
- `.jsx` returns `javascript`.
- `.dockerfile` and `Dockerfile` return `dockerfile`.
- Java, C/C++, SQL, XML, Lua, Ruby, and other bundled Monaco languages work without adding Crest-specific map entries.

All existing consumers continue to use one resolver so File Top Tabs, right editor models, `codeeditor` views, and Git Diff cannot disagree about language identity.

### 2. File URI And Model Ownership

LSP-backed models need canonical `file://` URIs. Move the existing Windows-safe `pathToFileUri()` helper out of `right-editor-model.ts` into a shared editor-path module and use it for Workspace File models.

Monaco permits only one model for a URI. File Top Tabs and the right editor can show the same local file, so model lifetime must be reference-counted across surfaces rather than owned by separate `MonacoModelRegistry` instances.

Use the singleton `MonacoModelRegistry` for Workspace File models. Each consumer retains a distinct model key, for example:

```text
workspace:<workspaceId>:<normalizedPath>
right-editor:<normalizedPath>
block:<blockId>:<normalizedPath>
```

The URI remains the canonical `file://` URI. Closing one surface releases only its key; the model is disposed only after the last key is released.

Model sharing must not bypass existing dirty-state owners. Each runtime continues subscribing to Monaco content changes. A successful save publishes the saved text through the shared registry so every retained adapter can update its saved baseline without clearing newer edits made while a save was in flight.

### 3. Workspace Root Propagation

`WorkspaceAppInner` already resolves `workspaceDir`. Pass that directory into `WorkspaceEditorRegistry` and expose it through each `WorkspaceFileRuntime`.

The LSP lifecycle input for a File Top Tab is:

```ts
{
    workspaceRoot: runtime.workspaceRoot,
    language: runtime.language,
    serverId: languageServer.serverId,
    languages: languageServer.languages,
}
```

If the workspace root is missing or the resolved language has no registered server, the file remains in basic editing mode.

### 4. Shared Language-Intelligence Lifecycle

Move the reusable lifecycle and status helpers currently located in `right-editor-workbench.tsx` into a focused language-intelligence module. The right editor, `codeeditor` view, and File Top Tab should consume the same API.

The API is responsible for:

- Mapping a Monaco language id to a server definition.
- Acquiring and releasing the shared client.
- Subscribing to status changes.
- Returning the install hint for unavailable servers.

File components stay mounted after first activation, so an activated file retains its server lease until the tab closes. Multiple files backed by the same server increase the existing reference count but still use one process and one WebSocket client for the workspace.

Language-server definitions should use Monaco's actual ids. The TypeScript server entry therefore uses `typescript` and `javascript`; TSX and JSX behavior is inferred from the canonical file URI extension.

### 5. File Tab LSP Status

Add a compact File Top Tab footer consistent with the existing right-editor status treatment.

Status text:

- Unsupported language: `Basic editing`.
- Starting: `<displayName> LSP starting`.
- Running: `<displayName> LSP ready`.
- Unavailable: the registry install hint when present.
- Error: a concise connection or startup message.

Save errors remain higher priority than LSP status. LSP failure never disables editing or saving.

### 6. Cross-File Navigation

Register one workspace-scoped `monaco.editor.registerEditorOpener()` while `WorkspaceApp` is mounted.

For a local `file://` target:

1. Convert the URI to a normalized local path.
2. Call `WorkspaceTopTabController.openFile(path)`, which reuses an existing File Top Tab or creates one.
3. Queue the requested range in `WorkspaceEditorRegistry` for that tab/path.
4. When the target editor mounts, consume the pending range, set the selection, reveal it in the center, and focus the editor.

The opener returns `false` for unsupported schemes so Monaco can continue its default behavior. The opener is disposed during workspace replacement or unmount so stale workspace controllers cannot receive navigation.

Definition and reference navigation are read-only and belong to the first delivery.

### 7. Workspace Edits: Second Milestone

Rename and some code actions return LSP `WorkspaceEdit` values that can affect files without open models. Applying them safely requires a workspace-level coordinator rather than direct Monaco edits.

The second milestone adds a `WorkspaceEditCoordinator` with these rules:

1. Accept text edits for canonical local `file://` URIs.
2. Validate document versions and all ranges before changing any model.
3. Ensure every affected file has a Workspace File runtime and File Top Tab, creating background tabs without changing the active tab.
4. Apply edits to Monaco models as unsaved changes so normal dirty indicators, undo, save, and close guards remain authoritative.
5. Restore the source tab as active and report a concise failure if any target could not be loaded.
6. Reject create, rename, and delete resource operations until they are integrated with the existing file-mutation transaction and rollback path.

The first milestone must not claim multi-file rename or workspace-editing code actions as supported. Providers that require unsupported resource operations should return a visible unsupported-operation result rather than partially applying an edit.

## Data Flow

### Open And Highlight

```text
FileExplorer.open(path)
  -> WorkspaceTopTabController.openFile(path)
  -> WorkspaceFileRuntime(path, workspaceRoot)
  -> EditorLanguageResolver(path, Monaco registrations)
  -> shared MonacoModelRegistry(file URI, Monaco language id)
  -> FileTopTab renders highlighted model
```

### Acquire Language Intelligence

```text
FileTopTab mounted
  -> language-intelligence registry lookup
  -> LanguageClientManager.acquireClient(workspaceRoot + serverId)
  -> MonacoLanguageClient attaches to file:// model
  -> completion / hover / diagnostics / navigation providers
  -> release lease when File Top Tab closes
```

### Definition Navigation

```text
LSP definition returns file URI + range
  -> Monaco editor opener
  -> WorkspaceTopTabController.openFile(path)
  -> WorkspaceEditorRegistry queues range
  -> target runtime/editor becomes ready
  -> select + reveal + focus
```

## Error Handling

- Unknown syntax: use `plaintext`; never fail file opening.
- Language loader failure: keep the file editable as plaintext and log the language id.
- LSP unavailable: show the install hint and retain basic editing.
- LSP startup or WebSocket failure: show error status; do not retry continuously.
- Invalid or non-file navigation target: return control to Monaco without opening a tab.
- Definition target read failure: keep the target tab and show its existing read-error surface.
- Stale pending reveal after rename or close: discard it by runtime identity.
- Workspace edit version mismatch: reject the whole edit without changing any model.
- Unsupported workspace resource operation: reject the whole edit and explain that it is unsupported.

## Testing Strategy

### Language Resolution

- TSX resolves to `typescript`; JSX resolves to `javascript`.
- Existing CSS, Go, HTML, JSON, Markdown, Python, Rust, shell, and YAML mappings remain correct.
- Monaco filename matching recognizes `Dockerfile`.
- Additional bundled extensions such as `.java`, `.cpp`, `.sql`, `.xml`, and `.lua` no longer fall back to plaintext.
- Shell basename overrides remain correct.
- Unknown files remain plaintext.

### Model Identity

- Workspace models use encoded local `file://` URIs on POSIX and Windows.
- Two surfaces retaining the same URI reuse one Monaco model.
- Releasing one model key does not dispose a model retained by another surface.
- Save-baseline publication does not clear an edit made after the save started.
- Rename and delete release or migrate only the intended model keys.

### LSP Lifecycle

- TS, TSX, JS, and JSX share one TypeScript/JavaScript client per workspace.
- Go uses one `gopls` client per workspace.
- Unsupported languages do not start clients.
- Multiple mounted File Top Tabs share one server lifecycle.
- Closing the last retaining tab releases the server.
- Starting, ready, unavailable, and error status updates render reactively.

### Navigation

- Definition to an open file activates its existing File Top Tab and reveals the range.
- Definition to a closed file creates one File Top Tab and reveals after load.
- Windows file URIs round-trip to normalized paths.
- Workspace replacement disposes the old opener.
- A failed target read does not lose the source tab or dirty buffers.

### Workspace Edits

- Version mismatch rejects all edits.
- Multi-file text edits create background File Top Tabs and mark every affected model dirty.
- The original source tab remains active.
- A target-load failure applies no edits.
- Resource create/rename/delete operations are rejected without partial application.

### Verification

- Run focused Vitest suites for language resolution, model registry, LSP lifecycle, File Top Tab, workspace controller, and workspace editor registry.
- Run the repository's frontend typecheck/build validation allowed by project rules.
- Manually verify TSX highlighting, TypeScript completion and diagnostics, Go unavailable status, and cross-file definition navigation in the Electron app.

## Delivery Order

1. Centralize Monaco language resolution and fix React-family ids.
2. Move shared file-URI handling and make model references safe across editor surfaces.
3. Propagate workspace root and extract shared language-intelligence lifecycle helpers.
4. Attach TS/JS/Go LSP to File Top Tabs and render status.
5. Register the workspace editor opener and implement pending selection reveal.
6. Verify the first delivery before enabling any mutation-based LSP features.
7. Add the Workspace Edit Coordinator as the second milestone.

## Success Criteria

- `.tsx` and `.jsx` visibly highlight in File Top Tabs.
- Files recognized by bundled Monaco definitions no longer require Crest-specific extension entries.
- TypeScript/JavaScript and Go File Top Tabs expose diagnostics, completion, hover, and read-only navigation when their servers are available.
- Definition navigation opens or reuses a Workspace File Top Tab and reveals the target range.
- One server is reused per `workspaceRoot + serverId`.
- Missing or failed language servers degrade to basic editing with a visible explanation.
- Dirty buffers, save races, rename/delete flows, and close guards continue to behave correctly.
- Multi-file mutation is not enabled until its workspace-edit tests pass.
