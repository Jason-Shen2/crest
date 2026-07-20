// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

import { Box } from "../src/components/box";
import { Image } from "../src/components/image";
import { Markdown } from "../src/components/markdown";
import { Spacer } from "../src/components/spacer";
import { Text } from "../src/components/text";
import { TruncatedText } from "../src/components/truncated-text";
import type { Component } from "../src/tui";
import { Chart } from "./rich/chart";
import { DiffView } from "./rich/diff-view";
import { RichTable } from "./rich/rich-table";
import { getPiGuiAdapter } from "./adapters";
import type { WidgetNode, WidgetSerializeOptions } from "./widget-tree";

let nextWidgetId = 0;

function makeId(component: Component, prefix: string): string {
    const record = component as Component & { __crestwidgetid?: string };
    if (!record.__crestwidgetid) {
        nextWidgetId++;
        record.__crestwidgetid = `${prefix}-${nextWidgetId}`;
    }
    return record.__crestwidgetid;
}

function getNumber(record: Record<string, unknown>, key: string, fallback: number): number {
    const value = record[key];
    return typeof value === "number" ? value : fallback;
}

function getString(record: Record<string, unknown>, key: string, fallback = ""): string {
    const value = record[key];
    return typeof value === "string" ? value : fallback;
}

function asRecord(component: Component): Record<string, unknown> {
    return component as unknown as Record<string, unknown>;
}

function componentName(component: Component): string {
    return typeof component.constructor?.name === "string" ? component.constructor.name : "";
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

    const name = componentName(component);

    if (component instanceof Text || name === "Text") {
        const record = asRecord(component);
        return {
            kind: "text",
            id: makeId(component, "text"),
            text: getString(record, "text"),
            paddingx: getNumber(record, "paddingX", 0),
            paddingy: getNumber(record, "paddingY", 0),
        };
    }

    if (component instanceof Box || name === "Box") {
        const record = asRecord(component);
        const children = Array.isArray(record.children) ? (record.children as Component[]) : [];
        return {
            kind: "box",
            id: makeId(component, "box"),
            paddingx: getNumber(record, "paddingX", 0),
            paddingy: getNumber(record, "paddingY", 0),
            children: children.map((child) => componentToWidget(child, options)),
        };
    }

    if (component instanceof Spacer || name === "Spacer") {
        const record = asRecord(component);
        return {
            kind: "spacer",
            id: makeId(component, "spacer"),
            lines: getNumber(record, "height", 1),
        };
    }

    if (component instanceof Markdown || name === "Markdown") {
        const record = asRecord(component);
        return {
            kind: "markdown",
            id: makeId(component, "markdown"),
            source: getString(record, "text"),
            paddingx: getNumber(record, "paddingX", 0),
            paddingy: getNumber(record, "paddingY", 0),
        };
    }

    if (component instanceof Image || name === "Image") {
        const record = asRecord(component);
        const base64Data = getString(record, "base64Data");
        const mimeType = getString(record, "mimeType", "application/octet-stream");
        const dimensions = record.dimensions as { widthPx?: unknown; heightPx?: unknown } | undefined;
        const imageOptions = record.options as { filename?: unknown } | undefined;
        return {
            kind: "image",
            id: makeId(component, "image"),
            src: `data:${mimeType};base64,${base64Data}`,
            mimetype: mimeType,
            filename: typeof imageOptions?.filename === "string" ? imageOptions.filename : undefined,
            widthpx: typeof dimensions?.widthPx === "number" ? dimensions.widthPx : undefined,
            heightpx: typeof dimensions?.heightPx === "number" ? dimensions.heightPx : undefined,
        };
    }

    if (component instanceof TruncatedText || name === "TruncatedText") {
        const record = asRecord(component);
        return {
            kind: "truncatedtext",
            id: makeId(component, "truncatedtext"),
            text: getString(record, "text"),
            paddingx: getNumber(record, "paddingX", 0),
            paddingy: getNumber(record, "paddingY", 0),
        };
    }

    if (
        component instanceof RichTable ||
        name === "RichTable" ||
        component instanceof DiffView ||
        name === "DiffView" ||
        component instanceof Chart ||
        name === "Chart"
    ) {
        const richComponent = component as RichTable | DiffView | Chart;
        return richComponent.toWidget(makeId(component, richComponent.widgetKind));
    }

    return {
        kind: "terminal",
        id: makeId(component, "terminal"),
        lines: component.render(options.width),
    };
}
