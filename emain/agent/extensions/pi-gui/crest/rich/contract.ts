// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

import type { Component } from "../../src/tui";
import type { WidgetChartNode, WidgetDiffViewNode, WidgetRichTableNode } from "../widget-tree";

export const CrestRichComponentKind = Symbol.for("crest.pi-gui.rich-component-kind");

export type CrestRichComponentKind = "richtable" | "diffview" | "chart";
export type CrestRichWidgetNode = WidgetRichTableNode | WidgetDiffViewNode | WidgetChartNode;

export interface CrestRichComponent<K extends CrestRichComponentKind = CrestRichComponentKind> extends Component {
    readonly [CrestRichComponentKind]: K;
    toWidget(id: string): CrestRichWidgetNode;
}

export function isCrestRichComponent(component: Component): component is CrestRichComponent {
    const candidate = component as Partial<CrestRichComponent>;
    const kind = candidate[CrestRichComponentKind];
    return (kind === "richtable" || kind === "diffview" || kind === "chart") && typeof candidate.toWidget === "function";
}
