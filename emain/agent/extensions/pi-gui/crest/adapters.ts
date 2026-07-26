// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

import { hasPiGuiComponentKind, type Component, type PiGuiComponentKind } from "../src/tui";
import { Box } from "../src/components/box";
import { CancellableLoader } from "../src/components/cancellable-loader";
import { Editor } from "../src/components/editor";
import { Image } from "../src/components/image";
import { Input } from "../src/components/input";
import { Loader } from "../src/components/loader";
import { Markdown } from "../src/components/markdown";
import { isValidSelectIndex, SelectList } from "../src/components/select-list";
import { isValidSettingsIndex, SettingsList } from "../src/components/settings-list";
import { Spacer } from "../src/components/spacer";
import { Text } from "../src/components/text";
import { TruncatedText } from "../src/components/truncated-text";
import type {
    WidgetEditorNode,
    WidgetInputNode,
    WidgetLoaderNode,
    WidgetNode,
    WidgetSelectListNode,
    WidgetSerializeOptions,
    WidgetSettingsListNode,
} from "./widget-tree";

export interface SnapshotContext {
    makeId(component: Component, prefix: string): string;
    options: WidgetSerializeOptions;
    snapshot(component: Component): WidgetNode;
}

export interface WidgetEvent {
    nodeid: string;
    type: "select" | "change" | "submit" | "cancel" | "key" | "focus" | "cycle";
    eventid?: string;
    payload?: unknown;
}

export interface DispatchContext {
    snapshot(component: Component): WidgetNode;
}

export interface DispatchResult {
    handled: boolean;
}

export interface PiGuiAdapter<TComponent extends Component = Component> {
    readonly kind: PiGuiComponentKind;
    readonly matches: (component: Component) => component is TComponent;
    readonly snapshot: (component: TComponent, context: SnapshotContext) => WidgetNode;
    readonly dispatch: (component: TComponent, event: WidgetEvent, context: DispatchContext) => DispatchResult;
    readonly children?: (component: TComponent) => readonly Component[];
    readonly dispose?: (component: TComponent) => void;
}

function payloadRecord(event: WidgetEvent): Record<string, unknown> | undefined {
    if (event.payload === undefined) return {};
    if (event.payload === null || typeof event.payload !== "object" || Array.isArray(event.payload)) return undefined;
    const prototype = Object.getPrototypeOf(event.payload);
    if (prototype !== null && Object.getPrototypeOf(prototype) !== null) return undefined;
    return event.payload as Record<string, unknown>;
}

function completeEditPayload(event: WidgetEvent): {
    value: string;
    selectionstart: number;
    selectionend: number;
} | undefined {
    const payload = payloadRecord(event);
    if (typeof payload.value !== "string") return undefined;
    if (!Number.isInteger(payload.selectionstart) || !Number.isInteger(payload.selectionend)) return undefined;
    const selectionstart = payload.selectionstart as number;
    const selectionend = payload.selectionend as number;
    if (selectionstart < 0 || selectionstart > selectionend || selectionend > payload.value.length) return undefined;
    return { value: payload.value, selectionstart, selectionend };
}

const TextAdapter: PiGuiAdapter<Text> = {
    kind: "text",
    matches: (component): component is Text => hasPiGuiComponentKind(component, "text"),
    snapshot(component, context) {
        const value = component.getSnapshot();
        return { kind: "text", id: context.makeId(component, "text"), text: value.text, paddingx: value.paddingX, paddingy: value.paddingY };
    },
    dispatch: () => ({ handled: false }),
};

const BoxAdapter: PiGuiAdapter<Box> = {
    kind: "box",
    matches: (component): component is Box => hasPiGuiComponentKind(component, "box"),
    snapshot(component, context) {
        const value = component.getSnapshot();
        return {
            kind: "box",
            id: context.makeId(component, "box"),
            paddingx: value.paddingX,
            paddingy: value.paddingY,
            children: value.children.map(context.snapshot),
        };
    },
    children: (component) => component.getChildren(),
    dispatch: () => ({ handled: false }),
};

