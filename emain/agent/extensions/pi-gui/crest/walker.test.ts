import { describe, expect, it } from "vitest";

import { Box } from "../src/components/box";
import { CancellableLoader } from "../src/components/cancellable-loader";
import { Editor, type EditorTheme } from "../src/components/editor";
import { Image, type ImageTheme } from "../src/components/image";
import { Input } from "../src/components/input";
import { Loader } from "../src/components/loader";
import { Markdown, type MarkdownTheme } from "../src/components/markdown";
import { SelectList } from "../src/components/select-list";
import { SettingsList, type SettingsListTheme } from "../src/components/settings-list";
import { Spacer } from "../src/components/spacer";
import { Text } from "../src/components/text";
import { TruncatedText } from "../src/components/truncated-text";
import { PiGuiComponentKind, type Component, type TUI } from "../src/tui";
import { Chart } from "./rich/chart";
import { DiffView } from "./rich/diff-view";
import { RichTable } from "./rich/rich-table";
import { componentToWidget } from "./walker";
import { getPiGuiAdapters, type DispatchResult, type PiGuiAdapter, type WidgetEvent } from "./adapters";

function assertAdapterEventContract(adapter: PiGuiAdapter): DispatchResult {
    const component: Component = {
        render: () => [],
        invalidate: () => {},
    };
    const event: WidgetEvent = { nodeid: "node-1", type: "cancel" };

    adapter.dispose?.(component);
    return adapter.dispatch(component, event, { snapshot: (nextComponent) => componentToWidget(nextComponent, { width: 80 }) });
}

function getAdapter(kind: string): PiGuiAdapter {
    const adapter = getPiGuiAdapters().find((candidate) => candidate.kind === kind);
    if (!adapter) throw new Error(`missing ${kind} adapter`);
    return adapter;
}

