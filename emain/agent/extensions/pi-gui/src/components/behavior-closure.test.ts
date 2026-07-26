import { afterEach, describe, expect, it, vi } from "vitest";
import { normalizeMarkdownPartialClosingFence } from "../index.ts";
import type { Component, TUI } from "../tui.ts";
import { CancellableLoader } from "./cancellable-loader.ts";
import { Editor } from "./editor.ts";
import { Input, normalizeGuiTextWithSelection } from "./input.ts";
import { Loader } from "./loader.ts";
import {
    Markdown,
    type MarkdownTheme,
} from "./markdown.ts";
import { SelectList, type SelectListTheme } from "./select-list.ts";
import { SettingsList, type SettingItem, type SettingsListTheme } from "./settings-list.ts";

const SelectTheme: SelectListTheme = {
    selectedPrefix: (text) => text,
    selectedText: (text) => text,
    description: (text) => text,
    scrollInfo: (text) => text,
    noMatch: (text) => text,
};

const SettingsTheme: SettingsListTheme = {
    label: (text) => text,
    value: (text) => text,
    description: (text) => text,
    cursor: "> ",
    hint: (text) => text,
};

const MarkdownTestTheme: MarkdownTheme = {
    heading: (text) => text,
    link: (text) => text,
    linkUrl: (text) => text,
    code: (text) => text,
    codeBlock: (text) => text,
    codeBlockBorder: (text) => text,
    quote: (text) => text,
    quoteBorder: (text) => text,
    hr: (text) => text,
    listBullet: (text) => text,
    bold: (text) => text,
    italic: (text) => text,
    strikethrough: (text) => text,
    underline: (text) => text,
};

afterEach(() => {
    vi.useRealTimers();
});

function makeSelectList(values: string[], maxVisible = 5): SelectList {
    return new SelectList(
        values.map((value) => ({ value, label: value })),
        maxVisible,
        SelectTheme
    );
}

function makeEditor(): Editor {
    const tui = {
        requestRender: () => {},
        terminal: { rows: 24 },
    } as unknown as TUI;
    return new Editor(tui, { borderColor: (text) => text, selectList: SelectTheme });
}

function makeSettingsListWithSubmenu(
    submenu: Component,
    options: { enableSearch: boolean; maxVisible: number }
): SettingsList {
    const items: SettingItem[] = [
        {
            id: "mode",
            label: "Mode",
            currentValue: "one",
            submenu: (_currentValue, done) => {
                const list = submenu as SelectList;
                list.onSelect = (item) => done(item.value);
                list.onCancel = () => done();
                return list;
            },
        },
        { id: "theme", label: "Theme", currentValue: "dark", values: ["dark", "light"] },
    ];
    return new SettingsList(
        items,
        options.maxVisible,
        SettingsTheme,
        () => {},
        () => {},
        {
            enableSearch: options.enableSearch,
        }
    );
}

function makeSettingsList(
    items: SettingItem[],
    options: {
        enableSearch?: boolean;
        maxVisible?: number;
        onChange?: (id: string, value: string) => void;
        onCancel?: () => void;
    } = {}
): SettingsList {
    return new SettingsList(
        items,
        options.maxVisible ?? 5,
        SettingsTheme,
        options.onChange ?? (() => {}),
        options.onCancel ?? (() => {}),
        { enableSearch: options.enableSearch }
    );
}

