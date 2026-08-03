// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0
// @vitest-environment jsdom

import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ContextPayload } from "./context-payload";

afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
});

function renderPayload(content: unknown) {
    return render(<ContextPayload itemId="source" panelId="payload" labelledBy="payload-label" content={content} />);
}

function renderedText(surface: HTMLElement): string {
    if (surface instanceof HTMLTextAreaElement) return surface.value;
    return surface.textContent ?? "";
}

describe("ContextPayload", () => {
    it("renders payloads in an inset rounded surface derived from the active theme", () => {
        renderPayload({ name: "read_file" });

        const region = screen.getByTestId("context-payload-source");

        expect(region.className).toContain("mx-3");
        expect(region.className).toContain("rounded-md");
        expect(region.className).toContain("bg-fg-overlay-1");
        expect(region.className).not.toContain("bg-slate-950");
    });

    it("preserves mixed line endings in one complete large plain-text surface", () => {
        const content = `first line\r\nsecond line\r${"x".repeat(1_048_576)}\r\nlast line`;

        renderPayload(content);

        const region = screen.getByTestId("context-payload-source");
        const surface = screen.getByTestId("context-payload-large-value");
        const textNode = surface.querySelector("code")?.firstChild;
        const tabStops = [region, ...region.querySelectorAll<HTMLElement>("[tabindex]")].filter(
            (element) => element.tabIndex >= 0
        );
        expect(renderedText(surface)).toBe(content);
        expect(surface.tagName).toBe("PRE");
        expect(tabStops.map((element) => element.dataset.testid)).toEqual(["context-payload-source"]);
        expect(region.className).toContain("overflow-auto");
        expect(surface.className).not.toContain("overflow-auto");
        expect(surface.className).not.toContain("max-h-");
        expect(surface.getAttribute("aria-label")).toBeNull();
        expect(textNode?.nodeType).toBe(Node.TEXT_NODE);
        expect(textNode?.textContent).toBe(content);
        expect(surface.querySelector("code")?.childNodes).toHaveLength(1);
        expect(screen.queryAllByTestId("context-payload-line-value")).toHaveLength(0);
        expect(screen.queryAllByTestId("context-json-token")).toHaveLength(0);
    });

    it("renders a JSON object with over ten thousand lines in one complete plain-text surface", () => {
        const content = {
            first: "beginning",
            lines: Array.from({ length: 10_001 }, (_, index) => `line ${index + 1}`),
            last: "ending",
        };
        const serialized = JSON.stringify(content, null, 2);

        renderPayload(content);

        const surface = screen.getByTestId("context-payload-large-value");
        const code = surface.querySelector("code");
        expect(code?.textContent).toBe(serialized);
        expect(code?.childNodes).toHaveLength(1);
        expect(code?.textContent).toContain('"first": "beginning"');
        expect(code?.textContent).toContain('"last": "ending"');
        expect(screen.queryAllByTestId("context-payload-line-number")).toHaveLength(0);
        expect(screen.queryAllByTestId("context-json-token")).toHaveLength(0);
    });

    it("keeps line numbers and safe syntax tones for small JSON payloads", () => {
        const content = { name: "read_file", enabled: true, count: 2 };

        renderPayload(content);

        const region = screen.getByTestId("context-payload-source");
        expect(region.tabIndex).toBe(0);
        expect(region.querySelectorAll("[tabindex]")).toHaveLength(0);
        expect(region.className).toContain("overflow-auto");
        expect(screen.queryByTestId("context-payload-large-value")).toBeNull();
        expect(screen.getAllByTestId("context-payload-line-number")).toHaveLength(5);
        expect(screen.getAllByTestId("context-json-token").length).toBeGreaterThan(0);
        expect(
            screen
                .getAllByTestId("context-payload-line-value")
                .map((element) => element.textContent ?? "")
                .join("\n")
        ).toBe(JSON.stringify(content, null, 2));
    });

    it("memoizes serialization while unrelated props rerender", () => {
        const content = { name: "read_file", enabled: true };
        const stringify = vi.spyOn(JSON, "stringify");
        const view = render(
            <ContextPayload itemId="source" panelId="payload-1" labelledBy="payload-label" content={content} />
        );

        view.rerender(
            <ContextPayload itemId="source" panelId="payload-2" labelledBy="payload-label" content={content} />
        );

        expect(stringify.mock.calls.filter(([value]) => value === content)).toHaveLength(1);
    });

    it.each([
        undefined,
        (() => {
            const circular: Record<string, unknown> = {};
            circular.self = circular;
            return circular;
        })(),
    ])("shows unavailable content for an unserializable value", (content) => {
        renderPayload(content);

        expect(screen.getByTestId("context-payload-line-value").textContent).toBe("Content unavailable.");
        expect(screen.queryByTestId("context-payload-large-value")).toBeNull();
    });
});
