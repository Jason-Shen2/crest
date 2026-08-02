// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0
// @vitest-environment jsdom

import { act, cleanup, render, screen } from "@testing-library/react";
import { useEffect } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { FileTopTab } from "./file-top-tab";

const editorProps = vi.hoisted(() => ({ current: null as any }));
const markdownFilePreviewProps = vi.hoisted(() => ({ current: null as any }));
const codeEditorLifecycleHarness = vi.hoisted(() => ({
    enabled: false,
    editors: [] as any[],
    cleanups: [] as Array<() => void>,
}));

vi.mock("@/app/view/codeeditor/codeeditor", () => ({
    CodeEditor: (props: any) => {
        editorProps.current = props;
        useEffect(() => {
            if (!codeEditorLifecycleHarness.enabled) {
                return;
            }
            const editor = codeEditorLifecycleHarness.editors.shift();
            if (editor == null) {
                return;
            }
            const cleanup = props.onMount(editor);
            codeEditorLifecycleHarness.cleanups.push(cleanup);
            return () => {
                cleanup();
                cleanup();
            };
        }, [props]);
        return <div>Monaco file editor</div>;
    },
}));

vi.mock("./markdown-file-preview", () => ({
    MarkdownFilePreview: (props: any) => {
        markdownFilePreviewProps.current = props;
        return <div data-testid="markdown-file-preview">{props.text}</div>;
    },
}));

function makeControlledRuntime(path: string, value: string) {
    const listeners = new Set<() => void>();
    let snapshot = { dirty: false, title: path.split("/").at(-1), status: "ready" };
    const runtime = {
        id: "file-1",
        path,
        value,
        readonly: false,
        get language() {
            return this.path.toLowerCase().endsWith(".md") ? "markdown" : "typescript";
        },
        model: { id: "model" },
        viewState: undefined,
        getSnapshot: () => snapshot,
        subscribe: vi.fn((listener: () => void) => {
            listeners.add(listener);
            return () => listeners.delete(listener);
        }),
        setValue: vi.fn((nextValue: string) => {
            runtime.value = nextValue;
            snapshot = { ...snapshot };
            listeners.forEach((listener) => listener());
        }),
        setPath(nextPath: string) {
            runtime.path = nextPath;
            snapshot = { ...snapshot, title: nextPath.split("/").at(-1) };
            listeners.forEach((listener) => listener());
        },
        attach: vi.fn(),
        detach: vi.fn(),
    };
    return runtime;
}

afterEach(() => {
    cleanup();
    editorProps.current = null;
    markdownFilePreviewProps.current = null;
    codeEditorLifecycleHarness.enabled = false;
    codeEditorLifecycleHarness.editors = [];
    codeEditorLifecycleHarness.cleanups = [];
});

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

    it("opens Markdown in preview, lets edits update the preview, and preserves the unsaved buffer", () => {
        const runtime = makeControlledRuntime("/repo/docs/README.md", "# Draft");
        render(<FileTopTab runtime={runtime as any} />);

        expect(screen.getByTestId("markdown-file-preview").textContent).toBe("# Draft");
        expect(markdownFilePreviewProps.current).toMatchObject({ path: "/repo/docs/README.md", text: "# Draft" });
        expect(screen.queryByText("Monaco file editor")).toBeNull();

        act(() => {
            screen.getByRole("button", { name: "Edit" }).click();
        });
        expect(screen.getByText("Monaco file editor")).toBeTruthy();

        act(() => {
            editorProps.current.onChange("# Edited");
        });
        act(() => {
            screen.getByRole("button", { name: "Preview" }).click();
        });

        expect(markdownFilePreviewProps.current).toMatchObject({ path: "/repo/docs/README.md", text: "# Edited" });
        expect(runtime.setValue).toHaveBeenCalledWith("# Edited");
    });

    it("resets its Markdown mode when the file path changes", async () => {
        const runtime = makeControlledRuntime("/repo/README.md", "# Draft");
        render(<FileTopTab runtime={runtime as any} />);

        act(() => {
            screen.getByRole("button", { name: "Edit" }).click();
        });
        expect(screen.getByText("Monaco file editor")).toBeTruthy();

        await act(async () => {
            runtime.setPath("/repo/README.ts");
        });
        expect(screen.getByText("Monaco file editor")).toBeTruthy();
        expect(screen.queryByRole("button", { name: "Preview" })).toBeNull();

        await act(async () => {
            runtime.setPath("/repo/README.MD");
        });
        expect(screen.getByTestId("markdown-file-preview")).toBeTruthy();
        expect(screen.queryByText("Monaco file editor")).toBeNull();
    });

    it("keeps editor mount cleanups isolated across Markdown view switches", () => {
        const firstEditor = {
            restoreViewState: vi.fn(),
            saveViewState: vi.fn(() => ({ cursorState: [] })),
        };
        const secondEditor = {
            restoreViewState: vi.fn(),
            saveViewState: vi.fn(() => ({ cursorState: [] })),
        };
        const runtime = makeControlledRuntime("/repo/README.md", "# Draft");
        (runtime as any).viewState = { cursorState: [{ position: { lineNumber: 2, column: 1 } }] };
        codeEditorLifecycleHarness.enabled = true;
        codeEditorLifecycleHarness.editors = [firstEditor, secondEditor];
        render(<FileTopTab runtime={runtime as any} />);

        act(() => {
            screen.getByRole("button", { name: "Edit" }).click();
        });
        expect(runtime.attach).toHaveBeenCalledWith(firstEditor);
        expect(firstEditor.restoreViewState).toHaveBeenCalledWith(runtime.viewState);

        act(() => {
            screen.getByRole("button", { name: "Preview" }).click();
        });
        expect(runtime.detach).toHaveBeenCalledTimes(1);

        act(() => {
            screen.getByRole("button", { name: "Edit" }).click();
        });
        expect(runtime.attach).toHaveBeenCalledWith(secondEditor);
        expect(secondEditor.restoreViewState).toHaveBeenCalledWith(runtime.viewState);

        act(() => {
            codeEditorLifecycleHarness.cleanups[0]();
        });
        expect(runtime.detach).toHaveBeenCalledTimes(1);

        act(() => {
            screen.getByRole("button", { name: "Preview" }).click();
        });
        expect(runtime.detach).toHaveBeenCalledTimes(2);
        expect(runtime.detach).toHaveBeenLastCalledWith(secondEditor);
    });

    it("keeps the runtime subscription stable while switching local Markdown views", () => {
        const runtime = makeControlledRuntime("/repo/README.md", "# Draft");
        render(<FileTopTab runtime={runtime as any} />);

        act(() => {
            screen.getByRole("button", { name: "Edit" }).click();
        });
        act(() => {
            screen.getByRole("button", { name: "Preview" }).click();
        });
        act(() => {
            screen.getByRole("button", { name: "Edit" }).click();
        });

        expect(runtime.subscribe).toHaveBeenCalledOnce();
    });
});
