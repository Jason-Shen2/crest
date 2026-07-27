// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0
// @vitest-environment jsdom

import { act, cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { FileTopTab } from "./file-top-tab";

const editorProps = vi.hoisted(() => ({ current: null as any }));

vi.mock("@/app/view/codeeditor/codeeditor", () => ({
    CodeEditor: (props: any) => {
        editorProps.current = props;
        return <div>Monaco file editor</div>;
    },
}));

afterEach(cleanup);

describe("FileTopTab", () => {
    it("shows a read failure with retry, close, and locate actions instead of an empty editor", () => {
        const snapshot = {
            dirty: false,
            title: "missing.ts",
            status: "error",
            operation: "idle",
            error: "file not found",
        };
        const runtime = {
            path: "/repo/missing.ts",
            getSnapshot: () => snapshot,
            subscribe: () => () => {},
            reload: vi.fn(),
        } as any;
        const onClose = vi.fn();
        const onLocate = vi.fn();

        render(<FileTopTab runtime={runtime} onClose={onClose} onLocate={onLocate} />);

        expect(screen.getByRole("alert").textContent).toContain("file not found");
        expect(screen.queryByText("Monaco file editor")).toBeNull();
        screen.getByRole("button", { name: "Retry" }).click();
        screen.getByRole("button", { name: "Close" }).click();
        screen.getByRole("button", { name: "Locate" }).click();
        expect(runtime.reload).toHaveBeenCalledOnce();
        expect(onClose).toHaveBeenCalledOnce();
        expect(onLocate).toHaveBeenCalledOnce();
    });

    it("attaches the existing model, restores view state, and only detaches on unmount", () => {
        const editor = {
            restoreViewState: vi.fn(),
            saveViewState: vi.fn(() => ({ cursorState: [] })),
        };
        const runtimeSnapshot = { dirty: false, title: "a.ts", status: "ready" };
        const runtime = {
            value: "buffer",
            readonly: false,
            get language() {
                return this.path.endsWith(".py") ? "python" : "typescript";
            },
            path: "/repo/a.ts",
            model: { id: "model" },
            viewState: { cursorState: [{ position: { lineNumber: 2, column: 1 } }] },
            getSnapshot: () => runtimeSnapshot,
            subscribe: () => () => {},
            setValue: vi.fn(),
            attach: vi.fn(),
            detach: vi.fn(),
        } as any;
        const view = render(<FileTopTab runtime={runtime} />);

        expect(screen.getByText("Monaco file editor")).toBeTruthy();
        const unmount = editorProps.current.onMount(editor);
        expect(runtime.attach).toHaveBeenCalledWith(editor);
        expect(editor.restoreViewState).toHaveBeenCalledWith(runtime.viewState);
        editorProps.current.onChange("edited");
        expect(runtime.setValue).toHaveBeenCalledWith("edited");

        unmount();
        view.unmount();
        expect(runtime.detach).toHaveBeenCalledWith(editor);
    });

    it("rerenders current runtime state after async read and model migration without remounting", () => {
        const listeners = new Set<() => void>();
        const firstModel = { id: "first" };
        const secondModel = { id: "second" };
        let snapshot = { dirty: false, title: "a.ts", status: "loading" };
        const runtime = {
            id: "file-1",
            value: "",
            readonly: false,
            get language() {
                return this.path.endsWith(".py") ? "python" : "typescript";
            },
            path: "/repo/a.ts",
            model: firstModel,
            viewState: undefined,
            getSnapshot: () => snapshot,
            subscribe: (listener: () => void) => {
                listeners.add(listener);
                return () => listeners.delete(listener);
            },
            setValue: vi.fn(),
            attach: vi.fn(),
            detach: vi.fn(),
        } as any;
        render(<FileTopTab runtime={runtime} />);
        const editor = {
            restoreViewState: vi.fn(),
            saveViewState: vi.fn(() => ({ cursorState: [] })),
        };
        editorProps.current.onMount(editor);

        expect(editorProps.current.model).toBe(firstModel);
        act(() => {
            runtime.value = "loaded";
            runtime.readonly = true;
            snapshot = { ...snapshot, status: "ready" };
            listeners.forEach((listener) => listener());
        });
        expect(editorProps.current.text).toBe("loaded");
        expect(editorProps.current.readonly).toBe(true);

        act(() => {
            runtime.path = "/repo/b.py";
            runtime.model = secondModel;
            snapshot = { ...snapshot, title: "b.py" };
            listeners.forEach((listener) => listener());
        });
        expect(editorProps.current.model).toBe(secondModel);
        expect(editorProps.current.fileName).toBe("/repo/b.py");
        expect(editorProps.current.language).toBe("python");
        expect(runtime.detach).toHaveBeenCalledWith(editor);
        expect(runtime.attach).toHaveBeenCalledTimes(2);
    });
});
