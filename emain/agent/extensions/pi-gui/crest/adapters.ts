// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

import type { Component } from "../src/tui";
import { CancellableLoader } from "../src/components/cancellable-loader";
import { Editor } from "../src/components/editor";
import { Input } from "../src/components/input";
import { Loader } from "../src/components/loader";
import { isValidSelectIndex, SelectList } from "../src/components/select-list";
import { isValidSettingsIndex, SettingsList } from "../src/components/settings-list";
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
    type: "select" | "change" | "submit" | "cancel" | "key";
    payload?: Record<string, unknown>;
}

export interface DispatchContext {
    snapshot(component: Component): WidgetNode;
}

export interface DispatchResult {
    handled: boolean;
}

export interface PiGuiAdapter<TComponent extends Component = Component> {
    kind: string;
    matches(component: Component): component is TComponent;
    snapshot(component: TComponent, context: SnapshotContext): WidgetNode;
    dispatch(component: TComponent, event: WidgetEvent, context: DispatchContext): DispatchResult;
    dispose?(component: TComponent): void;
}

const AdapterKinds = ["text", "box", "spacer", "selectlist", "settingslist", "input", "markdown", "editor", "image", "loader", "truncatedtext"];

function placeholderMatches(_component: Component): _component is Component {
    return false;
}

function payloadRecord(event: WidgetEvent): Record<string, unknown> {
    return event.payload ?? {};
}

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === "object" && value != null;
}

function hasFunction(record: Record<string, unknown>, key: string): boolean {
    return typeof record[key] === "function";
}

function readSnapshot(record: Record<string, unknown>): unknown {
    try {
        return (record.getSnapshot as () => unknown)();
    } catch {
        return undefined;
    }
}

function isInputLike(component: Component): component is Input {
    if (component instanceof Input) return true;
    const record = component as unknown as Record<string, unknown>;
    if (
        !hasFunction(record, "getSnapshot") ||
        !hasFunction(record, "setValue") ||
        !hasFunction(record, "getValue") ||
        !hasFunction(record, "handleInput")
    ) {
        return false;
    }
    const snapshot = readSnapshot(record);
    return (
        isRecord(snapshot) &&
        typeof snapshot.value === "string" &&
        typeof snapshot.cursor === "number" &&
        typeof snapshot.focused === "boolean"
    );
}

function isSelectListLike(component: Component): component is SelectList {
    if (component instanceof SelectList) return true;
    const record = component as unknown as Record<string, unknown>;
    if (
        !hasFunction(record, "getSnapshot") ||
        !hasFunction(record, "setSelectedIndex") ||
        !hasFunction(record, "getSelectedItem") ||
        !hasFunction(record, "setFilter") ||
        !hasFunction(record, "handleInput")
    ) {
        return false;
    }
    const snapshot = readSnapshot(record);
    return (
        isRecord(snapshot) &&
        Array.isArray(snapshot.items) &&
        typeof snapshot.selectedIndex === "number" &&
        typeof snapshot.maxVisible === "number" &&
        typeof snapshot.focused === "boolean"
    );
}

function isSettingsListLike(component: Component): component is SettingsList {
    if (component instanceof SettingsList) return true;
    const record = component as unknown as Record<string, unknown>;
    if (
        !hasFunction(record, "getSnapshot") ||
        !hasFunction(record, "setSelectedIndex") ||
        !hasFunction(record, "setItemValue") ||
        !hasFunction(record, "activateSelected") ||
        !hasFunction(record, "cancel") ||
        !hasFunction(record, "handleInput")
    ) {
        return false;
    }
    const snapshot = readSnapshot(record);
    return (
        isRecord(snapshot) &&
        Array.isArray(snapshot.items) &&
        typeof snapshot.selectedIndex === "number" &&
        typeof snapshot.maxVisible === "number"
    );
}

function isEditorLike(component: Component): component is Editor {
    if (component instanceof Editor) return true;
    const record = component as unknown as Record<string, unknown>;
    if (
        !hasFunction(record, "getSnapshot") ||
        !hasFunction(record, "setText") ||
        !hasFunction(record, "getText") ||
        !hasFunction(record, "handleInput")
    ) {
        return false;
    }
    const snapshot = readSnapshot(record);
    return (
        isRecord(snapshot) &&
        typeof snapshot.value === "string" &&
        Array.isArray(snapshot.lines) &&
        typeof snapshot.cursorLine === "number" &&
        typeof snapshot.cursorCol === "number" &&
        typeof snapshot.focused === "boolean" &&
        typeof snapshot.paddingX === "number"
    );
}

function isLoaderLike(component: Component): component is Loader {
    if (component instanceof Loader) return true;
    const record = component as unknown as Record<string, unknown>;
    if (!hasFunction(record, "getSnapshot") || !hasFunction(record, "stop")) {
        return false;
    }
    const snapshot = readSnapshot(record);
    return isRecord(snapshot) && typeof snapshot.label === "string" && typeof snapshot.frame === "string";
}

function isCancellableLoaderLike(component: Component): boolean {
    if (component instanceof CancellableLoader) return true;
    const record = component as unknown as Record<string, unknown>;
    return typeof record.aborted === "boolean" && hasFunction(record, "handleInput");
}