describe("M2.1C public Pi behavior", () => {
    it.each([
        ["one partial backtick", "```ts\nconst a = 1;\n`", "```ts\nconst a = 1;"],
        ["two partial backticks", "```ts\nconst a = 1;\n``", "```ts\nconst a = 1;"],
        ["complete closing fence", "```ts\nconst a = 1;\n```", "```ts\nconst a = 1;\n```"],
        [
            "last of multiple fences",
            "```js\nfirst()\n```\n\n```ts\nsecond()\n``",
            "```js\nfirst()\n```\n\n```ts\nsecond()",
        ],
        ["tilde fence does not consume backticks", "~~~ts\nconst tick = `x`;\n``", "~~~ts\nconst tick = `x`;\n``"],
        ["inline language-like marker", "text `ts` and ``code``", "text `ts` and ``code``"],
    ])("normalizes Markdown %s without mutating complete source", (_label, source, expected) => {
        expect(normalizeMarkdownPartialClosingFence(source)).toBe(expected);
    });

    it.each(["`", "``"])("keeps streamed Markdown closing %s out of Pi code text", (closing) => {
        const markdown = new Markdown(
            `\`\`\`ts\nconst value = 1;\n${closing}`,
            0,
            0,
            MarkdownTestTheme
        );

        const rendered = markdown.render(80).join("\n");

        expect(rendered).toContain("const value = 1;");
        expect(rendered).not.toContain(`const value = 1;\n${closing}`);
    });

    it("applies SelectList pointer selection through Pi callback order", () => {
        const calls: string[] = [];
        const list = makeSelectList(["alpha", "beta"]);
        list.onSelectionChange = (item) => calls.push(`change:${item.value}`);
        list.onSelect = (item) => calls.push(`select:${item.value}`);

        expect(list.selectAndActivate(1)).toBe(true);
        expect(list.getSnapshot().selectedIndex).toBe(1);
        expect(calls).toEqual(["change:beta", "select:beta"]);
    });

    it("copies every SelectList item into public snapshots", () => {
        const list = makeSelectList(["alpha", "beta"]);
        const first = list.getSnapshot();
        const second = list.getSnapshot();

        expect(first.items[0]).not.toBe(second.items[0]);
        first.items[0].label = "mutated";
        first.items[0].value = "mutated";

        expect(list.getSnapshot().items[0]).toEqual({
            label: "alpha",
            value: "alpha",
        });
        expect(list.selectAndActivate(0)).toBe(true);
        expect(list.getSelectedItem()).toEqual({
            label: "alpha",
            value: "alpha",
        });
    });

    it("activates the captured SelectList item when selection change reenters filtering", () => {
        const calls: string[] = [];
        const list = makeSelectList(["alpha", "beta"]);
        list.onSelectionChange = (item) => {
            calls.push(`change:${item.value}`);
            list.setFilter("a");
        };
        list.onSelect = (item) => calls.push(`select:${item.value}`);

        expect(list.selectAndActivate(1)).toBe(true);
        expect(calls).toEqual(["change:beta", "select:beta"]);
    });

    it("publishes SelectList visible range, no-match, filter, and focus", () => {
        const list = makeSelectList(["alpha", "beta", "bravo", "charlie"], 2);
        list.setFocused(true);
        list.setFilter("b");
        list.handleInput("\x1b[B");

        expect(list.getSnapshot()).toMatchObject({
            selectedIndex: 1,
            maxVisible: 2,
            visibleStart: 0,
            visibleEnd: 2,
            focused: true,
            filter: "b",
            noMatch: false,
        });

        list.setFilter("missing");
        const selectionChange = vi.fn();
        list.onSelectionChange = selectionChange;
        list.handleInput("\x1b[A");
        expect(list.getSnapshot().selectedIndex).toBe(0);
        list.handleInput("\x1b[B");
        expect(list.getSnapshot()).toMatchObject({
            items: [],
            selectedIndex: 0,
            visibleStart: 0,
            visibleEnd: 0,
            noMatch: true,
        });
        expect(selectionChange).not.toHaveBeenCalled();
    });

    it("wraps SelectList navigation and reports every Pi-owned selection change", () => {
        const calls: string[] = [];
        const list = makeSelectList(["alpha", "beta", "charlie"]);
        list.onSelectionChange = (item) => calls.push(item.value);

        list.handleInput("\x1b[A");
        expect(list.getSnapshot().selectedIndex).toBe(2);
        list.handleInput("\x1b[B");
        expect(list.getSnapshot().selectedIndex).toBe(0);
        list.handleInput("\x1b[B");

        expect(list.getSnapshot().selectedIndex).toBe(1);
        expect(calls).toEqual(["charlie", "alpha", "beta"]);
    });

    it("routes SelectList confirmation and cancellation through Pi callbacks once", () => {
        const list = makeSelectList(["alpha", "beta"]);
        const select = vi.fn();
        const cancel = vi.fn();
        list.onSelect = select;
        list.onCancel = cancel;

        list.handleInput("\r");
        list.handleInput("\x1b");

        expect(select).toHaveBeenCalledOnce();
        expect(select).toHaveBeenCalledWith(expect.objectContaining({ value: "alpha" }));
        expect(cancel).toHaveBeenCalledOnce();
    });

    it("filters SelectList by case-insensitive value prefix and prevents empty activation", () => {
        const list = makeSelectList(["alpha", "Beta", "bravo", "charlie"]);
        const select = vi.fn();
        list.onSelect = select;
        list.setSelectedIndex(3);

        list.setFilter("B");
        expect(list.getSnapshot()).toMatchObject({
            items: [expect.objectContaining({ value: "Beta" }), expect.objectContaining({ value: "bravo" })],
            selectedIndex: 0,
        });

        list.setFilter("missing");
        list.handleInput("\r");
        expect(list.selectAndActivate(0)).toBe(false);
        expect(select).not.toHaveBeenCalled();
    });

    it("keeps SelectList visible windows bounded around selection and rejects invalid pointer indices", () => {
        const list = makeSelectList(["alpha", "beta", "charlie", "delta", "echo"], 2);
        const selectionChange = vi.fn();
        const select = vi.fn();
        list.onSelectionChange = selectionChange;
        list.onSelect = select;

        for (let index = 0; index < 5; index++) {
            expect(list.setSelectedIndex(index)).toBe(true);
            const snapshot = list.getSnapshot();
            expect(snapshot.visibleEnd - snapshot.visibleStart).toBeLessThanOrEqual(snapshot.maxVisible);
            expect(snapshot.visibleStart).toBeLessThanOrEqual(snapshot.selectedIndex);
            expect(snapshot.visibleEnd).toBeGreaterThan(snapshot.selectedIndex);
        }

        const before = list.getSnapshot();
        for (const index of [-1, 5, Number.NaN, 1.5]) {
            expect(list.selectAndActivate(index)).toBe(false);
        }
        expect(list.getSnapshot()).toEqual(before);
        expect(selectionChange).not.toHaveBeenCalled();
        expect(select).not.toHaveBeenCalled();
    });

    it("publishes SettingsList search, focus, visible range, and active submenu", () => {
        const submenu = makeSelectList(["one", "two"]);
        const settings = makeSettingsListWithSubmenu(submenu, { enableSearch: true, maxVisible: 2 });

        expect(settings.setFocused(true)).toBe(true);
        expect(settings.setFilter("mode")).toBe(true);
        expect(settings.activateSelected()).toBe(true);
        expect(settings.getSnapshot()).toMatchObject({
            searchEnabled: true,
            filter: "mode",
            focused: true,
            visibleStart: 0,
            visibleEnd: 1,
            noMatch: false,
            submenu,
        });
        expect(settings.getSnapshot().items[0]).not.toHaveProperty("submenu");
        expect(settings.getChildren()).toEqual([submenu]);
    });

    it("publishes disabled SettingsList search and rejects filter mutation", () => {
        const settings = makeSettingsList([
            { id: "mode", label: "Mode", currentValue: "fast", values: ["fast", "safe"] },
            { id: "theme", label: "Theme", currentValue: "dark", values: ["dark", "light"] },
        ]);
        const before = settings.getSnapshot();

        expect(before).toMatchObject({
            searchEnabled: false,
            filter: undefined,
            selectedIndex: 0,
        });
        expect(settings.setFilter("theme")).toBe(false);
        expect(settings.getSnapshot()).toEqual(before);
    });

    it("wraps SettingsList navigation over fuzzy results and bounds the visible window", () => {
        const settings = makeSettingsList(
            [
                { id: "mode", label: "Execution Mode", currentValue: "fast", values: ["fast", "safe"] },
                { id: "theme", label: "Color Theme", currentValue: "dark", values: ["dark", "light"] },
                { id: "shell", label: "Login Shell", currentValue: "zsh", values: ["zsh", "bash"] },
                { id: "level", label: "Log Level", currentValue: "info", values: ["info", "debug"] },
            ],
            { enableSearch: true, maxVisible: 2 }
        );

        settings.handleInput("\x1b[A");
        expect(settings.getSnapshot().selectedIndex).toBe(3);
        settings.handleInput("\x1b[B");
        expect(settings.getSnapshot().selectedIndex).toBe(0);

        expect(settings.setFilter("cl th")).toBe(true);
        expect(settings.getSnapshot()).toMatchObject({
            items: [expect.objectContaining({ id: "theme" })],
            selectedIndex: 0,
            filter: "cl th",
            noMatch: false,
        });

        expect(settings.setFilter("")).toBe(true);
        for (let index = 0; index < 4; index++) {
            expect(settings.setSelectedIndex(index)).toBe(true);
            const snapshot = settings.getSnapshot();
            expect(snapshot.visibleEnd - snapshot.visibleStart).toBeLessThanOrEqual(snapshot.maxVisible);
            expect(snapshot.visibleStart).toBeLessThanOrEqual(snapshot.selectedIndex);
            expect(snapshot.visibleEnd).toBeGreaterThan(snapshot.selectedIndex);
        }

        expect(settings.setFilter("missing")).toBe(true);
        const before = settings.getSnapshot();
        expect(settings.activateSelected()).toBe(false);
        settings.handleInput("\x1b[A");
        settings.handleInput("\x1b[B");
        settings.handleInput("\r");
        expect(settings.getSnapshot()).toEqual(before);
        expect(before).toMatchObject({
            items: [],
            selectedIndex: 0,
            visibleStart: 0,
            visibleEnd: 0,
            noMatch: true,
        });
    });

    it("cycles SettingsList values in Pi order and activates with Enter or Space", () => {
        const calls: string[] = [];
        const settings = makeSettingsList(
            [{ id: "mode", label: "Mode", currentValue: "safe", values: ["fast", "safe", "slow"] }],
            { onChange: (id, value) => calls.push(`${id}:${value}`) }
        );

        expect(settings.cycleSelected(1)).toBe(true);
        expect(settings.getSnapshot().items[0].currentValue).toBe("slow");
        expect(settings.cycleSelected(-1)).toBe(true);
        expect(settings.getSnapshot().items[0].currentValue).toBe("safe");
        expect(settings.cycleSelected(0 as 1)).toBe(false);

        settings.handleInput("\r");
        settings.handleInput(" ");

        expect(settings.getSnapshot().items[0].currentValue).toBe("fast");
        expect(calls).toEqual(["mode:slow", "mode:safe", "mode:slow", "mode:fast"]);
    });

    it("starts Loader immediately and advances default frames every 80ms", () => {
        vi.useFakeTimers();
        const requestRender = vi.fn();
        const frames = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];
        const loader = new Loader(
            { requestRender } as unknown as TUI,
            (text) => text,
            (text) => text,
            "Loading"
        );

        expect(loader.getSnapshot().frame).toBe(frames[0]);
        expect(requestRender).toHaveBeenCalledTimes(1);
        vi.advanceTimersByTime(79);
        expect(requestRender).toHaveBeenCalledTimes(1);
        for (let index = 1; index <= frames.length; index++) {
            vi.advanceTimersByTime(index === 1 ? 1 : 80);
            expect(loader.getSnapshot().frame).toBe(frames[index % frames.length]);
            expect(requestRender).toHaveBeenCalledTimes(index + 1);
        }
    });

    it("preserves custom Loader frame order and positive interval", () => {
        vi.useFakeTimers();
        const requestRender = vi.fn();
        const loader = new Loader(
            { requestRender } as unknown as TUI,
            (text) => text,
            (text) => text,
            "Loading",
            { frames: ["first", "second", "third"], intervalMs: 25 }
        );

        expect(loader.getSnapshot().frame).toBe("first");
        vi.advanceTimersByTime(25);
        expect(loader.getSnapshot().frame).toBe("second");
        vi.advanceTimersByTime(25);
        expect(loader.getSnapshot().frame).toBe("third");
        vi.advanceTimersByTime(25);
        expect(loader.getSnapshot().frame).toBe("first");
        expect(requestRender).toHaveBeenCalledTimes(4);
    });

    it.each([
        ["absent", undefined],
        ["infinite", Number.POSITIVE_INFINITY],
        ["NaN", Number.NaN],
        ["zero", 0],
        ["negative", -10],
    ])("falls back to 80ms for %s Loader interval", (_label, intervalMs) => {
        vi.useFakeTimers();
        const requestRender = vi.fn();
        const loader = new Loader(
            { requestRender } as unknown as TUI,
            (text) => text,
            (text) => text,
            "Loading",
            { frames: ["a", "b"], intervalMs }
        );

        vi.advanceTimersByTime(79);
        expect(requestRender).toHaveBeenCalledTimes(1);
        vi.advanceTimersByTime(1);
        expect(loader.getSnapshot().frame).toBe("b");
        expect(requestRender).toHaveBeenCalledTimes(2);
    });

    it.each([
        ["zero", []],
        ["one", ["only"]],
    ])("creates no repeating timer for %s Loader frames", (_label, frames) => {
        vi.useFakeTimers();
        const requestRender = vi.fn();
        const loader = new Loader(
            { requestRender } as unknown as TUI,
            (text) => text,
            (text) => text,
            "Loading",
            { frames, intervalMs: 10 }
        );

        expect(vi.getTimerCount()).toBe(0);
        expect(requestRender).toHaveBeenCalledTimes(1);
        vi.advanceTimersByTime(100);
        expect(requestRender).toHaveBeenCalledTimes(1);
        expect(loader.getSnapshot().frame).toBe(frames[0] ?? "");
    });

    it("keeps Loader start, stop, and dispose idempotent without render requests after disposal", () => {
        vi.useFakeTimers();
        const requestRender = vi.fn();
        const loader = new Loader(
            { requestRender } as unknown as TUI,
            (text) => text,
            (text) => text,
            "Loading",
            { frames: ["a", "b"], intervalMs: 10 }
        );

        loader.start();
        loader.start();
        expect(requestRender).toHaveBeenCalledTimes(1);
        expect(vi.getTimerCount()).toBe(1);

        loader.stop();
        loader.stop();
        expect(vi.getTimerCount()).toBe(0);
        loader.setMessage("Stopped");
        vi.advanceTimersByTime(30);
        expect(requestRender).toHaveBeenCalledTimes(1);

        loader.start();
        expect(requestRender).toHaveBeenCalledTimes(2);
        expect(vi.getTimerCount()).toBe(1);
        loader.dispose();
        loader.dispose();
        loader.start();
        loader.setMessage("Disposed");
        vi.advanceTimersByTime(30);
        expect(vi.getTimerCount()).toBe(0);
        expect(requestRender).toHaveBeenCalledTimes(2);
    });

    it("cancels CancellableLoader once, stops animation, and publishes aborted state", () => {
        vi.useFakeTimers();
        const requestRender = vi.fn();
        const onAbort = vi.fn();
        const loader = new CancellableLoader(
            { requestRender } as unknown as TUI,
            (text) => text,
            (text) => text,
            "Loading",
            { frames: ["a", "b"], intervalMs: 10 }
        );
        loader.onAbort = onAbort;

        requestRender.mockClear();
        loader.cancel();
        loader.cancel();

        expect(loader.signal.aborted).toBe(true);
        expect(loader.getSnapshot()).toMatchObject({ aborted: true, cancellable: true });
        expect(onAbort).toHaveBeenCalledTimes(1);
        expect(vi.getTimerCount()).toBe(0);
        vi.advanceTimersByTime(30);
        expect(requestRender).not.toHaveBeenCalled();
    });

    it("completes or cancels SettingsList submenus once and restores parent selection", () => {
        const calls: string[] = [];
        const submenus: SelectList[] = [];
        const settings = makeSettingsList(
            [
                { id: "mode", label: "Mode", currentValue: "fast", values: ["fast", "safe"] },
                {
                    id: "theme",
                    label: "Theme",
                    currentValue: "dark",
                    submenu: (_currentValue, done) => {
                        const submenu = makeSelectList(["dark", "light"]);
                        submenu.onSelect = (item) => done(item.value);
                        submenu.onCancel = () => done();
                        submenus.push(submenu);
                        return submenu;
                    },
                },
            ],
            {
                onChange: (id, value) => calls.push(`change:${id}:${value}`),
                onCancel: () => calls.push("cancel"),
            }
        );

        expect(settings.setSelectedIndex(1)).toBe(true);
        expect(settings.activateSelected()).toBe(true);
        expect(settings.getChildren()).toEqual([submenus[0]]);
        expect(submenus[0].selectAndActivate(1)).toBe(true);
        expect(settings.getSnapshot()).toMatchObject({
            selectedIndex: 1,
            submenu: undefined,
            items: [
                expect.objectContaining({ currentValue: "fast" }),
                expect.objectContaining({ currentValue: "light" }),
            ],
        });
        expect(submenus[0].selectAndActivate(0)).toBe(true);

        expect(settings.activateSelected()).toBe(true);
        submenus[1].handleInput("\x1b");
        expect(settings.getSnapshot()).toMatchObject({
            selectedIndex: 1,
            submenu: undefined,
            items: [
                expect.objectContaining({ currentValue: "fast" }),
                expect.objectContaining({ currentValue: "light" }),
            ],
        });

        expect(settings.setSelectedIndex(0)).toBe(true);
        expect(settings.cycleSelected(1)).toBe(true);
        settings.handleInput("\x1b");

        expect(calls).toEqual(["change:theme:light", "change:mode:safe", "cancel"]);
        expect(settings.getSnapshot().items[0].currentValue).toBe("safe");
    });

    it("disposes a Loader returned after synchronous SettingsList completion", () => {
        vi.useFakeTimers();
        try {
            const requestRender = vi.fn();
            const ui = { requestRender } as unknown as TUI;
            const changes: string[] = [];
            let loader: Loader | undefined;
            let stop: ReturnType<typeof vi.spyOn> | undefined;
            let staleDone: ((value?: string) => void) | undefined;
            const settings = makeSettingsList(
                [
                    {
                        id: "theme",
                        label: "Theme",
                        currentValue: "dark",
                        submenu: (_value, done) => {
                            staleDone = done;
                            loader = new Loader(
                                ui,
                                (text) => text,
                                (text) => text,
                                "Loading",
                                {
                                    frames: ["a", "b"],
                                    intervalMs: 10,
                                }
                            );
                            stop = vi.spyOn(loader, "stop");
                            done("light");
                            return loader;
                        },
                    },
                ],
                { onChange: (id, value) => changes.push(`${id}:${value}`) }
            );

            expect(settings.activateSelected()).toBe(true);
            expect(settings.getChildren()).toEqual([]);
            expect(settings.getSnapshot()).toMatchObject({
                submenu: undefined,
                items: [expect.objectContaining({ currentValue: "light" })],
            });
            expect(changes).toEqual(["theme:light"]);
            expect(stop).toHaveBeenCalledTimes(1);

            requestRender.mockClear();
            vi.advanceTimersByTime(30);
            expect(requestRender).not.toHaveBeenCalled();

            staleDone?.("dark");
            expect(changes).toEqual(["theme:light"]);
            expect(settings.getSnapshot().items[0].currentValue).toBe("light");
            expect(stop).toHaveBeenCalledTimes(1);
            expect(loader).toBeDefined();
        } finally {
            vi.useRealTimers();
        }
    });

    it("settles synchronous SettingsList completion before a callback reopens a submenu", () => {
        const events: string[] = [];
        const requestRender = vi.fn();
        const ui = { requestRender } as unknown as TUI;
        const reopened = makeSelectList(["light", "dark"]);
        let factoryCalls = 0;
        let oldLoader: Loader | undefined;
        let oldStop: ReturnType<typeof vi.spyOn> | undefined;
        let settings: SettingsList;
        settings = makeSettingsList(
            [
                {
                    id: "theme",
                    label: "Theme",
                    currentValue: "dark",
                    submenu: (_value, done) => {
                        factoryCalls++;
                        if (factoryCalls === 1) {
                            oldLoader = new Loader(
                                ui,
                                (text) => text,
                                (text) => text,
                                "Old",
                                { frames: [] }
                            );
                            oldStop = vi.spyOn(oldLoader, "stop").mockImplementation(() => {
                                events.push("old-dispose");
                            });
                            done("light");
                            events.push("factory-after-done");
                            expect(settings.getSnapshot().items[0].currentValue).toBe("dark");
                            return oldLoader;
                        }
                        events.push("new-factory");
                        return reopened;
                    },
                },
            ],
            {
                onChange: (_id, value) => {
                    events.push(`change:${value}`);
                    expect(settings.getSnapshot()).toMatchObject({
                        selectedIndex: 0,
                        submenu: undefined,
                        items: [expect.objectContaining({ currentValue: "light" })],
                    });
                    expect(settings.activateSelected()).toBe(true);
                },
            }
        );

        expect(settings.activateSelected()).toBe(true);

        expect(events).toEqual(["factory-after-done", "old-dispose", "change:light", "new-factory"]);
        expect(settings.getChildren()).toEqual([reopened]);
        expect(oldStop).toHaveBeenCalledTimes(1);
        expect(oldLoader).toBeDefined();
    });

    it("contains a synchronous SettingsList returned-component disposal failure", () => {
        const error = new Error("submenu dispose failed");
        const dispose = vi.fn(() => {
            throw error;
        });
        const changes: string[] = [];
        let settings: SettingsList;
        settings = makeSettingsList(
            [
                { id: "mode", label: "Mode", currentValue: "fast", values: ["fast", "safe"] },
                {
                    id: "theme",
                    label: "Theme",
                    currentValue: "dark",
                    submenu: (_value, done) => {
                        done("light");
                        return {
                            render: () => [],
                            invalidate: () => {},
                            dispose,
                        };
                    },
                },
            ],
            {
                onChange: (id, value) => {
                    changes.push(`${id}:${value}`);
                    expect(settings.getSnapshot()).toMatchObject({
                        selectedIndex: 1,
                        submenu: undefined,
                        items: [
                            expect.objectContaining({ currentValue: "fast" }),
                            expect.objectContaining({ currentValue: "light" }),
                        ],
                    });
                },
            }
        );
        expect(settings.setSelectedIndex(1)).toBe(true);

        expect(() => settings.activateSelected()).not.toThrow();
        expect(dispose).toHaveBeenCalledTimes(1);
        expect(changes).toEqual(["theme:light"]);
        expect(settings.getChildren()).toEqual([]);
    });

    it("settles asynchronous SettingsList completion atomically before a callback reopens", () => {
        const events: string[] = [];
        const first = makeSelectList(["dark", "light"]);
        const reopened = makeSelectList(["light", "dark"]);
        let firstDone: ((value?: string) => void) | undefined;
        let secondDone: ((value?: string) => void) | undefined;
        let factoryCalls = 0;
        let settings: SettingsList;
        settings = makeSettingsList(
            [
                { id: "mode", label: "Mode", currentValue: "fast", values: ["fast", "safe"] },
                {
                    id: "theme",
                    label: "Theme",
                    currentValue: "dark",
                    submenu: (_value, done) => {
                        factoryCalls++;
                        if (factoryCalls === 1) {
                            firstDone = done;
                            return first;
                        }
                        secondDone = done;
                        events.push("new-factory");
                        return reopened;
                    },
                },
            ],
            {
                onChange: (_id, value) => {
                    events.push(`change:${value}`);
                    expect(settings.getSnapshot()).toMatchObject({
                        selectedIndex: 1,
                        submenu: undefined,
                        items: [
                            expect.objectContaining({ currentValue: "fast" }),
                            expect.objectContaining({ currentValue: value }),
                        ],
                    });
                    expect(settings.activateSelected()).toBe(true);
                },
            }
        );

        expect(settings.setSelectedIndex(1)).toBe(true);
        expect(settings.activateSelected()).toBe(true);
        expect(settings.getChildren()).toEqual([first]);

        firstDone?.("light");

        expect(events).toEqual(["change:light", "new-factory"]);
        expect(settings.getChildren()).toEqual([reopened]);
        expect(settings.getSnapshot()).toMatchObject({
            selectedIndex: 1,
            items: [
                expect.objectContaining({ currentValue: "fast" }),
                expect.objectContaining({ currentValue: "light" }),
            ],
        });

        firstDone?.("dark");
        firstDone?.();
        expect(events).toEqual(["change:light", "new-factory"]);
        expect(settings.getChildren()).toEqual([reopened]);

        secondDone?.();
        secondDone?.("dark");
        expect(events).toEqual(["change:light", "new-factory"]);
        expect(settings.getChildren()).toEqual([]);
        expect(settings.getSnapshot().items[1].currentValue).toBe("light");
    });

    it("disposes a component returned after synchronous SettingsList cancellation", () => {
        const dispose = vi.fn();
        const returned: Component = {
            render: () => [],
            invalidate: () => {},
            dispose,
        };
        const changes: string[] = [];
        let staleDone: ((value?: string) => void) | undefined;
        const settings = makeSettingsList(
            [
                {
                    id: "theme",
                    label: "Theme",
                    currentValue: "dark",
                    submenu: (_value, done) => {
                        staleDone = done;
                        done();
                        return returned;
                    },
                },
            ],
            { onChange: (id, value) => changes.push(`${id}:${value}`) }
        );

        expect(settings.activateSelected()).toBe(true);
        expect(settings.getChildren()).toEqual([]);
        expect(settings.getSnapshot().items[0].currentValue).toBe("dark");
        expect(changes).toEqual([]);
        expect(dispose).toHaveBeenCalledTimes(1);

        staleDone?.("light");
        expect(changes).toEqual([]);
        expect(settings.getSnapshot().items[0].currentValue).toBe("dark");
        expect(dispose).toHaveBeenCalledTimes(1);
    });

    it("applies complete Input values with normalized text and selection metadata", () => {
        const input = new Input();
        expect(input.applyGuiEdit("a\r\nb\tc", 1, 6)).toBe(true);
        expect(input.getSnapshot()).toEqual({
            value: "ab    c",
            cursor: 7,
            focused: false,
            selectionStart: 1,
            selectionEnd: 7,
        });
        expect(input.applyGuiEdit("x", -1, 0)).toBe(false);
        expect(input.getValue()).toBe("ab    c");
    });

    it("flushes Input before submit and exposes public escape behavior", () => {
        const calls: string[] = [];
        const input = new Input();
        input.onSubmit = (value) => calls.push(`submit:${value}`);
        input.onEscape = () => calls.push("escape");

        expect(input.submitGuiValue("final", 5, 5)).toBe(true);
        expect(input.escape()).toBe(true);
        expect(calls).toEqual(["submit:final", "escape"]);
    });

    it("collapses Input selection to cursor after terminal input but preserves it for no key", () => {
        const input = new Input();
        input.applyGuiEdit("abcd", 1, 3);

        input.handleInput("");
        expect(input.getSnapshot()).toMatchObject({
            cursor: 3,
            selectionStart: 1,
            selectionEnd: 3,
        });

        input.handleInput("\x1b[D");
        expect(input.getSnapshot()).toMatchObject({
            cursor: 2,
            selectionStart: 2,
            selectionEnd: 2,
        });

        input.applyGuiEdit("abcd", 1, 3);
        input.handleInput("x");
        expect(input.getSnapshot()).toMatchObject({
            value: "abcxd",
            cursor: 4,
            selectionStart: 4,
            selectionEnd: 4,
        });
    });

    it.each([
        ["unknown input", "\x1b[999~"],
        ["submit", "\r"],
        ["escape", "\x1b"],
    ])("preserves Input selection when %s does not change value or cursor", (_label, key) => {
        const input = new Input();
        const submit = vi.fn();
        const escape = vi.fn();
        input.onSubmit = submit;
        input.onEscape = escape;
        input.applyGuiEdit("abcd", 1, 3);

        input.handleInput(key);

        expect(input.getSnapshot()).toMatchObject({
            value: "abcd",
            cursor: 3,
            selectionStart: 1,
            selectionEnd: 3,
        });
        expect(submit).toHaveBeenCalledTimes(key === "\r" ? 1 : 0);
        expect(escape).toHaveBeenCalledTimes(key === "\x1b" ? 1 : 0);
    });

    it("submits Editor through Pi trim reset and callback order", () => {
        const calls: string[] = [];
        const editor = makeEditor();
        editor.onChange = (value) => calls.push(`change:${value}`);
        editor.onSubmit = (value) => calls.push(`submit:${value}`);

        expect(editor.submitGuiValue("  answer  ", 10, 10)).toEqual({
            accepted: true,
            submitted: true,
        });
        expect(calls).toEqual(["change:  answer  ", "change:", "submit:answer"]);
        expect(editor.getText()).toBe("");
    });

    it("flushes disabled Editor submit edits without trim reset or submit callback", () => {
        const editor = makeEditor();
        editor.applyGuiEdit("before", 1, 4);
        const change = vi.fn();
        const submit = vi.fn();
        editor.onChange = change;
        editor.onSubmit = submit;
        editor.disableSubmit = true;

        expect(editor.submitGuiValue("after\tvalue", 6, 11)).toEqual({
            accepted: true,
            submitted: false,
        });
        expect(editor.getSnapshot()).toMatchObject({
            value: "after    value",
            lines: ["after    value"],
            cursorLine: 0,
            cursorCol: 14,
            selectionStart: 9,
            selectionEnd: 14,
        });
        expect(change).toHaveBeenCalledOnce();
        expect(change).toHaveBeenCalledWith("after    value");
        expect(submit).not.toHaveBeenCalled();
    });

    it.each([
        ["setText", (editor: Editor) => editor.setText("next")],
        ["insertTextAtCursor", (editor: Editor) => editor.insertTextAtCursor("x")],
        ["handleInput", (editor: Editor) => editor.handleInput("x")],
    ])("keeps a valid collapsed Editor selection after legacy %s mutation", (_label, mutate) => {
        const editor = makeEditor();
        editor.applyGuiEdit("before", 1, 4);

        mutate(editor);

        const snapshot = editor.getSnapshot();
        const cursorOffset =
            snapshot.lines.slice(0, snapshot.cursorLine).reduce((length, line) => length + line.length + 1, 0) +
            snapshot.cursorCol;
        expect(snapshot.selectionStart).toBe(cursorOffset);
        expect(snapshot.selectionEnd).toBe(cursorOffset);
        expect(snapshot.selectionEnd).toBeLessThanOrEqual(snapshot.value.length);
    });

    it.each([
        ["left", "\x1b[D", "one two\nthree four\nfive six", 1, 11],
        ["right", "\x1b[C", "one two\nthree four\nfive six", 1, 11],
        ["line start", "\x1b[H", "one two\nthree four\nfive six", 1, 11],
        ["line end", "\x1b[F", "one two\nthree four\nfive six", 1, 11],
        ["word left", "\x1b[1;3D", "one two\nthree four\nfive six", 1, 11],
        ["word right", "\x1b[1;3C", "one two\nthree four\nfive six", 1, 11],
        ["up", "\x1b[A", "one two\nthree four\nfive six", 1, 13],
        ["down", "\x1b[B", "one two\nthree four\nfive six", 1, 13],
        ["page up", "\x1b[5~", "one\ntwo\nthree\nfour\nfive\nsix\nseven", 1, 16],
        ["page down", "\x1b[6~", "one\ntwo\nthree\nfour\nfive\nsix\nseven", 1, 16],
    ])("collapses Editor selection after pure cursor movement %s", (_label, key, value, start, end) => {
        const editor = makeEditor();
        editor.applyGuiEdit(value, start, end);
        const before = editor.getSnapshot();

        editor.handleInput(key);

        const snapshot = editor.getSnapshot();
        const cursorOffset =
            snapshot.lines.slice(0, snapshot.cursorLine).reduce((length, line) => length + line.length + 1, 0) +
            snapshot.cursorCol;
        expect({ line: snapshot.cursorLine, col: snapshot.cursorCol }).not.toEqual({
            line: before.cursorLine,
            col: before.cursorCol,
        });
        expect(snapshot.selectionStart).toBe(cursorOffset);
        expect(snapshot.selectionEnd).toBe(cursorOffset);
    });

    it.each([
        ["input removes CRLF and expands tabs", "single-line", "a\r\nb\tc", 1, 6, "ab    c", 1, 7],
        ["input maps a boundary inside removed CRLF", "single-line", "a\r\nb", 2, 2, "ab", 1, 1],
        ["editor collapses CRLF and expands tabs", "multi-line", "a\r\nb\tc", 2, 5, "a\nb    c", 2, 7],
        ["editor maps both CRLF interior boundaries after one newline", "multi-line", "a\r\nb", 2, 3, "a\nb", 2, 2],
        ["input preserves a boundary inside a surrogate pair", "single-line", "a😀b", 2, 2, "a😀b", 2, 2],
        ["editor preserves surrogate pair boundary span", "multi-line", "😀\r\nx", 1, 3, "😀\nx", 1, 3],
    ] as const)("%s", (_label, mode, raw, rawStart, rawEnd, normalized, normalizedStart, normalizedEnd) => {
        expect(normalizeGuiTextWithSelection(raw, rawStart, rawEnd, mode)).toEqual({
            value: normalized,
            selectionStart: normalizedStart,
            selectionEnd: normalizedEnd,
        });
    });

    it.each([
        ["NaN start", Number.NaN, 0],
        ["fractional start", 0.5, 1],
        ["negative start", -1, 0],
        ["reversed range", 2, 1],
        ["end beyond raw value", 0, 4],
    ])("rejects invalid Input selection metadata: %s", (_label, selectionStart, selectionEnd) => {
        const input = new Input();
        input.applyGuiEdit("before", 2, 2);
        const before = input.getSnapshot();
        const submit = vi.fn();
        input.onSubmit = submit;

        expect(input.applyGuiEdit("abc", selectionStart, selectionEnd)).toBe(false);
        expect(input.submitGuiValue("abc", selectionStart, selectionEnd)).toBe(false);
        expect(input.getSnapshot()).toEqual(before);
        expect(submit).not.toHaveBeenCalled();
    });

    it.each([
        ["NaN start", Number.NaN, 0],
        ["fractional start", 0.5, 1],
        ["negative start", -1, 0],
        ["reversed range", 2, 1],
        ["end beyond raw value", 0, 4],
    ])("rejects invalid Editor selection metadata: %s", (_label, selectionStart, selectionEnd) => {
        const editor = makeEditor();
        editor.applyGuiEdit("before", 2, 2);
        const before = editor.getSnapshot();
        const change = vi.fn();
        const submit = vi.fn();
        editor.onChange = change;
        editor.onSubmit = submit;

        expect(editor.applyGuiEdit("abc", selectionStart, selectionEnd)).toBe(false);
        expect(editor.submitGuiValue("abc", selectionStart, selectionEnd)).toEqual({
            accepted: false,
            submitted: false,
        });
        expect(editor.getSnapshot()).toEqual(before);
        expect(change).not.toHaveBeenCalled();
        expect(submit).not.toHaveBeenCalled();
    });
});
