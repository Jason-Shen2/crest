// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0
// @vitest-environment jsdom

import { act, createRef } from "react";
import { createRoot, type Root } from "react-dom/client";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it } from "vitest";

import type { PiExtUiState } from "@/app/store/use-pi-chat";
import {
    AgentExtUiPanel,
    keyDataForWidgetTerminal,
    notifyCustomWidgetCancel,
    widgetCancelEvent,
    widgetInputCancelEvent,
    widgetInputChangeEvent,
    widgetInputRendererSyncKey,
    widgetInputSubmitEvent,
    widgetKeyEvent,
    widgetSelectEvent,
} from "./agent-ext-ui";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

type RenderedAgentExtUiPanel = {
    container: HTMLDivElement;
    rerender: (extUi: PiExtUiState) => void;
    unmount: () => void;
};

const MountedPanels: RenderedAgentExtUiPanel[] = [];

function renderAgentExtUiPanel(
    extUi: PiExtUiState,
    respondWidgetEvent: (event: AgentWidgetEvent) => void = () => {}
): RenderedAgentExtUiPanel {
    const container = document.createElement("div");
    document.body.appendChild(container);
    const root: Root = createRoot(container);
    const render = (nextExtUi: PiExtUiState) => {
        act(() => {
            root.render(
                <AgentExtUiPanel
                    extUi={nextExtUi}
                    respondExtUi={() => {}}
                    respondWidgetEvent={respondWidgetEvent}
                    anchorRef={createRef<HTMLElement>()}
                />
            );
        });
    };
    render(extUi);
    const rendered = {
        container,
        rerender: render,
        unmount: () => {
            act(() => {
                root.unmount();
            });
            container.remove();
        },
    };
    MountedPanels.push(rendered);
    return rendered;
}

function clickElement(element: Element): void {
    act(() => {
        element.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
    });
}

function keyDownElement(element: Element, key: string): void {
    act(() => {
        element.dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true }));
    });
}

function changeInput(input: HTMLInputElement, value: string): void {
    const valueSetter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set;
    act(() => {
        valueSetter?.call(input, value);
        input.dispatchEvent(new Event("input", { bubbles: true, cancelable: true }));
    });
}

function changeTextArea(textarea: HTMLTextAreaElement, value: string): void {
    const valueSetter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")?.set;
    act(() => {
        valueSetter?.call(textarea, value);
        textarea.dispatchEvent(new Event("input", { bubbles: true, cancelable: true }));
    });
}

afterEach(() => {
    for (const mounted of MountedPanels.splice(0)) {
        mounted.unmount();
    }
});

