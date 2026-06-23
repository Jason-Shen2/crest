# Right Editor Multilanguage LSP Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the right editor's hard-coded JS/TS-only LSP path with a registry-based foundation that preserves JS/TS behavior and adds Go through `gopls`.

**Architecture:** Add shared frontend/backend language-server registries that map Monaco language ids to stable `serverId` values. Key frontend and backend lifecycle state by `workspaceRoot + serverId`, while preserving concrete file `language` for Monaco document selectors. Surface unsupported, starting, ready, unavailable, and error states in the right editor status area.

**Tech Stack:** TypeScript, React, Monaco Editor, `monaco-languageclient`, `vscode-ws-jsonrpc`, `vscode-jsonrpc/node`, Vitest, Electron main process.

---

## Progress

| Phase | Status | Notes |
| --- | --- | --- |
| Phase 0: Research | Done | Current Crest LSP chain and Warp LSP architecture reviewed. |
| Phase 1: Design | Done | See `docs/superpowers/specs/2026-06-22-right-editor-multilanguage-lsp-design.md`. |
| Phase 2: Plan | Done | This document is the implementation checklist and progress source. |
| Phase 3: Registry Refactor | Not started | Add frontend and backend registries while preserving JS/TS behavior. |
| Phase 4: Go Sample | Not started | Add `gopls` discovery, startup, and unavailable status. |
| Phase 5: UI Status | Not started | Surface LSP states and install hints. |
| Phase 6: Verification | Not started | Run unit, lifecycle, UI, and focused build checks. |

## File Structure

- Create `frontend/app/righteditor/lsp/language-server-registry.ts`: frontend registry for right editor LSP support, language lookup, basic-editing status copy, and display metadata.
- Create `frontend/app/righteditor/lsp/language-server-registry.test.ts`: frontend registry tests for JS/TS, Go, unsupported languages, and workspace-gated support checks.
- Modify `frontend/app/righteditor/right-editor-types.ts`: extend `RightEditorLspStatus` with `serverId`, `displayName`, and `unavailable`.
- Modify `frontend/app/righteditor/right-editor-workbench.tsx`: replace JS/TS hard-coding with registry lookup, pass `serverId` into lifecycle acquisition, and render LSP status text.
- Modify `frontend/app/righteditor/right-editor-workbench.test.tsx`: update acquisition tests for `serverId`, add Go support assertions, and add status rendering tests.
- Modify `frontend/app/righteditor/lsp/language-client-manager.ts`: key clients by `workspaceRoot + serverId`, track display metadata, and expose status for UI rendering.
- Create `frontend/app/righteditor/lsp/language-client-manager.test.ts`: focused lifecycle tests for server-level reuse, reference counting, status transitions, and failure mapping.
- Modify `frontend/app/righteditor/lsp/lsp-transport.ts`: include `serverId` in the WebSocket query and client name while keeping `language` in the document selector.
- Modify `frontend/app/righteditor/lsp/lsp-transport.test.ts`: assert `serverId` query parameter and unchanged document selector behavior.
- Create `emain/lsp/language-server-registry.ts`: backend registry for supported servers, command metadata, install hints, and language-to-server validation.
- Create `emain/lsp/language-server-registry.test.ts`: backend registry tests for JS/TS, Go, validation, and unavailable message content.
- Modify `emain/lsp/language-server-manager.ts`: resolve commands by `serverId`, preserve packaged TS resolution, add PATH-based `gopls`, and key cached processes by `workspaceRoot + serverId`.
- Modify `emain/lsp/language-server-manager.test.ts`: update resolver and lifecycle tests for `serverId`, Go, missing `gopls`, and JS/TS reuse.
- Modify `emain/lsp/lsp-websocket-server.ts`: parse `serverId`, validate language/server pairing, call cached server lifecycle, release on WebSocket cleanup, and reject duplicate active WebSocket sessions for the same `workspaceRoot + serverId`.
- Modify `emain/lsp/lsp-websocket-server.test.ts`: update request parsing tests and replace per-WebSocket session expectations with one active WebSocket session per server key.
- Modify `docs/superpowers/specs/2026-06-22-right-editor-multilanguage-lsp-design.md`: update progress rows after implementation phases complete.

## Task 1: Frontend Registry

**Files:**
- Create: `frontend/app/righteditor/lsp/language-server-registry.ts`
- Create: `frontend/app/righteditor/lsp/language-server-registry.test.ts`

- [ ] **Step 1: Write the failing registry tests**

Create `frontend/app/righteditor/lsp/language-server-registry.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import {
    getRightEditorLanguageServer,
    getRightEditorLanguageServerById,
    getRightEditorLspSupport,
    isRightEditorLspSupported,
} from "./language-server-registry";

describe("right editor language server registry", () => {
    it("maps JS and TS language ids to the TypeScript language server", () => {
        for (const language of ["typescript", "typescriptreact", "javascript", "javascriptreact"]) {
            expect(getRightEditorLanguageServer(language)).toEqual(
                expect.objectContaining({
                    serverId: "typescript-language-server",
                    displayName: "TypeScript/JavaScript",
                })
            );
        }
    });

    it("maps Go to gopls with an install hint", () => {
        expect(getRightEditorLanguageServer("go")).toEqual(
            expect.objectContaining({
                serverId: "gopls",
                displayName: "Go",
                installHint: "Install gopls: go install golang.org/x/tools/gopls@latest",
            })
        );
    });

    it("does not register unsupported languages", () => {
        expect(getRightEditorLanguageServer("json")).toBeUndefined();
        expect(getRightEditorLanguageServer("markdown")).toBeUndefined();
    });

    it("looks up servers by id", () => {
        expect(getRightEditorLanguageServerById("gopls")).toEqual(
            expect.objectContaining({
                languages: ["go"],
            })
        );
        expect(getRightEditorLanguageServerById("missing")).toBeUndefined();
    });

    it("requires a workspace root before reporting LSP support", () => {
        expect(isRightEditorLspSupported("go", "/repo")).toBe(true);
        expect(isRightEditorLspSupported("go", "")).toBe(false);
    });

    it("returns basic editing support details for unregistered languages", () => {
        expect(getRightEditorLspSupport("json", "/repo")).toEqual({
            supported: false,
            status: {
                language: "json",
                workspaceRoot: "/repo",
                serverId: null,
                displayName: "JSON",
                state: "stopped",
                message: "Basic editing",
            },
        });
    });
});
```

