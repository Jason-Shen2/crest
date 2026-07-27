// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0
// @vitest-environment jsdom

import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
import { renderToString } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { TopTabSurfaceFactories } from "./top-tab-runtime-host";
import { WorkspaceTopTabRuntimeRegistry, type TopTabRuntimeSnapshot } from "./top-tab-runtime-registry";
import { WorkspaceFileContentSlot } from "./workspace-file-content-slot";

const Tab = { id: "file-a", kind: "file" as const, path: "/repo/a.ts", title: "a.ts" };

function makeRuntime() {
    let snapshot: TopTabRuntimeSnapshot = { dirty: false, title: "a.ts", status: "loading" };
    const listeners = new Set<() => void>();
    return {
        runtime: {
            getSnapshot: () => snapshot,
            subscribe: (listener: () => void) => {
                listeners.add(listener);
                return () => listeners.delete(listener);
            },
            dispose: vi.fn(),
        },
        setStatus(status: TopTabRuntimeSnapshot["status"]) {
            snapshot = { ...snapshot, status };
            [...listeners].forEach((listener) => listener());
        },
    };
}

afterEach(cleanup);

describe("WorkspaceFileContentSlot", () => {
    it("renders File-owned loading without creating a runtime during static render", () => {
        const createRuntime = vi.fn();
        const factories = { renderFile: vi.fn() } as unknown as TopTabSurfaceFactories;

        const html = renderToString(
            <WorkspaceFileContentSlot
                active={true}
                tab={Tab}
                registry={new WorkspaceTopTabRuntimeRegistry()}
                createRuntime={createRuntime}
                factories={factories}
            />
        );

        expect(html).toContain("Loading a.ts");
        expect(createRuntime).not.toHaveBeenCalled();
        expect(factories.renderFile).not.toHaveBeenCalled();
    });

    it("keeps loading until runtime ready and then retains one content instance", async () => {
        const controlled = makeRuntime();
        const registry = new WorkspaceTopTabRuntimeRegistry();
        const createRuntime = vi.fn(() => controlled.runtime);
        const fileBody = vi.fn(() => <div data-testid="file-editor">editor</div>);
        const factories = { renderFile: fileBody } as unknown as TopTabSurfaceFactories;
        const view = render(
            <WorkspaceFileContentSlot
                active={true}
                tab={Tab}
                registry={registry}
                createRuntime={createRuntime}
                factories={factories}
            />
        );

        expect(screen.getByRole("status").textContent).toBe("Loading a.ts");
        expect(fileBody).not.toHaveBeenCalled();

        act(() => controlled.setStatus("ready"));
        expect(await screen.findByTestId("file-editor")).toBeTruthy();
        expect(fileBody).toHaveBeenCalledTimes(1);
        const editor = screen.getByTestId("file-editor");

        view.rerender(
            <WorkspaceFileContentSlot
                active={false}
                tab={Tab}
                registry={registry}
                createRuntime={createRuntime}
                factories={factories}
            />
        );
        expect(screen.getByTestId("file-editor")).toBe(editor);
    });

    it("returns to loading when the registry owner changes for the same File tab", async () => {
        const controlledA = makeRuntime();
        const controlledB = makeRuntime();
        const registryA = new WorkspaceTopTabRuntimeRegistry();
        const registryB = new WorkspaceTopTabRuntimeRegistry();
        const createRuntimeA = vi.fn(() => controlledA.runtime);
        const createRuntimeB = vi.fn(() => controlledB.runtime);
        const fileBody = vi.fn(() => <div data-testid="file-editor">editor</div>);
        const factories = { renderFile: fileBody } as unknown as TopTabSurfaceFactories;
        const view = render(
            <WorkspaceFileContentSlot
                active={true}
                tab={Tab}
                registry={registryA}
                createRuntime={createRuntimeA}
                factories={factories}
            />
        );

        act(() => controlledA.setStatus("ready"));
        expect(await screen.findByTestId("file-editor")).toBeTruthy();
        expect(fileBody).toHaveBeenCalledTimes(1);

        view.rerender(
            <WorkspaceFileContentSlot
                active={true}
                tab={Tab}
                registry={registryB}
                createRuntime={createRuntimeB}
                factories={factories}
            />
        );

        expect(screen.getByRole("status").textContent).toBe("Loading a.ts");
        expect(screen.queryByTestId("file-editor")).toBeNull();
        expect(fileBody).toHaveBeenCalledTimes(1);

        await waitFor(() => expect(createRuntimeB).toHaveBeenCalledTimes(1));
        expect(screen.getByRole("status").textContent).toBe("Loading a.ts");
        expect(fileBody).toHaveBeenCalledTimes(1);
    });
});
