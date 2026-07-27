// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0
// @vitest-environment jsdom

import { act, cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { BlockWatermark, type WatermarkState } from "./block-watermark";

afterEach(() => {
    cleanup();
    vi.useRealTimers();
});

describe("BlockWatermark", () => {
    it("renders the original Crest terminal welcome", () => {
        render(<BlockWatermark subscribe={() => () => undefined} getState={() => "visible"} />);

        expect(document.querySelector('[data-icon-name="computer-terminal-02"]')).toBeTruthy();
        expect(screen.getByText("Run your first command")).toBeTruthy();
        expect(screen.getByText("Type below to start a terminal session.")).toBeTruthy();
        expect(screen.queryByText("Browse your command history")).toBeNull();
        expect(screen.queryByText("Autocomplete paths and commands")).toBeNull();
        expect(screen.queryByText("Switch between Shell and AI")).toBeNull();
        expect(screen.queryByText("Open the command palette")).toBeNull();
    });

    it("unmounts its content after the dead-state fade", () => {
        vi.useFakeTimers();
        let state: WatermarkState = "visible";
        const listeners = new Set<() => void>();

        render(
            <BlockWatermark
                subscribe={(listener) => {
                    listeners.add(listener);
                    return () => listeners.delete(listener);
                }}
                getState={() => state}
            />
        );

        act(() => {
            state = "dead";
            for (const listener of listeners) listener();
        });
        expect(screen.getByText("Run your first command")).toBeTruthy();

        act(() => vi.advanceTimersByTime(600));
        expect(screen.queryByText("Run your first command")).toBeNull();
    });
});
