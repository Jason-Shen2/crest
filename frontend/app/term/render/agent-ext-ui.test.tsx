// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0
// @vitest-environment jsdom

import { act, createRef } from "react";
import { createRoot, type Root } from "react-dom/client";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { PiExtUiState } from "@/app/store/use-pi-chat";
import type {
    WidgetBoxNode,
    WidgetInputNode,
    WidgetNode,
} from "../../../../emain/agent/extensions/pi-gui/crest/widget-tree";
import {
    AgentExtUiPanel,
    createWidgetEventIdGenerator,
    forwardAgentWidgetEvent,
    keyDataForWidgetTerminal,
    notifyCustomWidgetCancel,
    widgetCancelEvent,
    widgetInputCancelEvent,
    widgetInputChangeEvent,
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

interface RenderAgentExtUiPanelOptions {
    respondExtUi?: (requestId: string, result: unknown) => void;
    respondWidgetEvent?: (event: AgentWidgetEvent) => unknown;
}

const MountedPanels: RenderedAgentExtUiPanel[] = [];

function renderAgentExtUiPanel(
    extUi: PiExtUiState,
    options: RenderAgentExtUiPanelOptions | ((event: AgentWidgetEvent) => unknown) = {}
): RenderedAgentExtUiPanel {
    const { respondExtUi = () => {}, respondWidgetEvent = () => {} } =
        typeof options === "function" ? { respondWidgetEvent: options } : options;
    const container = document.createElement("div");
    document.body.appendChild(container);
    const root: Root = createRoot(container);
    const render = (nextExtUi: PiExtUiState) => {
        act(() => {
            root.render(
                <AgentExtUiPanel
                    extUi={nextExtUi}
                    respondExtUi={respondExtUi}
                    respondWidgetEvent={(event) => {
                        const result = respondWidgetEvent(event);
                        if (result instanceof Promise) return result;
                    }}
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

function doubleClickElement(element: Element): void {
    act(() => {
        element.dispatchEvent(new MouseEvent("dblclick", { bubbles: true, cancelable: true }));
    });
}

function keyDownElement(element: Element, key: string): void {
    act(() => {
        element.dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true }));
    });
}

function dispatchKeyDown(element: Element, key: string): KeyboardEvent {
    const event = new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true });
    act(() => {
        element.dispatchEvent(event);
    });
    return event;
}

function dispatchModifiedKeyDown(
    element: Element,
    key: string,
    modifiers: Pick<KeyboardEventInit, "altKey" | "ctrlKey" | "metaKey" | "shiftKey">
): KeyboardEvent {
    const event = new KeyboardEvent("keydown", {
        key,
        bubbles: true,
        cancelable: true,
        ...modifiers,
    });
    act(() => {
        element.dispatchEvent(event);
    });
    return event;
}

function focusElement(element: HTMLElement): void {
    act(() => {
        element.focus();
    });
}

function blurElement(element: HTMLElement): void {
    act(() => {
        element.blur();
    });
}

function changeInput(input: HTMLInputElement, value: string): void {
    const valueSetter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set;
    act(() => {
        valueSetter?.call(input, value);
        input.dispatchEvent(new Event("input", { bubbles: true, cancelable: true }));
    });
}

function setInputValue(input: HTMLInputElement, value: string): void {
    const valueSetter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set;
    act(() => {
        valueSetter?.call(input, value);
    });
}

function changeTextArea(textarea: HTMLTextAreaElement, value: string): void {
    const valueSetter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")?.set;
    act(() => {
        valueSetter?.call(textarea, value);
        textarea.dispatchEvent(new Event("input", { bubbles: true, cancelable: true }));
    });
}

function setTextAreaValue(textarea: HTMLTextAreaElement, value: string): void {
    const valueSetter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")?.set;
    act(() => {
        valueSetter?.call(textarea, value);
    });
}

function makeEditorState(
    overrides: Partial<Extract<WidgetNode, { kind: "editor" }>> = {}
): PiExtUiState {
    const value = overrides.value ?? "draft text";
    const selectionstart = overrides.selectionstart ?? value.length;
    const selectionend = overrides.selectionend ?? selectionstart;
    return {
        statuses: {},
        widgets: {},
        widgetnodes: {
            editor: {
                kind: "editor",
                id: "editor-1",
                value,
                lines: value.split("\n"),
                cursorline: 0,
                cursorcol: selectionend,
                focused: true,
                paddingx: 1,
                selectionstart,
                selectionend,
                submitkeys: ["enter"],
                newlinekeys: ["shift+enter"],
                ...overrides,
            },
        },
        renderedEntries: [],
        request: null,
    };
}

afterEach(() => {
    for (const mounted of MountedPanels.splice(0)) {
        mounted.unmount();
    }
});

describe("AgentExtUiPanel", () => {
    it.each([
        { handled: false, published: false },
        { handled: true, published: false },
    ])("clears pending Input through the surface forwarder for $handled/$published", async (outcome) => {
        const node = {
            kind: "input" as const,
            id: "surface-forward-input",
            value: "server",
            cursor: 6,
            focused: true,
            selectionstart: 6,
            selectionend: 6,
        };
        const extUi: PiExtUiState = {
            statuses: {},
            widgets: {},
            widgetnodes: { input: node },
            renderedEntries: [],
            request: null,
        };
        const respondWidgetEvent = vi.fn(async () => outcome);
        const { container, rerender } = renderAgentExtUiPanel(extUi, (event) =>
            forwardAgentWidgetEvent({ respondWidgetEvent }, event)
        );
        const input = container.querySelector(
            '[aria-label="Input surface-forward-input"]'
        ) as HTMLInputElement;

        changeInput(input, "local");
        await act(async () => {
            await Promise.resolve();
        });
        rerender({
            ...extUi,
            widgetnodes: {
                input: {
                    ...node,
                    value: "authoritative",
                    cursor: 9,
                    selectionstart: 2,
                    selectionend: 9,
                },
            },
        });

        expect(respondWidgetEvent).toHaveBeenCalledOnce();
        expect(input.value).toBe("authoritative");
        expect(input.selectionStart).toBe(2);
        expect(input.selectionEnd).toBe(9);
    });

    it("creates opaque widget event ids with injectable UUID and one module fallback prefix plus counter", () => {
        const uuid = vi.fn()
            .mockReturnValueOnce("uuid-one")
            .mockReturnValueOnce("uuid-two");
        const uuidGenerator = createWidgetEventIdGenerator({ randomUUID: uuid });

        expect(uuidGenerator()).toBe("uuid-one");
        expect(uuidGenerator()).toBe("uuid-two");

        const firstFallback = createWidgetEventIdGenerator({ randomUUID: undefined });
        const secondFallback = createWidgetEventIdGenerator({ randomUUID: undefined });
        const ids = [firstFallback(), firstFallback(), secondFallback()];
        const split = ids.map((id) => id.match(/^(.*)-(\d+)$/)?.slice(1));

        expect(new Set(ids).size).toBe(3);
        expect(split.every((parts) => parts != null)).toBe(true);
        expect(new Set(split.map((parts) => parts?.[0])).size).toBe(1);
        expect(split.map((parts) => Number(parts?.[1]))).toEqual([
            expect.any(Number),
            expect.any(Number),
            expect.any(Number),
        ]);
        expect(Number(split[1]?.[1])).toBe(Number(split[0]?.[1]) + 1);
        expect(Number(split[2]?.[1])).toBe(Number(split[1]?.[1]) + 1);
    });

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

    it("keeps SelectList navigation, activation, cancellation, filter, and focus Pi-authoritative", () => {
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
                        { value: "bravo", label: "Bravo" },
                    ],
                    selectedindex: 0,
                    maxvisible: 2,
                    focused: true,
                    filter: "",
                    visiblestart: 0,
                    visibleend: 2,
                    nomatch: false,
                } as any,
            },
            renderedEntries: [],
            request: null,
        };
        const events: AgentWidgetEvent[] = [];
        const { container } = renderAgentExtUiPanel(extUi, (event) => events.push(event));

        const listbox = container.querySelector('[role="listbox"]') as HTMLElement;
        const filter = container.querySelector('input[aria-label="Filter list-1"]') as HTMLInputElement;
        const alpha = container.querySelector("#list-1-option-0") as HTMLElement;
        const beta = container.querySelector("#list-1-option-1") as HTMLElement;

        expect(listbox).toBeTruthy();
        expect(filter).toBeTruthy();
        expect(listbox.tabIndex).toBe(0);
        expect(listbox.getAttribute("aria-activedescendant")).toBe("list-1-option-0");
        expect(alpha.getAttribute("role")).toBe("option");
        expect(beta.getAttribute("role")).toBe("option");
        expect(alpha.getAttribute("aria-selected")).toBe("true");
        expect(beta.getAttribute("aria-selected")).toBe("false");

        focusElement(filter);
        changeInput(filter, "br");
        blurElement(filter);
        keyDownElement(listbox, "ArrowDown");
        keyDownElement(listbox, "ArrowUp");
        keyDownElement(listbox, "Enter");
        keyDownElement(listbox, "Escape");
        clickElement(beta);

        expect(events).toEqual([
            { nodeid: "list-1", type: "focus", payload: { focused: true } },
            { nodeid: "list-1", type: "change", payload: { value: "br" } },
            { nodeid: "list-1", type: "focus", payload: { focused: false } },
            widgetKeyEvent("list-1", "\x1b[B"),
            widgetKeyEvent("list-1", "\x1b[A"),
            widgetKeyEvent("list-1", "\n"),
            widgetKeyEvent("list-1", "\x1b"),
            widgetSelectEvent("list-1", 1),
        ]);
        expect(listbox.getAttribute("aria-activedescendant")).toBe("list-1-option-0");
        expect(alpha.getAttribute("aria-selected")).toBe("true");
        expect(beta.getAttribute("aria-selected")).toBe("false");
    });

    it("renders only the SelectList active window and an explicit no-match state", () => {
        const extUi: PiExtUiState = {
            statuses: {},
            widgets: {},
            widgetnodes: {
                list: {
                    kind: "selectlist",
                    id: "windowed-list",
                    items: ["alpha", "beta", "charlie", "delta", "echo"].map((value) => ({
                        value,
                        label: value,
                    })),
                    selectedindex: 3,
                    maxvisible: 2,
                    focused: true,
                    filter: "",
                    visiblestart: 2,
                    visibleend: 4,
                    nomatch: false,
                } as any,
            },
            renderedEntries: [],
            request: null,
        };
        const events: AgentWidgetEvent[] = [];
        const { container, rerender } = renderAgentExtUiPanel(extUi, (event) => events.push(event));

        const options = Array.from(container.querySelectorAll('[role="option"]'));
        expect(options).toHaveLength(2);
        expect(options.length).toBeLessThanOrEqual(2);
        expect(options.map((option) => option.textContent)).toEqual(["charlie", "delta"]);
        expect(options[1].getAttribute("aria-selected")).toBe("true");

        clickElement(options[0]);
        expect(events).toEqual([widgetSelectEvent("windowed-list", 2)]);

        rerender({
            ...extUi,
            widgetnodes: {
                list: {
                    ...(extUi.widgetnodes.list as any),
                    items: [],
                    selectedindex: 0,
                    filter: "missing",
                    visiblestart: 0,
                    visibleend: 0,
                    nomatch: true,
                } as any,
            },
        });

        expect(container.textContent).toContain("No matching options");
        const listbox = container.querySelector('[role="listbox"]') as HTMLElement;
        keyDownElement(listbox, "Enter");
        expect(events.filter((event) => event.type === "select")).toEqual([
            widgetSelectEvent("windowed-list", 2),
        ]);
    });

    it("preserves SelectList ARIA state across authoritative snapshot refresh", () => {
        const extUi: PiExtUiState = {
            statuses: {},
            widgets: {},
            widgetnodes: {
                list: {
                    kind: "selectlist",
                    id: "aria-list",
                    items: [
                        { value: "alpha", label: "Alpha" },
                        { value: "beta", label: "Beta" },
                    ],
                    selectedindex: 0,
                    maxvisible: 2,
                    focused: true,
                    filter: "a",
                    visiblestart: 0,
                    visibleend: 2,
                    nomatch: false,
                } as any,
            },
            renderedEntries: [],
            request: null,
        };
        const { container, rerender } = renderAgentExtUiPanel(extUi);
        const listbox = container.querySelector('[role="listbox"]') as HTMLElement;
        const filter = container.querySelector('input[aria-label="Filter aria-list"]') as HTMLInputElement;

        expect(filter.value).toBe("a");
        expect(listbox.getAttribute("aria-activedescendant")).toBe("aria-list-option-0");

        rerender({
            ...extUi,
            widgetnodes: {
                list: {
                    ...(extUi.widgetnodes.list as any),
                    items: [
                        { value: "bravo", label: "Bravo" },
                        { value: "charlie", label: "Charlie" },
                    ],
                    selectedindex: 1,
                    filter: "br",
                } as any,
            },
        });

        const refreshedListbox = container.querySelector('[role="listbox"]') as HTMLElement;
        const refreshedFilter = container.querySelector('input[aria-label="Filter aria-list"]') as HTMLInputElement;
        const refreshedOptions = Array.from(refreshedListbox.querySelectorAll('[role="option"]'));
        expect(refreshedListbox).toBe(listbox);
        expect(refreshedFilter).toBe(filter);
        expect(refreshedFilter.value).toBe("br");
        expect(refreshedListbox.getAttribute("aria-activedescendant")).toBe("aria-list-option-1");
        expect(refreshedOptions[0].getAttribute("aria-selected")).toBe("false");
        expect(refreshedOptions[1].getAttribute("aria-selected")).toBe("true");
    });

    it("routes SelectList semantic keys from the focused filter without stealing native editing", () => {
        const extUi: PiExtUiState = {
            statuses: {},
            widgets: {},
            widgetnodes: {
                list: {
                    kind: "selectlist",
                    id: "filter-keys-list",
                    items: [
                        { value: "alpha", label: "Alpha" },
                        { value: "beta", label: "Beta" },
                    ],
                    selectedindex: 0,
                    maxvisible: 2,
                    focused: true,
                    filter: "",
                    visiblestart: 0,
                    visibleend: 2,
                    nomatch: false,
                } as any,
            },
            renderedEntries: [],
            request: null,
        };
        const events: AgentWidgetEvent[] = [];
        const { container } = renderAgentExtUiPanel(extUi, (event) => events.push(event));
        const filter = container.querySelector('input[aria-label="Filter filter-keys-list"]') as HTMLInputElement;

        focusElement(filter);
        events.length = 0;
        const semanticEvents = [
            dispatchKeyDown(filter, "ArrowDown"),
            dispatchKeyDown(filter, "ArrowUp"),
            dispatchKeyDown(filter, "Enter"),
            dispatchKeyDown(filter, "Escape"),
        ];

        expect(document.activeElement).toBe(filter);
        expect(semanticEvents.every((event) => event.defaultPrevented)).toBe(true);
        expect(events).toEqual([
            widgetKeyEvent("filter-keys-list", "\x1b[B"),
            widgetKeyEvent("filter-keys-list", "\x1b[A"),
            widgetKeyEvent("filter-keys-list", "\n"),
            widgetKeyEvent("filter-keys-list", "\x1b"),
        ]);

        events.length = 0;
        const printableEvents = [dispatchKeyDown(filter, "a"), dispatchKeyDown(filter, "b")];
        changeInput(filter, "a");
        changeInput(filter, "ab");

        expect(document.activeElement).toBe(filter);
        expect(filter.value).toBe("ab");
        expect(printableEvents.every((event) => !event.defaultPrevented)).toBe(true);
        expect(events).toEqual([
            { nodeid: "filter-keys-list", type: "change", payload: { value: "a" } },
            { nodeid: "filter-keys-list", type: "change", payload: { value: "ab" } },
        ]);
    });

    it("preserves the local SelectList composition buffer across stale snapshots and reconciles after commit", () => {
        const extUi: PiExtUiState = {
            statuses: {},
            widgets: {},
            widgetnodes: {
                list: {
                    kind: "selectlist",
                    id: "filter-composition-list",
                    items: [{ value: "nihon", label: "Japan" }],
                    selectedindex: 0,
                    maxvisible: 1,
                    focused: true,
                    filter: "",
                    visiblestart: 0,
                    visibleend: 1,
                    nomatch: false,
                } as any,
            },
            renderedEntries: [],
            request: null,
        };
        const events: AgentWidgetEvent[] = [];
        const { container, rerender } = renderAgentExtUiPanel(extUi, (event) => events.push(event));
        const filter = container.querySelector(
            'input[aria-label="Filter filter-composition-list"]'
        ) as HTMLInputElement;

        focusElement(filter);
        events.length = 0;
        act(() => {
            filter.dispatchEvent(new CompositionEvent("compositionstart", { bubbles: true, data: "" }));
        });
        changeInput(filter, "日");
        changeInput(filter, "日本");

        expect(filter.value).toBe("日本");
        expect(events).toEqual([]);

        rerender({
            ...extUi,
            widgetnodes: {
                list: {
                    ...(extUi.widgetnodes.list as any),
                    filter: "",
                } as any,
            },
        });

        expect(filter.value).toBe("日本");
        expect(events).toEqual([]);

        act(() => {
            filter.dispatchEvent(new CompositionEvent("compositionend", { bubbles: true, data: "日本" }));
        });

        expect(document.activeElement).toBe(filter);
        expect(events).toEqual([
            { nodeid: "filter-composition-list", type: "change", payload: { value: "日本" } },
        ]);

        rerender({
            ...extUi,
            widgetnodes: {
                list: {
                    ...(extUi.widgetnodes.list as any),
                    filter: "日本",
                } as any,
            },
        });

        expect(filter.value).toBe("日本");
        expect(events).toHaveLength(1);
    });

    it("keeps a focused dirty SelectList query stable across stale echoes and accepts updates after acknowledgement", () => {
        const extUi: PiExtUiState = {
            statuses: {},
            widgets: {},
            widgetnodes: {
                list: {
                    kind: "selectlist",
                    id: "filter-echo-list",
                    items: [{ value: "alpha", label: "Alpha" }],
                    selectedindex: 0,
                    maxvisible: 1,
                    focused: true,
                    filter: "",
                    visiblestart: 0,
                    visibleend: 1,
                    nomatch: false,
                } as any,
            },
            renderedEntries: [],
            request: null,
        };
        const events: AgentWidgetEvent[] = [];
        const { container, rerender } = renderAgentExtUiPanel(extUi, async (event) => {
            events.push(event);
            return { handled: true, published: true };
        });
        const filter = container.querySelector('input[aria-label="Filter filter-echo-list"]') as HTMLInputElement;
        const rerenderFilter = (value: string) => {
            rerender({
                ...extUi,
                widgetnodes: {
                    list: {
                        ...(extUi.widgetnodes.list as any),
                        filter: value,
                    } as any,
                },
            });
        };

        focusElement(filter);
        changeInput(filter, "a");
        changeInput(filter, "ab");
        rerenderFilter("a");

        expect(filter.value).toBe("ab");

        rerenderFilter("ab");
        expect(container.querySelector('input[aria-label="Filter filter-echo-list"]')).toBe(filter);
        expect(document.activeElement).toBe(filter);
        expect(filter.value).toBe("ab");

        rerenderFilter("server");
        expect(filter.value).toBe("server");

        blurElement(filter);
        expect(filter.value).toBe("server");
        expect(events).toEqual([
            { nodeid: "filter-echo-list", type: "focus", payload: { focused: true } },
            { nodeid: "filter-echo-list", type: "change", payload: { value: "a" } },
            { nodeid: "filter-echo-list", type: "change", payload: { value: "ab" } },
            { nodeid: "filter-echo-list", type: "focus", payload: { focused: false } },
        ]);
    });

    it("accepts a different authoritative SelectList filter while focused after the local value is acknowledged", () => {
        const extUi: PiExtUiState = {
            statuses: {},
            widgets: {},
            widgetnodes: {
                list: {
                    kind: "selectlist",
                    id: "filter-ack-list",
                    items: [{ value: "draft", label: "Draft" }],
                    selectedindex: 0,
                    maxvisible: 1,
                    focused: true,
                    filter: "",
                    visiblestart: 0,
                    visibleend: 1,
                    nomatch: false,
                } as any,
            },
            renderedEntries: [],
            request: null,
        };
        const { container, rerender } = renderAgentExtUiPanel(extUi);
        const filter = container.querySelector('input[aria-label="Filter filter-ack-list"]') as HTMLInputElement;
        const rerenderFilter = (value: string) => {
            rerender({
                ...extUi,
                widgetnodes: {
                    list: {
                        ...(extUi.widgetnodes.list as any),
                        filter: value,
                    } as any,
                },
            });
        };

        focusElement(filter);
        changeInput(filter, "draft");
        rerenderFilter("draft");
        rerenderFilter("canonical");

        expect(container.querySelector('input[aria-label="Filter filter-ack-list"]')).toBe(filter);
        expect(document.activeElement).toBe(filter);
        expect(filter.value).toBe("canonical");
    });

    it("remounts SelectList by node id so an in-progress composition cannot leak into its replacement", () => {
        const extUi: PiExtUiState = {
            statuses: {},
            widgets: {},
            widgetnodes: {
                list: {
                    kind: "selectlist",
                    id: "composition-old-list",
                    items: [{ value: "old", label: "Old" }],
                    selectedindex: 0,
                    maxvisible: 1,
                    focused: true,
                    filter: "",
                    visiblestart: 0,
                    visibleend: 1,
                    nomatch: false,
                } as any,
            },
            renderedEntries: [],
            request: null,
        };
        const events: AgentWidgetEvent[] = [];
        const { container, rerender } = renderAgentExtUiPanel(extUi, async (event) => {
            events.push(event);
            return { handled: true, published: true };
        });
        const oldFilter = container.querySelector(
            'input[aria-label="Filter composition-old-list"]'
        ) as HTMLInputElement;

        focusElement(oldFilter);
        act(() => {
            oldFilter.dispatchEvent(new CompositionEvent("compositionstart", { bubbles: true, data: "" }));
        });
        changeInput(oldFilter, "旧");
        events.length = 0;

        rerender({
            ...extUi,
            widgetnodes: {
                list: {
                    ...(extUi.widgetnodes.list as any),
                    id: "composition-new-list",
                    items: [{ value: "new", label: "New" }],
                    filter: "new",
                } as any,
            },
        });

        const newFilter = container.querySelector(
            'input[aria-label="Filter composition-new-list"]'
        ) as HTMLInputElement;
        expect(newFilter).not.toBe(oldFilter);
        expect(newFilter.value).toBe("new");

        act(() => {
            oldFilter.dispatchEvent(new CompositionEvent("compositionend", { bubbles: true, data: "旧" }));
        });
        focusElement(newFilter);
        changeInput(newFilter, "fresh");

        expect(events.filter((event) => event.type === "change")).toEqual([
            { nodeid: "composition-new-list", type: "change", payload: { value: "fresh" } },
        ]);
    });

    it("publishes SelectList focus only when focus crosses the component boundary", () => {
        const extUi: PiExtUiState = {
            statuses: {},
            widgets: {},
            widgetnodes: {
                list: {
                    kind: "selectlist",
                    id: "focus-within-list",
                    items: [{ value: "alpha", label: "Alpha" }],
                    selectedindex: 0,
                    maxvisible: 1,
                    focused: true,
                    filter: "",
                    visiblestart: 0,
                    visibleend: 1,
                    nomatch: false,
                } as any,
            },
            renderedEntries: [],
            request: null,
        };
        const events: AgentWidgetEvent[] = [];
        const { container } = renderAgentExtUiPanel(extUi, (event) => events.push(event));
        const filter = container.querySelector('input[aria-label="Filter focus-within-list"]') as HTMLInputElement;
        const listbox = container.querySelector('[aria-label="Select list focus-within-list"]') as HTMLElement;
        const cancel = Array.from(container.querySelectorAll("button")).find(
            (button) => button.textContent === "Cancel"
        ) as HTMLButtonElement;
        const outside = document.createElement("button");
        document.body.appendChild(outside);

        focusElement(filter);
        focusElement(listbox);
        focusElement(cancel);
        focusElement(outside);

        expect(events).toEqual([
            { nodeid: "focus-within-list", type: "focus", payload: { focused: true } },
            { nodeid: "focus-within-list", type: "focus", payload: { focused: false } },
        ]);
        outside.remove();
    });

    it("preserves Input node identity and selection across authoritative snapshot echoes", () => {
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
                    selectionstart: 5,
                    selectionend: 5,
                } as any,
            },
            renderedEntries: [],
            request: null,
        };
        const { container, rerender } = renderAgentExtUiPanel(extUi);
        const input = container.querySelector('[aria-label="Input input-1"]') as HTMLInputElement;

        changeInput(input, "draft text");
        input.setSelectionRange(2, 7);
        rerender({
            ...extUi,
            widgetnodes: {
                input: {
                    ...(extUi.widgetnodes.input as any),
                    value: "draft text",
                    cursor: 7,
                    selectionstart: 2,
                    selectionend: 7,
                },
            },
        });

        const echoedInput = container.querySelector('[aria-label="Input input-1"]') as HTMLInputElement;
        expect(echoedInput).toBe(input);
        expect(echoedInput.value).toBe("draft text");
        expect(echoedInput.selectionStart).toBe(2);
        expect(echoedInput.selectionEnd).toBe(7);
    });

    it("keeps rapid Input edits across no-ack and exact older acknowledgements until all pending ids settle", () => {
        const node = {
            kind: "input" as const,
            id: "dirty-input",
            value: "",
            cursor: 0,
            focused: true,
            selectionstart: 0,
            selectionend: 0,
        };
        const extUi: PiExtUiState = {
            statuses: {},
            widgets: {},
            widgetnodes: { input: node },
            renderedEntries: [],
            request: null,
        };
        const events: AgentWidgetEvent[] = [];
        const { container, rerender } = renderAgentExtUiPanel(extUi, async (event) => {
            events.push(event);
            return { handled: true, published: true };
        });
        const input = container.querySelector('[aria-label="Input dirty-input"]') as HTMLInputElement;
        const publish = (value: string, ackid?: string) => {
            rerender({
                ...extUi,
                widgetnodes: {
                    input: {
                        ...node,
                        value,
                        cursor: value.length,
                        selectionstart: value.length,
                        selectionend: value.length,
                        ackid,
                    },
                },
            });
        };

        changeInput(input, "first");
        changeInput(input, "second");
        input.setSelectionRange(2, 4);
        const [firstId, secondId] = events.map((event) => (event as any).eventid);

        publish("initial scheduled snapshot");
        expect(input.value).toBe("second");
        expect(input.selectionStart).toBe(2);
        expect(input.selectionEnd).toBe(4);

        publish("first", firstId);
        expect(input.value).toBe("second");
        expect(input.selectionStart).toBe(2);
        expect(input.selectionEnd).toBe(4);

        publish("second", secondId);
        expect(input.value).toBe("second");
        expect(input.selectionStart).toBe(6);
        expect(input.selectionEnd).toBe(6);

        publish("remote");
        expect(input.value).toBe("remote");
        expect(input.selectionStart).toBe(6);
        expect(input.selectionEnd).toBe(6);
        expect(firstId).toEqual(expect.any(String));
        expect(secondId).toEqual(expect.any(String));
        expect(secondId).not.toBe(firstId);
    });

    it("uses exact ackids while dirty and applies replay snapshots after the latest ack cleans it", () => {
        const node = {
            kind: "input" as const,
            id: "repeat-input",
            value: "",
            cursor: 0,
            focused: true,
            selectionstart: 0,
            selectionend: 0,
        };
        const extUi: PiExtUiState = {
            statuses: {},
            widgets: {},
            widgetnodes: { input: node },
            renderedEntries: [],
            request: null,
        };
        const events: AgentWidgetEvent[] = [];
        const { container, rerender } = renderAgentExtUiPanel(extUi, async (event) => {
            events.push(event);
            return { handled: true, published: true };
        });
        const input = container.querySelector('[aria-label="Input repeat-input"]') as HTMLInputElement;
        const publish = (value: string, ackid?: string) => {
            rerender({
                ...extUi,
                widgetnodes: {
                    input: {
                        ...node,
                        value,
                        cursor: value.length,
                        selectionstart: value.length,
                        selectionend: value.length,
                        ackid,
                    },
                },
            });
        };

        changeInput(input, "same");
        changeInput(input, "different");
        changeInput(input, "same");
        input.setSelectionRange(1, 3);
        const [firstId, secondId, thirdId] = events.map((event) => (event as any).eventid);

        publish("same", firstId);
        publish("scheduled old value");
        expect(input.value).toBe("same");
        expect(input.selectionStart).toBe(1);
        expect(input.selectionEnd).toBe(3);

        publish("same", thirdId);
        expect(input.value).toBe("same");
        expect(input.selectionStart).toBe(4);
        expect(input.selectionEnd).toBe(4);

        publish("different", secondId);
        expect(input.value).toBe("different");
        expect(input.selectionStart).toBe(9);
        expect(input.selectionEnd).toBe(9);

        publish("foreign replay", "other-renderer:event");
        expect(input.value).toBe("foreign replay");
        expect(input.selectionStart).toBe(14);
        expect(input.selectionEnd).toBe(14);

        publish("same", firstId);
        publish("authoritative");
        expect(input.value).toBe("authoritative");
        expect(new Set([firstId, secondId, thirdId]).size).toBe(3);
    });

    it("clears pending Input ids when node identity changes", () => {
        const makeNode = (id: string, value = "") => ({
            kind: "input" as const,
            id,
            value,
            cursor: value.length,
            focused: true,
            selectionstart: value.length,
            selectionend: value.length,
        });
        const extUi: PiExtUiState = {
            statuses: {},
            widgets: {},
            widgetnodes: { input: makeNode("old-input") },
            renderedEntries: [],
            request: null,
        };
        const events: AgentWidgetEvent[] = [];
        const { container, rerender } = renderAgentExtUiPanel(extUi, async (event) => {
            events.push(event);
            return { handled: true, published: true };
        });
        const oldInput = container.querySelector('[aria-label="Input old-input"]') as HTMLInputElement;
        changeInput(oldInput, "old edit");

        rerender({
            ...extUi,
            widgetnodes: { input: makeNode("new-input", "new") },
        });
        const newInput = container.querySelector('[aria-label="Input new-input"]') as HTMLInputElement;
        changeInput(newInput, "new edit");

        expect(newInput).not.toBe(oldInput);
        expect(events.map((event) => event.nodeid)).toEqual(["old-input", "new-input"]);
        expect((events[0] as any).eventid).toEqual(expect.any(String));
        expect((events[1] as any).eventid).toEqual(expect.any(String));
        expect((events[1] as any).eventid).not.toBe((events[0] as any).eventid);
    });

    it("keeps event ids process-unique across two Input renderer instances", () => {
        const makeState = (slot: string, id: string): PiExtUiState => ({
            statuses: {},
            widgets: {},
            widgetnodes: {
                [slot]: {
                    kind: "input",
                    id,
                    value: "",
                    cursor: 0,
                    focused: true,
                    selectionstart: 0,
                    selectionend: 0,
                },
            },
            renderedEntries: [],
            request: null,
        });
        const events: AgentWidgetEvent[] = [];
        const first = renderAgentExtUiPanel(makeState("first", "shared-looking-a"), (event) => events.push(event));
        const second = renderAgentExtUiPanel(makeState("second", "shared-looking-b"), (event) => events.push(event));

        changeInput(first.container.querySelector('[aria-label="Input shared-looking-a"]') as HTMLInputElement, "a");
        changeInput(second.container.querySelector('[aria-label="Input shared-looking-b"]') as HTMLInputElement, "b");

        expect((events[0] as any).eventid).toEqual(expect.any(String));
        expect((events[1] as any).eventid).toEqual(expect.any(String));
        expect((events[0] as any).eventid).not.toBe((events[1] as any).eventid);
    });

    it("ignores foreign Input ack metadata while clean and applies authoritative value and selection", () => {
        const node = {
            kind: "input" as const,
            id: "late-ack-input",
            value: "initial",
            cursor: 7,
            focused: true,
            selectionstart: 7,
            selectionend: 7,
        };
        const extUi: PiExtUiState = {
            statuses: {},
            widgets: {},
            widgetnodes: { input: node },
            renderedEntries: [],
            request: null,
        };
        const { container, rerender } = renderAgentExtUiPanel(extUi);
        const input = container.querySelector('[aria-label="Input late-ack-input"]') as HTMLInputElement;

        rerender({
            ...extUi,
            widgetnodes: {
                input: {
                    ...node,
                    value: "replayed",
                    cursor: 8,
                    selectionstart: 8,
                    selectionend: 8,
                    ackid: "another-renderer:event",
                },
            },
        });
        expect(input.value).toBe("replayed");
        expect(input.selectionStart).toBe(8);
        expect(input.selectionEnd).toBe(8);
    });

    it("treats a foreign Input ack as no-ack while dirty", () => {
        const node = {
            kind: "input" as const,
            id: "dirty-foreign-ack-input",
            value: "initial",
            cursor: 7,
            focused: true,
            selectionstart: 7,
            selectionend: 7,
        };
        const extUi: PiExtUiState = {
            statuses: {},
            widgets: {},
            widgetnodes: { input: node },
            renderedEntries: [],
            request: null,
        };
        const events: AgentWidgetEvent[] = [];
        const { container, rerender } = renderAgentExtUiPanel(extUi, async (event) => {
            events.push(event);
            return { handled: true, published: true };
        });
        const input = container.querySelector(
            '[aria-label="Input dirty-foreign-ack-input"]'
        ) as HTMLInputElement;

        changeInput(input, "older local");
        const olderEventId = events[0].eventid;
        changeInput(input, "local");
        input.setSelectionRange(1, 4);
        rerender({
            ...extUi,
            widgetnodes: {
                input: {
                    ...node,
                    value: "older local",
                    cursor: 11,
                    selectionstart: 11,
                    selectionend: 11,
                    ackid: olderEventId,
                },
            },
        });
        rerender({
            ...extUi,
            widgetnodes: {
                input: {
                    ...node,
                    value: "foreign",
                    cursor: 7,
                    selectionstart: 0,
                    selectionend: 7,
                    ackid: "another-renderer:event",
                },
            },
        });

        expect(olderEventId).toEqual(expect.any(String));
        expect(events[1].eventid).toEqual(expect.any(String));
        expect(input.value).toBe("local");
        expect(input.selectionStart).toBe(1);
        expect(input.selectionEnd).toBe(4);
    });

    it("releases an Input pending event after an unhandled result and accepts the next no-ack snapshot", async () => {
        const node = {
            kind: "input" as const,
            id: "nack-input",
            value: "server",
            cursor: 6,
            focused: true,
            selectionstart: 6,
            selectionend: 6,
        };
        const extUi: PiExtUiState = {
            statuses: {},
            widgets: {},
            widgetnodes: { input: node },
            renderedEntries: [],
            request: null,
        };
        const respond = vi.fn(async () => ({ handled: false, published: false }));
        const { container, rerender } = renderAgentExtUiPanel(extUi, respond);
        const input = container.querySelector('[aria-label="Input nack-input"]') as HTMLInputElement;

        changeInput(input, "local");
        await act(async () => {
            await Promise.resolve();
        });
        rerender({
            ...extUi,
            widgetnodes: {
                input: { ...node, value: "authoritative", cursor: 13, selectionstart: 2, selectionend: 9 },
            },
        });

        expect(respond).toHaveBeenCalledOnce();
        expect(input.value).toBe("authoritative");
        expect(input.selectionStart).toBe(2);
        expect(input.selectionEnd).toBe(9);
    });

    it("releases an Input pending event after a rejected result without guessing an immediate rollback", async () => {
        const node = {
            kind: "input" as const,
            id: "reject-input",
            value: "server",
            cursor: 6,
            focused: true,
            selectionstart: 6,
            selectionend: 6,
        };
        const extUi: PiExtUiState = {
            statuses: {},
            widgets: {},
            widgetnodes: { input: node },
            renderedEntries: [],
            request: null,
        };
        const respond = vi.fn(async () => {
            throw new Error("ipc rejected");
        });
        const { container, rerender } = renderAgentExtUiPanel(extUi, respond);
        const input = container.querySelector('[aria-label="Input reject-input"]') as HTMLInputElement;

        changeInput(input, "local");
        expect(input.value).toBe("local");
        await act(async () => {
            await Promise.resolve();
        });
        expect(input.value).toBe("local");

        rerender({
            ...extUi,
            widgetnodes: {
                input: { ...node, value: "after rejection", cursor: 15, selectionstart: 15, selectionend: 15 },
            },
        });
        expect(input.value).toBe("after rejection");
    });

    it("keeps an Input pending after a handled published result until its live ack arrives", async () => {
        const node = {
            kind: "input" as const,
            id: "handled-input",
            value: "server",
            cursor: 6,
            focused: true,
            selectionstart: 6,
            selectionend: 6,
        };
        const extUi: PiExtUiState = {
            statuses: {},
            widgets: {},
            widgetnodes: { input: node },
            renderedEntries: [],
            request: null,
        };
        const events: AgentWidgetEvent[] = [];
        const { container, rerender } = renderAgentExtUiPanel(extUi, async (event) => {
            events.push(event);
            return { handled: true, published: true };
        });
        const input = container.querySelector('[aria-label="Input handled-input"]') as HTMLInputElement;

        changeInput(input, "local");
        await act(async () => {
            await Promise.resolve();
        });
        rerender({
            ...extUi,
            widgetnodes: {
                input: { ...node, value: "stale", cursor: 5, selectionstart: 5, selectionend: 5 },
            },
        });
        expect(input.value).toBe("local");

        rerender({
            ...extUi,
            widgetnodes: {
                input: {
                    ...node,
                    value: "local",
                    cursor: 5,
                    selectionstart: 5,
                    selectionend: 5,
                    ackid: events[0].eventid,
                },
            },
        });
        expect(input.value).toBe("local");
    });

    it("clears a legacy void Input dispatch immediately while still collecting the event", () => {
        const node = {
            kind: "input" as const,
            id: "void-input",
            value: "server",
            cursor: 6,
            focused: true,
            selectionstart: 6,
            selectionend: 6,
        };
        const extUi: PiExtUiState = {
            statuses: {},
            widgets: {},
            widgetnodes: { input: node },
            renderedEntries: [],
            request: null,
        };
        const events: AgentWidgetEvent[] = [];
        const { container, rerender } = renderAgentExtUiPanel(extUi, (event) => {
            events.push(event);
        });
        const input = container.querySelector('[aria-label="Input void-input"]') as HTMLInputElement;

        changeInput(input, "local");
        rerender({
            ...extUi,
            widgetnodes: {
                input: { ...node, value: "authoritative", cursor: 13, selectionstart: 3, selectionend: 8 },
            },
        });

        expect(events).toHaveLength(1);
        expect(input.value).toBe("authoritative");
        expect(input.selectionStart).toBe(3);
        expect(input.selectionEnd).toBe(8);
    });

    it("keeps only remaining Input tuples after older nack and retries the latest tuple after latest nack", async () => {
        const node = {
            kind: "input" as const,
            id: "multi-nack-input",
            value: "",
            cursor: 0,
            focused: true,
            selectionstart: 0,
            selectionend: 0,
        };
        const extUi: PiExtUiState = {
            statuses: {},
            widgets: {},
            widgetnodes: { input: node },
            renderedEntries: [],
            request: null,
        };
        const outcomes: Array<(result: { handled: boolean; published: boolean }) => void> = [];
        const events: AgentWidgetEvent[] = [];
        const { container } = renderAgentExtUiPanel(extUi, (event) => {
            events.push(event);
            return new Promise((resolve) => outcomes.push(resolve));
        });
        const input = container.querySelector('[aria-label="Input multi-nack-input"]') as HTMLInputElement;

        focusElement(input);
        events.length = 0;
        outcomes.length = 0;
        changeInput(input, "older");
        changeInput(input, "latest");
        await act(async () => {
            outcomes[0]({ handled: false, published: false });
            await Promise.resolve();
        });
        changeInput(input, "latest");
        expect(events).toHaveLength(2);

        await act(async () => {
            outcomes[1]({ handled: false, published: false });
            await Promise.resolve();
        });
        act(() => {
            input.dispatchEvent(new CompositionEvent("compositionend", { bubbles: true, data: "" }));
        });

        expect(events).toHaveLength(3);
        expect(events[2].eventid).not.toBe(events[1].eventid);
        expect(events[2].payload).toEqual({
            value: "latest",
            selectionstart: 6,
            selectionend: 6,
        });
    });

    it("accepts a handled unpublished Input tuple locally and allows the next no-ack authoritative snapshot", async () => {
        const node = {
            kind: "input" as const,
            id: "accepted-unpublished-input",
            value: "server",
            cursor: 6,
            focused: true,
            selectionstart: 6,
            selectionend: 6,
        };
        const extUi: PiExtUiState = {
            statuses: {},
            widgets: {},
            widgetnodes: { input: node },
            renderedEntries: [],
            request: null,
        };
        const events: AgentWidgetEvent[] = [];
        const { container, rerender } = renderAgentExtUiPanel(extUi, async (event) => {
            events.push(event);
            return { handled: true, published: false };
        });
        const input = container.querySelector(
            '[aria-label="Input accepted-unpublished-input"]'
        ) as HTMLInputElement;

        changeInput(input, "accepted");
        await act(async () => {
            await Promise.resolve();
        });
        changeInput(input, "accepted");
        expect(events).toHaveLength(1);

        rerender({
            ...extUi,
            widgetnodes: {
                input: { ...node, value: "authoritative", cursor: 13, selectionstart: 1, selectionend: 12 },
            },
        });
        expect(input.value).toBe("authoritative");
        expect(input.selectionStart).toBe(1);
        expect(input.selectionEnd).toBe(12);
    });

    it("does not revive an older pending Input after a newer submit is accepted unpublished", async () => {
        const node = {
            kind: "input" as const,
            id: "ordered-input",
            value: "",
            cursor: 0,
            focused: true,
            selectionstart: 0,
            selectionend: 0,
        };
        const extUi: PiExtUiState = {
            statuses: {},
            widgets: {},
            widgetnodes: { input: node },
            renderedEntries: [],
            request: null,
        };
        const outcomes: Array<(result: { handled: boolean; published: boolean }) => void> = [];
        const events: AgentWidgetEvent[] = [];
        const { container } = renderAgentExtUiPanel(extUi, (event) => {
            events.push(event);
            return new Promise((resolve) => outcomes.push(resolve));
        });
        const input = container.querySelector('[aria-label="Input ordered-input"]') as HTMLInputElement;

        changeInput(input, "A");
        setInputValue(input, "B");
        input.setSelectionRange(1, 1);
        dispatchKeyDown(input, "Enter");
        await act(async () => {
            outcomes[1]({ handled: true, published: false });
            await Promise.resolve();
        });
        act(() => {
            input.dispatchEvent(new Event("select", { bubbles: true }));
            input.dispatchEvent(new Event("input", { bubbles: true, cancelable: true }));
        });

        expect(events).toHaveLength(2);
        expect(events.map((event) => event.type)).toEqual(["change", "submit"]);
        expect(events[1].payload).toEqual({ value: "B", selectionstart: 1, selectionend: 1 });
    });

    it("settles a stale exact Input ack without overwriting a newer accepted tuple", async () => {
        const node = {
            kind: "input" as const,
            id: "stale-ack-input",
            value: "",
            cursor: 0,
            focused: true,
            selectionstart: 0,
            selectionend: 0,
        };
        const extUi: PiExtUiState = {
            statuses: {},
            widgets: {},
            widgetnodes: { input: node },
            renderedEntries: [],
            request: null,
        };
        const outcomes: Array<(result: { handled: boolean; published: boolean }) => void> = [];
        const events: AgentWidgetEvent[] = [];
        const { container, rerender } = renderAgentExtUiPanel(extUi, (event) => {
            events.push(event);
            return new Promise((resolve) => outcomes.push(resolve));
        });
        const input = container.querySelector('[aria-label="Input stale-ack-input"]') as HTMLInputElement;

        changeInput(input, "A");
        const changeId = events[0].eventid;
        setInputValue(input, "B");
        input.setSelectionRange(0, 1);
        input.scrollLeft = 23;
        dispatchKeyDown(input, "Enter");
        await act(async () => {
            outcomes[1]({ handled: true, published: false });
            await Promise.resolve();
        });

        rerender({
            ...extUi,
            widgetnodes: {
                input: {
                    ...node,
                    value: "A",
                    cursor: 1,
                    selectionstart: 1,
                    selectionend: 1,
                    ackid: changeId,
                },
            },
        });
        expect(container.querySelector('[aria-label="Input stale-ack-input"]')).toBe(input);
        expect(input.value).toBe("B");
        expect(input.selectionStart).toBe(0);
        expect(input.selectionEnd).toBe(1);
        expect(input.scrollLeft).toBe(23);

        rerender({
            ...extUi,
            widgetnodes: {
                input: {
                    ...node,
                    value: "C",
                    cursor: 1,
                    selectionstart: 0,
                    selectionend: 1,
                },
            },
        });
        expect(input.value).toBe("C");
        expect(input.selectionStart).toBe(0);
        expect(input.selectionEnd).toBe(1);
        expect(input.scrollLeft).toBe(23);
    });

    it("reconciles same-value Input selection snapshots without replacing or scrolling the node", () => {
        const node = {
            kind: "input" as const,
            id: "snapshot-selection-input",
            value: "same",
            cursor: 4,
            focused: true,
            selectionstart: 4,
            selectionend: 4,
        };
        const extUi: PiExtUiState = {
            statuses: {},
            widgets: {},
            widgetnodes: { input: node },
            renderedEntries: [],
            request: null,
        };
        const events: AgentWidgetEvent[] = [];
        const { container, rerender } = renderAgentExtUiPanel(extUi, async (event) => {
            events.push(event);
            return { handled: true, published: true };
        });
        const input = container.querySelector(
            '[aria-label="Input snapshot-selection-input"]'
        ) as HTMLInputElement;
        input.scrollLeft = 19;

        rerender({
            ...extUi,
            widgetnodes: { input: { ...node, selectionstart: 1, selectionend: 3 } },
        });
        expect(container.querySelector('[aria-label="Input snapshot-selection-input"]')).toBe(input);
        expect(input.selectionStart).toBe(1);
        expect(input.selectionEnd).toBe(3);
        expect(input.scrollLeft).toBe(19);

        changeInput(input, "local");
        input.setSelectionRange(2, 4);
        const eventid = events.at(-1)?.eventid;
        rerender({
            ...extUi,
            widgetnodes: { input: { ...node, selectionstart: 4, selectionend: 4 } },
        });
        rerender({
            ...extUi,
            widgetnodes: {
                input: { ...node, selectionstart: 0, selectionend: 1, ackid: "foreign:event" },
            },
        });
        expect(input.selectionStart).toBe(2);
        expect(input.selectionEnd).toBe(4);
        expect(input.value).toBe("local");

        rerender({
            ...extUi,
            widgetnodes: {
                input: {
                    ...node,
                    value: "local",
                    cursor: 2,
                    selectionstart: 0,
                    selectionend: 2,
                    ackid: eventid,
                },
            },
        });
        expect(container.querySelector('[aria-label="Input snapshot-selection-input"]')).toBe(input);
        expect(input.selectionStart).toBe(0);
        expect(input.selectionEnd).toBe(2);
        expect(input.scrollLeft).toBe(19);
    });

    it("dispatches one complete Input change for selection-only movement and deduplicates the same input tuple", () => {
        const node = {
            kind: "input" as const,
            id: "selection-input",
            value: "abcdef",
            cursor: 6,
            focused: true,
            selectionstart: 6,
            selectionend: 6,
        };
        const extUi: PiExtUiState = {
            statuses: {},
            widgets: {},
            widgetnodes: { input: node },
            renderedEntries: [],
            request: null,
        };
        const events: AgentWidgetEvent[] = [];
        const { container } = renderAgentExtUiPanel(extUi, (event) => events.push(event));
        const input = container.querySelector('[aria-label="Input selection-input"]') as HTMLInputElement;

        focusElement(input);
        events.length = 0;
        input.setSelectionRange(1, 4);
        act(() => {
            document.dispatchEvent(new Event("selectionchange", { bubbles: true }));
            input.dispatchEvent(new KeyboardEvent("keyup", { key: "ArrowLeft", bubbles: true }));
        });
        changeInput(input, "abcdef");

        expect(events).toHaveLength(1);
        expect(events[0]).toEqual({
            nodeid: "selection-input",
            type: "change",
            eventid: expect.any(String),
            payload: { value: "abcdef", selectionstart: 1, selectionend: 4 },
        });
    });

    it("wires Input composition events without dispatching intermediate synthetic text", () => {
        const extUi: PiExtUiState = {
            statuses: {},
            widgets: {},
            widgetnodes: {
                input: {
                    kind: "input",
                    id: "composition-input",
                    value: "",
                    cursor: 0,
                    focused: true,
                    selectionstart: 0,
                    selectionend: 0,
                },
            },
            renderedEntries: [],
            request: null,
        };
        const events: AgentWidgetEvent[] = [];
        const { container, rerender } = renderAgentExtUiPanel(extUi, (event) => events.push(event));
        const input = container.querySelector('[aria-label="Input composition-input"]') as HTMLInputElement;

        act(() => {
            input.dispatchEvent(new CompositionEvent("compositionstart", { bubbles: true, data: "" }));
        });
        changeInput(input, "日");
        changeInput(input, "日本");
        rerender(extUi);
        expect(input.value).toBe("日本");
        expect(events).toEqual([]);

        input.setSelectionRange(2, 2);
        act(() => {
            input.dispatchEvent(new CompositionEvent("compositionend", { bubbles: true, data: "日本" }));
        });

        expect(events).toEqual([
            {
                nodeid: "composition-input",
                type: "change",
                eventid: expect.any(String),
                payload: { value: "日本", selectionstart: 2, selectionend: 2 },
            },
        ]);
    });

    it("leaves Input Enter and Escape native while composition owns the control", () => {
        const extUi: PiExtUiState = {
            statuses: {},
            widgets: {},
            widgetnodes: {
                input: {
                    kind: "input",
                    id: "composition-actions-input",
                    value: "",
                    cursor: 0,
                    focused: true,
                    selectionstart: 0,
                    selectionend: 0,
                },
            },
            renderedEntries: [],
            request: null,
        };
        const events: AgentWidgetEvent[] = [];
        const { container } = renderAgentExtUiPanel(extUi, (event) => events.push(event));
        const input = container.querySelector(
            '[aria-label="Input composition-actions-input"]'
        ) as HTMLInputElement;

        act(() => {
            input.dispatchEvent(new CompositionEvent("compositionstart", { bubbles: true, data: "" }));
        });
        const enter = dispatchKeyDown(input, "Enter");
        const escape = dispatchKeyDown(input, "Escape");

        expect(enter.defaultPrevented).toBe(false);
        expect(escape.defaultPrevented).toBe(false);
        expect(events).toEqual([]);
    });

    it("does not dispatch a removed synthetic Input composition buffer", () => {
        const extUi: PiExtUiState = {
            statuses: {},
            widgets: {},
            widgetnodes: {
                input: {
                    kind: "input",
                    id: "removed-composition-input",
                    value: "server",
                    cursor: 6,
                    focused: true,
                    selectionstart: 6,
                    selectionend: 6,
                },
            },
            renderedEntries: [],
            request: null,
        };
        const events: AgentWidgetEvent[] = [];
        const { container, rerender } = renderAgentExtUiPanel(extUi, (event) => events.push(event));
        const input = container.querySelector(
            '[aria-label="Input removed-composition-input"]'
        ) as HTMLInputElement;

        act(() => {
            input.dispatchEvent(new CompositionEvent("compositionstart", { bubbles: true, data: "" }));
        });
        changeInput(input, "partial");
        rerender({ ...extUi, widgetnodes: {} });
        act(() => {
            input.dispatchEvent(new CompositionEvent("compositionend", { bubbles: true, data: "partial" }));
        });

        expect(events).toEqual([]);
    });

    it("leaves Input cut and paste DOM events native and dispatches subsequent complete input payloads", () => {
        const extUi: PiExtUiState = {
            statuses: {},
            widgets: {},
            widgetnodes: {
                input: {
                    kind: "input",
                    id: "native-input",
                    value: "alpha beta",
                    cursor: 10,
                    focused: false,
                    selectionstart: 10,
                    selectionend: 10,
                },
            },
            renderedEntries: [],
            request: null,
        };
        const events: AgentWidgetEvent[] = [];
        const { container } = renderAgentExtUiPanel(extUi, (event) => events.push(event));
        const input = container.querySelector('[aria-label="Input native-input"]') as HTMLInputElement;

        focusElement(input);
        const ordinaryKeys = [
            dispatchKeyDown(input, "a"),
            dispatchKeyDown(input, "Backspace"),
            dispatchKeyDown(input, "Home"),
            dispatchKeyDown(input, "ArrowLeft"),
            dispatchKeyDown(input, "v"),
        ];
        input.setSelectionRange(6, 10);
        act(() => {
            input.dispatchEvent(new Event("select", { bubbles: true }));
        });
        changeInput(input, "alpha 世界");
        input.setSelectionRange(6, 8);

        const cut = new Event("cut", { bubbles: true, cancelable: true });
        act(() => {
            input.dispatchEvent(cut);
        });
        changeInput(input, "alpha ");
        input.setSelectionRange(6, 6);

        const paste = new Event("paste", { bubbles: true, cancelable: true });
        act(() => {
            input.dispatchEvent(paste);
        });
        changeInput(input, "alpha 日本");
        input.setSelectionRange(8, 8);
        blurElement(input);

        expect(ordinaryKeys.every((event) => !event.defaultPrevented)).toBe(true);
        expect(cut.defaultPrevented).toBe(false);
        expect(paste.defaultPrevented).toBe(false);
        expect(events.map(({ eventid: _eventid, ...event }) => event)).toEqual([
            { nodeid: "native-input", type: "focus", payload: { focused: true } },
            {
                nodeid: "native-input",
                type: "change",
                payload: { value: "alpha 世界", selectionstart: 8, selectionend: 8 },
            },
            {
                nodeid: "native-input",
                type: "change",
                payload: { value: "alpha ", selectionstart: 6, selectionend: 6 },
            },
            {
                nodeid: "native-input",
                type: "change",
                payload: { value: "alpha 日本", selectionstart: 8, selectionend: 8 },
            },
            { nodeid: "native-input", type: "focus", payload: { focused: false } },
        ]);
        expect(new Set(events.map((event) => event.eventid)).size).toBe(events.length);
        expect(events.every((event) => typeof event.eventid === "string" && event.eventid.length > 0)).toBe(true);
        expect(events.some((event) => event.type === "key")).toBe(false);
    });

    it("flushes the latest Input DOM value before keyboard and button submit", () => {
        const extUi: PiExtUiState = {
            statuses: {},
            widgets: {},
            widgetnodes: {
                input: {
                    kind: "input",
                    id: "submit-input",
                    value: "draft",
                    cursor: 5,
                    focused: true,
                    selectionstart: 5,
                    selectionend: 5,
                },
            },
            renderedEntries: [],
            request: null,
        };
        const events: AgentWidgetEvent[] = [];
        const { container } = renderAgentExtUiPanel(extUi, (event) => events.push(event));
        const input = container.querySelector('[aria-label="Input submit-input"]') as HTMLInputElement;
        const buttons = Array.from(container.querySelectorAll("button"));
        const cancelButton = buttons.find((button) => button.textContent === "Cancel") as HTMLButtonElement;
        const submitButton = buttons.find((button) => button.textContent === "Submit") as HTMLButtonElement;

        setInputValue(input, "keyboard latest");
        input.setSelectionRange(2, 8);
        const enter = dispatchKeyDown(input, "Enter");

        setInputValue(input, "button latest");
        input.setSelectionRange(6, 6);
        clickElement(submitButton);
        const escape = dispatchKeyDown(input, "Escape");
        clickElement(cancelButton);

        expect(enter.defaultPrevented).toBe(true);
        expect(escape.defaultPrevented).toBe(true);
        expect(events.map(({ eventid: _eventid, ...event }) => event)).toEqual([
            {
                nodeid: "submit-input",
                type: "submit",
                payload: { value: "keyboard latest", selectionstart: 2, selectionend: 8 },
            },
            {
                nodeid: "submit-input",
                type: "submit",
                payload: { value: "button latest", selectionstart: 6, selectionend: 6 },
            },
            widgetInputCancelEvent("submit-input"),
            widgetInputCancelEvent("submit-input"),
        ]);
        expect(new Set(events.map((event) => event.eventid)).size).toBe(events.length);
    });

    it("restores a rejected Input edit from the next authoritative snapshot", () => {
        const extUi: PiExtUiState = {
            statuses: {},
            widgets: {},
            widgetnodes: {
                input: {
                    kind: "input",
                    id: "rejected-input",
                    value: "server",
                    cursor: 6,
                    focused: true,
                    selectionstart: 2,
                    selectionend: 4,
                },
            },
            renderedEntries: [],
            request: null,
        };
        const events: AgentWidgetEvent[] = [];
        const { container, rerender } = renderAgentExtUiPanel(extUi, (event) => events.push(event));
        const input = container.querySelector('[aria-label="Input rejected-input"]') as HTMLInputElement;

        changeInput(input, "rejected local edit");
        input.setSelectionRange(19, 19);
        const eventid = events[0].eventid;
        rerender({
            ...extUi,
            widgetnodes: {
                input: { ...(extUi.widgetnodes.input as any), ackid: eventid },
            },
        });

        expect(container.querySelector('[aria-label="Input rejected-input"]')).toBe(input);
        expect(input.value).toBe("server");
        expect(input.selectionStart).toBe(2);
        expect(input.selectionEnd).toBe(4);
    });

    it("keeps SettingsList selection, cycling, activation, and cancellation Pi-authoritative", () => {
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
                    maxvisible: 2,
                    searchenabled: true,
                    focused: true,
                    filter: "",
                    visiblestart: 0,
                    visibleend: 2,
                    nomatch: false,
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
        expect(container.querySelector('input[aria-label="Filter settings-1"]')).toBeTruthy();
        expect(modeOption.querySelector("button")).toBeNull();
        expect(themeOption.getAttribute("aria-selected")).toBe("false");
        expect(themeOption.querySelector("button")).toBeNull();

        clickElement(themeOption);
        keyDownElement(listbox, "ArrowRight");
        keyDownElement(listbox, "ArrowLeft");
        keyDownElement(listbox, "ArrowDown");
        keyDownElement(listbox, "ArrowUp");
        keyDownElement(listbox, "Enter");
        keyDownElement(listbox, " ");
        keyDownElement(listbox, "Escape");
        doubleClickElement(themeOption);

        expect(events).toEqual([
            { nodeid: "settings-1", type: "select", payload: { index: 1 } },
            { nodeid: "settings-1", type: "cycle", payload: { direction: 1 } },
            { nodeid: "settings-1", type: "cycle", payload: { direction: -1 } },
            widgetKeyEvent("settings-1", "\x1b[B"),
            widgetKeyEvent("settings-1", "\x1b[A"),
            { nodeid: "settings-1", type: "submit" },
            { nodeid: "settings-1", type: "submit" },
            widgetCancelEvent("settings-1"),
            { nodeid: "settings-1", type: "submit", payload: { index: 1 } },
        ]);
        expect(listbox.getAttribute("aria-activedescendant")).toBe("settings-1-option-0");
        expect(modeOption.getAttribute("aria-selected")).toBe("true");
        expect(themeOption.getAttribute("aria-selected")).toBe("false");
        expect(modeOption.textContent).toContain("fast");
        expect(themeOption.textContent).toContain("dark");

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

    it("keeps search-disabled SettingsList keyboard-only and rejects filter UI", () => {
        const extUi: PiExtUiState = {
            statuses: {},
            widgets: {},
            widgetnodes: {
                settings: {
                    kind: "settingslist",
                    id: "settings-no-search",
                    items: [
                        { id: "mode", label: "Mode", currentvalue: "fast", values: ["fast", "safe"] },
                        { id: "theme", label: "Theme", currentvalue: "dark", values: ["dark", "light"] },
                    ],
                    selectedindex: 0,
                    maxvisible: 2,
                    searchenabled: false,
                    focused: true,
                    visiblestart: 0,
                    visibleend: 2,
                    nomatch: false,
                },
            },
            renderedEntries: [],
            request: null,
        };
        const events: AgentWidgetEvent[] = [];
        const { container } = renderAgentExtUiPanel(extUi, (event) => events.push(event));
        const listbox = container.querySelector(
            '[aria-label="Settings list settings-no-search"]'
        ) as HTMLElement;

        expect(container.querySelector('input[aria-label="Filter settings-no-search"]')).toBeNull();
        expect(listbox.tabIndex).toBe(0);
        focusElement(listbox);
        keyDownElement(listbox, "ArrowDown");
        keyDownElement(listbox, "Enter");
        keyDownElement(listbox, "Escape");

        expect(document.activeElement).toBe(listbox);
        expect(events).toEqual([
            { nodeid: "settings-no-search", type: "focus", payload: { focused: true } },
            widgetKeyEvent("settings-no-search", "\x1b[B"),
            { nodeid: "settings-no-search", type: "submit" },
            widgetCancelEvent("settings-no-search"),
        ]);
    });

    it("hands SettingsList keyboard focus to a submenu and restores searchable parent focus after completion", () => {
        const parent = {
            kind: "settingslist" as const,
            id: "settings-focus-complete",
            items: [
                { id: "mode", label: "Mode", currentvalue: "fast", values: ["fast", "safe"] },
                { id: "theme", label: "Theme", currentvalue: "dark" },
            ],
            selectedindex: 0,
            maxvisible: 2,
            searchenabled: true,
            focused: true,
            filter: "",
            visiblestart: 0,
            visibleend: 2,
            nomatch: false,
        };
        const extUi: PiExtUiState = {
            statuses: {},
            widgets: {},
            widgetnodes: { settings: parent },
            renderedEntries: [],
            request: null,
        };
        const events: AgentWidgetEvent[] = [];
        const { container, rerender } = renderAgentExtUiPanel(extUi, (event) => events.push(event));
        const parentFilter = container.querySelector(
            'input[aria-label="Filter settings-focus-complete"]'
        ) as HTMLInputElement;

        focusElement(parentFilter);
        keyDownElement(parentFilter, "ArrowDown");
        keyDownElement(parentFilter, "Enter");
        expect(events.slice(-2)).toEqual([
            widgetKeyEvent("settings-focus-complete", "\x1b[B"),
            { nodeid: "settings-focus-complete", type: "submit" },
        ]);

        rerender({
            ...extUi,
            widgetnodes: {
                settings: {
                    ...parent,
                    selectedindex: 1,
                    submenu: {
                        kind: "selectlist",
                        id: "theme-focus-complete",
                        items: [
                            { value: "dark", label: "Dark" },
                            { value: "light", label: "Light" },
                        ],
                        selectedindex: 0,
                        maxvisible: 2,
                        focused: false,
                        filter: "",
                        visiblestart: 0,
                        visibleend: 2,
                        nomatch: false,
                    },
                },
            },
        });

        const childFilter = container.querySelector(
            'input[aria-label="Filter theme-focus-complete"]'
        ) as HTMLInputElement;
        expect(document.activeElement).toBe(childFilter);
        expect(events.at(-1)).toEqual({
            nodeid: "theme-focus-complete",
            type: "focus",
            payload: { focused: true },
        });

        keyDownElement(childFilter, "ArrowDown");
        keyDownElement(childFilter, "Enter");
        expect(events.slice(-2)).toEqual([
            widgetKeyEvent("theme-focus-complete", "\x1b[B"),
            widgetKeyEvent("theme-focus-complete", "\n"),
        ]);

        rerender({
            ...extUi,
            widgetnodes: {
                settings: {
                    ...parent,
                    items: [
                        parent.items[0],
                        { id: "theme", label: "Theme", currentvalue: "light" },
                    ],
                    selectedindex: 1,
                },
            },
        });

        const restoredFilter = container.querySelector(
            'input[aria-label="Filter settings-focus-complete"]'
        ) as HTMLInputElement;
        const restoredOption = container.querySelector("#settings-focus-complete-option-1") as HTMLElement;
        expect(document.activeElement).toBe(restoredFilter);
        expect(restoredOption.getAttribute("aria-selected")).toBe("true");
        expect(restoredOption.textContent).toContain("light");
    });

    it("restores search-disabled SettingsList listbox focus and selection after submenu Escape", () => {
        const parent = {
            kind: "settingslist" as const,
            id: "settings-focus-cancel",
            items: [
                { id: "mode", label: "Mode", currentvalue: "fast", values: ["fast", "safe"] },
                { id: "theme", label: "Theme", currentvalue: "dark" },
            ],
            selectedindex: 1,
            maxvisible: 2,
            searchenabled: false,
            focused: true,
            visiblestart: 0,
            visibleend: 2,
            nomatch: false,
        };
        const extUi: PiExtUiState = {
            statuses: {},
            widgets: {},
            widgetnodes: { settings: parent },
            renderedEntries: [],
            request: null,
        };
        const events: AgentWidgetEvent[] = [];
        const { container, rerender } = renderAgentExtUiPanel(extUi, (event) => events.push(event));
        const parentListbox = container.querySelector(
            '[aria-label="Settings list settings-focus-cancel"]'
        ) as HTMLElement;

        focusElement(parentListbox);
        keyDownElement(parentListbox, "Enter");
        expect(events.at(-1)).toEqual({ nodeid: "settings-focus-cancel", type: "submit" });

        rerender({
            ...extUi,
            widgetnodes: {
                settings: {
                    ...parent,
                    submenu: {
                        kind: "selectlist",
                        id: "theme-focus-cancel",
                        items: [
                            { value: "dark", label: "Dark" },
                            { value: "light", label: "Light" },
                        ],
                        selectedindex: 0,
                        maxvisible: 2,
                        focused: false,
                        filter: "",
                        visiblestart: 0,
                        visibleend: 2,
                        nomatch: false,
                    },
                },
            },
        });

        const childFilter = container.querySelector(
            'input[aria-label="Filter theme-focus-cancel"]'
        ) as HTMLInputElement;
        expect(document.activeElement).toBe(childFilter);
        keyDownElement(childFilter, "Escape");
        expect(events.at(-1)).toEqual(widgetKeyEvent("theme-focus-cancel", "\x1b"));

        rerender(extUi);

        const restoredListbox = container.querySelector(
            '[aria-label="Settings list settings-focus-cancel"]'
        ) as HTMLElement;
        const restoredOption = container.querySelector("#settings-focus-cancel-option-1") as HTMLElement;
        expect(document.activeElement).toBe(restoredListbox);
        expect(restoredOption.getAttribute("aria-selected")).toBe("true");
        expect(restoredOption.textContent).toContain("dark");
    });

    it("does not hand off focus when a SettingsList submenu opens while the parent DOM is unfocused", () => {
        const parent = {
            kind: "settingslist" as const,
            id: "settings-callback-open",
            items: [{ id: "theme", label: "Theme", currentvalue: "dark" }],
            selectedindex: 0,
            maxvisible: 1,
            searchenabled: true,
            focused: true,
            filter: "",
            visiblestart: 0,
            visibleend: 1,
            nomatch: false,
        };
        const extUi: PiExtUiState = {
            statuses: {},
            widgets: {},
            widgetnodes: { settings: parent },
            renderedEntries: [],
            request: null,
        };
        const events: AgentWidgetEvent[] = [];
        const outside = document.createElement("button");
        outside.textContent = "Composer";
        document.body.appendChild(outside);
        const { container, rerender } = renderAgentExtUiPanel(extUi, (event) => events.push(event));

        focusElement(outside);
        events.length = 0;
        rerender({
            ...extUi,
            widgetnodes: {
                settings: {
                    ...parent,
                    submenu: {
                        kind: "selectlist",
                        id: "theme-callback-open",
                        items: [{ value: "dark", label: "Dark" }],
                        selectedindex: 0,
                        maxvisible: 1,
                        focused: false,
                        filter: "",
                        visiblestart: 0,
                        visibleend: 1,
                        nomatch: false,
                    },
                },
            },
        });

        expect(container.querySelector('input[aria-label="Filter theme-callback-open"]')).toBeTruthy();
        expect(document.activeElement).toBe(outside);
        expect(events).not.toContainEqual({
            nodeid: "theme-callback-open",
            type: "focus",
            payload: { focused: true },
        });
    });

    it("does not restore SettingsList focus after its submenu moves focus to the composer", () => {
        const parent = {
            kind: "settingslist" as const,
            id: "settings-external-close",
            items: [{ id: "theme", label: "Theme", currentvalue: "dark" }],
            selectedindex: 0,
            maxvisible: 1,
            searchenabled: true,
            focused: true,
            filter: "",
            visiblestart: 0,
            visibleend: 1,
            nomatch: false,
        };
        const extUi: PiExtUiState = {
            statuses: {},
            widgets: {},
            widgetnodes: { settings: parent },
            renderedEntries: [],
            request: null,
        };
        const events: AgentWidgetEvent[] = [];
        const composer = document.createElement("textarea");
        composer.setAttribute("aria-label", "Composer");
        document.body.appendChild(composer);
        const { container, rerender } = renderAgentExtUiPanel(extUi, (event) => events.push(event));
        const parentFilter = container.querySelector(
            'input[aria-label="Filter settings-external-close"]'
        ) as HTMLInputElement;

        focusElement(parentFilter);
        rerender({
            ...extUi,
            widgetnodes: {
                settings: {
                    ...parent,
                    submenu: {
                        kind: "selectlist",
                        id: "theme-external-close",
                        items: [{ value: "dark", label: "Dark" }],
                        selectedindex: 0,
                        maxvisible: 1,
                        focused: false,
                        filter: "",
                        visiblestart: 0,
                        visibleend: 1,
                        nomatch: false,
                    },
                },
            },
        });
        const childFilter = container.querySelector(
            'input[aria-label="Filter theme-external-close"]'
        ) as HTMLInputElement;
        expect(document.activeElement).toBe(childFilter);

        focusElement(composer);
        expect(document.activeElement).toBe(composer);
        events.length = 0;
        rerender(extUi);

        expect(document.activeElement).toBe(composer);
        expect(events).not.toContainEqual({
            nodeid: "settings-external-close",
            type: "focus",
            payload: { focused: true },
        });
    });

    it("aborts an unfinished SettingsList composition when a submenu opens", () => {
        const parent = {
            kind: "settingslist" as const,
            id: "settings-composition-submenu",
            items: [{ id: "theme", label: "Theme", currentvalue: "dark" }],
            selectedindex: 0,
            maxvisible: 1,
            searchenabled: true,
            focused: true,
            filter: "server",
            visiblestart: 0,
            visibleend: 1,
            nomatch: false,
        };
        const extUi: PiExtUiState = {
            statuses: {},
            widgets: {},
            widgetnodes: { settings: parent },
            renderedEntries: [],
            request: null,
        };
        const events: AgentWidgetEvent[] = [];
        const { container, rerender } = renderAgentExtUiPanel(extUi, (event) => events.push(event));
        const parentFilter = container.querySelector(
            'input[aria-label="Filter settings-composition-submenu"]'
        ) as HTMLInputElement;

        focusElement(parentFilter);
        events.length = 0;
        act(() => {
            parentFilter.dispatchEvent(new CompositionEvent("compositionstart", { bubbles: true, data: "" }));
        });
        changeInput(parentFilter, "partial");
        expect(events).toEqual([]);

        rerender({
            ...extUi,
            widgetnodes: {
                settings: {
                    ...parent,
                    submenu: {
                        kind: "selectlist",
                        id: "theme-composition-submenu",
                        items: [{ value: "dark", label: "Dark" }],
                        selectedindex: 0,
                        maxvisible: 1,
                        focused: false,
                        filter: "",
                        visiblestart: 0,
                        visibleend: 1,
                        nomatch: false,
                    },
                },
            },
        });
        expect(events.filter((event) => event.type === "change")).toEqual([]);

        rerender(extUi);
        const restoredFilter = container.querySelector(
            'input[aria-label="Filter settings-composition-submenu"]'
        ) as HTMLInputElement;
        expect(restoredFilter.value).toBe("server");

        changeInput(restoredFilter, "fresh");
        expect(events.filter((event) => event.type === "change")).toEqual([
            {
                nodeid: "settings-composition-submenu",
                type: "change",
                payload: { filter: "fresh" },
            },
        ]);
    });

    it("does not hand off SettingsList focus when it moves to the composer during submenu commit", () => {
        const parent = {
            kind: "settingslist" as const,
            id: "settings-commit-focus",
            items: [{ id: "theme", label: "Theme", currentvalue: "dark" }],
            selectedindex: 0,
            maxvisible: 1,
            searchenabled: true,
            focused: true,
            filter: "",
            visiblestart: 0,
            visibleend: 1,
            nomatch: false,
        };
        const extUi: PiExtUiState = {
            statuses: {},
            widgets: {},
            widgetnodes: { settings: parent },
            renderedEntries: [],
            request: null,
        };
        const events: AgentWidgetEvent[] = [];
        const composer = document.createElement("textarea");
        composer.setAttribute("aria-label", "Composer during commit");
        document.body.appendChild(composer);
        const { container, rerender } = renderAgentExtUiPanel(extUi, (event) => events.push(event));
        const parentFilter = container.querySelector(
            'input[aria-label="Filter settings-commit-focus"]'
        ) as HTMLInputElement;
        focusElement(parentFilter);
        events.length = 0;

        const appendChild = Node.prototype.appendChild;
        const appendSpy = vi.spyOn(Node.prototype, "appendChild").mockImplementation(function <T extends Node>(
            this: Node,
            child: T
        ): T {
            const result = appendChild.call(this, child) as T;
            if (
                child instanceof Element &&
                child.querySelector('input[aria-label="Filter theme-commit-focus"]')
            ) {
                composer.focus();
            }
            return result;
        });
        try {
            rerender({
                ...extUi,
                widgetnodes: {
                    settings: {
                        ...parent,
                        submenu: {
                            kind: "selectlist",
                            id: "theme-commit-focus",
                            items: [{ value: "dark", label: "Dark" }],
                            selectedindex: 0,
                            maxvisible: 1,
                            focused: false,
                            filter: "",
                            visiblestart: 0,
                            visibleend: 1,
                            nomatch: false,
                        },
                    },
                },
            });
        } finally {
            appendSpy.mockRestore();
        }

        expect(document.activeElement).toBe(composer);
        expect(events).not.toContainEqual({
            nodeid: "theme-commit-focus",
            type: "focus",
            payload: { focused: true },
        });
    });

    it("routes SettingsList fuzzy search and active submenu through authoritative snapshots", () => {
        const extUi: PiExtUiState = {
            statuses: {},
            widgets: {},
            widgetnodes: {
                settings: {
                    kind: "settingslist",
                    id: "settings-search",
                    items: [
                        { id: "mode", label: "Mode", currentvalue: "fast", values: ["fast", "safe"] },
                        { id: "theme", label: "Theme", currentvalue: "dark" },
                    ],
                    selectedindex: 0,
                    maxvisible: 2,
                    searchenabled: true,
                    focused: true,
                    filter: "",
                    visiblestart: 0,
                    visibleend: 2,
                    nomatch: false,
                } as any,
            },
            renderedEntries: [],
            request: null,
        };
        const events: AgentWidgetEvent[] = [];
        const { container, rerender } = renderAgentExtUiPanel(extUi, (event) => events.push(event));
        const filter = container.querySelector('input[aria-label="Filter settings-search"]') as HTMLInputElement;

        focusElement(filter);
        act(() => {
            filter.dispatchEvent(new CompositionEvent("compositionstart", { bubbles: true, data: "" }));
        });
        changeInput(filter, "日");
        changeInput(filter, "日本");
        rerender(extUi);

        expect(filter.value).toBe("日本");
        expect(events).toEqual([
            { nodeid: "settings-search", type: "focus", payload: { focused: true } },
        ]);

        act(() => {
            filter.dispatchEvent(new CompositionEvent("compositionend", { bubbles: true, data: "日本" }));
        });
        expect(events.at(-1)).toEqual({
            nodeid: "settings-search",
            type: "change",
            payload: { filter: "日本" },
        });

        rerender({
            ...extUi,
            widgetnodes: {
                settings: {
                    ...(extUi.widgetnodes.settings as any),
                    filter: "日本",
                } as any,
            },
        });
        rerender({
            ...extUi,
            widgetnodes: {
                settings: {
                    ...(extUi.widgetnodes.settings as any),
                    filter: "theme",
                    selectedindex: 1,
                    visiblestart: 1,
                    visibleend: 2,
                    submenu: {
                        kind: "selectlist",
                        id: "theme-submenu",
                        items: [
                            { value: "dark", label: "Dark" },
                            { value: "light", label: "Light" },
                        ],
                        selectedindex: 0,
                        maxvisible: 2,
                        focused: true,
                        filter: "",
                        visiblestart: 0,
                        visibleend: 2,
                        nomatch: false,
                    },
                } as any,
            },
        });

        expect(container.querySelector('[aria-label="Settings list settings-search"]')).toBeNull();
        const submenu = container.querySelector('[aria-label="Select list theme-submenu"]') as HTMLElement;
        expect(submenu).toBeTruthy();
        clickElement(container.querySelector("#theme-submenu-option-1") as HTMLElement);
        expect(events.at(-1)).toEqual(widgetSelectEvent("theme-submenu", 1));
        const submenuCancel = Array.from(container.querySelectorAll("button")).find(
            (button) => button.textContent === "Cancel"
        ) as HTMLButtonElement;
        clickElement(submenuCancel);
        expect(events.at(-1)).toEqual(widgetCancelEvent("theme-submenu"));

        rerender({
            ...extUi,
            widgetnodes: {
                settings: {
                    ...(extUi.widgetnodes.settings as any),
                    items: [
                        { id: "mode", label: "Mode", currentvalue: "fast", values: ["fast", "safe"] },
                        { id: "theme", label: "Theme", currentvalue: "light" },
                    ],
                    selectedindex: 1,
                    filter: "theme",
                    visiblestart: 1,
                    visibleend: 2,
                } as any,
            },
        });

        const restoredFilter = container.querySelector(
            'input[aria-label="Filter settings-search"]'
        ) as HTMLInputElement;
        const restoredTheme = container.querySelector("#settings-search-option-1") as HTMLElement;
        expect(restoredFilter.value).toBe("theme");
        expect(restoredTheme.getAttribute("aria-selected")).toBe("true");
        expect(restoredTheme.textContent).toContain("light");
    });

    it("limits SettingsList DOM rows and exposes listbox ARIA state", () => {
        const items = ["Alpha", "Beta", "Charlie", "Delta", "Echo"].map((label, index) => ({
            id: label.toLowerCase(),
            label,
            description: index === 3 ? "Selected description" : undefined,
            currentvalue: `value-${index}`,
            values: [`value-${index}`, `next-${index}`],
        }));
        const extUi: PiExtUiState = {
            statuses: {},
            widgets: {},
            widgetnodes: {
                settings: {
                    kind: "settingslist",
                    id: "settings-window",
                    items,
                    selectedindex: 3,
                    maxvisible: 2,
                    searchenabled: true,
                    focused: true,
                    filter: "a",
                    visiblestart: 2,
                    visibleend: 4,
                    nomatch: false,
                } as any,
            },
            renderedEntries: [],
            request: null,
        };
        const events: AgentWidgetEvent[] = [];
        const { container, rerender } = renderAgentExtUiPanel(extUi, (event) => events.push(event));
        const listbox = container.querySelector('[aria-label="Settings list settings-window"]') as HTMLElement;
        const options = Array.from(listbox.querySelectorAll('[role="option"]'));

        expect(options).toHaveLength(2);
        expect(options.map((option) => option.textContent)).toEqual([
            expect.stringContaining("Charlie"),
            expect.stringContaining("Delta"),
        ]);
        expect(options[1].textContent).toContain("Selected description");
        expect(options[1].textContent).toContain("value-3");
        expect(options[1].getAttribute("aria-selected")).toBe("true");
        expect(listbox.getAttribute("aria-activedescendant")).toBe("settings-window-option-3");

        clickElement(options[0]);
        expect(events).toEqual([widgetSelectEvent("settings-window", 2)]);
        expect(options[1].getAttribute("aria-selected")).toBe("true");

        rerender({
            ...extUi,
            widgetnodes: {
                settings: {
                    ...(extUi.widgetnodes.settings as any),
                    items: [],
                    selectedindex: 0,
                    filter: "missing",
                    visiblestart: 0,
                    visibleend: 0,
                    nomatch: true,
                } as any,
            },
        });

        expect(container.textContent).toContain("No matching settings");
        const emptyListbox = container.querySelector('[aria-label="Settings list settings-window"]') as HTMLElement;
        expect(emptyListbox.getAttribute("aria-activedescendant")).toBeNull();
        keyDownElement(emptyListbox, "Enter");
        expect(events.filter((event) => event.type === "submit")).toEqual([]);
    });

    it("preserves Editor node identity, selection metadata, paste wiring, and scroll state across snapshot echoes", () => {
        const extUi = makeEditorState({
            value: "first line\nsecond line",
            selectionstart: 3,
            selectionend: 14,
        });
        const events: AgentWidgetEvent[] = [];
        const { container, rerender } = renderAgentExtUiPanel(extUi, (event) => events.push(event));
        const editor = container.querySelector('textarea[aria-label="Editor editor-1"]') as HTMLTextAreaElement;
        editor.setSelectionRange(3, 14);
        editor.scrollTop = 72;
        focusElement(editor);

        const cut = new Event("cut", { bubbles: true, cancelable: true });
        const paste = new Event("paste", { bubbles: true, cancelable: true });
        act(() => {
            editor.dispatchEvent(cut);
            editor.dispatchEvent(paste);
        });
        changeTextArea(editor, "first line\npasted line");
        editor.setSelectionRange(11, 22);
        const eventid = events.find((event) => event.type === "change")?.eventid;

        rerender({
            ...extUi,
            widgetnodes: {
                editor: {
                    ...(extUi.widgetnodes.editor as Extract<WidgetNode, { kind: "editor" }>),
                    value: "first line\npasted line",
                    lines: ["first line", "pasted line"],
                    selectionstart: 11,
                    selectionend: 22,
                    ackid: eventid,
                },
            },
        });

        const echoedEditor = container.querySelector('textarea[aria-label="Editor editor-1"]') as HTMLTextAreaElement;
        expect(echoedEditor).toBe(editor);
        expect(document.activeElement).toBe(editor);
        expect(editor.selectionStart).toBe(11);
        expect(editor.selectionEnd).toBe(22);
        expect(editor.scrollTop).toBe(72);
        expect(cut.defaultPrevented).toBe(false);
        expect(paste.defaultPrevented).toBe(false);
        expect(events.map(({ eventid: _eventid, ...event }) => event)).toEqual([
            { nodeid: "editor-1", type: "focus", payload: { focused: true } },
            {
                nodeid: "editor-1",
                type: "change",
                payload: {
                    value: "first line\npasted line",
                    selectionstart: 22,
                    selectionend: 22,
                },
            },
        ]);
        expect(eventid).toEqual(expect.any(String));
    });

    it("does not revive an older pending Editor after a newer submit is accepted unpublished", async () => {
        const extUi = makeEditorState({ value: "", selectionstart: 0, selectionend: 0 });
        const outcomes: Array<(result: { handled: boolean; published: boolean }) => void> = [];
        const events: AgentWidgetEvent[] = [];
        const { container } = renderAgentExtUiPanel(extUi, (event) => {
            events.push(event);
            return new Promise((resolve) => outcomes.push(resolve));
        });
        const editor = container.querySelector('textarea[aria-label="Editor editor-1"]') as HTMLTextAreaElement;

        changeTextArea(editor, "A");
        setTextAreaValue(editor, "B");
        editor.setSelectionRange(1, 1);
        dispatchKeyDown(editor, "Enter");
        await act(async () => {
            outcomes[1]({ handled: true, published: false });
            await Promise.resolve();
        });
        act(() => {
            editor.dispatchEvent(new Event("select", { bubbles: true }));
            editor.dispatchEvent(new Event("input", { bubbles: true, cancelable: true }));
        });

        expect(events).toHaveLength(2);
        expect(events.map((event) => event.type)).toEqual(["change", "submit"]);
        expect(events[1].payload).toEqual({ value: "B", selectionstart: 1, selectionend: 1 });
    });

    it("settles a stale exact Editor ack without overwriting a newer accepted tuple", async () => {
        const extUi = makeEditorState({ value: "", selectionstart: 0, selectionend: 0 });
        const outcomes: Array<(result: { handled: boolean; published: boolean }) => void> = [];
        const events: AgentWidgetEvent[] = [];
        const { container, rerender } = renderAgentExtUiPanel(extUi, (event) => {
            events.push(event);
            return new Promise((resolve) => outcomes.push(resolve));
        });
        const editor = container.querySelector('textarea[aria-label="Editor editor-1"]') as HTMLTextAreaElement;

        changeTextArea(editor, "A");
        const changeId = events[0].eventid;
        setTextAreaValue(editor, "B");
        editor.setSelectionRange(0, 1);
        editor.scrollTop = 41;
        dispatchKeyDown(editor, "Enter");
        await act(async () => {
            outcomes[1]({ handled: true, published: false });
            await Promise.resolve();
        });

        rerender({
            ...extUi,
            widgetnodes: {
                editor: {
                    ...(extUi.widgetnodes.editor as Extract<WidgetNode, { kind: "editor" }>),
                    value: "A",
                    lines: ["A"],
                    cursorcol: 1,
                    selectionstart: 1,
                    selectionend: 1,
                    ackid: changeId,
                },
            },
        });
        expect(container.querySelector('textarea[aria-label="Editor editor-1"]')).toBe(editor);
        expect(editor.value).toBe("B");
        expect(editor.selectionStart).toBe(0);
        expect(editor.selectionEnd).toBe(1);
        expect(editor.scrollTop).toBe(41);

        rerender({
            ...extUi,
            widgetnodes: {
                editor: {
                    ...(extUi.widgetnodes.editor as Extract<WidgetNode, { kind: "editor" }>),
                    value: "C",
                    lines: ["C"],
                    cursorcol: 1,
                    selectionstart: 0,
                    selectionend: 1,
                },
            },
        });
        expect(editor.value).toBe("C");
        expect(editor.selectionStart).toBe(0);
        expect(editor.selectionEnd).toBe(1);
        expect(editor.scrollTop).toBe(41);
    });

    it("reconciles same-value Editor selection snapshots without replacing or scrolling the node", () => {
        const extUi = makeEditorState({ value: "same", selectionstart: 4, selectionend: 4 });
        const events: AgentWidgetEvent[] = [];
        const { container, rerender } = renderAgentExtUiPanel(extUi, async (event) => {
            events.push(event);
            return { handled: true, published: true };
        });
        const editor = container.querySelector('textarea[aria-label="Editor editor-1"]') as HTMLTextAreaElement;
        editor.scrollTop = 37;

        rerender({
            ...extUi,
            widgetnodes: {
                editor: {
                    ...(extUi.widgetnodes.editor as Extract<WidgetNode, { kind: "editor" }>),
                    selectionstart: 1,
                    selectionend: 3,
                },
            },
        });
        expect(container.querySelector('textarea[aria-label="Editor editor-1"]')).toBe(editor);
        expect(editor.selectionStart).toBe(1);
        expect(editor.selectionEnd).toBe(3);
        expect(editor.scrollTop).toBe(37);

        changeTextArea(editor, "local");
        editor.setSelectionRange(2, 4);
        const eventid = events.at(-1)?.eventid;
        rerender({
            ...extUi,
            widgetnodes: {
                editor: {
                    ...(extUi.widgetnodes.editor as Extract<WidgetNode, { kind: "editor" }>),
                    selectionstart: 4,
                    selectionend: 4,
                },
            },
        });
        rerender({
            ...extUi,
            widgetnodes: {
                editor: {
                    ...(extUi.widgetnodes.editor as Extract<WidgetNode, { kind: "editor" }>),
                    selectionstart: 0,
                    selectionend: 1,
                    ackid: "foreign:event",
                },
            },
        });
        expect(editor.selectionStart).toBe(2);
        expect(editor.selectionEnd).toBe(4);
        expect(editor.value).toBe("local");

        rerender({
            ...extUi,
            widgetnodes: {
                editor: {
                    ...(extUi.widgetnodes.editor as Extract<WidgetNode, { kind: "editor" }>),
                    value: "local",
                    lines: ["local"],
                    cursorcol: 2,
                    selectionstart: 0,
                    selectionend: 2,
                    ackid: eventid,
                },
            },
        });
        expect(container.querySelector('textarea[aria-label="Editor editor-1"]')).toBe(editor);
        expect(editor.selectionStart).toBe(0);
        expect(editor.selectionEnd).toBe(2);
        expect(editor.scrollTop).toBe(37);
    });

    it("wires Editor composition events without dispatching intermediate synthetic text", () => {
        const extUi = makeEditorState({ value: "", selectionstart: 0, selectionend: 0 });
        const events: AgentWidgetEvent[] = [];
        const { container, rerender } = renderAgentExtUiPanel(extUi, (event) => events.push(event));
        const editor = container.querySelector('textarea[aria-label="Editor editor-1"]') as HTMLTextAreaElement;

        act(() => {
            editor.dispatchEvent(new CompositionEvent("compositionstart", { bubbles: true, data: "" }));
        });
        changeTextArea(editor, "日");
        changeTextArea(editor, "日本");
        rerender(extUi);
        expect(editor.value).toBe("日本");
        expect(events).toEqual([]);

        editor.setSelectionRange(2, 2);
        act(() => {
            editor.dispatchEvent(new CompositionEvent("compositionend", { bubbles: true, data: "日本" }));
        });
        expect(events).toEqual([
            {
                nodeid: "editor-1",
                type: "change",
                eventid: expect.any(String),
                payload: { value: "日本", selectionstart: 2, selectionend: 2 },
            },
        ]);
    });

    it("keeps Editor selection and Save native during composition then dispatches one final change", () => {
        const extUi = makeEditorState({ value: "", selectionstart: 0, selectionend: 0 });
        const events: AgentWidgetEvent[] = [];
        const { container } = renderAgentExtUiPanel(extUi, (event) => events.push(event));
        const editor = container.querySelector('textarea[aria-label="Editor editor-1"]') as HTMLTextAreaElement;
        const form = editor.closest("form") as HTMLFormElement;
        const save = Array.from(form.querySelectorAll("button")).find(
            (button) => button.textContent === "Save"
        ) as HTMLButtonElement;

        act(() => {
            editor.dispatchEvent(new CompositionEvent("compositionstart", { bubbles: true, data: "" }));
        });
        changeTextArea(editor, "日本");
        editor.setSelectionRange(1, 2);
        act(() => {
            editor.dispatchEvent(new Event("select", { bubbles: true }));
        });
        const buttonSubmit = new SubmitEvent("submit", {
            bubbles: true,
            cancelable: true,
            submitter: save,
        });
        act(() => {
            form.dispatchEvent(buttonSubmit);
        });

        expect(buttonSubmit.defaultPrevented).toBe(true);
        expect(events).toEqual([]);

        act(() => {
            editor.dispatchEvent(new CompositionEvent("compositionend", { bubbles: true, data: "日本" }));
        });

        expect(events).toEqual([
            {
                nodeid: "editor-1",
                type: "change",
                eventid: expect.any(String),
                payload: { value: "日本", selectionstart: 1, selectionend: 2 },
            },
        ]);
    });

    it("does not dispatch a removed synthetic Editor composition buffer", () => {
        const extUi = makeEditorState();
        const events: AgentWidgetEvent[] = [];
        const { container, rerender } = renderAgentExtUiPanel(extUi, (event) => events.push(event));
        const editor = container.querySelector('textarea[aria-label="Editor editor-1"]') as HTMLTextAreaElement;

        act(() => {
            editor.dispatchEvent(new CompositionEvent("compositionstart", { bubbles: true, data: "" }));
        });
        changeTextArea(editor, "partial");
        rerender({ ...extUi, widgetnodes: {} });
        act(() => {
            editor.dispatchEvent(new CompositionEvent("compositionend", { bubbles: true, data: "partial" }));
        });

        expect(events).toEqual([]);
    });

    it("routes configured Editor submit keys and leaves newline keys native", () => {
        const extUi = makeEditorState({
            value: "line one",
            selectionstart: 8,
            selectionend: 8,
            submitkeys: ["enter"],
            newlinekeys: ["shift+enter"],
        });
        const events: AgentWidgetEvent[] = [];
        const { container } = renderAgentExtUiPanel(extUi, (event) => events.push(event));
        const editor = container.querySelector('textarea[aria-label="Editor editor-1"]') as HTMLTextAreaElement;

        setTextAreaValue(editor, "line one\nline two");
        editor.setSelectionRange(4, 13);
        const newline = dispatchModifiedKeyDown(editor, "Enter", {
            altKey: false,
            ctrlKey: false,
            metaKey: false,
            shiftKey: true,
        });
        const submit = dispatchKeyDown(editor, "Enter");
        const escape = dispatchKeyDown(editor, "Escape");

        expect(newline.defaultPrevented).toBe(false);
        expect(submit.defaultPrevented).toBe(true);
        expect(escape.defaultPrevented).toBe(false);
        expect(events).toEqual([
            {
                nodeid: "editor-1",
                type: "submit",
                eventid: expect.any(String),
                payload: {
                    value: "line one\nline two",
                    selectionstart: 4,
                    selectionend: 13,
                },
            },
        ]);
    });

    it("matches only the configured Editor submit and newline keybindings", () => {
        const extUi = makeEditorState({
            submitkeys: ["ctrl+enter", "super+return"],
            newlinekeys: ["enter", "shift+enter"],
        });
        const events: AgentWidgetEvent[] = [];
        const { container } = renderAgentExtUiPanel(extUi, (event) => events.push(event));
        const editor = container.querySelector('textarea[aria-label="Editor editor-1"]') as HTMLTextAreaElement;

        const plainEnter = dispatchKeyDown(editor, "Enter");
        const shiftEnter = dispatchModifiedKeyDown(editor, "Enter", {
            altKey: false,
            ctrlKey: false,
            metaKey: false,
            shiftKey: true,
        });
        const altEnter = dispatchModifiedKeyDown(editor, "Enter", {
            altKey: true,
            ctrlKey: false,
            metaKey: false,
            shiftKey: false,
        });
        const ctrlEnter = dispatchModifiedKeyDown(editor, "Enter", {
            altKey: false,
            ctrlKey: true,
            metaKey: false,
            shiftKey: false,
        });
        const metaReturn = dispatchModifiedKeyDown(editor, "Enter", {
            altKey: false,
            ctrlKey: false,
            metaKey: true,
            shiftKey: false,
        });

        expect(plainEnter.defaultPrevented).toBe(false);
        expect(shiftEnter.defaultPrevented).toBe(false);
        expect(altEnter.defaultPrevented).toBe(false);
        expect(ctrlEnter.defaultPrevented).toBe(true);
        expect(metaReturn.defaultPrevented).toBe(true);
        expect(events.map((event) => event.type)).toEqual(["submit", "submit"]);
    });

    it("waits for the authoritative empty Editor acknowledgement after submit", () => {
        const extUi = makeEditorState({ value: "draft", selectionstart: 5, selectionend: 5 });
        const events: AgentWidgetEvent[] = [];
        const { container, rerender } = renderAgentExtUiPanel(extUi, async (event) => {
            events.push(event);
            return { handled: true, published: true };
        });
        const editor = container.querySelector('textarea[aria-label="Editor editor-1"]') as HTMLTextAreaElement;

        setTextAreaValue(editor, "  answer  ");
        editor.setSelectionRange(10, 10);
        const submit = dispatchKeyDown(editor, "Enter");
        expect(submit.defaultPrevented).toBe(true);
        expect(editor.value).toBe("  answer  ");

        rerender({
            ...extUi,
            widgetnodes: {
                editor: {
                    ...(extUi.widgetnodes.editor as Extract<WidgetNode, { kind: "editor" }>),
                    value: "",
                    lines: [""],
                    cursorline: 0,
                    cursorcol: 0,
                    selectionstart: 0,
                    selectionend: 0,
                    ackid: events[0].eventid,
                },
            },
        });

        expect(container.querySelector('textarea[aria-label="Editor editor-1"]')).toBe(editor);
        expect(editor.value).toBe("");
        expect(editor.selectionStart).toBe(0);
        expect(editor.selectionEnd).toBe(0);
    });

    it("renders no standard Editor cancel control and emits no Editor cancel event", () => {
        const extUi = makeEditorState();
        const events: AgentWidgetEvent[] = [];
        const { container } = renderAgentExtUiPanel(extUi, (event) => events.push(event));
        const editor = container.querySelector('textarea[aria-label="Editor editor-1"]') as HTMLTextAreaElement;
        const escape = dispatchKeyDown(editor, "Escape");

        expect(Array.from(container.querySelectorAll("button")).some((button) => button.textContent === "Cancel")).toBe(
            false
        );
        expect(escape.defaultPrevented).toBe(false);
        expect(events).toEqual([]);
    });

    it("keeps outer editor request dismissal separate from the standard Editor component", () => {
        const respondExtUi = vi.fn();
        const respondWidgetEvent = vi.fn();
        const extUi: PiExtUiState = {
            statuses: {},
            widgets: {},
            widgetnodes: {},
            renderedEntries: [],
            request: {
                requestId: "editor-request",
                kind: "editor",
                title: "Edit",
                prefill: "draft",
            },
        };
        renderAgentExtUiPanel(extUi, { respondExtUi, respondWidgetEvent });

        act(() => {
            window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }));
        });

        expect(respondExtUi).toHaveBeenCalledOnce();
        expect(respondExtUi).toHaveBeenCalledWith("editor-request", undefined);
        expect(respondWidgetEvent).not.toHaveBeenCalled();
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

    it("renders Markdown source through the shared semantic Markdown surface", () => {
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
                    source: "# Markdown\n\n- rendered as GUI\n\n[`link`](https://example.com)",
                    paddingx: 0,
                    paddingy: 0,
                },
            } as any,
        };

        const { container } = renderAgentExtUiPanel(extUi);
        const markdown = container.querySelector('[data-agent-widget-kind="markdown"]') as HTMLElement;

        expect(markdown.querySelector(".heading.is-1")?.textContent).toBe("Markdown");
        expect(markdown.querySelector("ul")).toBeTruthy();
        expect(markdown.querySelector("a[href='https://example.com']")?.textContent).toBe("link");
        expect(markdown.querySelector("code")?.textContent).toBe("link");
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

    it.each(["`", "``"])("keeps streaming Markdown closing %s out of semantic code text", (closing) => {
        const source = `# Stream\n\n\`\`\`ts\nconst value = 1;\n${closing}`;
        const extUi: PiExtUiState = {
            statuses: {},
            widgets: {},
            widgetnodes: {
                markdown: {
                    kind: "markdown",
                    id: "markdown-stream",
                    source,
                    paddingx: 1,
                    paddingy: 2,
                },
            },
            renderedEntries: [],
            request: null,
        };
        const { container, rerender } = renderAgentExtUiPanel(extUi);
        const markdown = container.querySelector('[data-agent-widget-kind="markdown"]') as HTMLElement;

        expect(markdown.style.paddingInline).toBe("8px");
        expect(markdown.style.paddingBlock).toBe("16px");
        expect(markdown.querySelector(".heading.is-1")?.textContent).toBe("Stream");
        expect(markdown.querySelector("pre code")?.textContent).toContain("const value = 1;");
        expect(markdown.querySelector("pre code")?.textContent).not.toContain(closing);

        rerender({
            ...extUi,
            widgetnodes: {
                markdown: {
                    ...extUi.widgetnodes.markdown,
                    source: "# Stream\n\n```ts\nconst value = 1;\n```\n\n| State | Value |\n| --- | --- |\n| done | yes |",
                } as Extract<WidgetNode, { kind: "markdown" }>,
            },
        });

        const refreshed = container.querySelector('[data-agent-widget-kind="markdown"]') as HTMLElement;
        expect(refreshed).toBe(markdown);
        expect(refreshed.querySelector("pre code")?.textContent).toContain("const value = 1;");
        expect(refreshed.querySelector("table")).toBeTruthy();
        expect(refreshed.querySelector("td")?.textContent).toBe("done");
    });

    it("normalizes only the final partial fence across multiple Markdown code blocks", () => {
        const extUi: PiExtUiState = {
            statuses: {},
            widgets: {},
            widgetnodes: {
                markdown: {
                    kind: "markdown",
                    id: "markdown-multiple-fences",
                    source: "```js\nfirst()\n```\n\n```ts\nsecond()\n``",
                    paddingx: 0,
                    paddingy: 0,
                },
            },
            renderedEntries: [],
            request: null,
        };
        const { container } = renderAgentExtUiPanel(extUi);
        const codeBlocks = container.querySelectorAll("pre code");

        expect(codeBlocks).toHaveLength(2);
        expect(codeBlocks[0].textContent).toContain("first()");
        expect(codeBlocks[1].textContent?.trimEnd()).toBe("second()");
    });

    it("preserves Box child order, nested ids, and both padding axes", () => {
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
                            kind: "input",
                            id: "first-child",
                            value: "first",
                            cursor: 5,
                            focused: false,
                            selectionstart: 5,
                            selectionend: 5,
                        },
                        {
                            kind: "box",
                            id: "nested-box",
                            paddingx: 1,
                            paddingy: 4,
                            children: [
                                {
                                    kind: "input",
                                    id: "nested-child",
                                    value: "nested",
                                    cursor: 6,
                                    focused: false,
                                    selectionstart: 6,
                                    selectionend: 6,
                                },
                            ],
                        },
                    ],
                },
            },
            renderedEntries: [],
            request: null,
        };
        const events: AgentWidgetEvent[] = [];
        const { container, rerender } = renderAgentExtUiPanel(extUi, (event) => events.push(event));
        const boxes = container.querySelectorAll('[data-agent-widget-kind="box"]');
        const box = boxes[0] as HTMLElement;
        const nestedBox = boxes[1] as HTMLElement;
        const inputs = container.querySelectorAll("input");
        const firstInput = inputs[0] as HTMLInputElement;
        const nestedInput = inputs[1] as HTMLInputElement;

        expect(box).toBeTruthy();
        expect(box.style.paddingInline).toBe("24px");
        expect(box.style.paddingBlock).toBe("16px");
        expect(nestedBox.style.paddingInline).toBe("8px");
        expect(nestedBox.style.paddingBlock).toBe("32px");
        expect(box.className).toContain("flex");
        expect(box.className).toContain("flex-col");
        expect(Array.from(inputs, (input) => input.getAttribute("aria-label"))).toEqual([
            "Input first-child",
            "Input nested-child",
        ]);

        const rootNode = extUi.widgetnodes.box as WidgetBoxNode;
        const firstNode = rootNode.children[0] as WidgetInputNode;
        const nestedNode = rootNode.children[1] as WidgetBoxNode;
        const nestedInputNode = nestedNode.children[0] as WidgetInputNode;
        rerender({
            ...extUi,
            widgetnodes: {
                box: {
                    ...rootNode,
                    children: [
                        {
                            ...firstNode,
                            value: "first refreshed",
                            cursor: 15,
                            selectionstart: 15,
                            selectionend: 15,
                        },
                        {
                            ...nestedNode,
                            children: [
                                {
                                    ...nestedInputNode,
                                    value: "nested refreshed",
                                    cursor: 16,
                                    selectionstart: 16,
                                    selectionend: 16,
                                },
                            ],
                        },
                    ],
                },
            },
        });

        const refreshedInputs = container.querySelectorAll("input");
        expect(refreshedInputs[0]).toBe(firstInput);
        expect(refreshedInputs[1]).toBe(nestedInput);
        const nestedSubmit = nestedInput.closest("form")?.querySelector('button[type="submit"]');
        if (!nestedSubmit) throw new Error("expected nested submit");
        clickElement(nestedSubmit);
        expect(events.at(-1)).toMatchObject({ nodeid: "nested-child", type: "submit" });
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
        expect(widgetInputChangeEvent("input-1", "draft", 1, 3)).toEqual({
            nodeid: "input-1",
            type: "change",
            payload: { value: "draft", selectionstart: 1, selectionend: 3 },
        });
        expect(widgetInputSubmitEvent("input-1", "draft", 2, 2)).toEqual({
            nodeid: "input-1",
            type: "submit",
            payload: { value: "draft", selectionstart: 2, selectionend: 2 },
        });
        expect(widgetInputCancelEvent("input-1")).toEqual({
            nodeid: "input-1",
            type: "cancel",
        });
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
            (event) => {
                events.push(event);
            }
        );

        expect(events).toEqual([{ nodeid: "widget-1", type: "cancel" }]);
    });
});