- [ ] **Step 2: Run the registry test to verify it fails**

Run:

```bash
npm test -- frontend/app/righteditor/lsp/language-server-registry.test.ts --run
```

Expected: FAIL with an import error for `./language-server-registry`.

- [ ] **Step 3: Add the frontend registry implementation**

Create `frontend/app/righteditor/lsp/language-server-registry.ts`:

```ts
import type { RightEditorLspStatus } from "../right-editor-types";

export type RightEditorLanguageServerDefinition = {
    serverId: string;
    displayName: string;
    languages: string[];
    installHint?: string;
};

export type RightEditorLspSupport =
    | {
          supported: true;
          server: RightEditorLanguageServerDefinition;
      }
    | {
          supported: false;
          status: RightEditorLspStatus;
      };

export const rightEditorLanguageServers: RightEditorLanguageServerDefinition[] = [
    {
        serverId: "typescript-language-server",
        displayName: "TypeScript/JavaScript",
        languages: ["typescript", "typescriptreact", "javascript", "javascriptreact"],
    },
    {
        serverId: "gopls",
        displayName: "Go",
        languages: ["go"],
        installHint: "Install gopls: go install golang.org/x/tools/gopls@latest",
    },
];

const languageServerById = new Map(rightEditorLanguageServers.map((server) => [server.serverId, server]));
const languageServerByLanguage = new Map<string, RightEditorLanguageServerDefinition>();

for (const server of rightEditorLanguageServers) {
    for (const language of server.languages) {
        languageServerByLanguage.set(language, server);
    }
}

export function getRightEditorLanguageServer(language: string): RightEditorLanguageServerDefinition | undefined {
    return languageServerByLanguage.get(language);
}

export function getRightEditorLanguageServerById(serverId: string): RightEditorLanguageServerDefinition | undefined {
    return languageServerById.get(serverId);
}

export function isRightEditorLspSupported(language: string, workspaceRoot: string): boolean {
    return Boolean(workspaceRoot && getRightEditorLanguageServer(language));
}

function displayNameForLanguage(language: string): string {
    if (!language) return "Plain Text";
    return language.charAt(0).toUpperCase() + language.slice(1);
}

export function getRightEditorLspSupport(language: string, workspaceRoot: string): RightEditorLspSupport {
    const server = getRightEditorLanguageServer(language);
    if (workspaceRoot && server) {
        return { supported: true, server };
    }
    return {
        supported: false,
        status: {
            language,
            workspaceRoot,
            serverId: null,
            displayName: displayNameForLanguage(language),
            state: "stopped",
            message: "Basic editing",
        },
    };
}
```

- [ ] **Step 4: Run the registry test to verify it passes**

Run:

```bash
npm test -- frontend/app/righteditor/lsp/language-server-registry.test.ts --run
```

Expected: PASS.

- [ ] **Step 5: Commit the frontend registry**

Run:

```bash
git add frontend/app/righteditor/lsp/language-server-registry.ts frontend/app/righteditor/lsp/language-server-registry.test.ts
git commit -m "feat: add right editor lsp registry"
```

## Task 2: Frontend Types, Gating, And Acquisition

**Files:**
- Modify: `frontend/app/righteditor/right-editor-types.ts`
- Modify: `frontend/app/righteditor/right-editor-workbench.tsx`
- Modify: `frontend/app/righteditor/right-editor-workbench.test.tsx`

- [ ] **Step 1: Write failing workbench tests for registry-backed support**

In `frontend/app/righteditor/right-editor-workbench.test.tsx`, replace the existing test named `starts LSP only for JavaScript and TypeScript files with a workspace root` with:

```ts
it("starts LSP for registered languages with a workspace root", () => {
    expect(shouldStartRightEditorLsp("typescript", "/repo")).toBe(true);
    expect(shouldStartRightEditorLsp("typescriptreact", "/repo")).toBe(true);
    expect(shouldStartRightEditorLsp("javascript", "/repo")).toBe(true);
    expect(shouldStartRightEditorLsp("javascriptreact", "/repo")).toBe(true);
    expect(shouldStartRightEditorLsp("go", "/repo")).toBe(true);
    expect(shouldStartRightEditorLsp("typescript", "")).toBe(false);
    expect(shouldStartRightEditorLsp("go", "")).toBe(false);
    expect(shouldStartRightEditorLsp("json", "/repo")).toBe(false);
});
```

Update the acquisition expectation in `acquires LSP for supported active files and releases on effect cleanup`:

```ts
expect(lspManager.acquireClient).toHaveBeenCalledWith({
    workspaceRoot: "/repo",
    language: "typescript",
    serverId: "typescript-language-server",
    displayName: "TypeScript/JavaScript",
});
```

Add this test after `acquires LSP with the active file workspace root`:

```ts
it("acquires Go LSP through gopls", () => {
    const release = vi.fn();
    const lspManager = {
        acquireClient: vi.fn(() => release),
    };

    const cleanup = acquireRightEditorLspForActiveFile({
        activeFile: {
            path: "/repo/main.go",
            uri: "file:///repo/main.go",
            language: "go",
            workspaceRoot: "/repo",
            readonly: false,
            savedText: "package main\n",
            dirtyText: null,
            saveStatus: "idle",
            error: null,
        },
        workspaceRoot: "/repo",
        lspManager,
    });

    expect(lspManager.acquireClient).toHaveBeenCalledWith({
        workspaceRoot: "/repo",
        language: "go",
        serverId: "gopls",
        displayName: "Go",
    });
    cleanup();
    expect(release).toHaveBeenCalledTimes(1);
});
```

- [ ] **Step 2: Run workbench tests to verify they fail**

Run:

```bash
npm test -- frontend/app/righteditor/right-editor-workbench.test.tsx --run
```

Expected: FAIL because `RightEditorLspStatus` lacks new fields and `acquireClient` receives no `serverId`.

- [ ] **Step 3: Extend the status type**

In `frontend/app/righteditor/right-editor-types.ts`, replace `RightEditorLspStatus` with:

