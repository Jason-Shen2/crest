import { readFile } from "node:fs/promises";
import { runInNewContext } from "node:vm";
import * as ts from "typescript";
import { describe, expect, expectTypeOf, it, vi } from "vitest";

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
import { getPiGuiAdapter, getPiGuiAdapters, type DispatchResult, type PiGuiAdapter, type WidgetEvent } from "./adapters";

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

const AllowedWalkerModules = new Set([
    "../src/tui",
    "./adapters",
    "./rich/contract",
    "./widget-tree",
]);

function getStaticString(node: ts.Node, aliases: ReadonlyMap<string, string> = new Map()): string | undefined {
    if (ts.isStringLiteralLike(node)) return node.text;
    return ts.isIdentifier(node) ? aliases.get(node.text) : undefined;
}

function getAccessName(node: ts.Expression, aliases: ReadonlyMap<string, string>): string | undefined {
    if (ts.isPropertyAccessExpression(node)) return node.name.text;
    if (ts.isElementAccessExpression(node) && node.argumentExpression) {
        return getStaticString(node.argumentExpression, aliases);
    }
    return undefined;
}

function getCallableName(
    node: ts.Expression,
    stringAliases: ReadonlyMap<string, string>,
    callableAliases: ReadonlyMap<string, string>
): string | undefined {
    if (ts.isIdentifier(node)) return callableAliases.get(node.text);
    const property = getAccessName(node, stringAliases);
    const expression = ts.isPropertyAccessExpression(node) || ts.isElementAccessExpression(node) ? node.expression : undefined;
    return expression != null && ts.isIdentifier(expression) && property != null ? `${expression.text}.${property}` : undefined;
}

function isConstructorReference(
    node: ts.Expression,
    stringAliases: ReadonlyMap<string, string>,
    callableAliases: ReadonlyMap<string, string>
): boolean {
    if (getAccessName(node, stringAliases) === "constructor") return true;
    return (
        ts.isCallExpression(node) &&
        getCallableName(node.expression, stringAliases, callableAliases) === "Reflect.get" &&
        node.arguments.length >= 2 &&
        getStaticString(node.arguments[1], stringAliases) === "constructor"
    );
}

function isConstructorNameAccess(
    node: ts.Node,
    stringAliases: ReadonlyMap<string, string>,
    callableAliases: ReadonlyMap<string, string>
): boolean {
    if (
        (ts.isPropertyAccessExpression(node) || ts.isElementAccessExpression(node)) &&
        getAccessName(node, stringAliases) === "name"
    ) {
        return isConstructorReference(node.expression, stringAliases, callableAliases);
    }
    if (!ts.isCallExpression(node) || node.arguments.length < 2) return false;
    if (
        getStaticString(node.arguments[1], stringAliases) !== "name" ||
        !isConstructorReference(node.arguments[0], stringAliases, callableAliases)
    ) {
        return false;
    }
    const callableName = getCallableName(node.expression, stringAliases, callableAliases);
    return callableName === "Reflect.get" || callableName === "Object.getOwnPropertyDescriptor";
}

function isExpandoAccess(node: ts.Node, stringAliases: ReadonlyMap<string, string>): boolean {
    if (
        (ts.isPropertyAccessExpression(node) || ts.isElementAccessExpression(node)) &&
        getAccessName(node, stringAliases) === "__crestwidgetid"
    ) {
        return true;
    }
    if (!ts.isCallExpression(node) || node.arguments.length < 2) return false;
    if (getStaticString(node.arguments[1], stringAliases) !== "__crestwidgetid") return false;
    const callableName = getCallableName(node.expression, stringAliases, new Map());
    return ["Object.defineProperty", "Reflect.get", "Reflect.set", "Reflect.deleteProperty"].includes(callableName ?? "");
}

function isComponentStringWeakMap(node: ts.NewExpression): boolean {
    if (!ts.isIdentifier(node.expression) || node.expression.text !== "WeakMap" || node.typeArguments?.length !== 2) {
        return false;
    }
    const [keyType, valueType] = node.typeArguments;
    return (
        ts.isTypeReferenceNode(keyType) &&
        ts.isIdentifier(keyType.typeName) &&
        keyType.typeName.text === "Component" &&
        valueType.kind === ts.SyntaxKind.StringKeyword
    );
}

function collectAliases(sourceFile: ts.SourceFile): {
    stringAliases: Map<string, string>;
    callableAliases: Map<string, string>;
} {
    const stringAliases = new Map<string, string>();
    const callableAliases = new Map<string, string>();

    function visit(node: ts.Node): void {
        if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.initializer) {
            const stringValue = getStaticString(node.initializer, stringAliases);
            if (stringValue != null) stringAliases.set(node.name.text, stringValue);
            const callableName = getCallableName(node.initializer, stringAliases, callableAliases);
            if (callableName != null) callableAliases.set(node.name.text, callableName);
        }
        ts.forEachChild(node, visit);
    }

    visit(sourceFile);
    return { stringAliases, callableAliases };
}

