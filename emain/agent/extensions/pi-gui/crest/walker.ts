// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

import type { Component } from "../src/tui";
import { getPiGuiAdapter } from "./adapters";
import { CrestRichComponentKind, isCrestRichComponent } from "./rich/contract";
import type { WidgetNode, WidgetSerializeOptions } from "./widget-tree";

let nextWidgetId = 0;
const WidgetIds = new WeakMap<Component, string>();

function makeId(component: Component, prefix: string): string {
    const existing = WidgetIds.get(component);
    if (existing) return existing;
    nextWidgetId++;
    const id = `${prefix}-${nextWidgetId}`;
    WidgetIds.set(component, id);
    return id;
}

export function componentToWidget(component: Component, options: WidgetSerializeOptions): WidgetNode {
    const adapter = getPiGuiAdapter(component);
    if (adapter) {
        return adapter.snapshot(component, {
            makeId,
            options,
            snapshot: (child) => componentToWidget(child, options),
        });
    }

    if (isCrestRichComponent(component)) {
        return component.toWidget(makeId(component, component[CrestRichComponentKind]));
    }

    return {
        kind: "terminal",
        id: makeId(component, "terminal"),
        lines: component.render(options.width),
    };
}