```ts
export type RightEditorLspStatus = {
    language: string;
    workspaceRoot: string;
    serverId: string | null;
    displayName: string;
    state: "stopped" | "starting" | "running" | "unavailable" | "error";
    message: string | null;
};
```

- [ ] **Step 4: Replace hard-coded frontend gating with registry lookup**

In `frontend/app/righteditor/right-editor-workbench.tsx`, add this import:

```ts
import { getRightEditorLanguageServer, isRightEditorLspSupported } from "./lsp/language-server-registry";
```

Replace `shouldStartRightEditorLsp`:

```ts
export function shouldStartRightEditorLsp(language: string, workspaceRoot: string): boolean {
    return isRightEditorLspSupported(language, workspaceRoot);
}
```

Replace `LspLifecycleManager`:

```ts
type LspLifecycleManager = {
    acquireClient: (input: { workspaceRoot: string; language: string; serverId: string; displayName: string }) => () => void;
};
```

Replace the `acquireClient` call inside `acquireRightEditorLspForActiveFile`:

```ts
const server = getRightEditorLanguageServer(input.activeFile.language);
if (!workspaceRoot || !server) return undefined;
return input.lspManager.acquireClient({
    workspaceRoot,
    language: input.activeFile.language,
    serverId: server.serverId,
    displayName: server.displayName,
});
```

- [ ] **Step 5: Run workbench tests to verify they pass**

Run:

```bash
npm test -- frontend/app/righteditor/right-editor-workbench.test.tsx --run
```

Expected: PASS.

- [ ] **Step 6: Commit frontend gating changes**

Run:

```bash
git add frontend/app/righteditor/right-editor-types.ts frontend/app/righteditor/right-editor-workbench.tsx frontend/app/righteditor/right-editor-workbench.test.tsx
git commit -m "feat: route right editor lsp through registry"
```

## Task 3: Frontend Lifecycle Keying And Status

**Files:**
- Create: `frontend/app/righteditor/lsp/language-client-manager.test.ts`
- Modify: `frontend/app/righteditor/lsp/language-client-manager.ts`

- [ ] **Step 1: Write failing lifecycle manager tests**

Create `frontend/app/righteditor/lsp/language-client-manager.test.ts`:

```ts
import { describe, expect, it, vi } from "vitest";
import { LanguageClientManager } from "./language-client-manager";

function input(overrides: Partial<{ workspaceRoot: string; language: string; serverId: string; displayName: string }> = {}) {
    return {
        workspaceRoot: "/repo",
        language: "typescript",
        serverId: "typescript-language-server",
        displayName: "TypeScript/JavaScript",
        ...overrides,
    };
}

describe("LanguageClientManager", () => {
    it("reuses one transport for languages that share a server id", async () => {
        const dispose = vi.fn();
        const transportFactory = vi.fn(async () => ({ dispose }));
        const manager = new LanguageClientManager({ transportFactory });

        const releaseTs = manager.acquireClient(input({ language: "typescript" }));
        const releaseTsx = manager.acquireClient(input({ language: "typescriptreact" }));
        await manager.ensureClient(input({ language: "typescript" }));
        await manager.ensureClient(input({ language: "typescriptreact" }));

        expect(transportFactory).toHaveBeenCalledTimes(1);
        releaseTs();
        expect(dispose).not.toHaveBeenCalled();
        releaseTsx();
        expect(dispose).toHaveBeenCalledTimes(1);
    });

    it("starts separate transports for different server ids in the same workspace", async () => {
        const transportFactory = vi.fn(async () => ({ dispose: vi.fn() }));
        const manager = new LanguageClientManager({ transportFactory });

        manager.acquireClient(input({ language: "typescript", serverId: "typescript-language-server" }));
        manager.acquireClient(input({ language: "go", serverId: "gopls", displayName: "Go" }));
        await manager.ensureClient(input({ language: "typescript", serverId: "typescript-language-server" }));
        await manager.ensureClient(input({ language: "go", serverId: "gopls", displayName: "Go" }));

        expect(transportFactory).toHaveBeenCalledTimes(2);
    });

    it("records running status with server metadata", async () => {
        const manager = new LanguageClientManager({ transportFactory: vi.fn(async () => ({ dispose: vi.fn() })) });
        await manager.ensureClient(input({ language: "go", serverId: "gopls", displayName: "Go" }));

        expect(manager.getStatus(input({ language: "go", serverId: "gopls", displayName: "Go" }))).toEqual({
            workspaceRoot: "/repo",
            language: "go",
            serverId: "gopls",
            displayName: "Go",
            state: "running",
            message: null,
        });
    });

    it("maps websocket unavailable errors to unavailable status", async () => {
        const manager = new LanguageClientManager({
            transportFactory: vi.fn(async () => {
                throw new Error("LSP unavailable: Install gopls: go install golang.org/x/tools/gopls@latest");
            }),
        });

        await expect(manager.ensureClient(input({ language: "go", serverId: "gopls", displayName: "Go" }))).rejects.toThrow(
            "LSP unavailable"
        );
        expect(manager.getStatus(input({ language: "go", serverId: "gopls", displayName: "Go" }))).toEqual(
            expect.objectContaining({
                serverId: "gopls",
                displayName: "Go",
                state: "unavailable",
                message: "Install gopls: go install golang.org/x/tools/gopls@latest",
            })
        );
    });
});
```

- [ ] **Step 2: Run lifecycle manager tests to verify they fail**

Run:

```bash
npm test -- frontend/app/righteditor/lsp/language-client-manager.test.ts --run
```

Expected: FAIL because manager input does not accept `serverId` and keys by language.

- [ ] **Step 3: Update manager input, keying, and status**

In `frontend/app/righteditor/lsp/language-client-manager.ts`, replace `EnsureClientInput`:

```ts
export type EnsureClientInput = {
    workspaceRoot: string;
    language: string;
    serverId: string;
    displayName: string;
};
```

Replace `setStatus` with:

```ts
private setStatus(input: EnsureClientInput, state: RightEditorLspStatus["state"], message: string | null): void {
    this.statusByKey.set(this.makeKey(input), {
        workspaceRoot: input.workspaceRoot,
        language: input.language,
        serverId: input.serverId,
        displayName: input.displayName,
        state,
        message,
    });
}
```

