// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0
// @vitest-environment jsdom

import { beforeEach, describe, expect, it, vi } from "vitest";

const runtime = vi.hoisted(() => ({
    loadFonts: vi.fn(),
    registerBuilderGlobalKeys: vi.fn(),
    registerElectronReinjectKeyHandler: vi.fn(),
    sendLog: vi.fn(),
}));

vi.mock("@/util/fontutil", () => ({ loadFonts: runtime.loadFonts }));
vi.mock("@/app/store/keymodel", () => ({
    registerBuilderGlobalKeys: runtime.registerBuilderGlobalKeys,
    registerElectronReinjectKeyHandler: runtime.registerElectronReinjectKeyHandler,
}));
vi.mock("@/app/monaco/monaco-env", () => ({ loadMonaco: vi.fn().mockResolvedValue(undefined) }));
vi.mock("@/app/store/ai-user-config", () => ({ initAIUserConfig: vi.fn() }));
vi.mock("@/app/store/global-model", () => ({
    GlobalModel: { getInstance: () => ({ initialize: vi.fn().mockResolvedValue(undefined) }) },
}));
vi.mock("@/app/store/wshclientapi", () => ({
    RpcApi: {
        GetRTInfoCommand: vi.fn().mockResolvedValue({}),
        GetFullConfigCommand: vi.fn().mockResolvedValue({}),
    },
}));
vi.mock("@/app/store/wshrouter", () => ({ makeBuilderRouteId: (builderId: string) => `builder:${builderId}` }));
vi.mock("@/app/store/wshrpcutil", () => ({ initWshrpc: vi.fn(), TabRpcClient: {} }));
vi.mock("@/app/theme/theme-model", () => ({
    ThemeModel: { getInstance: () => ({ initialize: vi.fn() }) },
}));
vi.mock("@/builder/builder-app", () => ({
    BuilderApp: ({ onFirstRender }: { onFirstRender: () => void }) => {
        onFirstRender();
        return null;
    },
}));
vi.mock("@/store/global", () => ({
    atoms: { builderAppId: {}, fullConfigAtom: {} },
    getApi: () => ({ getPlatform: () => "linux", sendLog: runtime.sendLog }),
    globalStore: { set: vi.fn() },
    initGlobal: vi.fn(),
    loadConnStatus: vi.fn().mockResolvedValue(undefined),
}));
vi.mock("@/store/wos", () => ({
    makeORef: (otype: string, oid: string) => `${otype}:${oid}`,
    loadAndPinWaveObject: vi.fn().mockResolvedValue({}),
}));
vi.mock("react-dom/client", () => ({
    createRoot: () => ({
        render: (element: { props: { onFirstRender: () => void } }) => element.props.onFirstRender(),
    }),
}));

const initOpts = {
    clientId: "client-1",
    windowId: "window-1",
    builderId: "builder-1",
} as BuilderInitOpts;

describe("Builder renderer runtime preparation", () => {
    beforeEach(() => {
        vi.resetModules();
        document.body.innerHTML = '<div id="main"></div>';
        runtime.loadFonts.mockClear();
        runtime.registerBuilderGlobalKeys.mockClear();
        runtime.registerElectronReinjectKeyHandler.mockClear();
        runtime.sendLog.mockClear();
    });

    it("initializes Linux key semantics and fonts once before Builder keys register", async () => {
        const { initializeBuilderRenderer } = await import("./builder-bootstrap");
        const { checkKeyPressed } = await import("@/util/keyutil");

        await initializeBuilderRenderer(initOpts);
        await initializeBuilderRenderer(initOpts);

        expect(runtime.loadFonts).toHaveBeenCalledOnce();
        expect(runtime.loadFonts.mock.invocationCallOrder[0]).toBeLessThan(
            runtime.registerBuilderGlobalKeys.mock.invocationCallOrder[0]
        );
        expect(
            checkKeyPressed(
                {
                    key: "w",
                    cmd: true,
                    alt: true,
                    meta: false,
                    option: false,
                    control: false,
                    shift: false,
                } as WaveKeyboardEvent,
                "Cmd:w"
            )
        ).toBe(true);
        expect(
            checkKeyPressed(
                {
                    key: "w",
                    cmd: true,
                    alt: false,
                    meta: true,
                    option: true,
                    control: false,
                    shift: false,
                } as WaveKeyboardEvent,
                "Cmd:w"
            )
        ).toBe(false);
    });

    it("preserves the runtime preparation failure boundary", async () => {
        const fontError = new Error("font setup failed");
        runtime.loadFonts.mockImplementationOnce(() => {
            throw fontError;
        });
        const { initializeBuilderRenderer } = await import("./builder-bootstrap");

        await expect(initializeBuilderRenderer(initOpts)).rejects.toBe(fontError);
        expect(runtime.registerBuilderGlobalKeys).not.toHaveBeenCalled();
        expect(runtime.sendLog).not.toHaveBeenCalled();
    });
});
