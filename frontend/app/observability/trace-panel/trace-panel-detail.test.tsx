// Copyright (c) 2023-2026 Langfuse GmbH
// SPDX-License-Identifier: MIT

// @vitest-environment jsdom

import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { serializeDetailValue } from "./detail-value";
import { IOPreview } from "./io-preview";

afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
});

function deferred<T>() {
    let resolve!: (value: T) => void;
    let reject!: (reason: unknown) => void;
    const promise = new Promise<T>((resolvePromise, rejectPromise) => {
        resolve = resolvePromise;
        reject = rejectPromise;
    });
    return { promise, resolve, reject };
}

describe("IOPreview", () => {
    it("does not render a section for a null value", () => {
        render(<IOPreview label="Output" value={null} />);

        expect(screen.queryByRole("region", { name: "Output" })).toBeNull();
    });

    it("bounds the preview but copies the complete value", async () => {
        const writeText = vi.fn().mockResolvedValue(undefined);
        vi.stubGlobal("navigator", { clipboard: { writeText } });
        const value = { output: "x".repeat(20_000) };
        render(<IOPreview label="Output" value={value} />);

        const section = screen.getByRole("region", { name: "Output" });
        expect(within(section).getByTestId("detail-value-preview").textContent?.length).toBeLessThanOrEqual(10_001);
        expect(within(section).getByText("Preview truncated")).not.toBeNull();

        fireEvent.click(within(section).getByRole("button", { name: "Copy Output" }));
        expect(writeText).toHaveBeenCalledWith(serializeDetailValue(value));
        expect(await within(section).findByText("Copied")).not.toBeNull();
    });

    it("reports clipboard failure", async () => {
        vi.stubGlobal("navigator", {
            clipboard: { writeText: vi.fn().mockRejectedValue(new Error("denied")) },
        });
        render(<IOPreview label="Output" value={{ ok: true }} />);

        fireEvent.click(screen.getByRole("button", { name: "Copy Output" }));

        expect(await screen.findByText("Copy failed")).not.toBeNull();
    });

    it("reports an unavailable clipboard API as a failure", async () => {
        vi.stubGlobal("navigator", {});
        render(<IOPreview label="Output" value={{ ok: true }} />);

        fireEvent.click(screen.getByRole("button", { name: "Copy Output" }));

        expect(await screen.findByText("Copy failed")).not.toBeNull();
    });

    it("ignores an old copy success after the value changes", async () => {
        const oldCopy = deferred<void>();
        const writeText = vi.fn().mockReturnValueOnce(oldCopy.promise).mockResolvedValueOnce(undefined);
        vi.stubGlobal("navigator", { clipboard: { writeText } });
        const view = render(<IOPreview label="Output" value={{ version: "old" }} />);

        fireEvent.click(screen.getByRole("button", { name: "Copy Output" }));
        view.rerender(<IOPreview label="Output" value={{ version: "new" }} />);
        await act(() => oldCopy.resolve());

        expect(screen.queryByText("Copied")).toBeNull();

        fireEvent.click(screen.getByRole("button", { name: "Copy Output" }));
        expect(await screen.findByText("Copied")).not.toBeNull();
    });

    it("ignores an old copy success after switching to an equivalent value", async () => {
        const oldCopy = deferred<void>();
        const writeText = vi.fn().mockReturnValueOnce(oldCopy.promise);
        vi.stubGlobal("navigator", { clipboard: { writeText } });
        const view = render(<IOPreview label="Output" value={{ result: "same" }} />);

        fireEvent.click(screen.getByRole("button", { name: "Copy Output" }));
        view.rerender(<IOPreview label="Output" value={{ result: "same" }} />);
        await act(() => oldCopy.resolve());

        expect(screen.queryByText("Copied")).toBeNull();
    });

    it("ignores an old copy success after the selection changes with the same string value", async () => {
        const oldCopy = deferred<void>();
        const writeText = vi.fn().mockReturnValueOnce(oldCopy.promise);
        vi.stubGlobal("navigator", { clipboard: { writeText } });
        const view = render(<IOPreview label="Output" value="same" copyScopeKey="observation-old" />);

        fireEvent.click(screen.getByRole("button", { name: "Copy Output" }));
        view.rerender(<IOPreview label="Output" value="same" copyScopeKey="observation-new" />);
        await act(() => oldCopy.resolve());

        expect(screen.queryByText("Copied")).toBeNull();
    });

    it("ignores an old copy failure after the value changes", async () => {
        const oldCopy = deferred<void>();
        const writeText = vi.fn().mockReturnValueOnce(oldCopy.promise).mockResolvedValueOnce(undefined);
        vi.stubGlobal("navigator", { clipboard: { writeText } });
        const view = render(<IOPreview label="Output" value={{ version: "old" }} />);

        fireEvent.click(screen.getByRole("button", { name: "Copy Output" }));
        view.rerender(<IOPreview label="Output" value={{ version: "new" }} />);
        await act(() => oldCopy.reject(new Error("denied")));

        expect(screen.queryByText("Copy failed")).toBeNull();
    });

    it("does not expose media or comments controls", () => {
        render(<IOPreview label="Output" value={{ ok: true }} />);

        expect(screen.queryByText(/media/i)).toBeNull();
        expect(screen.queryByText(/comment/i)).toBeNull();
    });
});