describe("AgentExtUiPanel", () => {
    it("renders custom pi-gui widget requests as native GUI", () => {
        const extUi: PiExtUiState = {
            statuses: {},
            widgets: {},
            widgetnodes: {},
            renderedEntries: [],
            request: {
                requestId: "r1",
                kind: "custom",
                widget: {
                    kind: "text",
                    id: "w1",
                    text: "native gui",
                    paddingx: 0,
                    paddingy: 0,
                },
                options: { anchor: "center" },
            } as any,
        };

        const html = renderToStaticMarkup(
            <AgentExtUiPanel extUi={extUi} respondExtUi={() => {}} anchorRef={createRef<HTMLElement>()} />
        );

        expect(html).toContain("native gui");
    });

    it("renders persistent semantic widget slots", () => {
        const extUi: PiExtUiState = {
            statuses: {},
            widgets: {},
            widgetnodes: {
                summary: {
                    kind: "text",
                    id: "w1",
                    text: "semantic widget",
                    paddingx: 0,
                    paddingy: 0,
                },
            },
            renderedEntries: [],
            header: {
                kind: "text",
                id: "h1",
                text: "header gui",
                paddingx: 0,
                paddingy: 0,
            },
            footer: {
                kind: "text",
                id: "f1",
                text: "footer gui",
                paddingx: 0,
                paddingy: 0,
            },
            request: null,
        };

        const html = renderToStaticMarkup(
            <AgentExtUiPanel extUi={extUi} respondExtUi={() => {}} anchorRef={createRef<HTMLElement>()} />
        );

        expect(html).toContain("header gui");
        expect(html).toContain("semantic widget");
        expect(html).toContain("footer gui");
    });

    it("renders extension-rendered session entries", () => {
        const extUi: PiExtUiState = {
            statuses: {},
            widgets: {},
            widgetnodes: {},
            renderedEntries: [
                {
                    id: "entry-1",
                    customtype: "checkpoint",
                    source: "entry",
                    widget: {
                        kind: "text",
                        id: "entry-widget",
                        text: "rendered session entry",
                        paddingx: 0,
                        paddingy: 0,
                    },
                },
            ],
            request: null,
        };

        const html = renderToStaticMarkup(
            <AgentExtUiPanel extUi={extUi} respondExtUi={() => {}} anchorRef={createRef<HTMLElement>()} />
        );

        expect(html).toContain("rendered session entry");
    });

    it("renders a cancel affordance for selectlist widgets", () => {
        const extUi: PiExtUiState = {
            statuses: {},
            widgets: {},
            widgetnodes: {},
            renderedEntries: [],
            request: {
                requestId: "r1",
                kind: "custom",
                widget: {
                    kind: "selectlist",
                    id: "list-1",
                    items: [{ value: "a", label: "Alpha" }],
                    selectedindex: 0,
                    maxvisible: 5,
                    focused: true,
                },
            } as any,
        };

        const html = renderToStaticMarkup(
            <AgentExtUiPanel extUi={extUi} respondExtUi={() => {}} anchorRef={createRef<HTMLElement>()} />
        );

        expect(html).toContain("Alpha");
        expect(html).toContain("Cancel");
    });

    it("handles selectlist click, keyboard, cancel, and rerendered selection feedback through React DOM", () => {
        const extUi: PiExtUiState = {
            statuses: {},
            widgets: {},
            widgetnodes: {
                list: {
                    kind: "selectlist",
                    id: "list-1",
                    items: [
                        { value: "a", label: "Alpha", description: "first option" },
                        { value: "b", label: "Beta" },
                    ],
                    selectedindex: 0,
                    maxvisible: 5,
                    focused: true,
                } as any,
            },
            renderedEntries: [],
            request: null,
        };
        const events: AgentWidgetEvent[] = [];
        const { container, rerender } = renderAgentExtUiPanel(extUi, (event) => events.push(event));

        const listbox = container.querySelector('[role="listbox"]') as HTMLElement;
        const alpha = container.querySelector("#list-1-option-0") as HTMLElement;
        const beta = container.querySelector("#list-1-option-1") as HTMLElement;

        expect(listbox).toBeTruthy();
        expect(listbox.tabIndex).toBe(0);
        expect(listbox.getAttribute("aria-activedescendant")).toBe("list-1-option-0");
        expect(alpha.tagName).not.toBe("BUTTON");
        expect(beta.tagName).not.toBe("BUTTON");
        expect(alpha.getAttribute("role")).toBe("option");
        expect(beta.getAttribute("role")).toBe("option");
        expect(alpha.getAttribute("tabindex")).toBeNull();
        expect(beta.getAttribute("tabindex")).toBeNull();
        expect(alpha.getAttribute("aria-selected")).toBe("true");
        expect(beta.getAttribute("aria-selected")).toBe("false");

        clickElement(beta);
        keyDownElement(listbox, "ArrowDown");
        keyDownElement(listbox, "Enter");
        keyDownElement(listbox, "Escape");
        clickElement(
            Array.from(container.querySelectorAll("button")).find(
                (button) => button.textContent === "Cancel"
            ) as HTMLElement
        );

        expect(events).toEqual([
            widgetSelectEvent("list-1", 1),
            widgetKeyEvent("list-1", "\x1b[B"),
            widgetKeyEvent("list-1", "\n"),
            widgetKeyEvent("list-1", "\x1b"),
            widgetCancelEvent("list-1"),
        ]);

        rerender({
            ...extUi,
            widgetnodes: {
                list: {
                    ...(extUi.widgetnodes.list as any),
                    selectedindex: 1,
                } as any,
            },
        });

        expect(listbox.getAttribute("aria-activedescendant")).toBe("list-1-option-1");
        expect(alpha.getAttribute("aria-selected")).toBe("false");
        expect(beta.getAttribute("aria-selected")).toBe("true");
    });

    it("handles input change, Enter submit, Escape cancel, button submit, button cancel, and rerender sync through React DOM", () => {
        const extUi: PiExtUiState = {
            statuses: {},
            widgets: {},
            widgetnodes: {
                input: {
                    kind: "input",
                    id: "input-1",
                    value: "draft",
                    cursor: 5,
                    focused: true,
                } as any,
            },
            renderedEntries: [],
            request: null,
        };
        const events: AgentWidgetEvent[] = [];
        const { container, rerender } = renderAgentExtUiPanel(extUi, (event) => events.push(event));

        const input = container.querySelector('[role="textbox"]') as HTMLInputElement;
        const buttons = Array.from(container.querySelectorAll("button"));
        const cancelButton = buttons.find((button) => button.textContent === "Cancel") as HTMLButtonElement;
        const submitButton = buttons.find((button) => button.textContent === "Submit") as HTMLButtonElement;

        expect(input).toBeTruthy();
        expect(input.value).toBe("draft");

        changeInput(input, "final");
        keyDownElement(input, "Enter");
        keyDownElement(input, "Escape");
        clickElement(submitButton);
        clickElement(cancelButton);

        expect(input.value).toBe("final");
        expect(events).toEqual([
            widgetInputChangeEvent("input-1", "final"),
            widgetInputSubmitEvent("input-1"),
            widgetInputCancelEvent("input-1"),
            widgetInputSubmitEvent("input-1"),
            widgetInputCancelEvent("input-1"),
        ]);

        rerender({
            ...extUi,
            widgetnodes: {
                input: {
                    ...(extUi.widgetnodes.input as any),
                    value: "server value",
                } as any,
            },
        });

        expect((container.querySelector('[role="textbox"]') as HTMLInputElement).value).toBe("server value");
    });

    it("handles SettingsList immediate value changes, activate, cancel, keyboard, and rerendered value feedback through React DOM", () => {
        const extUi: PiExtUiState = {
            statuses: {},
            widgets: {},
            widgetnodes: {
                settings: {
                    kind: "settingslist",
                    id: "settings-1",
                    items: [
                        {
                            id: "mode",
                            label: "Mode",
                            description: "Execution mode",
                            currentvalue: "fast",
                            values: ["fast", "safe"],
                        },
                        {
                            id: "theme",
                            label: "Theme",
                            currentvalue: "dark",
                            values: ["dark", "light"],
                        },
                    ],
                    selectedindex: 0,
                    maxvisible: 5,
                } as any,
            },
            renderedEntries: [],
            request: null,
        };
        const events: AgentWidgetEvent[] = [];
        const { container, rerender } = renderAgentExtUiPanel(extUi, (event) => events.push(event));

        const listbox = container.querySelector('[role="listbox"][aria-label="Settings list settings-1"]') as HTMLElement;
        const themeOption = container.querySelector("#settings-1-option-1") as HTMLElement;
        const modeOption = container.querySelector("#settings-1-option-0") as HTMLElement;

        expect(listbox).toBeTruthy();
        expect(listbox.getAttribute("tabindex")).toBe("0");
        expect(listbox.getAttribute("aria-activedescendant")).toBe("settings-1-option-0");
        expect(modeOption.querySelector("button")).toBeNull();
        expect(themeOption.getAttribute("aria-selected")).toBe("false");
        expect(themeOption.querySelector("button")).toBeNull();

        clickElement(themeOption);
        keyDownElement(listbox, "ArrowRight");
        keyDownElement(listbox, "ArrowLeft");
        keyDownElement(listbox, "ArrowDown");
        keyDownElement(listbox, "Enter");
        keyDownElement(listbox, "Escape");

        expect(events).toEqual([
            { nodeid: "settings-1", type: "select", payload: { index: 1 } },
            { nodeid: "settings-1", type: "change", payload: { id: "theme", value: "light" } },
            { nodeid: "settings-1", type: "change", payload: { id: "theme", value: "light" } },
            widgetKeyEvent("settings-1", "\x1b[B"),
            { nodeid: "settings-1", type: "submit" },
            widgetCancelEvent("settings-1"),
        ]);

        rerender({
            ...extUi,
            widgetnodes: {
                settings: {
                    ...(extUi.widgetnodes.settings as any),
                    selectedindex: 1,
                    items: [
                        {
                            id: "mode",
                            label: "Mode",
                            description: "Execution mode",
                            currentvalue: "safe",
                            values: ["fast", "safe"],
                        },
                        {
                            id: "theme",
                            label: "Theme",
                            currentvalue: "light",
                            values: ["dark", "light"],
                        },
                    ],
                } as any,
            },
        });

        expect(listbox.getAttribute("aria-activedescendant")).toBe("settings-1-option-1");
        expect(themeOption.getAttribute("aria-selected")).toBe("true");
        expect(container.textContent).toContain("safe");
        expect(container.textContent).toContain("light");
    });

    it("handles Editor editing, keyboard input, submit, cancel, and rerender sync through React DOM", () => {
        const extUi: PiExtUiState = {
            statuses: {},
            widgets: {},
            widgetnodes: {
                editor: {
                    kind: "editor",
                    id: "editor-1",
                    value: "draft text",
                    lines: ["draft text"],
                    cursorline: 0,
                    cursorcol: 5,
                    focused: true,
                    paddingx: 1,
                } as any,
            },
            renderedEntries: [],
            request: null,
        };
        const events: AgentWidgetEvent[] = [];
        const { container, rerender } = renderAgentExtUiPanel(extUi, (event) => events.push(event));

        const editor = container.querySelector('textarea[aria-label="Editor editor-1"]') as HTMLTextAreaElement;
        const save = Array.from(container.querySelectorAll("button")).find((button) => button.textContent === "Save") as HTMLButtonElement;
        const cancel = Array.from(container.querySelectorAll("button")).find((button) => button.textContent === "Cancel") as HTMLButtonElement;

        expect(editor).toBeTruthy();
        expect(editor.value).toBe("draft text");
        expect(editor.style.paddingInline).toBe("8px");

        changeTextArea(editor, "final text");
        keyDownElement(editor, "ArrowLeft");
        clickElement(save);
        clickElement(cancel);

        expect(events).toEqual([
            { nodeid: "editor-1", type: "change", payload: { value: "final text" } },
            widgetKeyEvent("editor-1", "\x1b[D"),
            { nodeid: "editor-1", type: "submit" },
            widgetCancelEvent("editor-1"),
        ]);

        rerender({
            ...extUi,
            widgetnodes: {
                editor: {
                    ...(extUi.widgetnodes.editor as any),
                    value: "server text",
                    lines: ["server text"],
                } as any,
            },
        });

        expect((container.querySelector('textarea[aria-label="Editor editor-1"]') as HTMLTextAreaElement).value).toBe(
            "server text"
        );
    });

    it("renders Loader state and dispatches CancellableLoader cancellation through React DOM", () => {
        const extUi: PiExtUiState = {
            statuses: {},
            widgets: {},
            widgetnodes: {
                loader: {
                    kind: "loader",
                    id: "loader-1",
                    label: "Working",
                    frame: "*",
                    cancellable: false,
                    aborted: false,
                } as any,
                cancellable: {
                    kind: "loader",
                    id: "loader-2",
                    label: "Abortable",
                    frame: "!",
                    cancellable: true,
                    aborted: true,
                } as any,
            },
            renderedEntries: [],
            request: null,
        };
        const events: AgentWidgetEvent[] = [];
        const { container } = renderAgentExtUiPanel(extUi, (event) => events.push(event));

        const loader = container.querySelector('[data-agent-widget-id="loader-1"]') as HTMLElement;
        const cancellable = container.querySelector('[data-agent-widget-id="loader-2"]') as HTMLElement;
        const cancelButton = cancellable.querySelector("button") as HTMLButtonElement;

        expect(loader.textContent).toContain("Working");
        expect(loader.querySelector("button")).toBeNull();
        expect(cancellable.textContent).toContain("Abortable");
        expect(cancellable.textContent).toContain("Cancelled");

        clickElement(cancelButton);

        expect(events).toEqual([widgetCancelEvent("loader-2")]);
    });

    it("renders markdown widgets as semantic markdown instead of plain text", () => {
        const extUi: PiExtUiState = {
            statuses: {},
            widgets: {},
            widgetnodes: {},
            renderedEntries: [],
            request: {
                requestId: "r1",
                kind: "custom",
                widget: {
                    kind: "markdown",
                    id: "markdown-1",
                    source: "# Markdown\n\n- rendered as GUI\n\n`code`",
                    paddingx: 0,
                    paddingy: 0,
                },
            } as any,
        };

        const { container } = renderAgentExtUiPanel(extUi);
        const markdown = container.querySelector('[data-agent-widget-kind="markdown"]') as HTMLElement;

        expect(markdown.querySelector(".heading.is-1")?.textContent).toBe("Markdown");
        expect(markdown.querySelector("ul")).toBeTruthy();
        expect(markdown.querySelector("code")?.textContent).toBe("code");
        expect(markdown.textContent).not.toContain("# Markdown");
    });

    it("renders markdown GFM tables, task lists, strikethrough, and links through the shared Markdown surface", () => {
        const extUi: PiExtUiState = {
            statuses: {},
            widgets: {},
            widgetnodes: {
                markdown: {
                    kind: "markdown",
                    id: "markdown-gfm",
                    source: [
                        "| Feature | Status |",
                        "| --- | --- |",
                        "| GFM | ~~missing~~ ready |",
                        "",
                        "- [x] task complete",
                        "",
                        "[https://example.com](https://example.com)",
                    ].join("\n"),
                    paddingx: 0,
                    paddingy: 0,
                },
            },
            renderedEntries: [],
            request: null,
        };
        const { container } = renderAgentExtUiPanel(extUi);
        const markdown = container.querySelector('[data-agent-widget-kind="markdown"]') as HTMLElement;

        expect(markdown).toBeTruthy();
        expect(markdown.querySelector(".agent-ext-markdown.markdown")).toBeTruthy();
        expect(markdown.querySelector("table")).toBeTruthy();
        expect(markdown.querySelector("th")?.textContent).toBe("Feature");
        expect(markdown.querySelector("td")?.textContent).toBe("GFM");
        expect(markdown.querySelector("del")?.textContent).toBe("missing");
        expect(markdown.querySelector("input[type='checkbox']")).toMatchObject({ checked: true, disabled: true });
        expect(markdown.querySelector("a[href='https://example.com']")?.textContent).toBe("https://example.com");
    });

    it("honors Box padding and lays out children as a vertical GUI container", () => {
        const extUi: PiExtUiState = {
            statuses: {},
            widgets: {},
            widgetnodes: {
                box: {
                    kind: "box",
                    id: "box-padding",
                    paddingx: 3,
                    paddingy: 2,
                    children: [
                        {
                            kind: "text",
                            id: "box-child",
                            text: "inside box",
                            paddingx: 0,
                            paddingy: 0,
                        },
                    ],
                },
            },
            renderedEntries: [],
            request: null,
        };
        const { container } = renderAgentExtUiPanel(extUi);
        const box = container.querySelector('[data-agent-widget-kind="box"]') as HTMLElement;

        expect(box).toBeTruthy();
        expect(box.style.paddingInline).toBe("24px");
        expect(box.style.paddingBlock).toBe("16px");
        expect(box.className).toContain("flex");
        expect(box.className).toContain("flex-col");
        expect(box.textContent).toContain("inside box");
    });

    it("clamps Box and child padding to finite safe values", () => {
        const extUi: PiExtUiState = {
            statuses: {},
            widgets: {},
            widgetnodes: {
                box: {
                    kind: "box",
                    id: "box-padding-clamp",
                    paddingx: Number.NEGATIVE_INFINITY,
                    paddingy: Number.POSITIVE_INFINITY,
                    children: [
                        {
                            kind: "text",
                            id: "huge-padding-child",
                            text: "safe padding",
                            paddingx: 10_000,
                            paddingy: -4,
                        },
                    ],
                },
            },
            renderedEntries: [],
            request: null,
        };
        const { container } = renderAgentExtUiPanel(extUi);
        const box = container.querySelector('[data-agent-widget-kind="box"]') as HTMLElement;
        const text = container.querySelector('[data-agent-widget-kind="text"]') as HTMLElement;

        expect(box.style.paddingInline).toBe("0px");
        expect(box.style.paddingBlock).toBe("0px");
        expect(text.style.paddingInline).toBe("512px");
        expect(text.style.paddingBlock).toBe("0px");
    });

    it("renders extended pi-gui widget nodes", () => {
        const extUi: PiExtUiState = {
            statuses: {},
            widgets: {},
            widgetnodes: {
                editor: {
                    kind: "editor",
                    id: "editor-1",
                    value: "draft text",
                    lines: ["draft text"],
                    cursorline: 0,
                    cursorcol: 5,
                    focused: true,
                    paddingx: 1,
                } as any,
                image: {
                    kind: "image",
                    id: "image-1",
                    src: "data:image/png;base64,aGVsbG8=",
                    mimetype: "image/png",
                    filename: "hello.png",
                    widthpx: 10,
                    heightpx: 5,
                } as any,
                loader: {
                    kind: "loader",
                    id: "loader-1",
                    label: "Working",
                    frame: "*",
                    cancellable: true,
                    aborted: false,
                } as any,
                truncated: {
                    kind: "truncatedtext",
                    id: "truncated-1",
                    text: "very long text",
                    paddingx: 0,
                    paddingy: 0,
                } as any,
            },
            renderedEntries: [],
            request: null,
        };

        const html = renderToStaticMarkup(
            <AgentExtUiPanel extUi={extUi} respondExtUi={() => {}} anchorRef={createRef<HTMLElement>()} />
        );

        expect(html).toContain("draft text");
        expect(html).toContain("hello.png");
        expect(html).toContain("Working");
        expect(html).toContain("Cancel");
        expect(html).toContain("very long text");
    });

    it("builds selectlist widget events for renderer clicks", () => {
        expect(widgetSelectEvent("list-1", 2)).toEqual({
            nodeid: "list-1",
            type: "select",
            payload: { index: 2 },
        });
    });

    it("builds input widget events for renderer input interactions", () => {
        expect(widgetInputChangeEvent("input-1", "draft")).toEqual({
            nodeid: "input-1",
            type: "change",
            payload: { value: "draft" },
        });
        expect(widgetInputSubmitEvent("input-1")).toEqual({
            nodeid: "input-1",
            type: "submit",
        });
        expect(widgetInputCancelEvent("input-1")).toEqual({
            nodeid: "input-1",
            type: "cancel",
        });
    });

    it("builds input renderer sync keys from both widget id and value", () => {
        expect(widgetInputRendererSyncKey("input-1", "draft")).toBe("input-1:draft");
        expect(widgetInputRendererSyncKey("input-1", "draft")).not.toBe(widgetInputRendererSyncKey("input-2", "draft"));
        expect(widgetInputRendererSyncKey("input-1", "draft")).not.toBe(widgetInputRendererSyncKey("input-1", "final"));
    });

    it("builds generic widget cancel events for custom dismissals", () => {
        expect(widgetCancelEvent("widget-1")).toEqual({
            nodeid: "widget-1",
            type: "cancel",
        });
    });

    it("builds terminal fallback key events", () => {
        expect(widgetKeyEvent("terminal-1", "x")).toEqual({
            nodeid: "terminal-1",
            type: "key",
            payload: { data: "x" },
        });
        expect(keyDataForWidgetTerminal("Enter")).toBe("\n");
        expect(keyDataForWidgetTerminal("Escape")).toBe("\x1b");
        expect(keyDataForWidgetTerminal("ArrowUp")).toBe("\x1b[A");
        expect(keyDataForWidgetTerminal("ArrowDown")).toBe("\x1b[B");
        expect(keyDataForWidgetTerminal("ArrowRight")).toBe("\x1b[C");
        expect(keyDataForWidgetTerminal("ArrowLeft")).toBe("\x1b[D");
        expect(keyDataForWidgetTerminal("Backspace")).toBe("\x7f");
        expect(keyDataForWidgetTerminal("Tab")).toBe("\t");
        expect(keyDataForWidgetTerminal("a")).toBe("a");
        expect(keyDataForWidgetTerminal("Shift")).toBe("");
    });

    it("notifies the live widget when custom requests are dismissed", () => {
        const events: AgentWidgetEvent[] = [];
        notifyCustomWidgetCancel(
            {
                requestId: "r1",
                kind: "custom",
                widget: {
                    kind: "text",
                    id: "widget-1",
                    text: "native gui",
                    paddingx: 0,
                    paddingy: 0,
                },
            } as any,
            (event) => events.push(event)
        );

        expect(events).toEqual([{ nodeid: "widget-1", type: "cancel" }]);
    });
});
