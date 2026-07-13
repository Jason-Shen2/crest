// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

import type { WebviewTag } from "electron";
import type { RefObject } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { RightBrowser, RightBrowserModel } from "./right-browser";

vi.mock("@/app/waveenv/waveenv", () => ({
    useWaveEnv: () => ({
        electron: {
            getWebviewPreload: () => "/tmp/preload-webview.js",
            openExternal: vi.fn(),
            setWebviewFocus: vi.fn(),
        },
    }),
}));

function expectNoHardcodedHexColors(markup: string): void {
    expect(markup).not.toMatch(/#[0-9a-fA-F]{3,8}/);
}

function expectNoBackgroundTokensUsedAsText(markup: string): void {
    expect(markup).not.toMatch(/\btext-(muted|secondary)(?=[\s"/])/);
}

describe("RightBrowserModel", () => {
    beforeEach(() => {
        RightBrowserModel.resetInstance();
    });

    it("starts on the official Google page using the shared Crest browser partition", () => {
        const model = RightBrowserModel.getInstance();
        const tab = model.getActiveTab();

        expect(tab).not.toBeNull();
        expect(tab!.title).toBe("Google");
        expect(tab!.url).toBe("https://www.google.com");
        expect(tab!.urlInputValue).toBe("https://www.google.com");
        expect(tab!.partition).toBe("persist:crest-browser");
    });

    it("navigates away from the official Google page even before a webview ref exists", () => {
        const model = RightBrowserModel.getInstance();
        const tab = model.getActiveTab();

        expect(tab).not.toBeNull();

        model.loadUrl(tab!.id, "crest terminal");
        const updated = model.getTab(tab!.id);

        expect(updated!.url).toBe("https://www.google.com/search?q=crest%20terminal");
        expect(updated!.urlInputValue).toBe("https://www.google.com/search?q=crest%20terminal");
        expect(updated!.partition).toBe("persist:crest-browser");
    });

    it("returns to the official Google page when Home is pressed", () => {
        const model = RightBrowserModel.getInstance();
        const tab = model.getActiveTab();

        expect(tab).not.toBeNull();

        model.loadUrl(tab!.id, "https://example.com");
        model.goHome(tab!.id);
        const updated = model.getTab(tab!.id);

        expect(updated!.title).toBe("Google");
        expect(updated!.url).toBe("https://www.google.com");
        expect(updated!.partition).toBe("persist:crest-browser");
    });

    it("ignores stale webview ref cleanup after a replacement ref is registered", () => {
        const model = RightBrowserModel.getInstance();
        const tab = model.getActiveTab();

        expect(tab).not.toBeNull();

        const staleRef = model.getWebviewRef(tab!.id);
        model.removeWebviewRef(tab!.id, staleRef);
        const replacementRef = model.getWebviewRef(tab!.id);

        expect(replacementRef).not.toBe(staleRef);

        model.removeWebviewRef(tab!.id, staleRef);

        expect(model.getWebviewRef(tab!.id)).toBe(replacementRef);
    });

    it("does not publish a tab update when the patch leaves tab state unchanged", () => {
        const model = RightBrowserModel.getInstance();
        const tab = model.getActiveTab();

        expect(tab).not.toBeNull();

        const stateBefore = model.getStateNow();
        const refBefore = model.getWebviewRef(tab!.id) as RefObject<WebviewTag>;

        model.patchTab(tab!.id, {
            domReady: tab!.domReady,
            isLoading: tab!.isLoading,
        });

        expect(model.getStateNow()).toBe(stateBefore);
        expect(model.getWebviewRef(tab!.id)).toBe(refBefore);
    });
});

describe("RightBrowser", () => {
    beforeEach(() => {
        RightBrowserModel.resetInstance();
    });

    it("renders the official Google page in a persistent webview for the default tab", () => {
        const markup = renderToStaticMarkup(<RightBrowser />);

        expect(markup).toContain('src="https://www.google.com"');
        expect(markup).toContain('partition="persist:crest-browser"');
        expect(markup).toContain("bg-background");
        expect(markup).not.toContain("Search Google");
        expect(markup).not.toContain("about:blank");
    });

    it("uses theme color tokens instead of fixed hex colors for browser chrome", () => {
        const model = RightBrowserModel.getInstance();
        const tab = model.getActiveTab();

        expect(tab).not.toBeNull();

        model.patchTab(tab!.id, {
            mediaPlaying: true,
        });

        const markup = renderToStaticMarkup(<RightBrowser />);

        expectNoHardcodedHexColors(markup);
        expectNoBackgroundTokensUsedAsText(markup);
        expect(markup).toContain("bg-panel");
        expect(markup).toContain("bg-fg-overlay");
        expect(markup).toContain("text-foreground");
        expect(markup).toContain("text-muted-foreground");
        expect(markup).toContain("border-border");
    });

    it("renders toolbar icons through the shared Icon component", () => {
        const markup = renderToStaticMarkup(<RightBrowser />);

        for (const title of ["Go Back", "Go Forward", "Reload", "Home", "Open in External Browser"]) {
            expect(markup).toMatch(new RegExp(`<button[^>]*title="${title}"[\\s\\S]*?<svg`));
        }
        expect(markup).not.toContain('<i class="text-[12px]');
    });

    it("uses the dedicated refresh icon for the reload action", () => {
        const markup = renderToStaticMarkup(<RightBrowser />);

        expect(markup).toMatch(/<button[^>]*title="Reload"[^>]*data-icon-name="refresh-01"/);
    });
});