const SpacerAdapter: PiGuiAdapter<Spacer> = {
    kind: "spacer",
    matches: (component): component is Spacer => hasPiGuiComponentKind(component, "spacer"),
    snapshot(component, context) {
        return { kind: "spacer", id: context.makeId(component, "spacer"), lines: component.getSnapshot().lines };
    },
    dispatch: () => ({ handled: false }),
};

const MarkdownAdapter: PiGuiAdapter<Markdown> = {
    kind: "markdown",
    matches: (component): component is Markdown => hasPiGuiComponentKind(component, "markdown"),
    snapshot(component, context) {
        const value = component.getSnapshot();
        return {
            kind: "markdown",
            id: context.makeId(component, "markdown"),
            source: value.source,
            paddingx: value.paddingX,
            paddingy: value.paddingY,
        };
    },
    dispatch: () => ({ handled: false }),
};

const ImageAdapter: PiGuiAdapter<Image> = {
    kind: "image",
    matches: (component): component is Image => hasPiGuiComponentKind(component, "image"),
    snapshot(component, context) {
        const value = component.getSnapshot();
        return {
            kind: "image",
            id: context.makeId(component, "image"),
            src: `data:${value.mimeType};base64,${value.base64Data}`,
            mimetype: value.mimeType,
            filename: value.filename,
            widthpx: value.widthPx,
            heightpx: value.heightPx,
        };
    },
    dispatch: () => ({ handled: false }),
};

const TruncatedTextAdapter: PiGuiAdapter<TruncatedText> = {
    kind: "truncatedtext",
    matches: (component): component is TruncatedText => hasPiGuiComponentKind(component, "truncatedtext"),
    snapshot(component, context) {
        const value = component.getSnapshot();
        return {
            kind: "truncatedtext",
            id: context.makeId(component, "truncatedtext"),
            text: value.text,
            paddingx: value.paddingX,
            paddingy: value.paddingY,
        };
    },
    dispatch: () => ({ handled: false }),
};

const SelectListAdapter: PiGuiAdapter<SelectList> = {
    kind: "selectlist",
    matches: (component): component is SelectList => hasPiGuiComponentKind(component, "selectlist"),
    snapshot(component, context): WidgetSelectListNode {
        const snapshot = component.getSnapshot();
        return {
            kind: "selectlist",
            id: context.makeId(component, "selectlist"),
            items: snapshot.items.map((item) => ({ ...item })),
            selectedindex: snapshot.selectedIndex,
            maxvisible: snapshot.maxVisible,
            focused: snapshot.focused,
            filter: snapshot.filter,
            visiblestart: snapshot.visibleStart,
            visibleend: snapshot.visibleEnd,
            nomatch: snapshot.noMatch,
        };
    },
    dispatch(component, event): DispatchResult {
        const payload = payloadRecord(event);
        if (!payload) return { handled: false };
        if (event.type === "select") {
            if (typeof payload.index !== "number" || !isValidSelectIndex(payload.index)) return { handled: false };
            return { handled: component.selectAndActivate(payload.index) };
        }
        if (event.type === "cancel") {
            if (!component.onCancel) return { handled: false };
            component.onCancel();
            return { handled: true };
        }
        if (event.type === "change") {
            if (typeof payload.value !== "string") return { handled: false };
            component.setFilter(payload.value);
            return { handled: true };
        }
        if (event.type === "focus") {
            if (typeof payload.focused !== "boolean") return { handled: false };
            return { handled: component.setFocused(payload.focused) };
        }
        if (event.type === "key") {
            if (typeof payload.data !== "string") return { handled: false };
            component.handleInput(payload.data);
            return { handled: true };
        }
        return { handled: false };
    },
};

