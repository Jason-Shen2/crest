# File Tab Language Intelligence Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give Workspace File Top Tabs bundled-Monaco syntax highlighting plus existing TypeScript/JavaScript and Go LSP diagnostics, completion, hover, and cross-file read-only navigation.

**Architecture:** Replace Crest's extension allowlist with a resolver over Monaco language registrations, then give Workspace File models canonical `file://` identities with shared reference-counted ownership. Extract the existing right-editor LSP lifecycle into a shared module, attach it to File Top Tabs, and route Monaco definition targets through the Workspace Top Tab controller and a pending-reveal queue.

**Tech Stack:** TypeScript, React 19, Monaco Editor 0.55, monaco-languageclient, Jotai, Vitest, Testing Library, Electron.

---

## Scope Boundary

This plan implements the first delivery in [`docs/superpowers/specs/2026-08-04-file-tab-language-intelligence-design.md`](../specs/2026-08-04-file-tab-language-intelligence-design.md): highlighting, read-only LSP intelligence, status, and navigation.

The spec's `WorkspaceEditCoordinator` is a separate subsystem and gets a separate plan after this delivery passes Electron smoke testing. This plan must not enable multi-file Rename or mutation-based Code Actions.

## File Responsibility Map

- `frontend/app/righteditor/right-editor-language.ts`: resolve filenames to actual Monaco language ids.
- `frontend/app/righteditor/editor-path.ts`: convert local POSIX/Windows paths and `file://` URIs.
- `frontend/app/righteditor/monaco-model-registry.ts`: reference-count models and publish saved baselines.
- `frontend/app/righteditor/right-editor-model.ts`: keep right-editor saved state synchronized with shared models.
- `frontend/app/righteditor/lsp/language-intelligence.ts`: shared LSP lifecycle and status API.
- `frontend/app/workspace/workspace-editor-registry.ts`: Workspace File model, root, and pending reveal owner.
- `frontend/app/workspace/workspace-editor-opener.ts`: translate Monaco targets into File Top Tab operations.
- `frontend/app/workspace/file-top-tab.tsx`: acquire intelligence and render status.
- `frontend/app/workspace/workspace-app.tsx`: own the registry and opener lifecycles.

### Task 1: Resolve Bundled Monaco Languages

**Files:**
- Modify: `frontend/app/righteditor/right-editor-language.ts`
- Modify: `frontend/app/righteditor/right-editor-language.test.ts`

- [ ] **Step 1: Write the failing resolver tests**

Add deterministic definitions and cover React files, exact filenames, longest extensions, shell overrides, and fallback:

```ts
const Definitions = [
    { id: "typescript", extensions: [".ts", ".tsx"] },
    { id: "javascript", extensions: [".js", ".jsx"] },
    { id: "dockerfile", extensions: [".dockerfile"], filenames: ["Dockerfile"] },
    { id: "java", extensions: [".java"] },
    { id: "cpp", extensions: [".cc", ".cpp", ".h"] },
    { id: "sql", extensions: [".sql"] },
    { id: "xml", extensions: [".xml"] },
    { id: "lua", extensions: [".lua"] },
];

it.each([
    ["/repo/app.tsx", "typescript"],
    ["/repo/app.jsx", "javascript"],
    ["/repo/Dockerfile", "dockerfile"],
    ["/repo/Main.java", "java"],
    ["/repo/main.cpp", "cpp"],
    ["/repo/query.sql", "sql"],
    ["/repo/view.xml", "xml"],
    ["/repo/init.lua", "lua"],
])("resolves %s", (path, expected) => {
    expect(resolveMonacoLanguage(path, Definitions)).toBe(expected);
});

it("prefers the longest matching extension", () => {
    expect(resolveMonacoLanguage("/repo/a.test.tsx", [
        { id: "short", extensions: [".tsx"] },
        { id: "long", extensions: [".test.tsx"] },
    ])).toBe("long");
});

it.each([".zshrc", ".bashrc", ".bash_profile", ".profile"])("keeps %s as shell", (name) => {
    expect(resolveMonacoLanguage(`/Users/me/${name}`, Definitions)).toBe("shell");
});

it("falls back to plaintext", () => {
    expect(resolveMonacoLanguage("/repo/file.unknown", Definitions)).toBe("plaintext");
});
```

- [ ] **Step 2: Run the test and verify it fails**

Run: `npx vitest run frontend/app/righteditor/right-editor-language.test.ts`

Expected: FAIL because `resolveMonacoLanguage` is missing and TSX/JSX use React-specific ids.

- [ ] **Step 3: Implement the resolver**