Replace the fallback object in `getStatus`:

```ts
{
    workspaceRoot: input.workspaceRoot,
    language: input.language,
    serverId: input.serverId,
    displayName: input.displayName,
    state: "stopped",
    message: null,
}
```

Replace the catch block in `ensureClient`:

```ts
} catch (e: any) {
    const rawMessage = e?.message ?? String(e);
    if (rawMessage.startsWith("LSP unavailable: ")) {
        this.setStatus(input, "unavailable", rawMessage.replace("LSP unavailable: ", ""));
    } else {
        this.setStatus(input, "error", rawMessage);
    }
    throw e;
} finally {
```

Replace `makeKey`:

```ts
private makeKey(input: EnsureClientInput): ClientKey {
    return `${input.workspaceRoot}\u0000${input.serverId}`;
}
```

- [ ] **Step 4: Run lifecycle manager tests to verify they pass**

Run:

```bash
npm test -- frontend/app/righteditor/lsp/language-client-manager.test.ts --run
```

Expected: PASS.

- [ ] **Step 5: Run existing transport and workbench tests**

Run:

```bash
npm test -- frontend/app/righteditor/lsp/lsp-transport.test.ts frontend/app/righteditor/right-editor-workbench.test.tsx --run
```

Expected: PASS or compile failure only where the transport type still needs `serverId`, which Task 4 addresses.

- [ ] **Step 6: Commit lifecycle keying**

Run:

```bash
git add frontend/app/righteditor/lsp/language-client-manager.ts frontend/app/righteditor/lsp/language-client-manager.test.ts
git commit -m "feat: key right editor lsp clients by server"
```

## Task 4: WebSocket Transport Contract

**Files:**
- Modify: `frontend/app/righteditor/lsp/lsp-transport.ts`
- Modify: `frontend/app/righteditor/lsp/lsp-transport.test.ts`
- Modify: `emain/lsp/lsp-websocket-server.ts`
- Modify: `emain/lsp/lsp-websocket-server.test.ts`

- [ ] **Step 1: Update failing frontend transport tests**

In `frontend/app/righteditor/lsp/lsp-transport.test.ts`, update calls to `createLspWebSocketTransport` so each input includes `serverId`.

For the URL assertion test, use:

```ts
const transport = await createLspWebSocketTransport({
    workspaceRoot: "/repo",
    language: "typescript",
    serverId: "typescript-language-server",
    displayName: "TypeScript/JavaScript",
});
```

Update the URL expectation:

```ts
expect(MockWebSocket.instances[0].url).toBe(
    "ws://127.0.0.1:9010/lsp?workspaceRoot=%2Frepo&language=typescript&serverId=typescript-language-server"
);
```

Update the client constructor expectation:

```ts
expect(TransportMocks.clientConstructor).toHaveBeenCalledWith(
    expect.objectContaining({
        name: "Crest TypeScript/JavaScript Language Client",
        clientOptions: expect.objectContaining({
            documentSelector: [{ scheme: "file", language: "typescript" }],
        }),
    })
);
```

- [ ] **Step 2: Update failing backend parse tests**

In `emain/lsp/lsp-websocket-server.test.ts`, replace the parse success test with:

```ts
it("extracts language, server id, and workspace root", () => {
    expect(parseLspRequest("/lsp?language=typescript&serverId=typescript-language-server&workspaceRoot=%2Frepo")).toEqual({
        language: "typescript",
        serverId: "typescript-language-server",
        workspaceRoot: "/repo",
    });
});
```

Add:

```ts
it("rejects missing server id", () => {
    expect(() => parseLspRequest("/lsp?language=typescript&workspaceRoot=%2Frepo")).toThrow("Missing serverId");
});
```

Update all WebSocket test URLs from:

```ts
`${url}/lsp?language=typescript&workspaceRoot=%2Frepo`
```

to:

```ts
`${url}/lsp?language=typescript&serverId=typescript-language-server&workspaceRoot=%2Frepo`
```

- [ ] **Step 3: Run transport tests to verify they fail**

Run:

```bash
npm test -- frontend/app/righteditor/lsp/lsp-transport.test.ts emain/lsp/lsp-websocket-server.test.ts --run
```

Expected: FAIL because neither transport nor parser handles `serverId`.

- [ ] **Step 4: Update frontend transport input and URL**

In `frontend/app/righteditor/lsp/lsp-transport.ts`, replace `LspTransportInput`:

```ts
export type LspTransportInput = {
    workspaceRoot: string;
    language: string;
    serverId: string;
    displayName: string;
};
```

Update URL params:

```ts
const params = new URLSearchParams({
    workspaceRoot: input.workspaceRoot,
    language: input.language,
    serverId: input.serverId,
});
```

Update the client name:

```ts
name: `Crest ${input.displayName} Language Client`,
```

- [ ] **Step 5: Update backend request parsing**

In `emain/lsp/lsp-websocket-server.ts`, replace `ParsedLspRequest`:

```ts
export type ParsedLspRequest = {
    language: string;
    serverId: string;
    workspaceRoot: string;
};
```

Replace the parser body after `language`:

```ts
const serverId = url.searchParams.get("serverId");
const workspaceRoot = url.searchParams.get("workspaceRoot");
if (!language) throw new Error("Missing language");
if (!serverId) throw new Error("Missing serverId");
if (!workspaceRoot) throw new Error("Missing workspaceRoot");
return { language, serverId, workspaceRoot };
```

- [ ] **Step 6: Run transport tests to verify they pass**

Run:

```bash
npm test -- frontend/app/righteditor/lsp/lsp-transport.test.ts emain/lsp/lsp-websocket-server.test.ts --run
```

Expected: PASS, except the bridge reuse test may still fail until Task 6 changes manager methods.

- [ ] **Step 7: Commit transport contract changes**

Run:

```bash
git add frontend/app/righteditor/lsp/lsp-transport.ts frontend/app/righteditor/lsp/lsp-transport.test.ts emain/lsp/lsp-websocket-server.ts emain/lsp/lsp-websocket-server.test.ts
git commit -m "feat: include lsp server id in transport"
```

## Task 5: Backend Registry And Command Resolution

