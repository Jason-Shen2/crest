// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0
import { beforeEach, describe, expect, it, vi } from "vitest";

const MonacoEnvMocks = vi.hoisted(() => ({
    initializeMonacoVscodeApi: vi.fn(async () => undefined),
    configureMonacoYaml: vi.fn(),
    defineTheme: vi.fn(),
    setTheme: vi.fn(),
    setTypescriptDiagnosticsOptions: vi.fn(),
    setJsonDiagnosticsOptions: vi.fn(),
}));

vi.mock("@codingame/monaco-vscode-api/services", () => ({
    initialize: MonacoEnvMocks.initializeMonacoVscodeApi,
}));

vi.mock("@codingame/monaco-vscode-configuration-service-override", () => ({
    default: () => ({ configurationService: true }),
}));

vi.mock("@codingame/monaco-vscode-languages-service-override", () => ({
    default: () => ({ languagesService: true }),
}));

vi.mock("@codingame/monaco-vscode-log-service-override", () => ({
    default: () => ({ logService: true }),
}));

vi.mock("@codingame/monaco-vscode-model-service-override", () => ({
    default: () => ({ modelService: true }),
}));

vi.mock("monaco-yaml", () => ({
    configureMonacoYaml: MonacoEnvMocks.configureMonacoYaml,
}));

vi.mock("monaco-editor", () => ({
    editor: {
        defineTheme: MonacoEnvMocks.defineTheme,
        setTheme: MonacoEnvMocks.setTheme,
    },
    typescript: {
        typescriptDefaults: {
            setDiagnosticsOptions: MonacoEnvMocks.setTypescriptDiagnosticsOptions,
        },
    },
    json: {
        jsonDefaults: {
            setDiagnosticsOptions: MonacoEnvMocks.setJsonDiagnosticsOptions,
        },
    },
}));

vi.mock("monaco-editor/esm/vs/language/css/monaco.contribution", () => ({}));
vi.mock("monaco-editor/esm/vs/language/html/monaco.contribution", () => ({}));
vi.mock("monaco-editor/esm/vs/language/json/monaco.contribution", () => ({}));
vi.mock("monaco-editor/esm/vs/language/typescript/monaco.contribution", () => ({}));
vi.mock("monaco-editor/esm/vs/editor/editor.worker?worker", () => ({ default: class EditorWorker {} }));
vi.mock("monaco-editor/esm/vs/language/css/css.worker?worker", () => ({ default: class CssWorker {} }));
vi.mock("monaco-editor/esm/vs/language/html/html.worker?worker", () => ({ default: class HtmlWorker {} }));
vi.mock("monaco-editor/esm/vs/language/json/json.worker?worker", () => ({ default: class JsonWorker {} }));
vi.mock("monaco-editor/esm/vs/language/typescript/ts.worker?worker", () => ({ default: class TsWorker {} }));
vi.mock("./yamlworker?worker", () => ({ default: class YamlWorker {} }));

function setViewport(width: number, height: number) {
    Object.defineProperty(globalThis, "window", {
        configurable: true,
        value: {
            innerWidth: width,
            innerHeight: height,
            MonacoEnvironment: undefined,
        },
    });
    Object.defineProperty(globalThis, "document", {
        configurable: true,
        value: {
            body: {
                clientWidth: width,
                clientHeight: height,
            },
            documentElement: {
                clientWidth: width,
                clientHeight: height,
            },
        },
    });
}

describe("loadMonaco", () => {
    beforeEach(() => {
        vi.resetModules();
        vi.clearAllMocks();
        setViewport(1024, 768);
    });

    it("defers vscode service initialization until the browser viewport has dimensions", async () => {
        setViewport(0, 0);
        const { loadMonaco } = await import("./monaco-env");

        loadMonaco();

        expect(MonacoEnvMocks.initializeMonacoVscodeApi).not.toHaveBeenCalled();
    });

    it("initializes deferred vscode services when loadMonaco runs after the viewport is ready", async () => {
        setViewport(0, 0);
        const { loadMonaco } = await import("./monaco-env");
        loadMonaco();

        setViewport(1024, 768);
        loadMonaco();

        expect(MonacoEnvMocks.initializeMonacoVscodeApi).toHaveBeenCalledTimes(1);
    });
});