```ts
import * as monaco from "monaco-editor";

export type MonacoLanguageDefinition = {
    id: string;
    extensions?: string[];
    filenames?: string[];
};

export function resolveMonacoLanguage(path: string, definitions: MonacoLanguageDefinition[]): string {
    const normalized = path.replace(/\\/g, "/");
    const name = normalized.slice(normalized.lastIndexOf("/") + 1);
    const basenameLanguage = BasenameLanguageMap[name];
    if (basenameLanguage) return basenameLanguage;

    const filenameMatch = definitions.find((definition) => definition.filenames?.includes(name));
    if (filenameMatch) return filenameMatch.id;

    const lowerName = name.toLowerCase();
    const extensionMatch = definitions
        .flatMap((definition) =>
            (definition.extensions ?? []).map((extension) => ({
                id: definition.id,
                extension: extension.toLowerCase(),
            }))
        )
        .sort((left, right) => right.extension.length - left.extension.length)
        .find(({ extension }) => lowerName.endsWith(extension));
    return extensionMatch?.id ?? "plaintext";
}

export function getRightEditorLanguage(path: string): string {
    return resolveMonacoLanguage(path, monaco.languages.getLanguages());
}
```

Keep the complete existing `BasenameLanguageMap`; delete `ExtensionLanguageMap`.

- [ ] **Step 4: Run affected tests**

Run:

```bash
npx vitest run frontend/app/righteditor/right-editor-language.test.ts frontend/app/righteditor/right-editor-model.test.ts frontend/app/view/codeeditor/codeeditor.test.tsx
```

Expected: PASS after updating old TSX/JSX expectations to `typescript`/`javascript`.

- [ ] **Step 5: Commit**

```bash
git add frontend/app/righteditor/right-editor-language.ts frontend/app/righteditor/right-editor-language.test.ts frontend/app/righteditor/right-editor-model.test.ts frontend/app/view/codeeditor/codeeditor.test.tsx
git commit -m "fix: resolve bundled Monaco file languages"
```

### Task 2: Centralize Canonical File URIs

**Files:**
- Create: `frontend/app/righteditor/editor-path.ts`
- Create: `frontend/app/righteditor/editor-path.test.ts`
- Modify: `frontend/app/righteditor/right-editor-model.ts`
- Modify: `frontend/app/view/codeeditor/file-editor-model.tsx`
- Modify: `frontend/app/workspace/workspace-editor-registry.ts`
- Modify: `frontend/app/righteditor/right-editor-model.test.ts`
- Modify: `frontend/app/view/codeeditor/codeeditor.test.tsx`
- Modify: `frontend/app/workspace/workspace-editor-registry.test.ts`

- [ ] **Step 1: Write failing path tests**

```ts
it.each([
    ["/repo/app file.ts", "file:///repo/app%20file.ts"],
    ["C:\\repo\\app file.ts", "file:///C:/repo/app%20file.ts"],
])("round-trips %s", (path, uri) => {
    expect(pathToFileUri(path)).toBe(uri);
    expect(fileUriToPath(uri)).toBe(path.replace(/\\/g, "/"));
});

it("rejects non-file schemes", () => {
    expect(fileUriToPath("wave://workspace/repo/app.ts")).toBeNull();
});

it("rejects remote file hosts because UNC paths are out of scope", () => {
    expect(fileUriToPath("file://server/share/app.ts")).toBeNull();
});
```

- [ ] **Step 2: Verify failure**

Run: `npx vitest run frontend/app/righteditor/editor-path.test.ts`

Expected: FAIL because the module does not exist.

- [ ] **Step 3: Implement shared conversion**

```ts
export function pathToFileUri(path: string): string {
    const normalizedPath = path.replace(/\\/g, "/");
    const driveMatch = /^([A-Za-z]:)(\/.*)?$/.exec(normalizedPath);
    if (driveMatch) {
        const [, drive, rest = ""] = driveMatch;
        return `file:///${drive}${rest.split("/").map(encodeURIComponent).join("/")}`;
    }
    return `file://${normalizedPath.split("/").map(encodeURIComponent).join("/")}`;
}

export function fileUriToPath(uriText: string): string | null {
    let uri: URL;
    try {
        uri = new URL(uriText);
    } catch {
        return null;
    }
    if (uri.protocol !== "file:" || (uri.hostname && uri.hostname !== "localhost")) return null;
    const decoded = decodeURIComponent(uri.pathname);
    return /^\/[A-Za-z]:\//.test(decoded) ? decoded.slice(1) : decoded;
}
```

- [ ] **Step 4: Replace duplicate helpers and Workspace URI generation**

Delete the local `pathToFileUri` functions in `right-editor-model.ts` and `file-editor-model.tsx`. Import the shared helper. Change Workspace identity to:

```ts
modelKey(path: string): string {
    return `workspace:${this.workspaceId}:${this.normalizePath(path)}`;
}