**Files:**
- Create: `emain/lsp/language-server-registry.ts`
- Create: `emain/lsp/language-server-registry.test.ts`
- Modify: `emain/lsp/language-server-manager.ts`
- Modify: `emain/lsp/language-server-manager.test.ts`

- [ ] **Step 1: Write failing backend registry tests**

Create `emain/lsp/language-server-registry.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import {
    getLanguageServerDefinition,
    getLanguageServerForLanguage,
    validateLanguageServerRequest,
} from "./language-server-registry";

describe("main-process language server registry", () => {
    it("maps TypeScript-family languages to typescript-language-server", () => {
        expect(getLanguageServerForLanguage("typescript")).toEqual(
            expect.objectContaining({ serverId: "typescript-language-server" })
        );
        expect(getLanguageServerForLanguage("javascriptreact")).toEqual(
            expect.objectContaining({ serverId: "typescript-language-server" })
        );
    });

    it("maps Go to gopls", () => {
        expect(getLanguageServerForLanguage("go")).toEqual(
            expect.objectContaining({
                serverId: "gopls",
                installHint: "Install gopls: go install golang.org/x/tools/gopls@latest",
            })
        );
    });

    it("validates that a language belongs to the requested server", () => {
        expect(() => validateLanguageServerRequest({ language: "go", serverId: "gopls" })).not.toThrow();
        expect(() =>
            validateLanguageServerRequest({ language: "go", serverId: "typescript-language-server" })
        ).toThrow("Language go is not supported by typescript-language-server");
    });

    it("rejects unknown server ids", () => {
        expect(getLanguageServerDefinition("missing")).toBeUndefined();
        expect(() => validateLanguageServerRequest({ language: "go", serverId: "missing" })).toThrow(
            "No language server configured for missing"
        );
    });
});
```

- [ ] **Step 2: Update manager tests for server id and Go**

In `emain/lsp/language-server-manager.test.ts`, update `resolveCommand` calls to pass objects.

Replace:

```ts
expect(manager.resolveCommand("typescript")).toEqual({
```

with:

```ts
expect(manager.resolveCommand({ serverId: "typescript-language-server", language: "typescript" })).toEqual({
```

Add this test after the TypeScript resolver tests:

```ts
it("resolves gopls from PATH when available", () => {
    const manager = new LanguageServerManager({
        commandAvailable: (command, args) => command === "gopls" && args.join(" ") === "version",
        spawn: vi.fn() as any,
    });

    expect(manager.resolveCommand({ serverId: "gopls", language: "go" })).toEqual({
        command: "gopls",
        args: [],
    });
});
```

Add this test after the Go resolver test:

```ts
it("throws an unavailable error when gopls is missing", () => {
    const manager = new LanguageServerManager({ commandAvailable: () => false, spawn: vi.fn() as any });

    expect(() => manager.resolveCommand({ serverId: "gopls", language: "go" })).toThrow(
        "LSP unavailable: Install gopls: go install golang.org/x/tools/gopls@latest"
    );
});
```

Update lifecycle inputs from:

```ts
{ workspaceRoot: "/repo", language: "typescript" }
```

to:

```ts
{ workspaceRoot: "/repo", language: "typescript", serverId: "typescript-language-server" }
```

Add a reuse assertion for shared TypeScript server ids:

```ts
it("reuses one process per workspace root and server id", () => {
    const spawn = vi.fn(() => makeChild().child);
    const manager = new LanguageServerManager({ spawn: spawn as any });

    manager.getOrStart({ workspaceRoot: "/repo", language: "typescript", serverId: "typescript-language-server" });
    manager.getOrStart({ workspaceRoot: "/repo", language: "typescriptreact", serverId: "typescript-language-server" });

    expect(spawn).toHaveBeenCalledTimes(1);
});
```

- [ ] **Step 3: Run backend registry and manager tests to verify they fail**

Run:

```bash
npm test -- emain/lsp/language-server-registry.test.ts emain/lsp/language-server-manager.test.ts --run
```

Expected: FAIL because registry file does not exist and manager still resolves by raw language.

- [ ] **Step 4: Add backend registry**

Create `emain/lsp/language-server-registry.ts`:

```ts
export type LanguageServerDefinition = {
    serverId: string;
    displayName: string;
    languages: string[];
    command: "typescript-language-server" | "gopls";
    installHint?: string;
};

export const languageServerDefinitions: LanguageServerDefinition[] = [
    {
        serverId: "typescript-language-server",
        displayName: "TypeScript/JavaScript",
        languages: ["typescript", "typescriptreact", "javascript", "javascriptreact"],
        command: "typescript-language-server",
    },
    {
        serverId: "gopls",
        displayName: "Go",
        languages: ["go"],
        command: "gopls",
        installHint: "Install gopls: go install golang.org/x/tools/gopls@latest",
    },
];

const definitionByServerId = new Map(languageServerDefinitions.map((definition) => [definition.serverId, definition]));
const definitionByLanguage = new Map<string, LanguageServerDefinition>();

for (const definition of languageServerDefinitions) {
    for (const language of definition.languages) {
        definitionByLanguage.set(language, definition);
    }
}

export function getLanguageServerDefinition(serverId: string): LanguageServerDefinition | undefined {
    return definitionByServerId.get(serverId);
}

export function getLanguageServerForLanguage(language: string): LanguageServerDefinition | undefined {
    return definitionByLanguage.get(language);
}

export function validateLanguageServerRequest(input: { language: string; serverId: string }): LanguageServerDefinition {
    const definition = getLanguageServerDefinition(input.serverId);
    if (!definition) {
        throw new Error(`No language server configured for ${input.serverId}`);
    }
    if (!definition.languages.includes(input.language)) {
        throw new Error(`Language ${input.language} is not supported by ${input.serverId}`);
    }
    return definition;
}
```

- [ ] **Step 5: Update backend manager for registry-backed resolution**

In `emain/lsp/language-server-manager.ts`, add:

```ts
import { validateLanguageServerRequest } from "./language-server-registry";
```

Add a `spawnSync` import:

```ts
import { spawnSync } from "node:child_process";
```

Add a command availability type near `CommandExistsFn`:

```ts
type CommandAvailableFn = (command: string, args: string[]) => boolean;
```