const SelectListAdapter: PiGuiAdapter<SelectList> = {
    kind: "selectlist",
    matches(component): component is SelectList {
        return isSelectListLike(component);
    },
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
        };
    },
    dispatch(component, event): DispatchResult {
        if (event.type === "select") {
            const payload = payloadRecord(event);
            if (typeof payload.index === "number") {
                if (!isValidSelectIndex(payload.index)) return { handled: false };
                component.setSelectedIndex(payload.index);
            }
            const item = component.getSelectedItem();
            if (!item || !component.onSelect) return { handled: false };
            component.onSelect(item);
            return { handled: true };
        }
        if (event.type === "cancel") {
            if (!component.onCancel) return { handled: false };
            component.onCancel();
            return { handled: true };
        }
        if (event.type === "change") {
            const payload = payloadRecord(event);
            if (typeof payload.value !== "string") return { handled: false };
            component.setFilter(payload.value);
            return { handled: true };
        }
        if (event.type === "key") {
            const payload = payloadRecord(event);
            if (typeof payload.data !== "string") return { handled: false };
            component.handleInput(payload.data);
            return { handled: true };
        }
        return { handled: false };
    },
};

const SettingsListAdapter: PiGuiAdapter<SettingsList> = {
    kind: "settingslist",
    matches(component): component is SettingsList {
        return isSettingsListLike(component);
    },
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
        };
    },
    dispatch(component, event): DispatchResult {
        if (event.type === "select") {
            const payload = payloadRecord(event);
            if (typeof payload.index !== "number" || !isValidSettingsIndex(payload.index)) return { handled: false };
            return { handled: component.setSelectedIndex(payload.index) };
        }
        if (event.type === "change") {
            const payload = payloadRecord(event);
            if (typeof payload.value !== "string") return { handled: false };
            if (typeof payload.id === "string") {
                return { handled: component.setItemValue(payload.id, payload.value) };
            }
            const item = component.getSelectedItem();
            if (!item) return { handled: false };
            return { handled: component.setItemValue(item.id, payload.value) };
        }
        if (event.type === "submit") {
            return { handled: component.activateSelected() };
        }
        if (event.type === "cancel") {
            component.cancel();
            return { handled: true };
        }
        if (event.type === "key") {
            const payload = payloadRecord(event);
            if (typeof payload.data !== "string") return { handled: false };
            component.handleInput(payload.data);
            return { handled: true };
        }
        return { handled: false };
    },
};

const InputAdapter: PiGuiAdapter<Input> = {
    kind: "input",
    matches(component): component is Input {
        return isInputLike(component);
    },
    snapshot(component, context): WidgetInputNode {
        const snapshot = component.getSnapshot();
        return {
            kind: "input",
            id: context.makeId(component, "input"),
            value: snapshot.value,
            cursor: snapshot.cursor,
            focused: snapshot.focused,
        };
    },
    dispatch(component, event): DispatchResult {
        if (event.type === "change") {
            const payload = payloadRecord(event);
            if (typeof payload.value !== "string") return { handled: false };
            component.setValue(payload.value);
            return { handled: true };
        }
        if (event.type === "submit") {
            if (!component.onSubmit) return { handled: false };
            component.onSubmit(component.getValue());
            return { handled: true };
        }
        if (event.type === "cancel") {
            if (!component.onEscape) return { handled: false };
            component.onEscape();
            return { handled: true };
        }
        if (event.type === "key") {
            const payload = payloadRecord(event);
            if (typeof payload.data !== "string") return { handled: false };
            component.handleInput(payload.data);
            return { handled: true };
        }
        return { handled: false };
    },
};

const EditorAdapter: PiGuiAdapter<Editor> = {
    kind: "editor",
    matches(component): component is Editor {
        return isEditorLike(component);
    },
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
        };
    },
    dispatch(component, event): DispatchResult {
        if (event.type === "change") {
            const payload = payloadRecord(event);
            if (typeof payload.value !== "string") return { handled: false };
            component.setText(payload.value);
            return { handled: true };
        }
        if (event.type === "submit") {
            if (!component.onSubmit) return { handled: false };
            component.onSubmit(component.getText());
            return { handled: true };
        }
        if (event.type === "key") {
            const payload = payloadRecord(event);
            if (typeof payload.data !== "string") return { handled: false };
            component.handleInput(payload.data);
            return { handled: true };
        }
        return { handled: false };
    },
};

const LoaderAdapter: PiGuiAdapter<Loader> = {
    kind: "loader",
    matches(component): component is Loader {
        return isLoaderLike(component);
    },
    snapshot(component, context): WidgetLoaderNode {
        const snapshot = component.getSnapshot();
        const cancellable = isCancellableLoaderLike(component);
        return {
            kind: "loader",
            id: context.makeId(component, "loader"),
            label: snapshot.label,
            frame: snapshot.frame,
            cancellable,
            aborted: cancellable ? Boolean((component as unknown as { aborted?: unknown }).aborted) : undefined,
        };
    },
    dispatch(component, event): DispatchResult {
        if (event.type !== "cancel" || !isCancellableLoaderLike(component)) return { handled: false };
        (component as unknown as { handleInput(data: string): void }).handleInput("\x1b");
        return { handled: true };
    },
    dispose(component): void {
        component.stop();
    },
};

const AdapterByKind: Record<string, PiGuiAdapter> = {
    selectlist: SelectListAdapter,
    settingslist: SettingsListAdapter,
    input: InputAdapter,
    editor: EditorAdapter,
    loader: LoaderAdapter,
};

export function getPiGuiAdapter(component: Component): PiGuiAdapter | undefined {
    return getPiGuiAdapters().find((adapter) => adapter.matches(component));
}

export function getPiGuiAdapters(): PiGuiAdapter[] {
    return AdapterKinds.map((kind) => ({
        ...AdapterByKind[kind],
        kind,
        matches: AdapterByKind[kind]?.matches ?? placeholderMatches,
        snapshot: AdapterByKind[kind]?.snapshot ?? (() => {
            throw new Error(`adapter ${kind} is not wired yet`);
        }),
        dispatch: AdapterByKind[kind]?.dispatch ?? (() => ({ handled: false })),
    }));
}