const SettingsListAdapter: PiGuiAdapter<SettingsList> = {
    kind: "settingslist",
    matches: (component): component is SettingsList => hasPiGuiComponentKind(component, "settingslist"),
    snapshot(component, context): WidgetSettingsListNode {
        const snapshot = component.getSnapshot();
        return {
            kind: "settingslist",
            id: context.makeId(component, "settingslist"),
            items: snapshot.items.map((item) => ({
                id: item.id,
                label: item.label,
                description: item.description,
                currentvalue: item.currentValue,
                values: item.values ? [...item.values] : undefined,
            })),
            selectedindex: snapshot.selectedIndex,
            maxvisible: snapshot.maxVisible,
            searchenabled: snapshot.searchEnabled,
            focused: snapshot.focused,
            filter: snapshot.filter,
            visiblestart: snapshot.visibleStart,
            visibleend: snapshot.visibleEnd,
            nomatch: snapshot.noMatch,
            submenu: snapshot.submenu ? context.snapshot(snapshot.submenu) : undefined,
        };
    },
    children: (component) => component.getChildren(),
    dispatch(component, event): DispatchResult {
        const payload = payloadRecord(event);
        if (!payload) return { handled: false };
        if (event.type === "select") {
            if (typeof payload.index !== "number" || !isValidSettingsIndex(payload.index)) return { handled: false };
            if (payload.index < 0 || payload.index >= component.getSnapshot().items.length) return { handled: false };
            return { handled: component.setSelectedIndex(payload.index) };
        }
        if (event.type === "change") {
            if (typeof payload.filter !== "string") return { handled: false };
            return { handled: component.setFilter(payload.filter) };
        }
        if (event.type === "cycle") {
            if (payload.direction !== 1 && payload.direction !== -1) return { handled: false };
            return { handled: component.cycleSelected(payload.direction) };
        }
        if (event.type === "submit") {
            if (event.payload === undefined) return { handled: component.activateSelected() };
            if (typeof payload.index !== "number" || !isValidSettingsIndex(payload.index)) return { handled: false };
            return { handled: component.activateIndex(payload.index) };
        }
        if (event.type === "cancel") {
            if (component.getChildren().length > 0) return { handled: false };
            component.cancel();
            return { handled: true };
        }
        if (event.type === "focus") {
            if (typeof payload.focused !== "boolean") return { handled: false };
            return { handled: component.setFocused(payload.focused) };
        }
        if (event.type === "key") {
            if (typeof payload.data !== "string") return { handled: false };
            component.handleInput(payload.data);
            return { handled: true };
        }
        return { handled: false };
    },
};

const InputAdapter: PiGuiAdapter<Input> = {
    kind: "input",
    matches: (component): component is Input => hasPiGuiComponentKind(component, "input"),
    snapshot(component, context): WidgetInputNode {
        const snapshot = component.getSnapshot();
        return {
            kind: "input",
            id: context.makeId(component, "input"),
            value: snapshot.value,
            cursor: snapshot.cursor,
            focused: snapshot.focused,
            selectionstart: snapshot.selectionStart,
            selectionend: snapshot.selectionEnd,
        };
    },
    dispatch(component, event): DispatchResult {
        const payload = payloadRecord(event);
        if (!payload) return { handled: false };
        if (event.type === "change") {
            const edit = completeEditPayload(event);
            if (!edit) return { handled: false };
            return { handled: component.applyGuiEdit(edit.value, edit.selectionstart, edit.selectionend) };
        }
        if (event.type === "submit") {
            const edit = completeEditPayload(event);
            if (!edit) return { handled: false };
            return { handled: component.submitGuiValue(edit.value, edit.selectionstart, edit.selectionend) };
        }
        if (event.type === "cancel") {
            return { handled: component.escape() };
        }
        if (event.type === "focus") {
            if (typeof payload.focused !== "boolean") return { handled: false };
            return { handled: component.setFocused(payload.focused) };
        }
        if (event.type === "key") {
            if (typeof payload.data !== "string") return { handled: false };
            component.handleInput(payload.data);
            return { handled: true };
        }
        return { handled: false };
    },
};

