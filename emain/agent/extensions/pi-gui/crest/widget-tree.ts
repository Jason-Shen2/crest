// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

export interface WidgetBase {
    kind: string;
    id: string;
}

export interface SelectItemNode {
    value: string;
    label: string;
    description?: string;
}

export interface WidgetTextNode extends WidgetBase {
    kind: "text";
    text: string;
    paddingx: number;
    paddingy: number;
}

export interface WidgetBoxNode extends WidgetBase {
    kind: "box" | "container";
    paddingx: number;
    paddingy: number;
    children: WidgetNode[];
}

export interface WidgetSpacerNode extends WidgetBase {
    kind: "spacer";
    lines: number;
}

export interface WidgetSelectListNode extends WidgetBase {
    kind: "selectlist";
    items: SelectItemNode[];
    selectedindex: number;
    maxvisible: number;
    focused: boolean;
    filter?: string;
}

export interface WidgetSettingsListNode extends WidgetBase {
    kind: "settingslist";
    items: Array<{ id: string; label: string; description?: string; currentvalue: string; values?: string[] }>;
    selectedindex: number;
    maxvisible: number;
}

export interface WidgetInputNode extends WidgetBase {
    kind: "input";
    value: string;
    cursor: number;
    focused: boolean;
}

export interface WidgetMarkdownNode extends WidgetBase {
    kind: "markdown";
    source: string;
    paddingx: number;
    paddingy: number;
}

export interface WidgetEditorNode extends WidgetBase {
    kind: "editor";
    value: string;
    lines: string[];
    cursorline: number;
    cursorcol: number;
    focused: boolean;
    paddingx: number;
}

export interface WidgetImageNode extends WidgetBase {
    kind: "image";
    src: string;
    mimetype: string;
    filename?: string;
    widthpx?: number;
    heightpx?: number;
}

export interface WidgetLoaderNode extends WidgetBase {
    kind: "loader";
    label: string;
    frame: string;
    cancellable: boolean;
    aborted?: boolean;
}

export interface WidgetTruncatedTextNode extends WidgetBase {
    kind: "truncatedtext";
    text: string;
    paddingx: number;
    paddingy: number;
}

export interface WidgetTerminalNode extends WidgetBase {
    kind: "terminal";
    lines: string[];
}

export interface RichTableColumn {
    key: string;
    label: string;
}

export type RichTableRow = Record<string, string | number | boolean | null | undefined>;

export interface WidgetRichTableNode extends WidgetBase {
    kind: "richtable";
    columns: RichTableColumn[];
    rows: RichTableRow[];
    selectedrow?: number;
}

export type DiffLineType = "context" | "add" | "remove";

export interface DiffLine {
    type: DiffLineType;
    text: string;
}

export interface DiffHunk {
    header: string;
    lines: DiffLine[];
}

export interface WidgetDiffViewNode extends WidgetBase {
    kind: "diffview";
    filename?: string;
    hunks: DiffHunk[];
}

export type ChartType = "bar" | "line" | "sparkline";

export interface ChartPoint {
    label: string;
    value: number;
}

export interface ChartSeries {
    name: string;
    points: ChartPoint[];
}

export interface WidgetChartNode extends WidgetBase {
    kind: "chart";
    charttype: ChartType;
    series: ChartSeries[];
}

export interface RenderedExtensionEntryNode {
    id: string;
    customtype: string;
    source: "entry" | "message";
    widget: WidgetNode;
}

export type WidgetNode =
    | WidgetTextNode
    | WidgetBoxNode
    | WidgetSpacerNode
    | WidgetSelectListNode
    | WidgetSettingsListNode
    | WidgetInputNode
    | WidgetMarkdownNode
    | WidgetEditorNode
    | WidgetImageNode
    | WidgetLoaderNode
    | WidgetTruncatedTextNode
    | WidgetTerminalNode
    | WidgetRichTableNode
    | WidgetDiffViewNode
    | WidgetChartNode;

export interface WidgetSerializeOptions {
    width: number;
}