Add a private property:

```ts
private readonly commandAvailable: CommandAvailableFn;
```

In the constructor deps type, add:

```ts
commandAvailable?: CommandAvailableFn;
```

In the constructor body, initialize:

```ts
this.commandAvailable =
    deps.commandAvailable ??
    ((command, args) => {
        const result = spawnSync(command, args, { stdio: "ignore" });
        return result.status === 0;
    });
```

Replace `LanguageServerInput`:

```ts
type LanguageServerInput = {
    workspaceRoot: string;
    language: string;
    serverId: string;
};
```

Replace `resolveCommand`:

```ts
resolveCommand(input: Pick<LanguageServerInput, "language" | "serverId">): LanguageServerCommand {
    const definition = validateLanguageServerRequest(input);
    if (definition.command === "typescript-language-server") {
        return this.resolvePackagedCommand("typescript-language-server") ?? {
            command: this.resolveAppBinCommand("typescript-language-server"),
            args: ["--stdio"],
        };
    }
    if (definition.command === "gopls") {
        if (!this.commandAvailable("gopls", ["version"])) {
            throw new Error(`LSP unavailable: ${definition.installHint}`);
        }
        return {
            command: "gopls",
            args: [],
        };
    }
    throw new Error(`No command resolver configured for ${definition.serverId}`);
}
```

Replace every process key expression with:

```ts
`${input.workspaceRoot}\u0000${input.serverId}`
```

Replace `spawnProcess` command resolution:

```ts
const command = this.resolveCommand(input);
```

Remove the old `if (!command)` block because `resolveCommand` now throws actionable errors.

- [ ] **Step 6: Run backend tests to verify they pass**

Run:

```bash
npm test -- emain/lsp/language-server-registry.test.ts emain/lsp/language-server-manager.test.ts --run
```

Expected: PASS.

- [ ] **Step 7: Commit backend registry and command resolution**

Run:

```bash
git add emain/lsp/language-server-registry.ts emain/lsp/language-server-registry.test.ts emain/lsp/language-server-manager.ts emain/lsp/language-server-manager.test.ts
git commit -m "feat: resolve right editor lsp servers from registry"
```

## Task 6: Backend WebSocket Reuse And Release

**Files:**
- Modify: `emain/lsp/lsp-websocket-server.ts`
- Modify: `emain/lsp/lsp-websocket-server.test.ts`
- Modify: `emain/lsp/language-server-manager.ts`
- Modify: `emain/lsp/language-server-manager.test.ts`

- [ ] **Step 1: Add failing tests for cached WebSocket sessions**

In `emain/lsp/language-server-manager.test.ts`, replace the independent session tests with reference-counted lifecycle tests:

```ts
it("keeps a cached process alive until the final release", () => {
    const spawned = makeChild();
    const spawn = vi.fn(() => spawned.child);
    const manager = new LanguageServerManager({ spawn: spawn as any });
    const input = { workspaceRoot: "/repo", language: "go", serverId: "gopls" };

    manager.acquire(input);
    manager.acquire(input);
    manager.release(input);

    expect(spawn).toHaveBeenCalledTimes(1);
    expect(spawned.child.kill).not.toHaveBeenCalled();

    manager.release(input);

    expect(spawned.child.kill).toHaveBeenCalledTimes(1);
});
```

In `emain/lsp/lsp-websocket-server.test.ts`, replace the test named `starts a separate language server session for each websocket client` with:

```ts
it("rejects a duplicate active websocket session for the same workspace and server id", async () => {
    const child = makeStreamChild();
    const languageServerManager = {
        acquire: vi.fn(() => child),
        release: vi.fn(),
        stopAll: vi.fn(),
    };
    const bridge = new LspWebSocketBridge({ languageServerManager: languageServerManager as any });
    const url = await bridge.start();
    const firstClient = new WebSocket(`${url}/lsp?language=typescript&serverId=typescript-language-server&workspaceRoot=%2Frepo`);
    const secondClient = new WebSocket(`${url}/lsp?language=typescriptreact&serverId=typescript-language-server&workspaceRoot=%2Frepo`);
    await Promise.all([
        new Promise<void>((resolve) => firstClient.once("open", resolve)),
        new Promise<void>((resolve) => secondClient.once("open", resolve)),
    ]);

    await vi.waitFor(() => {
        expect(secondClient.readyState).toBe(WebSocket.CLOSED);
    });
    expect(languageServerManager.acquire).toHaveBeenCalledTimes(1);
    expect(languageServerManager.acquire).toHaveBeenNthCalledWith(1, {
        language: "typescript",
        serverId: "typescript-language-server",
        workspaceRoot: "/repo",
    });
    expect(child.stdout.listenerCount("data")).toBe(1);

    firstClient.close();
    await vi.waitFor(() => {
        expect(languageServerManager.release).toHaveBeenCalledTimes(1);
    });
    await bridge.stop();
});
```

Update other bridge test manager mocks from `startSession` to:

```ts
acquire: vi.fn(() => child),
release: vi.fn(),
stopAll: vi.fn(),
```

- [ ] **Step 2: Run bridge and manager tests to verify they fail**

Run:

```bash
npm test -- emain/lsp/lsp-websocket-server.test.ts emain/lsp/language-server-manager.test.ts --run
```

Expected: FAIL because `acquire` and `release` do not exist and the bridge still calls `startSession`.

- [ ] **Step 3: Add reference-counted backend acquire/release**

In `emain/lsp/language-server-manager.ts`, add a private map:

```ts
private readonly referenceCounts = new Map<string, number>();
```

Add:

```ts
acquire(input: LanguageServerInput): ChildProcessWithoutNullStreams {
    const key = this.makeKey(input);
    this.referenceCounts.set(key, (this.referenceCounts.get(key) ?? 0) + 1);
    return this.getOrStart(input);
}

release(input: LanguageServerInput): void {
    const key = this.makeKey(input);
    const nextCount = (this.referenceCounts.get(key) ?? 0) - 1;
    if (nextCount > 0) {
        this.referenceCounts.set(key, nextCount);
        return;
    }
    this.referenceCounts.delete(key);
    this.stop(input);
}

private makeKey(input: LanguageServerInput): string {
    return `${input.workspaceRoot}\u0000${input.serverId}`;
}
```