modelUri(path: string): string {
    return pathToFileUri(this.normalizePath(path));
}
```

- [ ] **Step 5: Run identity tests**

Run:

```bash
npx vitest run frontend/app/righteditor/editor-path.test.ts frontend/app/righteditor/right-editor-model.test.ts frontend/app/view/codeeditor/codeeditor.test.tsx frontend/app/workspace/workspace-editor-registry.test.ts
```

Expected: PASS after replacing `wave://workspace/...` assertions with `file://` assertions.

- [ ] **Step 6: Commit**

```bash
git add frontend/app/righteditor/editor-path.ts frontend/app/righteditor/editor-path.test.ts frontend/app/righteditor/right-editor-model.ts frontend/app/view/codeeditor/file-editor-model.tsx frontend/app/workspace/workspace-editor-registry.ts frontend/app/righteditor/right-editor-model.test.ts frontend/app/view/codeeditor/codeeditor.test.tsx frontend/app/workspace/workspace-editor-registry.test.ts
git commit -m "refactor: use canonical editor file uris"
```

### Task 3: Share Monaco Models Without Losing Save State

**Files:**
- Modify: `frontend/app/righteditor/monaco-model-registry.ts`
- Modify: `frontend/app/righteditor/monaco-model-registry.test.ts`
- Modify: `frontend/app/righteditor/right-editor-rpc.ts`
- Create: `frontend/app/righteditor/right-editor-rpc.test.ts`
- Modify: `frontend/app/righteditor/right-editor-model.ts`
- Modify: `frontend/app/righteditor/right-editor-workbench.tsx`
- Modify: `frontend/app/righteditor/right-editor-workbench.test.tsx`
- Modify: `frontend/app/view/codeeditor/file-editor-model.tsx`
- Modify: `frontend/app/workspace/workspace-editor-registry.ts`
- Modify: `frontend/app/workspace/workspace-app.tsx`
- Modify: `frontend/app/workspace/right-tool-panel.tsx`
- Modify: `frontend/app/righteditor/right-editor-model.test.ts`
- Modify: `frontend/app/view/codeeditor/codeeditor.test.tsx`
- Modify: `frontend/app/workspace/workspace-editor-registry.test.ts`
- Modify: `frontend/app/workspace/workspace-app.test.tsx`
- Modify: `frontend/app/workspace/right-tool-panel.test.tsx`

- [ ] **Step 1: Write failing shared-model tests**

```ts
it("keeps a shared URI alive until every surface releases it", () => {
    const registry = MonacoModelRegistry.getInstance();
    const workspace = registry.getOrCreateModel({
        path: "workspace:one:/repo/app.ts",
        uri: "file:///repo/app.ts",
        text: "one",
        language: "typescript",
    });
    registry.getOrCreateModel({
        path: "right-editor:/repo/app.ts",
        uri: "file:///repo/app.ts",
        text: "two",
        language: "typescript",
    });

    registry.disposePath("workspace:one:/repo/app.ts");

    expect((workspace as unknown as MockModel).disposed).toBe(false);
});

it("publishes saved text to all subscribers", () => {
    const registry = MonacoModelRegistry.getInstance();
    const first = vi.fn();
    const second = vi.fn();
    registry.subscribeSavedText("file:///repo/app.ts", first);
    registry.subscribeSavedText("file:///repo/app.ts", second);
    registry.publishSavedText("file:///repo/app.ts", "saved");
    expect(first).toHaveBeenCalledWith("saved");
    expect(second).toHaveBeenCalledWith("saved");
});
```

Add a Workspace runtime test: set model to `valueA`, start saving, change to `valueB`, publish `valueA`; expect `savedValue === valueA`, `value === valueB`, and `dirty === true`.

- [ ] **Step 2: Verify failure**

Run:

```bash
npx vitest run frontend/app/righteditor/monaco-model-registry.test.ts frontend/app/workspace/workspace-editor-registry.test.ts
```

Expected: FAIL because saved-text subscriptions do not exist.

- [ ] **Step 3: Add saved-baseline events**