function assertWalkerSourceInvariant(source: string): void {
    const sourceFile = ts.createSourceFile("walker.ts", source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
    const { stringAliases, callableAliases } = collectAliases(sourceFile);
    const moduleSpecifiers: string[] = [];
    const forbiddenHelpers: string[] = [];
    const standardInstanceOf: string[] = [];
    let hasConstructorNameAccess = false;
    let hasExpandoAccess = false;
    let widgetIdsDeclarationCount = 0;
    let hasValidWidgetIdsDeclaration = false;
    let makeIdUsesWidgetIdsGet = false;
    let makeIdUsesWidgetIdsSet = false;

    function visit(node: ts.Node): void {
        if ((ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) && node.moduleSpecifier) {
            const specifier = getStaticString(node.moduleSpecifier);
            if (specifier != null) moduleSpecifiers.push(specifier);
        }
        if (ts.isImportEqualsDeclaration(node) && ts.isExternalModuleReference(node.moduleReference)) {
            const specifier = node.moduleReference.expression && getStaticString(node.moduleReference.expression);
            moduleSpecifiers.push(specifier ?? "<non-literal import-equals>");
        }
        if (ts.isCallExpression(node) && node.arguments.length > 0) {
            const isDynamicImport = node.expression.kind === ts.SyntaxKind.ImportKeyword;
            const isRequire = ts.isIdentifier(node.expression) && node.expression.text === "require";
            if (isDynamicImport || isRequire) {
                const specifier = getStaticString(node.arguments[0]);
                moduleSpecifiers.push(specifier ?? `<non-literal ${isDynamicImport ? "import" : "require"}>`);
            }
        }
        if (ts.isIdentifier(node) && ["asRecord", "getNumber", "getString"].includes(node.text)) {
            forbiddenHelpers.push(node.text);
        }
        if (
            ts.isBinaryExpression(node) &&
            node.operatorToken.kind === ts.SyntaxKind.InstanceOfKeyword &&
            ts.isIdentifier(node.right) &&
            ["Text", "Box", "Spacer", "SelectList", "SettingsList", "Input", "Markdown", "Editor", "Image", "Loader", "TruncatedText"].includes(
                node.right.text
            )
        ) {
            standardInstanceOf.push(node.right.text);
        }
        if (isConstructorNameAccess(node, stringAliases, callableAliases)) hasConstructorNameAccess = true;
        if (isExpandoAccess(node, stringAliases)) hasExpandoAccess = true;
        if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.name.text === "WidgetIds") {
            widgetIdsDeclarationCount++;
            const isConst = ts.isVariableDeclarationList(node.parent) && (node.parent.flags & ts.NodeFlags.Const) !== 0;
            if (
                isConst &&
                node.initializer &&
                ts.isNewExpression(node.initializer) &&
                isComponentStringWeakMap(node.initializer)
            ) {
                hasValidWidgetIdsDeclaration = true;
            }
        }
        if (ts.isFunctionDeclaration(node) && node.name?.text === "makeId" && node.body) {
            function visitMakeId(child: ts.Node): void {
                if (
                    ts.isCallExpression(child) &&
                    (ts.isPropertyAccessExpression(child.expression) || ts.isElementAccessExpression(child.expression)) &&
                    ts.isIdentifier(child.expression.expression) &&
                    child.expression.expression.text === "WidgetIds"
                ) {
                    const method = getAccessName(child.expression, stringAliases);
                    if (method === "get") makeIdUsesWidgetIdsGet = true;
                    if (method === "set") makeIdUsesWidgetIdsSet = true;
                }
                ts.forEachChild(child, visitMakeId);
            }
            visitMakeId(node.body);
        }
        ts.forEachChild(node, visit);
    }

    visit(sourceFile);

    expect(moduleSpecifiers.filter((specifier) => !AllowedWalkerModules.has(specifier))).toEqual([]);
    expect(hasConstructorNameAccess).toBe(false);
    expect(hasExpandoAccess).toBe(false);
    expect(forbiddenHelpers).toEqual([]);
    expect(standardInstanceOf).toEqual([]);
    expect(widgetIdsDeclarationCount).toBe(1);
    expect(hasValidWidgetIdsDeclaration).toBe(true);
    expect(makeIdUsesWidgetIdsGet).toBe(true);
    expect(makeIdUsesWidgetIdsSet).toBe(true);
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
            text: "* Working",
            paddingX: 1,
            paddingY: 0,
            label: "Working",
            frame: "*",
            cancellable: false,
            aborted: undefined,
        });
        expect(cancellableLoader.getSnapshot()).toEqual({
            text: "! Abortable",
            paddingX: 1,
            paddingY: 0,
            label: "Abortable",
            frame: "!",
            cancellable: true,
            aborted: false,
        });

        cancellableLoader.cancel();

        expect(cancellableLoader.getSnapshot().aborted).toBe(true);
        expect(abortCount).toBe(1);
    });

    it("cancels CancellableLoader idempotently", () => {
        const tui = { requestRender: () => {} } as unknown as TUI;
        const loader = new CancellableLoader(tui, (text) => text, (text) => text, "Abortable", { frames: [] });
        let abortCount = 0;
        loader.onAbort = () => {
            abortCount++;
        };

        loader.cancel();
        loader.cancel();

        expect(loader.aborted).toBe(true);
        expect(abortCount).toBe(1);
    });

    it("registers every concrete standard adapter", () => {
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

        expect(getPiGuiAdapters().map((adapter) => adapter.kind)).toEqual([
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
        expect([
            text,
            box,
            spacer,
            list,
            settings,
            input,
            markdown,
            editor,
            image,
            loader,
            cancellableLoader,
            truncated,
        ].map((component) => getPiGuiAdapter(component)?.kind)).toEqual([
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
        expect(assertAdapterEventContract(getAdapter("text"))).toEqual({ handled: false });
    });

    it("keeps adapters and their registry immutable at runtime", () => {
        const adapters = getPiGuiAdapters();
        const firstAdapter = adapters[0];

        expect(getPiGuiAdapters()).toBe(adapters);
        expect(Object.isFrozen(adapters)).toBe(true);
        expect(adapters.every(Object.isFrozen)).toBe(true);
        expect(() => (adapters as PiGuiAdapter[]).push(firstAdapter)).toThrow(TypeError);
        expect(() => {
            (firstAdapter as { kind: string }).kind = "box";
        }).toThrow(TypeError);
        expect(getPiGuiAdapters()).toBe(adapters);
        expect(firstAdapter.kind).toBe("text");
    });

    it("rejects unmarked method lookalikes", () => {
        const inputMethodLookalike = {
            getSnapshot: () => ({ value: "", cursor: 0, focused: false }),
            setValue: () => {},
            getValue: () => "",
            handleInput: () => {},
            render: () => [],
            invalidate: () => {},
        } as unknown as Component;
        const selectMethodLookalike = {
            getSnapshot: () => ({ items: [], selectedIndex: 0, maxVisible: 5, focused: false }),
            setSelectedIndex: () => true,
            getSelectedItem: () => null,
            setFilter: () => {},
            handleInput: () => {},
            render: () => [],
            invalidate: () => {},
        } as unknown as Component;
        const settingsMethodLookalike = {
            getSnapshot: () => ({ items: [], selectedIndex: 0, maxVisible: 5 }),
            setSelectedIndex: () => true,
            setItemValue: () => true,
            activateSelected: () => true,
            cancel: () => {},
            handleInput: () => {},
            render: () => [],
            invalidate: () => {},
        } as unknown as Component;
        const editorMethodLookalike = {
            getSnapshot: () => ({
                value: "",
                lines: [],
                cursorLine: 0,
                cursorCol: 0,
                focused: false,
                paddingX: 0,
            }),
            setText: () => {},
            getText: () => "",
            handleInput: () => {},
            render: () => [],
            invalidate: () => {},
        } as unknown as Component;
        const loaderMethodLookalike = {
            getSnapshot: () => ({ label: "", frame: "" }),
            stop: () => {},
            render: () => [],
            invalidate: () => {},
        } as unknown as Component;

        expect(getPiGuiAdapter(inputMethodLookalike)).toBeUndefined();
        expect(getPiGuiAdapter(selectMethodLookalike)).toBeUndefined();
        expect(getPiGuiAdapter(settingsMethodLookalike)).toBeUndefined();
        expect(getPiGuiAdapter(editorMethodLookalike)).toBeUndefined();
        expect(getPiGuiAdapter(loaderMethodLookalike)).toBeUndefined();
    });

    it("keeps adapter registration concrete and marker-based", async () => {
        const source = await readFile(new URL("./adapters.ts", import.meta.url), "utf8");
        expect(source).not.toMatch(/\bAdapterKinds\b/);
        expect(source).not.toMatch(/\bis(?:Input|SelectList|SettingsList|Editor|Loader)Like\b/);
        expect(source).not.toMatch(/\breadSnapshot\b|\bhasFunction\b/);
        expect(source).not.toContain("is not wired yet");
        expect(source).toContain("hasPiGuiComponentKind");
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
            selectionstart: 0,
            selectionend: 0,
        });
        expect(adapter.dispatch(input, {
            nodeid: "input-1",
            type: "change",
            payload: { value: "final", selectionstart: 5, selectionend: 5 },
        }, {
            snapshot: (component) => componentToWidget(component, { width: 80 }),
        })).toEqual({ handled: true });
        expect(adapter.dispatch(input, {
            nodeid: "input-1",
            type: "submit",
            payload: { value: "final", selectionstart: 5, selectionend: 5 },
        }, {
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
            visiblestart: 0,
            visibleend: 2,
            nomatch: false,
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
            },
            { enableSearch: true }
        );

        expect(adapter.matches(settings)).toBe(true);
        expect(adapter.snapshot(settings, {
            makeId: () => "settingslist-1",
            options: { width: 80 },
            snapshot: (component) => componentToWidget(component, { width: 80 }),
        })).toMatchObject({
            kind: "settingslist",
            id: "settingslist-1",
            searchenabled: true,
            selectedindex: 0,
            maxvisible: 6,
            focused: false,
            visiblestart: 0,
            visibleend: 2,
            nomatch: false,
            items: [
                { id: "mode", label: "Mode", currentvalue: "fast", description: "speed", values: ["fast", "safe"] },
                { id: "theme", label: "Theme", currentvalue: "dark", values: ["dark", "light"] },
            ],
        });
        expect(adapter.dispatch(settings, { nodeid: "settingslist-1", type: "select", payload: { index: 1 } }, {
            snapshot: (component) => componentToWidget(component, { width: 80 }),
        })).toEqual({ handled: true });
        expect(settings.getSnapshot().selectedIndex).toBe(1);
        expect(adapter.dispatch(settings, { nodeid: "settingslist-1", type: "change", payload: { filter: "theme" } }, {
            snapshot: (component) => componentToWidget(component, { width: 80 }),
        })).toEqual({ handled: true });
        expect(adapter.dispatch(settings, { nodeid: "settingslist-1", type: "submit", payload: { index: 0 } }, {
            snapshot: (component) => componentToWidget(component, { width: 80 }),
        })).toEqual({ handled: true });
        expect(adapter.dispatch(settings, { nodeid: "settingslist-1", type: "cancel" }, {
            snapshot: (component) => componentToWidget(component, { width: 80 }),
        })).toEqual({ handled: true });
        expect(changes).toEqual([["theme", "light"]]);
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
            selectionstart: 11,
            selectionend: 11,
            submitkeys: expect.any(Array),
            newlinekeys: expect.any(Array),
        });
        expect(adapter.dispatch(editor, {
            nodeid: "editor-1",
            type: "change",
            payload: { value: "final", selectionstart: 5, selectionend: 5 },
        }, {
            snapshot: (component) => componentToWidget(component, { width: 80 }),
        })).toEqual({ handled: true });
        expect(editor.getText()).toBe("final");
        expect(adapter.dispatch(editor, { nodeid: "editor-1", type: "key", payload: { data: "!" } }, {
            snapshot: (component) => componentToWidget(component, { width: 80 }),
        })).toEqual({ handled: true });
        expect(editor.getText()).toBe("final!");
        expect(adapter.dispatch(editor, {
            nodeid: "editor-1",
            type: "submit",
            payload: { value: "final!", selectionstart: 6, selectionend: 6 },
        }, {
            snapshot: (component) => componentToWidget(component, { width: 80 }),
        })).toEqual({ handled: true });
        expect(adapter.dispatch(editor, { nodeid: "editor-1", type: "cancel" }, {
            snapshot: (component) => componentToWidget(component, { width: 80 }),
        })).toEqual({ handled: false });
        expect(submissions).toEqual(["final!"]);
        expect(changes).toContain("final");
    });

    it("handles an accepted disabled Editor submit without reporting submission", () => {
        const adapter = getAdapter("editor");
        const editor = new Editor(
            { requestRender: () => {}, terminal: { rows: 24 } } as any,
            {
                borderColor: (text) => text,
                selectList: {
                    selectedPrefix: (text) => text,
                    selectedText: (text) => text,
                    description: (text) => text,
                    scrollInfo: (text) => text,
                    noMatch: (text) => text,
                },
            }
        );
        const submit = vi.fn();
        editor.onSubmit = submit;
        editor.disableSubmit = true;

        expect(adapter.dispatch(editor, {
            nodeid: "editor-disabled",
            type: "submit",
            payload: { value: "accepted", selectionstart: 2, selectionend: 6 },
        }, {
            snapshot: (component) => componentToWidget(component, { width: 80 }),
        })).toEqual({ handled: true });
        expect(editor.getSnapshot()).toMatchObject({
            value: "accepted",
            selectionStart: 2,
            selectionEnd: 6,
        });
        expect(submit).not.toHaveBeenCalled();
    });

    it("publishes disabled SettingsList search and rejects filter events through its adapter", () => {
        const adapter = getAdapter("settingslist");
        const theme: SettingsListTheme = {
            label: (text) => text,
            value: (text) => text,
            description: (text) => text,
            cursor: "> ",
            hint: (text) => text,
        };
        const settings = new SettingsList(
            [{ id: "mode", label: "Mode", currentValue: "fast", values: ["fast", "safe"] }],
            5,
            theme,
            () => {},
            () => {}
        );
        const context = {
            makeId: () => "settingslist-disabled",
            options: { width: 80 },
            snapshot: (component: Component) => componentToWidget(component, { width: 80 }),
        };
        const before = settings.getSnapshot();

        expect(adapter.snapshot(settings, context)).toMatchObject({
            kind: "settingslist",
            searchenabled: false,
            filter: undefined,
        });
        expect(adapter.dispatch(settings, {
            nodeid: "settingslist-disabled",
            type: "change",
            payload: { filter: "mode" },
        }, { snapshot: context.snapshot })).toEqual({ handled: false });
        expect(settings.getSnapshot()).toEqual(before);
    });

    it("round-trips M2.1C focus, selection, visible range, and submenu fields", () => {
        const context = {
            makeId: (_component: Component, prefix: string) => `${prefix}-1`,
            options: { width: 80 },
            snapshot: (component: Component) => componentToWidget(component, { width: 80 }),
        };
        const dispatchContext = { snapshot: context.snapshot };
        const select = new SelectList(
            [
                { value: "alpha", label: "Alpha" },
                { value: "beta", label: "Beta" },
                { value: "bravo", label: "Bravo" },
            ],
            2,
            {
                selectedPrefix: (text) => text,
                selectedText: (text) => text,
                description: (text) => text,
                scrollInfo: (text) => text,
                noMatch: (text) => text,
            }
        );
        const submenu = new SelectList(
            [{ value: "one", label: "One" }],
            1,
            {
                selectedPrefix: (text) => text,
                selectedText: (text) => text,
                description: (text) => text,
                scrollInfo: (text) => text,
                noMatch: (text) => text,
            }
        );
        const settings = new SettingsList(
            [{ id: "mode", label: "Mode", currentValue: "one", submenu: () => submenu }],
            2,
            {
                label: (text) => text,
                value: (text) => text,
                description: (text) => text,
                cursor: "> ",
                hint: (text) => text,
            },
            () => {},
            () => {},
            { enableSearch: true }
        );
        const input = new Input();
        const editor = new Editor(
            { requestRender: () => {} } as TUI,
            {
                borderColor: (text) => text,
                selectList: {
                    selectedPrefix: (text) => text,
                    selectedText: (text) => text,
                    description: (text) => text,
                    scrollInfo: (text) => text,
                    noMatch: (text) => text,
                },
            }
        );

        expect(getAdapter("selectlist").dispatch(select, {
            nodeid: "selectlist-1",
            type: "focus",
            payload: { focused: true },
        }, dispatchContext)).toEqual({ handled: true });
        expect(getAdapter("selectlist").dispatch(select, {
            nodeid: "selectlist-1",
            type: "change",
            payload: { value: "b" },
        }, dispatchContext)).toEqual({ handled: true });
        expect(getAdapter("selectlist").snapshot(select, context)).toMatchObject({
            focused: true,
            filter: "b",
            visiblestart: 0,
            visibleend: 2,
            nomatch: false,
        });

        expect(getAdapter("settingslist").dispatch(settings, {
            nodeid: "settingslist-1",
            type: "focus",
            payload: { focused: true },
        }, dispatchContext)).toEqual({ handled: true });
        expect(getAdapter("settingslist").dispatch(settings, {
            nodeid: "settingslist-1",
            type: "change",
            payload: { filter: "mode" },
        }, dispatchContext)).toEqual({ handled: true });
        expect(getAdapter("settingslist").dispatch(settings, {
            nodeid: "settingslist-1",
            type: "submit",
            payload: { index: 0 },
        }, dispatchContext)).toEqual({ handled: true });
        expect(getAdapter("settingslist").children?.(settings)).toEqual([submenu]);
        expect(getAdapter("settingslist").snapshot(settings, context)).toMatchObject({
            focused: true,
            filter: "mode",
            visiblestart: 0,
            visibleend: 1,
            nomatch: false,
            submenu: { kind: "selectlist" },
        });

        expect(getAdapter("input").dispatch(input, {
            nodeid: "input-1",
            type: "change",
            payload: { value: "a\r\nb\tc", selectionstart: 1, selectionend: 6 },
        }, dispatchContext)).toEqual({ handled: true });
        expect(getAdapter("input").dispatch(input, {
            nodeid: "input-1",
            type: "focus",
            payload: { focused: true },
        }, dispatchContext)).toEqual({ handled: true });
        expect(getAdapter("input").snapshot(input, context)).toMatchObject({
            value: "ab    c",
            focused: true,
            selectionstart: 1,
            selectionend: 7,
        });

        expect(getAdapter("editor").dispatch(editor, {
            nodeid: "editor-1",
            type: "change",
            payload: { value: "a\r\nb\tc", selectionstart: 2, selectionend: 5 },
        }, dispatchContext)).toEqual({ handled: true });
        expect(getAdapter("editor").dispatch(editor, {
            nodeid: "editor-1",
            type: "focus",
            payload: { focused: true },
        }, dispatchContext)).toEqual({ handled: true });
        expect(getAdapter("editor").snapshot(editor, context)).toMatchObject({
            value: "a\nb    c",
            focused: true,
            selectionstart: 2,
            selectionend: 7,
            submitkeys: expect.any(Array),
            newlinekeys: expect.any(Array),
        });
    });

    it("rejects invalid M2.1C semantic payloads without mutation", () => {
        const dispatchContext = { snapshot: (component: Component) => componentToWidget(component, { width: 80 }) };
        const input = new Input();
        input.applyGuiEdit("stable", 2, 4);
        const inputBefore = input.getSnapshot();
        const editor = new Editor(
            { requestRender: () => {} } as TUI,
            {
                borderColor: (text) => text,
                selectList: {
                    selectedPrefix: (text) => text,
                    selectedText: (text) => text,
                    description: (text) => text,
                    scrollInfo: (text) => text,
                    noMatch: (text) => text,
                },
            }
        );
        editor.applyGuiEdit("stable", 2, 4);
        const editorBefore = editor.getSnapshot();
        const inputSubmit = vi.fn();
        const editorSubmit = vi.fn();
        input.onSubmit = inputSubmit;
        editor.onSubmit = editorSubmit;
        const settings = new SettingsList(
            [
                { id: "first", label: "First", currentValue: "one", values: ["one", "two"] },
                { id: "second", label: "Second", currentValue: "one", values: ["one", "two"] },
            ],
            2,
            {
                label: (text) => text,
                value: (text) => text,
                description: (text) => text,
                cursor: "> ",
                hint: (text) => text,
            },
            () => {},
            () => {},
            { enableSearch: true }
        );

        for (const payload of [
            { value: "next", selectionstart: Number.NaN, selectionend: 4 },
            { value: "next", selectionstart: 1.5, selectionend: 4 },
            { value: "next", selectionstart: -1, selectionend: 4 },
            { value: "next", selectionstart: 4, selectionend: 3 },
            { value: "next", selectionstart: 0, selectionend: 5 },
            { value: 1, selectionstart: 0, selectionend: 0 },
            { value: "next", selectionstart: 0 },
        ]) {
            expect(getAdapter("input").dispatch(input, {
                nodeid: "input-1",
                type: "submit",
                payload,
            }, dispatchContext)).toEqual({ handled: false });
            expect(getAdapter("editor").dispatch(editor, {
                nodeid: "editor-1",
                type: "submit",
                payload,
            }, dispatchContext)).toEqual({ handled: false });
        }
        expect(getAdapter("input").dispatch(input, {
            nodeid: "input-1",
            type: "focus",
            payload: { focused: "yes" },
        }, dispatchContext)).toEqual({ handled: false });
        expect(getAdapter("editor").dispatch(editor, {
            nodeid: "editor-1",
            type: "focus",
            payload: {},
        }, dispatchContext)).toEqual({ handled: false });
        expect(getAdapter("settingslist").dispatch(settings, {
            nodeid: "settingslist-1",
            type: "select",
            payload: { index: 2 },
        }, dispatchContext)).toEqual({ handled: false });
        expect(getAdapter("settingslist").dispatch(settings, {
            nodeid: "settingslist-1",
            type: "submit",
            payload: { index: -1 },
        }, dispatchContext)).toEqual({ handled: false });
        expect(getAdapter("settingslist").dispatch(settings, {
            nodeid: "settingslist-1",
            type: "change",
            payload: { filter: 1 },
        }, dispatchContext)).toEqual({ handled: false });
        expect(getAdapter("settingslist").dispatch(settings, {
            nodeid: "settingslist-1",
            type: "focus",
            payload: { focused: "yes" },
        }, dispatchContext)).toEqual({ handled: false });
        expect(input.getSnapshot()).toEqual(inputBefore);
        expect(editor.getSnapshot()).toEqual(editorBefore);
        expect(settings.getSnapshot().selectedIndex).toBe(0);
        expect(inputSubmit).not.toHaveBeenCalled();
        expect(editorSubmit).not.toHaveBeenCalled();
    });

    it("keeps WidgetEvent payload unknown and rejects explicit non-plain payloads", () => {
        expectTypeOf<WidgetEvent["payload"]>().toEqualTypeOf<unknown>();
        const dispatchContext = { snapshot: (component: Component) => componentToWidget(component, { width: 80 }) };
        const invalidPayloads: unknown[] = [
            null,
            [],
            "payload",
            new Date(),
            new (class Payload {})(),
        ];

        for (const payload of invalidPayloads) {
            const select = new SelectList(
                [{ value: "one", label: "One" }],
                1,
                {
                    selectedPrefix: (text) => text,
                    selectedText: (text) => text,
                    description: (text) => text,
                    scrollInfo: (text) => text,
                    noMatch: (text) => text,
                }
            );
            const selectCancel = vi.fn();
            select.onCancel = selectCancel;
            const settingsChange = vi.fn();
            const settings = new SettingsList(
                [{ id: "mode", label: "Mode", currentValue: "one", values: ["one", "two"] }],
                1,
                {
                    label: (text) => text,
                    value: (text) => text,
                    description: (text) => text,
                    cursor: "> ",
                    hint: (text) => text,
                },
                settingsChange,
                () => {}
            );
            const input = new Input();
            const escape = vi.fn();
            input.onEscape = escape;
            const loader = new CancellableLoader(
                { requestRender: () => {} } as TUI,
                (text) => text,
                (text) => text,
                "Loading",
                { frames: ["-"] }
            );
            const abort = vi.fn();
            loader.onAbort = abort;

            expect(getAdapter("selectlist").dispatch(
                select,
                { nodeid: "selectlist-1", type: "cancel", payload },
                dispatchContext
            )).toEqual({ handled: false });
            expect(getAdapter("settingslist").dispatch(
                settings,
                { nodeid: "settingslist-1", type: "submit", payload },
                dispatchContext
            )).toEqual({ handled: false });
            expect(getAdapter("input").dispatch(
                input,
                { nodeid: "input-1", type: "cancel", payload },
                dispatchContext
            )).toEqual({ handled: false });
            expect(getAdapter("cancellableloader").dispatch(
                loader,
                { nodeid: "loader-1", type: "cancel", payload },
                dispatchContext
            )).toEqual({ handled: false });
            expect(settings.getSnapshot().items[0].currentValue).toBe("one");
            expect(selectCancel).not.toHaveBeenCalled();
            expect(settingsChange).not.toHaveBeenCalled();
            expect(escape).not.toHaveBeenCalled();
            expect(abort).not.toHaveBeenCalled();
        }
    });

    it("defaults SettingsList submit only for undefined payload and accepts a plain-object index", () => {
        const dispatchContext = { snapshot: (component: Component) => componentToWidget(component, { width: 80 }) };
        const changes: Array<[string, string]> = [];
        const settings = new SettingsList(
            [
                { id: "first", label: "First", currentValue: "one", values: ["one", "two"] },
                { id: "second", label: "Second", currentValue: "one", values: ["one", "two"] },
            ],
            2,
            {
                label: (text) => text,
                value: (text) => text,
                description: (text) => text,
                cursor: "> ",
                hint: (text) => text,
            },
            (id, value) => changes.push([id, value]),
            () => {}
        );

        expect(getAdapter("settingslist").dispatch(
            settings,
            { nodeid: "settingslist-1", type: "submit" },
            dispatchContext
        )).toEqual({ handled: true });
        expect(getAdapter("settingslist").dispatch(
            settings,
            { nodeid: "settingslist-1", type: "submit", payload: { index: 1 } },
            dispatchContext
        )).toEqual({ handled: true });
        expect(getAdapter("settingslist").dispatch(
            settings,
            { nodeid: "settingslist-1", type: "submit", payload: {} },
            dispatchContext
        )).toEqual({ handled: false });
        expect(changes).toEqual([
            ["first", "two"],
            ["second", "two"],
        ]);
    });

    it("accepts plain-object payloads across realms while rejecting foreign class instances", () => {
        const dispatchContext = { snapshot: (component: Component) => componentToWidget(component, { width: 80 }) };
        const changes: Array<[string, string]> = [];
        const settings = new SettingsList(
            [
                { id: "first", label: "First", currentValue: "one", values: ["one", "two"] },
                { id: "second", label: "Second", currentValue: "one", values: ["one", "two"] },
            ],
            2,
            {
                label: (text) => text,
                value: (text) => text,
                description: (text) => text,
                cursor: "> ",
                hint: (text) => text,
            },
            (id, value) => changes.push([id, value]),
            () => {}
        );
        const foreignPlain = runInNewContext("({ index: 1 })") as unknown;
        const foreignNullPrototype = runInNewContext(
            "Object.assign(Object.create(null), { index: 0 })"
        ) as unknown;
        const foreignClass = runInNewContext("new (class Payload { constructor() { this.index = 0; } })()") as unknown;

        expect(getAdapter("settingslist").dispatch(
            settings,
            { nodeid: "settingslist-1", type: "submit", payload: foreignPlain },
            dispatchContext
        )).toEqual({ handled: true });
        expect(getAdapter("settingslist").dispatch(
            settings,
            { nodeid: "settingslist-1", type: "submit", payload: foreignNullPrototype },
            dispatchContext
        )).toEqual({ handled: true });
        expect(getAdapter("settingslist").dispatch(
            settings,
            { nodeid: "settingslist-1", type: "submit", payload: foreignClass },
            dispatchContext
        )).toEqual({ handled: false });
        expect(changes).toEqual([
            ["second", "two"],
            ["first", "two"],
        ]);
    });

    it("keeps Editor cancel outside the standard adapter contract", () => {
        const editor = new Editor(
            { requestRender: () => {} } as TUI,
            {
                borderColor: (text) => text,
                selectList: {
                    selectedPrefix: (text) => text,
                    selectedText: (text) => text,
                    description: (text) => text,
                    scrollInfo: (text) => text,
                    noMatch: (text) => text,
                },
            }
        );

        expect(getAdapter("editor").dispatch(
            editor,
            { nodeid: "editor-1", type: "cancel" },
            { snapshot: (component) => componentToWidget(component, { width: 80 }) }
        )).toEqual({ handled: false });
    });

    it("snapshots and dispatches Loader and CancellableLoader through separate adapters", () => {
        const loaderAdapter = getAdapter("loader");
        const cancellableLoaderAdapter = getAdapter("cancellableloader");
        const tui = { requestRender: () => {} } as any;
        const loader = new Loader(tui, (text) => text, (text) => text, "Working", { frames: ["*"] });
        const cancellableLoader = new CancellableLoader(tui, (text) => text, (text) => text, "Abortable", { frames: ["!"] });
        let aborted = false;
        cancellableLoader.onAbort = () => {
            aborted = true;
        };

        expect(loaderAdapter.matches(loader)).toBe(true);
        expect(loaderAdapter.matches(cancellableLoader)).toBe(false);
        expect(cancellableLoaderAdapter.matches(loader)).toBe(false);
        expect(cancellableLoaderAdapter.matches(cancellableLoader)).toBe(true);
        expect(loaderAdapter.snapshot(loader, {
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
        expect(cancellableLoaderAdapter.snapshot(cancellableLoader, {
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
        expect(loaderAdapter.dispatch(loader, { nodeid: "loader-1", type: "cancel" }, {
            snapshot: (component) => componentToWidget(component, { width: 80 }),
        })).toEqual({ handled: false });
        expect(cancellableLoaderAdapter.dispatch(cancellableLoader, { nodeid: "loader-2", type: "cancel" }, {
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

    it("serializes marked components independently of constructor display names", () => {
        const input = new Input();
        const box = new Box();
        const inputNameDescriptor = Object.getOwnPropertyDescriptor(input.constructor, "name");
        const boxNameDescriptor = Object.getOwnPropertyDescriptor(box.constructor, "name");

        try {
            Object.defineProperty(input.constructor, "name", { configurable: true, value: "MinifiedA" });
            Object.defineProperty(box.constructor, "name", { configurable: true, value: "MinifiedB" });

            expect(componentToWidget(input, { width: 80 }).kind).toBe("input");
            expect(componentToWidget(box, { width: 80 }).kind).toBe("box");
        } finally {
            if (inputNameDescriptor) {
                Object.defineProperty(input.constructor, "name", inputNameDescriptor);
            }
            if (boxNameDescriptor) {
                Object.defineProperty(box.constructor, "name", boxNameDescriptor);
            }
        }
    });

    it.each([
        [
            "richtable",
            {
                kind: "richtable",
                columns: [{ key: "name", label: "Name" }],
                rows: [{ name: "cross-loader" }],
            },
        ],
        [
            "diffview",
            {
                kind: "diffview",
                filename: "cross-loader.ts",
                hunks: [{ header: "@@ -1 +1 @@", lines: [{ type: "add", text: "+new" }] }],
            },
        ],
        [
            "chart",
            {
                kind: "chart",
                charttype: "bar",
                series: [{ name: "coverage", points: [{ label: "GUI", value: 1 }] }],
            },
        ],
    ] as const)("serializes %s through explicit rich identity across loader realms", (kind, snapshot) => {
        const component = runInNewContext(
            `({
                [Symbol.for("crest.pi-gui.rich-component-kind")]: ${JSON.stringify(kind)},
                render: () => ["foreign fallback"],
                invalidate: () => {},
                toWidget: (id) => ({ ...snapshot, id })
            })`,
            { snapshot }
        ) as Component;

        expect(componentToWidget(component, { width: 80 })).toMatchObject(snapshot);
    });

    it("keeps stable WeakMap-owned ids without mutating components", () => {
        const frozen = Object.freeze({
            render: () => ["frozen"],
            invalidate: () => {},
        }) as Component;
        const other: Component = {
            render: () => ["other"],
            invalidate: () => {},
        };

        const first = componentToWidget(frozen, { width: 80 });
        const second = componentToWidget(frozen, { width: 40 });
        const distinct = componentToWidget(other, { width: 80 });

        expect(second.id).toBe(first.id);
        expect(distinct.id).not.toBe(first.id);
        expect(Object.prototype.hasOwnProperty.call(frozen, "__crestwidgetid")).toBe(false);
        expect(Object.prototype.hasOwnProperty.call(other, "__crestwidgetid")).toBe(false);
    });

    it("does not attempt to mutate components while assigning ids", () => {
        const mutationAttempts: Array<{ operation: string; property: PropertyKey }> = [];
        const component = new Proxy<Component>(
            {
                render: () => ["proxied"],
                invalidate: () => {},
            },
            {
                set(_target, property) {
                    mutationAttempts.push({ operation: "set", property });
                    return true;
                },
                defineProperty(_target, property) {
                    mutationAttempts.push({ operation: "defineProperty", property });
                    return true;
                },
                deleteProperty(_target, property) {
                    mutationAttempts.push({ operation: "deleteProperty", property });
                    return true;
                },
            }
        );

        const first = componentToWidget(component, { width: 80 });
        const second = componentToWidget(component, { width: 40 });

        expect(second.id).toBe(first.id);
        expect(mutationAttempts).toEqual([]);
    });

    it("keeps standard reflection and component mutation out of the walker", async () => {
        const source = await readFile(new URL("./walker.ts", import.meta.url), "utf8");
        assertWalkerSourceInvariant(source);
    });

    it.each([
        ['import { Input } from "../src";', "../src"],
        ['import { Input } from "../src/index";', "../src/index"],
        ['import { Input } from "../src/index.ts";', "../src/index.ts"],
        ['export { Input } from "../src/index.ts";', "export-from ../src/index.ts"],
        ['import { Input } from "../src/components";', "../src/components"],
        ['import { Input } from "../src/components/index.ts";', "../src/components/index.ts"],
        ['import { Input } from "../src/components/input";', "../src/components/input"],
        ['import { Input } from "../src/components/input.ts";', "../src/components/input.ts"],
        ['await import("../src/index.ts");', "dynamic import"],
        ['require("../src/components/input.ts");', "require"],
        ['import type { Component } from "../src/tui.ts";', "tui .ts"],
        ['import { getPiGuiAdapter } from "./adapters.js";', "adapters .js"],
        ['import { Chart } from "./rich";', "rich directory"],
        ['import { Chart } from "./rich/chart";', "rich class"],
        ['import { DiffView } from "./rich/diff-view";', "rich class"],
        ['import { RichTable } from "./rich/rich-table";', "rich class"],
        ['import type { WidgetNode } from "./widget-tree.js";', "widget-tree .js"],
        ['import value from "@/app/value";', "alias"],
        ['import value from "external-package";', "package"],
        ['await import("./unknown");', "dynamic unknown"],
        ['require("./unknown");', "require unknown"],
        ["await import(modulePath);", "dynamic non-literal"],
        ["require(modulePath);", "require non-literal"],
        ['import value = require("./unknown");', "import-equals require"],
    ])("rejects module source outside the walker allowlist: %s (%s)", async (statement) => {
        const source = await readFile(new URL("./walker.ts", import.meta.url), "utf8");
        expect(() => assertWalkerSourceInvariant(`${source}\n${statement}`)).toThrow();
    });

    it.each([
        ['import type { Component } from "../src/tui";', "../src/tui"],
        ['import { getPiGuiAdapter } from "./adapters";', "./adapters"],
        ['import { isCrestRichComponent } from "./rich/contract";', "./rich/contract"],
        ['import type { WidgetNode } from "./widget-tree";', "./widget-tree"],
    ])("allows current walker module source: %s (%s)", async (statement) => {
        const source = await readFile(new URL("./walker.ts", import.meta.url), "utf8");
        expect(() => assertWalkerSourceInvariant(`${source}\n${statement}`)).not.toThrow();
    });

    it.each([
        ['// import value from "external-package";', "line-comment import"],
        ['/* await import("./unknown"); */', "block-comment dynamic import"],
        ['const example = \'require("./unknown")\';', "string require"],
        ['const example = "component.constructor.name";', "string constructor name"],
        ['const example = "Reflect.get(component.constructor, \\"name\\")";', "string reflected constructor name"],
        ['const example = "__crestwidgetid";', "string expando"],
        ['// component["__crestwidgetid"] = "legacy";', "comment expando"],
    ])("ignores invariant-like text in comments and strings: %s (%s)", async (statement) => {
        const source = await readFile(new URL("./walker.ts", import.meta.url), "utf8");
        expect(() => assertWalkerSourceInvariant(`${source}\n${statement}`)).not.toThrow();
    });

    it("rejects source mutations that restore standard reflection", async () => {
        const source = await readFile(new URL("./walker.ts", import.meta.url), "utf8");
        const mutations = [
            `${source}\nconst kind = component.constructor["name"];`,
            `${source}\nconst kind = component["constructor"].name;`,
            `${source}\nconst kind = Reflect.get(component.constructor, "name");`,
            `${source}\nconst kind = Reflect.get(Reflect.get(component, "constructor"), "name");`,
            `${source}\nconst kind = Reflect["get"](component.constructor, "name");`,
            `${source}\nconst kind = Object.getOwnPropertyDescriptor(component.constructor, "name")?.value;`,
        ];

        for (const mutation of mutations) {
            expect(() => assertWalkerSourceInvariant(mutation)).toThrow();
        }
    });

    it.each([
        ["wrong generic types", (source: string) => source.replace("new WeakMap<Component, string>()", "new WeakMap<object, number>()")],
        [
            "mutable declaration",
            (source: string) =>
                source.replace("const WidgetIds = new WeakMap<Component, string>();", "let WidgetIds = new WeakMap<Component, string>();"),
        ],
        [
            "different map implementation",
            (source: string) =>
                source.replace(
                    "const WidgetIds = new WeakMap<Component, string>();",
                    "const SpareIds = new WeakMap<Component, string>();\nconst WidgetIds = new Map<Component, string>();"
                ),
        ],
        ["duplicate declaration", (source: string) => `${source}\nconst WidgetIds = new WeakMap<Component, string>();`],
        [
            "get from another map",
            (source: string) =>
                `${source.replace("WidgetIds.get(component)", "OtherIds.get(component)")}\nconst OtherIds = new WeakMap<Component, string>();`,
        ],
        [
            "set on another map",
            (source: string) =>
                `${source.replace("WidgetIds.set(component, id)", "OtherIds.set(component, id)")}\nconst OtherIds = new WeakMap<Component, string>();`,
        ],
    ])("requires WidgetIds to be the typed WeakMap used by makeId: %s", async (_label, mutate) => {
        const source = await readFile(new URL("./walker.ts", import.meta.url), "utf8");
        expect(() => assertWalkerSourceInvariant(mutate(source))).toThrow();
    });

    it.each([
        [
            'const constructorKey = "constructor"; const nameKey = "name"; const kind = component[constructorKey][nameKey];',
            "element key aliases",
        ],
        [
            'const constructorLiteral = "constructor"; const constructorKey = constructorLiteral; const nameLiteral = "name"; const nameKey = nameLiteral; const kind = component[constructorKey][nameKey];',
            "chained key aliases",
        ],
        [
            'const constructorKey = "constructor"; const nameKey = "name"; const kind = Reflect.get(Reflect.get(component, constructorKey), nameKey);',
            "Reflect.get key aliases",
        ],
        [
            'const constructorKey = "constructor"; const nameKey = "name"; const reflectGet = Reflect.get; const kind = reflectGet(reflectGet(component, constructorKey), nameKey);',
            "Reflect.get method alias",
        ],
        [
            'const constructorKey = "constructor"; const nameKey = "name"; const descriptor = Object.getOwnPropertyDescriptor; const kind = descriptor(component[constructorKey], nameKey)?.value;',
            "descriptor method alias",
        ],
    ])("rejects constructor-name reflection through aliases: %s (%s)", async (statement) => {
        const source = await readFile(new URL("./walker.ts", import.meta.url), "utf8");
        expect(() => assertWalkerSourceInvariant(`${source}\n${statement}`)).toThrow();
    });

    it.each([
        ['component.__crestwidgetid = "legacy";', "property access"],
        ['component["__crestwidgetid"] = "legacy";', "element access"],
        ['Object.defineProperty(component, "__crestwidgetid", { value: "legacy" });', "defineProperty"],
        ['Reflect.set(component, "__crestwidgetid", "legacy");', "Reflect.set"],
        ['Reflect.get(component, "__crestwidgetid");', "Reflect.get"],
        ['Reflect.deleteProperty(component, "__crestwidgetid");', "Reflect.deleteProperty"],
    ])("rejects source mutations that restore component expando ids: %s (%s)", async (statement) => {
        const source = await readFile(new URL("./walker.ts", import.meta.url), "utf8");
        expect(() => assertWalkerSourceInvariant(`${source}\n${statement}`)).toThrow();
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
