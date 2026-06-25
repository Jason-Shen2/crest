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