```ts
type SavedTextListener = (text: string) => void;
private readonly savedTextListenersByUri = new Map<string, Set<SavedTextListener>>();

subscribeSavedText(uriText: string, listener: SavedTextListener): monaco.IDisposable {
    let listeners = this.savedTextListenersByUri.get(uriText);
    if (!listeners) {
        listeners = new Set();
        this.savedTextListenersByUri.set(uriText, listeners);
    }
    listeners.add(listener);
    return { dispose: () => {
        listeners?.delete(listener);
        if (listeners?.size === 0) this.savedTextListenersByUri.delete(uriText);
    } };
}

publishSavedText(uriText: string, text: string): void {
    this.savedTextListenersByUri.get(uriText)?.forEach((listener) => listener(text));
}
```

`disposeAll()` clears these listeners, but Workspace teardown must release only Workspace keys.

- [ ] **Step 4: Publish successful writes at the RPC boundary**

```ts
writeFile: async (path: string, text: string) => {
    await RpcApi.FileWriteCommand(TabRpcClient, {
        info: { path },
        data64: stringToBase64(text),
    });
    MonacoModelRegistry.getInstance().publishSavedText(pathToFileUri(path), text);
},
```

In `right-editor-rpc.test.ts`, assert publication happens after success and never after `FileWriteCommand` rejects.

- [ ] **Step 5: Update all saved-state owners**

`WorkspaceFileRuntime` subscribes when `bindModel()` changes URI and disposes in `finalize()`. Apply events using:

```ts
applySavedText(value: string): void {
    if (this.disposed) return;
    this.savedValue = value;
    this.dirty = this.value !== value;
    if (this.saveStatus !== "saving") this.saveStatus = this.dirty ? "idle" : "saved";
    this.emit();
}
```

`RightEditorModel` retains one injected saved-text subscription per open file and disposes it on close, delete, rename, and `resetInstance()`. Add this dependency shape and pass it from `RightToolContent`:

```ts
type RightEditorModelDeps = {
    disposeModelPath?: (path: string) => void;
    migrateModelPath?: (oldPath: string, newPath: string) => void;
    subscribeSavedText?: (uri: string, listener: (text: string) => void) => { dispose(): void };
};

subscribeSavedText: (uri, listener) => MonacoModelRegistry.getInstance().subscribeSavedText(uri, listener),
```

`FileEditorView` subscribes while its active file is mounted and calls a public `FileEditorViewModel.applySavedText()` with the same saved/dirty rule.

- [ ] **Step 6: Use one registry safely**

```ts
new WorkspaceEditorRegistry(
    workspace.oid,
    RightEditorProductionRpc,
    MonacoModelRegistry.getInstance(),
    workspaceDir
)
```

Add `workspaceRoot` as the fourth constructor parameter with default `""`. Remove `this.models.disposeAll()` from `WorkspaceEditorRegistry.finishDisposal()` because `finalize()` already releases every Workspace key.

Define the owner-key helper in `right-editor-model.ts` and use it everywhere the right editor retains or releases a model:

```ts
export function rightEditorModelKey(path: string): string {
    return `right-editor:${path}`;
}
```

Use `path: rightEditorModelKey(activeFile.path)` in `RightEditorWorkbench`. Update `disposeRightEditorModelPath()` and `migrateRightEditorModelPath()` in `right-tool-panel.tsx` to pass prefixed keys, so Workspace and right-editor ownership cannot collide.

- [ ] **Step 7: Run shared-state tests**

Run:

```bash
npx vitest run frontend/app/righteditor/monaco-model-registry.test.ts frontend/app/righteditor/right-editor-rpc.test.ts frontend/app/righteditor/right-editor-model.test.ts frontend/app/righteditor/right-editor-workbench.test.tsx frontend/app/view/codeeditor/codeeditor.test.tsx frontend/app/workspace/workspace-editor-registry.test.ts frontend/app/workspace/workspace-app.test.tsx frontend/app/workspace/right-tool-panel.test.tsx
```

Expected: PASS, including Workspace replacement that does not dispose a model retained by another surface.

- [ ] **Step 8: Commit**

```bash
git add frontend/app/righteditor/monaco-model-registry.ts frontend/app/righteditor/monaco-model-registry.test.ts frontend/app/righteditor/right-editor-rpc.ts frontend/app/righteditor/right-editor-rpc.test.ts frontend/app/righteditor/right-editor-model.ts frontend/app/righteditor/right-editor-model.test.ts frontend/app/righteditor/right-editor-workbench.tsx frontend/app/righteditor/right-editor-workbench.test.tsx frontend/app/view/codeeditor/file-editor-model.tsx frontend/app/view/codeeditor/codeeditor.test.tsx frontend/app/workspace/workspace-editor-registry.ts frontend/app/workspace/workspace-editor-registry.test.ts frontend/app/workspace/workspace-app.tsx frontend/app/workspace/workspace-app.test.tsx frontend/app/workspace/right-tool-panel.tsx frontend/app/workspace/right-tool-panel.test.tsx
git commit -m "refactor: share Monaco file models safely"
```

