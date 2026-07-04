// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

import { afterEach, describe, expect, it, vi } from "vitest";
import { MonacoModelRegistry } from "./monaco-model-registry";

type MockModel = {
    uri: { toString: () => string };
    language: string;
    value: string;
    disposed: boolean;
    getValue: () => string;
    dispose: () => void;
};

const Models = vi.hoisted(() => new Map<string, MockModel>());

vi.mock("@/app/monaco/monaco-env", () => ({
    loadMonaco: vi.fn(),
}));

vi.mock("monaco-editor", () => ({
    Uri: {
        parse: (uri: string) => ({
            toString: () => uri,
        }),
    },
    editor: {
        createModel: (value: string, language: string, uri: { toString: () => string }) => {
            const model: MockModel = {
                uri,
                language,
                value,
                disposed: false,
                getValue: () => model.value,
                dispose: () => {
                    model.disposed = true;
                    Models.delete(uri.toString());
                },
            };
            Models.set(uri.toString(), model);
            return model;
        },
        getModel: (uri: { toString: () => string }) => Models.get(uri.toString()) ?? null,
        setModelLanguage: (model: MockModel, language: string) => {
            model.language = language;
        },
    },
}));

describe("MonacoModelRegistry", () => {
    afterEach(() => {
        MonacoModelRegistry.getInstance().disposeAll();
    });

    it("returns the same model for the same file uri", () => {
        const registry = MonacoModelRegistry.getInstance();
        const first = registry.getOrCreateModel({
            path: "/repo/src/app.ts",
            uri: "file:///repo/src/app.ts",
            text: "export const a = 1;",
            language: "typescript",
        });
        const second = registry.getOrCreateModel({
            path: "/repo/src/app.ts",
            uri: "file:///repo/src/app.ts",
            text: "export const a = 2;",
            language: "typescript",
        });

        expect(second).toBe(first);
        expect(second.getValue()).toBe("export const a = 1;");
    });

    it("updates model language without replacing the model", () => {
        const registry = MonacoModelRegistry.getInstance();
        const model = registry.getOrCreateModel({
            path: "/repo/script",
            uri: "file:///repo/script",
            text: "echo hi",
            language: "plaintext",
        });

        registry.setLanguage("file:///repo/script", "shell");

        expect((model as unknown as MockModel).language).toBe("shell");
    });

    it("keeps a shared file uri model alive until all scoped paths are disposed", () => {
        const registry = MonacoModelRegistry.getInstance();
        const first = registry.getOrCreateModel({
            path: "codeeditor:block-1:/repo/src/app.ts",
            uri: "file:///repo/src/app.ts",
            text: "export const a = 1;",
            language: "typescript",
        });
        const second = registry.getOrCreateModel({
            path: "codeeditor:block-2:/repo/src/app.ts",
            uri: "file:///repo/src/app.ts",
            text: "export const a = 2;",
            language: "typescript",
        });

        registry.disposePath("codeeditor:block-1:/repo/src/app.ts");

        expect(second).toBe(first);
        expect((first as unknown as MockModel).disposed).toBe(false);
        expect(registry.getModelByPath("codeeditor:block-2:/repo/src/app.ts")).toBe(first);

        registry.disposePath("codeeditor:block-2:/repo/src/app.ts");

        expect((first as unknown as MockModel).disposed).toBe(true);
    });

    it("cleans the old model when a file path is renamed", () => {
        const registry = MonacoModelRegistry.getInstance();
        const model = registry.getOrCreateModel({
            path: "/repo/src/app.ts",
            uri: "file:///repo/src/app.ts",
            text: "export const a = 1;",
            language: "typescript",
        });

        registry.migratePath("/repo/src/app.ts", "/repo/lib/app.ts");

        expect((model as unknown as MockModel).disposed).toBe(true);
        expect(registry.getModelByPath("/repo/src/app.ts")).toBeNull();
        expect(registry.getModelByPath("/repo/lib/app.ts")).toBeNull();
    });
});