const EditorAdapter: PiGuiAdapter<Editor> = {
    kind: "editor",
    matches: (component): component is Editor => hasPiGuiComponentKind(component, "editor"),
    snapshot(component, context): WidgetEditorNode {
        const snapshot = component.getSnapshot();
        return {
            kind: "editor",
            id: context.makeId(component, "editor"),
            value: snapshot.value,
            lines: [...snapshot.lines],
            cursorline: snapshot.cursorLine,
            cursorcol: snapshot.cursorCol,
            focused: snapshot.focused,
            paddingx: snapshot.paddingX,
            selectionstart: snapshot.selectionStart,
            selectionend: snapshot.selectionEnd,
            submitkeys: [...snapshot.submitKeys],
            newlinekeys: [...snapshot.newLineKeys],
        };
    },
    dispatch(component, event): DispatchResult {
        const payload = payloadRecord(event);
        if (!payload) return { handled: false };
        if (event.type === "change") {
            const edit = completeEditPayload(event);
            if (!edit) return { handled: false };
            return { handled: component.applyGuiEdit(edit.value, edit.selectionstart, edit.selectionend) };
        }
        if (event.type === "submit") {
            const edit = completeEditPayload(event);
            if (!edit) return { handled: false };
            const outcome = component.submitGuiValue(edit.value, edit.selectionstart, edit.selectionend);
            return { handled: outcome.accepted };
        }
        if (event.type === "focus") {
            if (typeof payload.focused !== "boolean") return { handled: false };
            return { handled: component.setFocused(payload.focused) };
        }
        if (event.type === "key") {
            if (typeof payload.data !== "string") return { handled: false };
            component.handleInput(payload.data);
            return { handled: true };
        }
        return { handled: false };
    },
};

function loaderNode(component: Loader, context: SnapshotContext): WidgetLoaderNode {
    const value = component.getSnapshot();
    return {
        kind: "loader",
        id: context.makeId(component, "loader"),
        label: value.label,
        frame: value.frame,
        cancellable: value.cancellable,
        aborted: value.aborted,
    };
}

const LoaderAdapter: PiGuiAdapter<Loader> = {
    kind: "loader",
    matches: (component): component is Loader => hasPiGuiComponentKind(component, "loader"),
    snapshot: loaderNode,
    dispatch: () => ({ handled: false }),
    dispose: (component) => component.dispose(),
};

const CancellableLoaderAdapter: PiGuiAdapter<CancellableLoader> = {
    kind: "cancellableloader",
    matches: (component): component is CancellableLoader => hasPiGuiComponentKind(component, "cancellableloader"),
    snapshot: loaderNode,
    dispatch(component, event) {
        if (!payloadRecord(event)) return { handled: false };
        if (event.type !== "cancel") return { handled: false };
        component.cancel();
        return { handled: true };
    },
    dispose: (component) => component.dispose(),
};

const PiGuiAdapters: readonly PiGuiAdapter[] = Object.freeze(
    [
        TextAdapter,
        BoxAdapter,
        SpacerAdapter,
        SelectListAdapter,
        SettingsListAdapter,
        InputAdapter,
        MarkdownAdapter,
        EditorAdapter,
        ImageAdapter,
        LoaderAdapter,
        CancellableLoaderAdapter,
        TruncatedTextAdapter,
    ].map((adapter) => Object.freeze(adapter))
);

export function getPiGuiAdapter(component: Component): PiGuiAdapter | undefined {
    return PiGuiAdapters.find((adapter) => adapter.matches(component));
}

export function getPiGuiAdapters(): readonly PiGuiAdapter[] {
    return PiGuiAdapters;
}