### Task 4: Extract Shared Language Intelligence

**Files:**
- Create: `frontend/app/righteditor/lsp/language-intelligence.ts`
- Create: `frontend/app/righteditor/lsp/language-intelligence.test.tsx`
- Modify: `frontend/app/righteditor/right-editor-workbench.tsx`
- Modify: `frontend/app/righteditor/right-editor-workbench.test.tsx`
- Modify: `frontend/app/view/codeeditor/file-editor-model.tsx`
- Modify: `frontend/app/view/codeeditor/codeeditor.test.tsx`
- Modify: `frontend/app/righteditor/lsp/language-server-registry.ts`
- Modify: `frontend/app/righteditor/lsp/language-server-registry.test.ts`
- Modify: `emain/lsp/language-server-registry.ts`
- Modify: `emain/lsp/language-server-registry.test.ts`
- Modify: `emain/lsp/language-server-manager.test.ts`

- [ ] **Step 1: Write failing lifecycle tests**

```ts
const TypeScriptFile = { language: "typescript", workspaceRoot: "/repo" };

it("builds the TypeScript server input", () => {
    expect(getLanguageIntelligenceInput(TypeScriptFile)).toEqual({
        workspaceRoot: "/repo",
        language: "typescript",
        languages: ["typescript", "javascript"],
        serverId: "typescript-language-server",
        displayName: "TypeScript/JavaScript",
    });
});

it("acquires the registered server", () => {
    const acquireClient = vi.fn(() => vi.fn());
    acquireLanguageIntelligence(TypeScriptFile, { acquireClient });
    expect(acquireClient).toHaveBeenCalledWith(expect.objectContaining({
        workspaceRoot: "/repo",
        serverId: "typescript-language-server",
    }));
});

it("labels unsupported languages as basic editing", () => {
    expect(getLanguageIntelligenceStatusLabel(undefined)).toBe("Basic editing");
});
```

- [ ] **Step 2: Verify failure**

Run: `npx vitest run frontend/app/righteditor/lsp/language-intelligence.test.tsx frontend/app/righteditor/lsp/language-server-registry.test.ts emain/lsp/language-server-registry.test.ts`

Expected: FAIL because the module is absent and registries list React-specific ids.

- [ ] **Step 3: Implement the shared API**

```ts
export type LanguageIntelligenceFile = { language: string; workspaceRoot: string };

export function getLanguageIntelligenceInput(file: LanguageIntelligenceFile | null | undefined) {
    if (!file?.workspaceRoot) return undefined;
    const support = getRightEditorLspSupport(file.language, file.workspaceRoot);
    if (!support.supported) return undefined;
    return {
        workspaceRoot: file.workspaceRoot,
        language: file.language,
        languages: support.server.languages,
        serverId: support.server.serverId,
        displayName: support.server.displayName,
    };
}

export function getLanguageIntelligenceLifecycleKey(file: LanguageIntelligenceFile | null | undefined) {
    const input = getLanguageIntelligenceInput(file);
    return input ? `${input.workspaceRoot}\u0000${input.serverId}` : undefined;
}

export function acquireLanguageIntelligence(file: LanguageIntelligenceFile | null | undefined, manager = languageClientManager) {
    const input = getLanguageIntelligenceInput(file);
    return input ? manager.acquireClient(input) : undefined;
}
```

Move status detail lookup, label formatting, install hints, and the `useSyncExternalStore` status hook from `right-editor-workbench.tsx` into this module with these stable exports:

```ts
export function getLanguageIntelligenceStatusDetails(
    file: LanguageIntelligenceFile | null | undefined,
    manager = languageClientManager
): RightEditorLspStatusDetails | undefined;

export function getLanguageIntelligenceStatusLabel(
    status: RightEditorLspStatus | undefined,
    installHint?: string | null
): string;

export function useLanguageIntelligenceStatusVersion(
    file: LanguageIntelligenceFile | null | undefined
): number;
```

- [ ] **Step 4: Normalize server language ids**

Change frontend and backend TypeScript definitions to `languages: ["typescript", "javascript"]`. Keep Monaco worker routing for legacy React labels; it is independent from model ids.

- [ ] **Step 5: Migrate right editor and codeeditor consumers**

Import shared functions in both consumers and delete duplicated lifecycle/status helpers. Preserve keyboard, tab display, and save behavior.