Update `getOrStart`, `stop`, child `exit` handler, child `error` handler, and `stopAll` to use `makeKey`. In the `exit` and `error` handlers also delete `referenceCounts` for that key:

```ts
child.on("exit", () => {
    this.processes.delete(key);
    this.referenceCounts.delete(key);
});
child.on("error", () => {
    this.processes.delete(key);
    this.referenceCounts.delete(key);
});
```

Remove `startSession` after bridge tests no longer use it.

- [ ] **Step 4: Update bridge to acquire and release cached servers**

In `emain/lsp/lsp-websocket-server.ts`, replace `LanguageServerManagerLike`:

```ts
type LanguageServerManagerLike = {
    acquire: (input: ParsedLspRequest) => ChildProcessWithoutNullStreams;
    release: (input: ParsedLspRequest) => void;
    stopAll?: () => void;
};
```

Add active session tracking to `LspWebSocketBridge`:

```ts
private readonly activeSessionKeys = new Set<string>();
```

In `handleConnection`, store the parsed request and acquire:

```ts
let child: ChildProcessWithoutNullStreams;
let lspRequest: ParsedLspRequest;
let sessionKey: string | null = null;
try {
    lspRequest = parseLspRequest(urlText);
    sessionKey = `${lspRequest.workspaceRoot}\u0000${lspRequest.serverId}`;
    if (this.activeSessionKeys.has(sessionKey)) {
        ws.close(1013, `LSP session already active for ${lspRequest.serverId}`);
        return;
    }
    this.activeSessionKeys.add(sessionKey);
    child = this.languageServerManager.acquire(lspRequest);
} catch (e: any) {
    if (sessionKey) {
        this.activeSessionKeys.delete(sessionKey);
    }
    ws.close(1008, e?.message ?? String(e));
    return;
}
```

In `cleanup`, replace direct `child.kill()` with release:

```ts
this.activeSessionKeys.delete(`${lspRequest.workspaceRoot}\u0000${lspRequest.serverId}`);
if (opts.killChild) {
    this.languageServerManager.release(lspRequest);
}
```

In `stop`, after session cleanup loop, call:

```ts
this.languageServerManager.stopAll?.();
```

- [ ] **Step 5: Run backend tests to verify they pass**

Run:

```bash
npm test -- emain/lsp/lsp-websocket-server.test.ts emain/lsp/language-server-manager.test.ts --run
```

Expected: PASS.

- [ ] **Step 6: Commit WebSocket reuse**

Run:

```bash
git add emain/lsp/lsp-websocket-server.ts emain/lsp/lsp-websocket-server.test.ts emain/lsp/language-server-manager.ts emain/lsp/language-server-manager.test.ts
git commit -m "feat: reuse right editor lsp servers by workspace"
```

## Task 7: Right Editor LSP Status UI

**Files:**
- Modify: `frontend/app/righteditor/right-editor-workbench.tsx`
- Modify: `frontend/app/righteditor/right-editor-workbench.test.tsx`
- Modify: `frontend/app/righteditor/lsp/language-client-manager.ts`
- Modify: `frontend/app/righteditor/lsp/language-client-manager.test.ts`

- [ ] **Step 1: Write failing status UI tests**

In `frontend/app/righteditor/right-editor-workbench.test.tsx`, update the `language-client-manager` mock:

```ts
vi.mock("./lsp/language-client-manager", () => ({
    languageClientManager: {
        acquireClient: vi.fn(() => vi.fn()),
        getStatus: vi.fn(() => ({
            language: "typescript",
            workspaceRoot: "/repo",
            serverId: "typescript-language-server",
            displayName: "TypeScript/JavaScript",
            state: "running",
            message: null,
        })),
    },
}));
```

Import the mocked manager after existing imports:

```ts
import { languageClientManager } from "./lsp/language-client-manager";
```

Add tests:

```ts
it("renders basic editing status for unsupported languages", async () => {
    const model = RightEditorModel.getInstance(rpc);
    await model.openFile("/repo/package.json", "/repo");

    const markup = renderWithStore(<RightEditorWorkbench model={model} />);

    expect(markup).toContain("Basic editing");
    expect(markup).toContain("JSON");
});

it("renders running LSP status for supported languages", async () => {
    vi.mocked(languageClientManager.getStatus).mockReturnValueOnce({
        language: "go",
        workspaceRoot: "/repo",
        serverId: "gopls",
        displayName: "Go",
        state: "running",
        message: null,
    });
    const model = RightEditorModel.getInstance(rpc);
    await model.openFile("/repo/main.go", "/repo");

    const markup = renderWithStore(<RightEditorWorkbench model={model} />);

    expect(markup).toContain("LSP: Go ready");
});

it("renders unavailable LSP status with install hint", async () => {
    vi.mocked(languageClientManager.getStatus).mockReturnValueOnce({
        language: "go",
        workspaceRoot: "/repo",
        serverId: "gopls",
        displayName: "Go",
        state: "unavailable",
        message: "Install gopls: go install golang.org/x/tools/gopls@latest",
    });
    const model = RightEditorModel.getInstance(rpc);
    await model.openFile("/repo/main.go", "/repo");

    const markup = renderWithStore(<RightEditorWorkbench model={model} />);

    expect(markup).toContain("LSP: Go unavailable");
    expect(markup).toContain("Install gopls: go install golang.org/x/tools/gopls@latest");
});
```

- [ ] **Step 2: Run status UI tests to verify they fail**

Run:

```bash
npm test -- frontend/app/righteditor/right-editor-workbench.test.tsx --run
```

Expected: FAIL because no status area is rendered.

- [ ] **Step 3: Add status helpers and rendering**

In `frontend/app/righteditor/right-editor-workbench.tsx`, import the type:

```ts
import type { RightEditorLspStatus, RightEditorOpenFile } from "./right-editor-types";
```

Add:

```ts
function getRightEditorLspStatusLabel(status: RightEditorLspStatus): string {
    if (status.state === "stopped" && status.message === "Basic editing") {
        return `${status.displayName} · Basic editing`;
    }
    if (status.state === "starting") return `LSP: ${status.displayName} starting`;
    if (status.state === "running") return `LSP: ${status.displayName} ready`;
    if (status.state === "unavailable") return `LSP: ${status.displayName} unavailable`;
    if (status.state === "error") return `LSP: ${status.displayName} error`;
    return `LSP: ${status.displayName} stopped`;
}

function getRightEditorStatusForActiveFile(input: {
    activeFile: RightEditorOpenFile;
    workspaceRoot: string;
    lspManager: Pick<typeof languageClientManager, "getStatus">;
}): RightEditorLspStatus {
    const workspaceRoot = input.activeFile.workspaceRoot || input.workspaceRoot;
    const support = getRightEditorLspSupport(input.activeFile.language, workspaceRoot);
    if (!support.supported) return support.status;
    return input.lspManager.getStatus({
        workspaceRoot,
        language: input.activeFile.language,
        serverId: support.server.serverId,
        displayName: support.server.displayName,
    });
}
```

Update the registry import to include `getRightEditorLspSupport`.

Before `return` in `RightEditorWorkbench`, compute:

```ts
const lspStatus = getRightEditorStatusForActiveFile({
    activeFile,
    workspaceRoot: state.workspaceRoot,
    lspManager: languageClientManager,
});
const lspStatusLabel = getRightEditorLspStatusLabel(lspStatus);
```

Add a status row near the bottom of the editor container, after `CodeEditor`:

```tsx
<div
    aria-label="Right editor LSP status"
    className="flex h-6 shrink-0 items-center justify-between gap-3 border-t border-[#2a2b2f] px-3 text-[11px] text-secondary"
    title={lspStatus.message ?? lspStatusLabel}
>
    <span>{lspStatusLabel}</span>
    {lspStatus.message && lspStatus.message !== "Basic editing" ? (
        <span className="truncate text-[#c9a66b]">{lspStatus.message}</span>
    ) : null}
</div>
```

- [ ] **Step 4: Run status UI tests to verify they pass**

Run:

```bash
npm test -- frontend/app/righteditor/right-editor-workbench.test.tsx --run
```

Expected: PASS.

- [ ] **Step 5: Commit status UI**

Run:

```bash
git add frontend/app/righteditor/right-editor-workbench.tsx frontend/app/righteditor/right-editor-workbench.test.tsx
git commit -m "feat: show right editor lsp status"
```

## Task 8: Verification And Documentation Progress

**Files:**
- Modify: `docs/superpowers/specs/2026-06-22-right-editor-multilanguage-lsp-design.md`
- Modify: `docs/superpowers/plans/2026-06-22-right-editor-multilanguage-lsp.md`

- [ ] **Step 1: Run all focused tests**

Run:

```bash
npm test -- frontend/app/righteditor/lsp/language-server-registry.test.ts frontend/app/righteditor/lsp/language-client-manager.test.ts frontend/app/righteditor/lsp/lsp-transport.test.ts frontend/app/righteditor/right-editor-workbench.test.tsx emain/lsp/language-server-registry.test.ts emain/lsp/language-server-manager.test.ts emain/lsp/lsp-websocket-server.test.ts --run
```

Expected: PASS.

- [ ] **Step 2: Run type/build verification**

Run:

```bash
npm run build:dev
```

Expected: PASS with no TypeScript or bundling errors in the changed frontend and Electron main files.

- [ ] **Step 3: Manually validate Go unavailable status**

Temporarily run the app in an environment where `gopls` is not on PATH, open a `.go` file in the right editor, and verify the status area shows:

```text
LSP: Go unavailable
Install gopls: go install golang.org/x/tools/gopls@latest
```

Expected: the file remains editable and no duplicate `gopls` process is spawned.

- [ ] **Step 4: Manually validate Go available path**

Install `gopls` if needed:

```bash
go install golang.org/x/tools/gopls@latest
```

Open a workspace with:

```text
go.mod
main.go
pkg/foo.go
```

Expected:
- Opening `main.go` shows `LSP: Go ready`.
- Diagnostics from `gopls` appear as Monaco markers.
- Switching between `main.go` and `pkg/foo.go` does not create a second `gopls` process for the same workspace.

- [ ] **Step 5: Update progress in design and plan docs**

In `docs/superpowers/specs/2026-06-22-right-editor-multilanguage-lsp-design.md`, update the progress table to:

```md
| Phase | Status | Notes |
| --- | --- | --- |
| Phase 0: Research | Done | Current Crest LSP chain and Warp LSP architecture reviewed. |
| Phase 1: Design | Done | Registry, workspace reuse, Go sample, and status UI decisions captured. |
| Phase 2: Plan | Done | Implementation checklist created in `docs/superpowers/plans/2026-06-22-right-editor-multilanguage-lsp.md`. |
| Phase 3: Registry Refactor | Done | Frontend and backend registry paths replace JS/TS hard-coding. |
| Phase 4: Go Sample | Done | `gopls` is discovered from PATH and reports an actionable unavailable status. |
| Phase 5: UI Status | Done | Right editor shows basic, starting, ready, unavailable, and error states. |
| Phase 6: Verification | Done | Focused tests, development build, and Go validation completed. |
```

In this plan file, update the `Progress` table to the same completed statuses after verification passes.

- [ ] **Step 6: Commit verification docs**

Run:

```bash
git add docs/superpowers/specs/2026-06-22-right-editor-multilanguage-lsp-design.md docs/superpowers/plans/2026-06-22-right-editor-multilanguage-lsp.md
git commit -m "docs: mark right editor multilanguage lsp progress"
```

## Self-Review

- Spec coverage: Tasks 1 and 5 implement the registry; Tasks 2, 3, and 4 wire frontend gating, `serverId`, and transport; Task 6 implements `workspaceRoot + serverId` reuse; Task 7 exposes basic, ready, unavailable, and error-oriented status labels; Task 8 covers focused verification and progress tracking.
- Placeholder scan: The plan contains no unresolved placeholder steps; every task has concrete file paths, test commands, code blocks, and commit commands.
- Type consistency: The shared input shape after Task 3 is `{ workspaceRoot, language, serverId, displayName }` on the frontend. The backend request shape after Task 4 is `{ workspaceRoot, language, serverId }`. The status type after Task 2 includes `serverId`, `displayName`, and `unavailable`.