describe("pi-gui widget walker", () => {
    it("publishes stable standard component kinds", () => {
        const tui = { requestRender: () => {} } as unknown as TUI;
        const selectListTheme = {
            selectedPrefix: (text: string) => text,
            selectedText: (text: string) => text,
            description: (text: string) => text,
            scrollInfo: (text: string) => text,
            noMatch: (text: string) => text,
        };
        const settingsTheme: SettingsListTheme = {
            label: (text) => text,
            value: (text) => text,
            description: (text) => text,
            cursor: "> ",
            hint: (text) => text,
        };
        const markdownTheme: MarkdownTheme = {
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
        const text = new Text();
        const box = new Box();
        const spacer = new Spacer();
        const list = new SelectList([], 5, selectListTheme);
        const settings = new SettingsList([], 5, settingsTheme, () => {}, () => {});
        const input = new Input();
        const markdown = new Markdown("", 0, 0, markdownTheme);
        const editor = new Editor(tui, { borderColor: (value) => value, selectList: selectListTheme });
        const image = new Image("", "image/png", { fallbackColor: (value) => value });
        const loader = new Loader(tui, (value) => value, (value) => value, "", { frames: [] });
        const cancellableLoader = new CancellableLoader(tui, (value) => value, (value) => value, "", { frames: [] });
        const truncated = new TruncatedText("");

        expect([
            text[PiGuiComponentKind],
            box[PiGuiComponentKind],
            spacer[PiGuiComponentKind],
            list[PiGuiComponentKind],
            settings[PiGuiComponentKind],
            input[PiGuiComponentKind],
            markdown[PiGuiComponentKind],
            editor[PiGuiComponentKind],
            image[PiGuiComponentKind],
            loader[PiGuiComponentKind],
            cancellableLoader[PiGuiComponentKind],
            truncated[PiGuiComponentKind],
        ]).toEqual([
            "text",
            "box",
            "spacer",
            "selectlist",
            "settingslist",
            "input",
            "markdown",
            "editor",
            "image",
            "loader",
            "cancellableloader",
            "truncatedtext",
        ]);
    });

    it("publishes immutable public snapshots", () => {
        const tui = { requestRender: () => {} } as unknown as TUI;
        const markdownTheme: MarkdownTheme = {
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
        const child = new Text("child", 0, 0);
        const box = new Box(4, 5);
        box.addChild(child);
        const firstBoxSnapshot = box.getSnapshot();
        firstBoxSnapshot.children.length = 0;
        const spacer = new Spacer(6);
        const markdown = new Markdown("**hello**", 1, 0, markdownTheme);
        const image = new Image(
            "aGVsbG8=",
            "image/png",
            { fallbackColor: (text) => text },
            { filename: "hello.png" },
            { widthPx: 10, heightPx: 5 }
        );
        const loader = new Loader(tui, (text) => text, (text) => text, "Working", { frames: ["*"] });
        const cancellableLoader = new CancellableLoader(
            tui,
            (text) => text,
            (text) => text,
            "Abortable",
            { frames: ["!"] }
        );
        let abortCount = 0;
        cancellableLoader.onAbort = () => {
            abortCount++;
        };

        expect(new Text("hello", 2, 3).getSnapshot()).toEqual({
            text: "hello",
            paddingX: 2,
            paddingY: 3,
        });
        expect(box.getSnapshot()).toEqual({
            children: [child],
            paddingX: 4,
            paddingY: 5,
        });
        expect(spacer.getSnapshot()).toEqual({ lines: 6 });
        spacer.setLines(2);
        expect(spacer.getSnapshot()).toEqual({ lines: 2 });
        expect(markdown.getSnapshot()).toEqual({
            source: "**hello**",
            paddingX: 1,
            paddingY: 0,
        });
        expect(image.getSnapshot()).toEqual({
            base64Data: "aGVsbG8=",
            mimeType: "image/png",
            filename: "hello.png",
            widthPx: 10,
            heightPx: 5,
        });
        expect(new TruncatedText("long", 2, 1).getSnapshot()).toEqual({
            text: "long",
            paddingX: 2,
            paddingY: 1,
        });
        expect(loader.getSnapshot()).toEqual({
            label: "Working",
            frame: "*",
            cancellable: false,
            aborted: undefined,
        });
        expect(cancellableLoader.getSnapshot()).toEqual({
            label: "Abortable",
            frame: "!",
            cancellable: true,
            aborted: false,
        });

        cancellableLoader.cancel();

        expect(cancellableLoader.getSnapshot().aborted).toBe(true);
        expect(abortCount).toBe(1);
    });

    it("registers placeholder adapter kinds for standard components", () => {
        const adapters = getPiGuiAdapters();
        const component: Component = {
            render: () => ["fallback"],
            invalidate: () => {},
        };

        expect(adapters.map((adapter) => adapter.kind)).toEqual([
            "text",
            "box",
            "spacer",
            "selectlist",
            "settingslist",
            "input",
            "markdown",
            "editor",
            "image",
            "loader",
            "truncatedtext",
        ]);
        expect(adapters.some((adapter) => adapter.matches(component))).toBe(false);
        expect(assertAdapterEventContract(adapters[0])).toEqual({ handled: false });
    });

    it("snapshots and dispatches Input through its adapter", () => {
        const adapter = getAdapter("input");
        const input = new Input();
        const submissions: string[] = [];
        let cancelled = false;
        input.setValue("draft");
        input.onSubmit = (value) => submissions.push(value);
        input.onEscape = () => {
            cancelled = true;
        };

        expect(adapter.matches(input)).toBe(true);
        expect(adapter.snapshot(input, {
            makeId: () => "input-1",
            options: { width: 80 },
            snapshot: (component) => componentToWidget(component, { width: 80 }),
        })).toEqual({
            kind: "input",
            id: "input-1",
            value: "draft",
            cursor: 0,
            focused: false,
        });
        expect(adapter.dispatch(input, { nodeid: "input-1", type: "change", payload: { value: "final" } }, {
            snapshot: (component) => componentToWidget(component, { width: 80 }),
        })).toEqual({ handled: true });
        expect(adapter.dispatch(input, { nodeid: "input-1", type: "submit" }, {
            snapshot: (component) => componentToWidget(component, { width: 80 }),
        })).toEqual({ handled: true });
        expect(submissions).toEqual(["final"]);
        expect(adapter.dispatch(input, { nodeid: "input-1", type: "cancel" }, {
            snapshot: (component) => componentToWidget(component, { width: 80 }),
        })).toEqual({ handled: true });
        expect(cancelled).toBe(true);
    });

    it("snapshots and dispatches SelectList through its adapter", () => {
        const adapter = getAdapter("selectlist");
        const list = new SelectList(
            [
                { value: "fast", label: "Fast", description: "quick path" },
                { value: "safe", label: "Safe" },
            ],
            5,
            {
                selectedPrefix: (text) => text,
                selectedText: (text) => text,
                description: (text) => text,
                scrollInfo: (text) => text,
                noMatch: (text) => text,
            }
        );
        const selected: string[] = [];
        let cancelled = false;
        list.onSelect = (item) => selected.push(item.value);
        list.onCancel = () => {
            cancelled = true;
        };

        expect(adapter.matches(list)).toBe(true);
        expect(adapter.snapshot(list, {
            makeId: () => "selectlist-1",
            options: { width: 80 },
            snapshot: (component) => componentToWidget(component, { width: 80 }),
        })).toMatchObject({
            kind: "selectlist",
            id: "selectlist-1",
            selectedindex: 0,
            maxvisible: 5,
            focused: false,
            items: [
                { value: "fast", label: "Fast", description: "quick path" },
                { value: "safe", label: "Safe" },
            ],
        });
        expect(adapter.dispatch(list, { nodeid: "selectlist-1", type: "select", payload: { index: 1 } }, {
            snapshot: (component) => componentToWidget(component, { width: 80 }),
        })).toEqual({ handled: true });
        expect(selected).toEqual(["safe"]);
        expect(adapter.dispatch(list, { nodeid: "selectlist-1", type: "cancel" }, {
            snapshot: (component) => componentToWidget(component, { width: 80 }),
        })).toEqual({ handled: true });
        expect(cancelled).toBe(true);
    });

    it("snapshots and dispatches SettingsList through its adapter", () => {
        const adapter = getAdapter("settingslist");
        const settingsTheme: SettingsListTheme = {
            label: (text) => text,
            value: (text) => text,
            description: (text) => text,
            cursor: "> ",
            hint: (text) => text,
        };
        const changes: Array<[string, string]> = [];
        let cancelled = false;
        const settings = new SettingsList(
            [
                { id: "mode", label: "Mode", currentValue: "fast", description: "speed", values: ["fast", "safe"] },
                { id: "theme", label: "Theme", currentValue: "dark", values: ["dark", "light"] },
            ],
            6,
            settingsTheme,
            (id, value) => changes.push([id, value]),
            () => {
                cancelled = true;
            }
        );

        expect(adapter.matches(settings)).toBe(true);
        expect(adapter.snapshot(settings, {
            makeId: () => "settingslist-1",
            options: { width: 80 },
            snapshot: (component) => componentToWidget(component, { width: 80 }),
        })).toEqual({
            kind: "settingslist",
            id: "settingslist-1",
            selectedindex: 0,
            maxvisible: 6,
            items: [
                { id: "mode", label: "Mode", currentvalue: "fast", description: "speed", values: ["fast", "safe"] },
                { id: "theme", label: "Theme", currentvalue: "dark", values: ["dark", "light"] },
            ],
        });
        expect(adapter.dispatch(settings, { nodeid: "settingslist-1", type: "select", payload: { index: 1 } }, {
            snapshot: (component) => componentToWidget(component, { width: 80 }),
        })).toEqual({ handled: true });
        expect(settings.getSnapshot().selectedIndex).toBe(1);
        expect(adapter.dispatch(settings, { nodeid: "settingslist-1", type: "change", payload: { id: "theme", value: "light" } }, {
            snapshot: (component) => componentToWidget(component, { width: 80 }),
        })).toEqual({ handled: true });
        expect(adapter.dispatch(settings, { nodeid: "settingslist-1", type: "submit" }, {
            snapshot: (component) => componentToWidget(component, { width: 80 }),
        })).toEqual({ handled: true });
        expect(adapter.dispatch(settings, { nodeid: "settingslist-1", type: "cancel" }, {
            snapshot: (component) => componentToWidget(component, { width: 80 }),
        })).toEqual({ handled: true });
        expect(changes).toEqual([
            ["theme", "light"],
            ["theme", "dark"],
        ]);
        expect(cancelled).toBe(true);
    });

    it("snapshots and dispatches Editor through its adapter", () => {
        const adapter = getAdapter("editor");
        const tui = { requestRender: () => {} } as any;
        const editorTheme: EditorTheme = {
            borderColor: (text) => text,
            selectList: {
                selectedPrefix: (text) => text,
                selectedText: (text) => text,
                description: (text) => text,
                scrollInfo: (text) => text,
                noMatch: (text) => text,
            },
        };
        const editor = new Editor(tui, editorTheme, { paddingX: 2 });
        const submissions: string[] = [];
        const changes: string[] = [];
        editor.setText("hello\nworld");
        editor.onSubmit = (value) => submissions.push(value);
        editor.onChange = (value) => changes.push(value);

        expect(adapter.matches(editor)).toBe(true);
        expect(adapter.snapshot(editor, {
            makeId: () => "editor-1",
            options: { width: 80 },
            snapshot: (component) => componentToWidget(component, { width: 80 }),
        })).toMatchObject({
            kind: "editor",
            id: "editor-1",
            value: "hello\nworld",
            lines: ["hello", "world"],
            cursorline: 1,
            paddingx: 2,
        });
        expect(adapter.dispatch(editor, { nodeid: "editor-1", type: "change", payload: { value: "final" } }, {
            snapshot: (component) => componentToWidget(component, { width: 80 }),
        })).toEqual({ handled: true });
        expect(editor.getText()).toBe("final");
        expect(adapter.dispatch(editor, { nodeid: "editor-1", type: "key", payload: { data: "!" } }, {
            snapshot: (component) => componentToWidget(component, { width: 80 }),
        })).toEqual({ handled: true });
        expect(editor.getText()).toBe("final!");
        expect(adapter.dispatch(editor, { nodeid: "editor-1", type: "submit" }, {
            snapshot: (component) => componentToWidget(component, { width: 80 }),
        })).toEqual({ handled: true });
        expect(adapter.dispatch(editor, { nodeid: "editor-1", type: "cancel" }, {
            snapshot: (component) => componentToWidget(component, { width: 80 }),
        })).toEqual({ handled: false });
        expect(submissions).toEqual(["final!"]);
        expect(changes).toContain("final");
    });

    it("snapshots and dispatches Loader and CancellableLoader through their adapter", () => {
        const adapter = getAdapter("loader");
        const tui = { requestRender: () => {} } as any;
        const loader = new Loader(tui, (text) => text, (text) => text, "Working", { frames: ["*"] });
        const cancellableLoader = new CancellableLoader(tui, (text) => text, (text) => text, "Abortable", { frames: ["!"] });
        let aborted = false;
        cancellableLoader.onAbort = () => {
            aborted = true;
        };

        expect(adapter.matches(loader)).toBe(true);
        expect(adapter.matches(cancellableLoader)).toBe(true);
        expect(adapter.snapshot(loader, {
            makeId: () => "loader-1",
            options: { width: 80 },
            snapshot: (component) => componentToWidget(component, { width: 80 }),
        })).toEqual({
            kind: "loader",
            id: "loader-1",
            label: "Working",
            frame: "*",
            cancellable: false,
            aborted: undefined,
        });
        expect(adapter.snapshot(cancellableLoader, {
            makeId: () => "loader-2",
            options: { width: 80 },
            snapshot: (component) => componentToWidget(component, { width: 80 }),
        })).toEqual({
            kind: "loader",
            id: "loader-2",
            label: "Abortable",
            frame: "!",
            cancellable: true,
            aborted: false,
        });
        expect(adapter.dispatch(loader, { nodeid: "loader-1", type: "cancel" }, {
            snapshot: (component) => componentToWidget(component, { width: 80 }),
        })).toEqual({ handled: false });
        expect(adapter.dispatch(cancellableLoader, { nodeid: "loader-2", type: "cancel" }, {
            snapshot: (component) => componentToWidget(component, { width: 80 }),
        })).toEqual({ handled: true });
        expect(aborted).toBe(true);
        expect(cancellableLoader.aborted).toBe(true);
    });

    it("rejects non-finite and non-integer SelectList indexes", () => {
        const adapter = getAdapter("selectlist");
        const list = new SelectList(
            [
                { value: "fast", label: "Fast" },
                { value: "safe", label: "Safe" },
            ],
            5,
            {
                selectedPrefix: (text) => text,
                selectedText: (text) => text,
                description: (text) => text,
                scrollInfo: (text) => text,
                noMatch: (text) => text,
            }
        );
        const selected: string[] = [];
        list.onSelect = (item) => selected.push(item.value);

        list.setSelectedIndex(Number.NaN);
        expect(list.getSnapshot().selectedIndex).toBe(0);
        list.setSelectedIndex(1.5);
        expect(list.getSnapshot().selectedIndex).toBe(0);
        list.setSelectedIndex(Number.POSITIVE_INFINITY);
        expect(list.getSnapshot().selectedIndex).toBe(0);
        expect(adapter.dispatch(list, { nodeid: "selectlist-1", type: "select", payload: { index: 1.5 } }, {
            snapshot: (component) => componentToWidget(component, { width: 80 }),
        })).toEqual({ handled: false });
        expect(adapter.dispatch(list, { nodeid: "selectlist-1", type: "select", payload: { index: Number.NaN } }, {
            snapshot: (component) => componentToWidget(component, { width: 80 }),
        })).toEqual({ handled: false });
        expect(list.getSnapshot().selectedIndex).toBe(0);
        expect(selected).toEqual([]);
    });

    it("does not handle Input or SelectList cancel without callbacks at the adapter boundary", () => {
        const inputAdapter = getAdapter("input");
        const selectListAdapter = getAdapter("selectlist");
        const input = new Input();
        const list = new SelectList(
            [{ value: "fast", label: "Fast" }],
            5,
            {
                selectedPrefix: (text) => text,
                selectedText: (text) => text,
                description: (text) => text,
                scrollInfo: (text) => text,
                noMatch: (text) => text,
            }
        );

        expect(inputAdapter.dispatch(input, { nodeid: "input-1", type: "cancel" }, {
            snapshot: (component) => componentToWidget(component, { width: 80 }),
        })).toEqual({ handled: false });
        expect(selectListAdapter.dispatch(list, { nodeid: "selectlist-1", type: "cancel" }, {
            snapshot: (component) => componentToWidget(component, { width: 80 }),
        })).toEqual({ handled: false });
    });

    it("does not serialize Input or SelectList constructor-name lookalikes without adapters", () => {
        const inputLookalike = {
            constructor: { name: "Input" },
            getValue: () => "private-field fallback",
            render: () => ["input fallback"],
            invalidate: () => {},
        } as unknown as Component;
        const selectListLookalike = {
            constructor: { name: "SelectList" },
            items: [{ value: "legacy", label: "Legacy" }],
            selectedIndex: 0,
            maxVisible: 5,
            render: () => ["selectlist fallback"],
            invalidate: () => {},
        } as unknown as Component;

        expect(componentToWidget(inputLookalike, { width: 80 })).toMatchObject({
            kind: "terminal",
            lines: ["input fallback"],
        });
        expect(componentToWidget(selectListLookalike, { width: 80 })).toMatchObject({
            kind: "terminal",
            lines: ["selectlist fallback"],
        });
    });

    it("falls back to terminal when Input-like or SelectList-like snapshots throw", () => {
        const throwingInputLike = {
            getSnapshot: () => {
                throw new Error("input snapshot unavailable");
            },
            setValue: () => {},
            getValue: () => "draft",
            handleInput: () => {},
            render: () => ["input fallback"],
            invalidate: () => {},
        } as unknown as Component;
        const throwingSelectListLike = {
            getSnapshot: () => {
                throw new Error("selectlist snapshot unavailable");
            },
            setSelectedIndex: () => true,
            getSelectedItem: () => null,
            setFilter: () => {},
            handleInput: () => {},
            render: () => ["selectlist fallback"],
            invalidate: () => {},
        } as unknown as Component;

        expect(componentToWidget(throwingInputLike, { width: 80 })).toMatchObject({
            kind: "terminal",
            lines: ["input fallback"],
        });
        expect(componentToWidget(throwingSelectListLike, { width: 80 })).toMatchObject({
            kind: "terminal",
            lines: ["selectlist fallback"],
        });
    });

    it("serializes retained Text and Box trees without calling render", () => {
        const box = new Box(2, 1);
        box.addChild(new Text("hello gui", 1, 0));

        const node = componentToWidget(box, { width: 80 });

        expect(node).toMatchObject({
            kind: "box",
            paddingx: 2,
            paddingy: 1,
            children: [
                {
                    kind: "text",
                    text: "hello gui",
                    paddingx: 1,
                    paddingy: 0,
                },
            ],
        });
    });

    it("serializes SelectList with item semantics and selected state", () => {
        const list = new SelectList(
            [
                { value: "fast", label: "Fast", description: "quick path" },
                { value: "safe", label: "Safe" },
            ],
            5,
            {
                selectedPrefix: (text) => text,
                selectedText: (text) => text,
                description: (text) => text,
                scrollInfo: (text) => text,
                noMatch: (text) => text,
            }
        );
        list.setSelectedIndex(1);

        const node = componentToWidget(list, { width: 80 });

        expect(node).toMatchObject({
            kind: "selectlist",
            selectedindex: 1,
            maxvisible: 5,
            items: [
                { value: "fast", label: "Fast", description: "quick path" },
                { value: "safe", label: "Safe" },
            ],
        });
    });

    it("falls back to terminal lines for unknown hand-written components", () => {
        const component: Component = {
            render: () => ["\u001b[32mraw tui\u001b[0m"],
            invalidate: () => {},
        };

        const node = componentToWidget(component, { width: 20 });

        expect(node).toEqual({
            kind: "terminal",
            id: expect.any(String),
            lines: ["\u001b[32mraw tui\u001b[0m"],
        });
    });

    it("serializes Input, SettingsList, and Markdown as semantic widgets", () => {
        const input = new Input();
        input.setValue("typed");
        const settingsTheme: SettingsListTheme = {
            label: (text) => text,
            value: (text) => text,
            description: (text) => text,
            cursor: "> ",
            hint: (text) => text,
        };
        const settings = new SettingsList(
            [{ id: "mode", label: "Mode", currentValue: "fast", values: ["fast", "safe"] }],
            6,
            settingsTheme,
            () => {},
            () => {}
        );
        const markdownTheme: MarkdownTheme = {
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
        const markdown = new Markdown("**hello**", 1, 0, markdownTheme);

        expect(componentToWidget(input, { width: 80 })).toMatchObject({
            kind: "input",
            value: "typed",
            cursor: 0,
        });
        expect(componentToWidget(settings, { width: 80 })).toMatchObject({
            kind: "settingslist",
            items: [{ id: "mode", label: "Mode", currentvalue: "fast", values: ["fast", "safe"] }],
        });
        expect(componentToWidget(markdown, { width: 80 })).toMatchObject({
            kind: "markdown",
            source: "**hello**",
            paddingx: 1,
            paddingy: 0,
        });
    });

    it("serializes extended pi-tui components as semantic widgets", () => {
        const tui = { requestRender: () => {} } as any;
        const selectListTheme = {
            selectedPrefix: (text: string) => text,
            selectedText: (text: string) => text,
            description: (text: string) => text,
            scrollInfo: (text: string) => text,
            noMatch: (text: string) => text,
        };
        const editorTheme: EditorTheme = {
            borderColor: (text) => text,
            selectList: selectListTheme,
        };
        const imageTheme: ImageTheme = {
            fallbackColor: (text) => text,
        };
        const editor = new Editor(tui, editorTheme, { paddingX: 2 });
        editor.setText("hello\nworld");
        const image = new Image("aGVsbG8=", "image/png", imageTheme, { filename: "hello.png" }, { widthPx: 10, heightPx: 5 });
        const loader = new Loader(tui, (text) => text, (text) => text, "Working", { frames: ["*"] });
        const cancellableLoader = new CancellableLoader(tui, (text) => text, (text) => text, "Abortable", { frames: ["!"] });
        const truncated = new TruncatedText("long text", 1, 0);

        expect(componentToWidget(editor, { width: 80 })).toMatchObject({
            kind: "editor",
            value: "hello\nworld",
            lines: ["hello", "world"],
            cursorline: 1,
            paddingx: 2,
        });
        expect(componentToWidget(image, { width: 80 })).toMatchObject({
            kind: "image",
            src: "data:image/png;base64,aGVsbG8=",
            filename: "hello.png",
            widthpx: 10,
            heightpx: 5,
        });
        expect(componentToWidget(loader, { width: 80 })).toMatchObject({
            kind: "loader",
            label: "Working",
            frame: "*",
            cancellable: false,
        });
        expect(componentToWidget(cancellableLoader, { width: 80 })).toMatchObject({
            kind: "loader",
            label: "Abortable",
            frame: "!",
            cancellable: true,
            aborted: false,
        });
        expect(componentToWidget(truncated, { width: 80 })).toMatchObject({
            kind: "truncatedtext",
            text: "long text",
            paddingx: 1,
            paddingy: 0,
        });
    });
});

describe("pi-gui rich components", () => {
    it("emits RichTable GUI data and keeps an ANSI fallback", () => {
        const table = new RichTable({
            columns: [
                { key: "name", label: "Name" },
                { key: "status", label: "Status" },
            ],
            rows: [
                { name: "pi-gui", status: "planned" },
                { name: "fallback", status: "ready" },
            ],
        });

        expect(componentToWidget(table, { width: 80 })).toMatchObject({
            kind: "richtable",
            columns: [
                { key: "name", label: "Name" },
                { key: "status", label: "Status" },
            ],
            rows: [
                { name: "pi-gui", status: "planned" },
                { name: "fallback", status: "ready" },
            ],
        });
        expect(table.render(40).join("\n")).toContain("pi-gui");
    });

    it("emits DiffView GUI data and keeps an ANSI fallback", () => {
        const diff = new DiffView({
            filename: "a.ts",
            hunks: [
                {
                    header: "@@ -1 +1 @@",
                    lines: [
                        { type: "remove", text: "-old" },
                        { type: "add", text: "+new" },
                    ],
                },
            ],
        });

        expect(componentToWidget(diff, { width: 80 })).toMatchObject({
            kind: "diffview",
            filename: "a.ts",
            hunks: [
                {
                    header: "@@ -1 +1 @@",
                    lines: [
                        { type: "remove", text: "-old" },
                        { type: "add", text: "+new" },
                    ],
                },
            ],
        });
        expect(diff.render(40).join("\n")).toContain("@@ -1 +1 @@");
    });

    it("emits Chart GUI data and keeps an ANSI fallback", () => {
        const chart = new Chart({
            charttype: "bar",
            series: [
                {
                    name: "coverage",
                    points: [
                        { label: "Text", value: 1 },
                        { label: "Box", value: 2 },
                    ],
                },
            ],
        });

        expect(componentToWidget(chart, { width: 80 })).toMatchObject({
            kind: "chart",
            charttype: "bar",
            series: [
                {
                    name: "coverage",
                    points: [
                        { label: "Text", value: 1 },
                        { label: "Box", value: 2 },
                    ],
                },
            ],
        });
        expect(chart.render(40).join("\n")).toContain("coverage");
    });
});