- [ ] **Step 6: Run LSP regression tests**

Run:

```bash
npx vitest run frontend/app/righteditor/lsp/language-intelligence.test.tsx frontend/app/righteditor/lsp/language-server-registry.test.ts frontend/app/righteditor/right-editor-workbench.test.tsx frontend/app/view/codeeditor/codeeditor.test.tsx emain/lsp/language-server-registry.test.ts emain/lsp/language-server-manager.test.ts
```

Expected: PASS after updating React-specific assertions.

- [ ] **Step 7: Commit**

```bash
git add frontend/app/righteditor/lsp/language-intelligence.ts frontend/app/righteditor/lsp/language-intelligence.test.tsx frontend/app/righteditor/lsp/language-server-registry.ts frontend/app/righteditor/lsp/language-server-registry.test.ts frontend/app/righteditor/right-editor-workbench.tsx frontend/app/righteditor/right-editor-workbench.test.tsx frontend/app/view/codeeditor/file-editor-model.tsx frontend/app/view/codeeditor/codeeditor.test.tsx emain/lsp/language-server-registry.ts emain/lsp/language-server-registry.test.ts emain/lsp/language-server-manager.test.ts
git commit -m "refactor: share editor language intelligence"
```

### Task 5: Attach Intelligence To File Top Tabs

**Files:**
- Modify: `frontend/app/workspace/workspace-editor-registry.ts`
- Modify: `frontend/app/workspace/file-top-tab.tsx`
- Modify: `frontend/app/workspace/workspace-app.tsx`
- Modify: `frontend/app/workspace/workspace-editor-registry.test.ts`
- Modify: `frontend/app/workspace/file-top-tab.test.tsx`
- Modify: `frontend/app/workspace/workspace-app.test.tsx`

- [ ] **Step 1: Write failing File Top Tab tests**

Mock `language-intelligence.ts` and assert acquisition receives `{ language: "typescript", workspaceRoot: "/repo" }`, running status renders `TypeScript/JavaScript LSP ready`, and a save error suppresses the LSP label while its alert is active.

Use this concrete expectation:

```ts
expect(acquireLanguageIntelligence).toHaveBeenCalledWith(
    { language: "typescript", workspaceRoot: "/repo" }
);
expect(screen.getByRole("status").textContent).toContain("TypeScript/JavaScript LSP ready");
```

- [ ] **Step 2: Verify failure**

Run: `npx vitest run frontend/app/workspace/file-top-tab.test.tsx frontend/app/workspace/workspace-editor-registry.test.ts`

Expected: FAIL because File Top Tabs do not acquire LSP and runtime has no root.

- [ ] **Step 3: Expose root and acquire intelligence**

```ts
get workspaceRoot(): string {
    return this.registry.workspaceRoot;
}
```

In `FileTopTab`:

```tsx
const languageFile = useMemo(
    () => ({ language: runtime.language, workspaceRoot: runtime.workspaceRoot }),
    [runtime.language, runtime.workspaceRoot]
);
const lifecycleKey = getLanguageIntelligenceLifecycleKey(languageFile);
const statusVersion = useLanguageIntelligenceStatusVersion(languageFile);

useEffect(() => acquireLanguageIntelligence(languageFile), [lifecycleKey]);
const statusDetails = getLanguageIntelligenceStatusDetails(languageFile);
void statusVersion;
```

- [ ] **Step 4: Render status**

Add a 24px footer shared by Markdown edit and normal code modes. Show `Basic editing`, starting, ready, unavailable hint, or error. Keep the existing save-error alert higher priority.

```tsx
const footerLabel = snapshot.saveStatus === "error"
    ? ""
    : getLanguageIntelligenceStatusLabel(statusDetails?.status, statusDetails?.installHint);

const footer = (
    <div className="flex h-6 shrink-0 items-center justify-end border-t border-border px-2 text-[11px] text-secondary">
        <span className="max-w-72 truncate" role="status" aria-live="polite" title={footerLabel}>
            {footerLabel}
        </span>
    </div>
);
```

- [ ] **Step 5: Run integration tests**

Run: `npx vitest run frontend/app/workspace/file-top-tab.test.tsx frontend/app/workspace/workspace-editor-registry.test.ts frontend/app/workspace/workspace-app.test.tsx`

Expected: PASS with one shared lifecycle per workspace/server.

- [ ] **Step 6: Commit**

```bash
git add frontend/app/workspace/workspace-editor-registry.ts frontend/app/workspace/workspace-editor-registry.test.ts frontend/app/workspace/file-top-tab.tsx frontend/app/workspace/file-top-tab.test.tsx frontend/app/workspace/workspace-app.tsx frontend/app/workspace/workspace-app.test.tsx
git commit -m "feat: add LSP intelligence to file tabs"
```

### Task 6: Open Definition Targets In Workspace Tabs

**Files:**
- Create: `frontend/app/workspace/workspace-editor-opener.ts`
- Create: `frontend/app/workspace/workspace-editor-opener.test.ts`
- Modify: `frontend/app/workspace/workspace-editor-registry.ts`
- Modify: `frontend/app/workspace/file-top-tab.tsx`
- Modify: `frontend/app/workspace/workspace-app.tsx`
- Modify: `frontend/app/workspace/workspace-editor-registry.test.ts`
- Modify: `frontend/app/workspace/file-top-tab.test.tsx`
- Modify: `frontend/app/workspace/workspace-app.test.tsx`

- [ ] **Step 1: Write failing opener tests**

```ts
it("opens and queues a file target", async () => {
    const controller = { openFile: vi.fn(() => "file-2") };
    const editorRegistry = { queueReveal: vi.fn() };
    const registration = registerWorkspaceEditorOpener({
        controller,
        editorRegistry,
        registerEditorOpener: vi.fn((opener) => ({ dispose: vi.fn(), opener })) as any,
    });
    const handled = await registration.opener.openCodeEditor(
        {} as any,
        { toString: () => "file:///repo/lib.ts" } as any,
        { lineNumber: 8, column: 4 }
    );
    expect(handled).toBe(true);
    expect(controller.openFile).toHaveBeenCalledWith("/repo/lib.ts");
    expect(editorRegistry.queueReveal).toHaveBeenCalledWith("/repo/lib.ts", { lineNumber: 8, column: 4 });
});

it("declines non-file targets", async () => {
    const registration = registerWorkspaceEditorOpener({
        controller: { openFile: vi.fn() },
        editorRegistry: { queueReveal: vi.fn() },
        registerEditorOpener: vi.fn((opener) => ({ dispose: vi.fn(), opener })) as any,
    });
    expect(await registration.opener.openCodeEditor(
        {} as any,
        { toString: () => "https://example.com/app.ts" } as any,
        { lineNumber: 1, column: 1 }
    )).toBe(false);
});
```

Add runtime tests for reveal queued before mount, immediate reveal for an attached editor, and pending reveal cleanup during close/rename.

- [ ] **Step 2: Verify failure**

Run: `npx vitest run frontend/app/workspace/workspace-editor-opener.test.ts frontend/app/workspace/workspace-editor-registry.test.ts frontend/app/workspace/file-top-tab.test.tsx`

Expected: FAIL because opener and reveal queue are missing.

- [ ] **Step 3: Implement the opener**

```ts
export function registerWorkspaceEditorOpener({ controller, editorRegistry, registerEditorOpener }: Deps) {
    const opener: monaco.editor.ICodeEditorOpener = {
        openCodeEditor: async (_source, resource, selectionOrPosition) => {
            const path = fileUriToPath(resource.toString());
            if (!path) return false;
            controller.openFile(path);
            if (selectionOrPosition) editorRegistry.queueReveal(path, selectionOrPosition);
            return true;
        },
    };
    const disposable = registerEditorOpener(opener);
    return { dispose: () => disposable.dispose(), opener };
}
```

Define `Deps` with `Pick<WorkspaceTopTabController, "openFile">`, `Pick<WorkspaceEditorRegistry, "queueReveal">`, and `typeof monaco.editor.registerEditorOpener`.

- [ ] **Step 4: Implement pending reveals**

```ts
pendingRevealByPath = new Map<string, monaco.IRange | monaco.IPosition>();

queueReveal(path: string, selection: monaco.IRange | monaco.IPosition): void {
    const normalized = this.normalizePath(path);
    this.pendingRevealByPath.set(normalized, selection);
    this.runtimesByPath.get(normalized)?.revealPendingSelection();
}

takePendingReveal(path: string) {
    const normalized = this.normalizePath(path);
    const selection = this.pendingRevealByPath.get(normalized);
    this.pendingRevealByPath.delete(normalized);
    return selection;
}
```

Store the attached editor on `WorkspaceFileRuntime`. On attach or queued reveal, schedule one `requestAnimationFrame`, convert a position to a zero-length `monaco.Range`, then call `setSelection`, `revealRangeInCenter`, and `focus`. Close and disposal delete the path; rename migrates the pending entry and rollback restores it.

- [ ] **Step 5: Own opener lifecycle in WorkspaceApp**

```tsx
useEffect(() => {
    if (!topTabControllerReady) return;
    return registerWorkspaceEditorOpener({
        controller: topTabController,
        editorRegistry,
        registerEditorOpener: monaco.editor.registerEditorOpener,
    }).dispose;
}, [editorRegistry, topTabController, topTabControllerReady]);
```

Add a replacement test proving the old opener is disposed and cannot call the stale controller.

- [ ] **Step 6: Run navigation suites**

Run: `npx vitest run frontend/app/workspace/workspace-editor-opener.test.ts frontend/app/workspace/workspace-editor-registry.test.ts frontend/app/workspace/file-top-tab.test.tsx frontend/app/workspace/workspace-app.test.tsx`

Expected: PASS for existing tab reuse, cold target creation, delayed reveal, Windows URI conversion, and disposal.

- [ ] **Step 7: Commit**

```bash
git add frontend/app/workspace/workspace-editor-opener.ts frontend/app/workspace/workspace-editor-opener.test.ts frontend/app/workspace/workspace-editor-registry.ts frontend/app/workspace/workspace-editor-registry.test.ts frontend/app/workspace/file-top-tab.tsx frontend/app/workspace/file-top-tab.test.tsx frontend/app/workspace/workspace-app.tsx frontend/app/workspace/workspace-app.test.tsx
git commit -m "feat: open LSP targets in file tabs"
```

### Task 7: Regression, Build, And Electron Smoke

**Files:**
- Modify only if verification exposes a defect: files from Tasks 1-6
- Modify after verification: `docs/superpowers/specs/2026-08-04-file-tab-language-intelligence-design.md`

- [ ] **Step 1: Run focused regression**

```bash
npx vitest run frontend/app/righteditor/right-editor-language.test.ts frontend/app/righteditor/editor-path.test.ts frontend/app/righteditor/monaco-model-registry.test.ts frontend/app/righteditor/right-editor-rpc.test.ts frontend/app/righteditor/right-editor-model.test.ts frontend/app/righteditor/lsp/language-intelligence.test.tsx frontend/app/righteditor/lsp/language-server-registry.test.ts frontend/app/righteditor/lsp/language-client-manager.test.ts frontend/app/righteditor/lsp/lsp-transport.test.ts frontend/app/righteditor/right-editor-workbench.test.tsx frontend/app/view/codeeditor/codeeditor.test.tsx frontend/app/workspace/workspace-editor-opener.test.ts frontend/app/workspace/workspace-editor-registry.test.ts frontend/app/workspace/file-top-tab.test.tsx frontend/app/workspace/workspace-app.test.tsx emain/lsp/language-server-registry.test.ts emain/lsp/language-server-manager.test.ts emain/lsp/lsp-websocket-server.test.ts
```

Expected: all tests PASS with no unhandled rejection.

- [ ] **Step 2: Run the allowed build**

Run: `npm run build:dev`

Expected: exit code 0. Do not run `go build`, per repository rules.

- [ ] **Step 3: Perform Electron smoke verification**

Run: `npm run dev`

Verify:

1. `.tsx` and `.jsx` visibly highlight.
2. `Dockerfile`, `.java`, `.cpp`, `.sql`, `.xml`, and `.lua` are non-plaintext.
3. TypeScript completion, hover, signature help, and diagnostics work.
4. Go To Definition opens a closed target once, reveals its position, and reuses it thereafter.
5. Go uses `gopls` when available or shows its install hint.
6. The same file open in main and right editors preserves newer edits and shared model lifetime.
7. File Explorer rename/delete preserves dirty state and rollback behavior.
8. Workspace replacement leaves no stale editor opener.

Stop the dev process afterward.

- [ ] **Step 4: Record only verified progress**

Update the design status to `First delivery complete; Workspace Edit milestone pending` only when Steps 1-3 pass. Add:

```markdown
## Implementation Progress

- Bundled Monaco language resolution: complete.
- File Top Tab TS/JS/Go read-only language intelligence: complete.
- Cross-file definition navigation: complete.
- Workspace Edit Coordinator: pending separate plan.
- Automated verification: complete.
- Electron smoke verification: complete.
```

If smoke is not performed, record `Electron smoke verification: pending`.

- [ ] **Step 5: Check and commit verification metadata**

Run:

```bash
git diff --check
git status --short
```

Expected: no whitespace errors and only intended files modified.

```bash
git add docs/superpowers/specs/2026-08-04-file-tab-language-intelligence-design.md
git commit -m "docs: record file tab intelligence verification"
```
