// Copyright (c) 2023-2026 Langfuse GmbH
// SPDX-License-Identifier: MIT

export interface DetailPreview {
    text: string;
    truncated: boolean;
}

export interface DetailPreviewOptions {
    maxCharacters: number;
    maxTraversalNodes?: number;
}

const DefaultPreviewTraversalNodes = 1_000;

function unicodeSafePrefix(value: string, maxCodeUnits: number): string {
    if (value.length <= maxCodeUnits) {
        return value;
    }
    let end = Math.max(0, maxCodeUnits);
    const lastCode = value.charCodeAt(end - 1);
    if (lastCode >= 0xd800 && lastCode <= 0xdbff) {
        end -= 1;
    }
    return value.slice(0, end);
}

class PreviewWriter {
    text = "";
    truncated = false;
    traversalNodes = 0;

    constructor(
        readonly maxCharacters: number,
        readonly maxTraversalNodes: number
    ) {}

    get exhausted(): boolean {
        return this.truncated || this.text.length >= this.maxCharacters;
    }

    get hasTraversalBudget(): boolean {
        return this.traversalNodes < this.maxTraversalNodes;
    }

    enterNode(): boolean {
        if (this.traversalNodes >= this.maxTraversalNodes) {
            this.truncate();
            return false;
        }
        this.traversalNodes += 1;
        return true;
    }

    write(value: string): boolean {
        if (this.truncated) {
            return false;
        }
        const remaining = this.maxCharacters - this.text.length;
        if (value.length <= remaining) {
            this.text += value;
            return true;
        }
        const contentBudget = Math.max(0, remaining - 1);
        this.text += unicodeSafePrefix(value, contentBudget);
        this.truncate();
        return false;
    }

    truncate(): void {
        if (this.truncated) {
            return;
        }
        this.truncated = true;
        if (this.maxCharacters <= 0) {
            this.text = "";
            return;
        }
        if (this.text.length >= this.maxCharacters) {
            this.text = `${unicodeSafePrefix(this.text, this.maxCharacters - 1)}…`;
            return;
        }
        this.text += "…";
    }
}

function writeQuotedString(writer: PreviewWriter, value: string): void {
    if (!writer.write('"')) {
        return;
    }
    for (const character of value) {
        if (writer.exhausted) {
            break;
        }
        const code = character.charCodeAt(0);
        if (character === '"' || character === "\\") {
            writer.write(`\\${character}`);
        } else if (character === "\n") {
            writer.write("\\n");
        } else if (character === "\r") {
            writer.write("\\r");
        } else if (character === "\t") {
            writer.write("\\t");
        } else if (code < 0x20) {
            writer.write(`\\u${code.toString(16).padStart(4, "0")}`);
        } else {
            writer.write(character);
        }
    }
    writer.write('"');
}

function writeCollectionItemPrefix(writer: PreviewWriter, first: boolean, depth: number): boolean {
    return writer.write(first ? "\n" : ",\n") && writer.write("  ".repeat(depth + 1));
}

function readCollectionItem(value: object, key: string): unknown {
    try {
        return (value as Record<string, unknown>)[key];
    } catch {
        return "[Unreadable]";
    }
}

function writePreviewArray(
    writer: PreviewWriter,
    value: unknown[],
    depth: number,
    ancestors: WeakSet<object>
): boolean {
    let first = true;
    for (let index = 0; index < value.length; index += 1) {
        if (writer.exhausted) {
            break;
        }
        if (!writer.hasTraversalBudget) {
            writer.truncate();
            break;
        }
        if (!writeCollectionItemPrefix(writer, first, depth)) {
            break;
        }
        const item = index in value ? readCollectionItem(value, String(index)) : null;
        writePreviewValue(writer, item, depth + 1, ancestors);
        first = false;
    }
    return first;
}

function writePreviewObject(writer: PreviewWriter, value: object, depth: number, ancestors: WeakSet<object>): boolean {
    let first = true;
    for (const key in value) {
        if (writer.exhausted || !Object.prototype.hasOwnProperty.call(value, key)) {
            break;
        }
        if (!writer.hasTraversalBudget) {
            writer.truncate();
            break;
        }
        if (!writeCollectionItemPrefix(writer, first, depth)) {
            break;
        }
        writeQuotedString(writer, key);
        if (!writer.write(": ") || writer.exhausted) {
            break;
        }
        writePreviewValue(writer, readCollectionItem(value, key), depth + 1, ancestors);
        first = false;
    }
    return first;
}

function writePreviewValue(
    writer: PreviewWriter,
    value: unknown,
    depth: number,
    ancestors: WeakSet<object>,
    root = false
): void {
    if (!writer.enterNode()) {
        return;
    }
    if (value == null) {
        writer.write("null");
        return;
    }
    if (typeof value === "string") {
        if (root) {
            writer.write(value);
        } else {
            writeQuotedString(writer, value);
        }
        return;
    }
    if (typeof value === "number") {
        writer.write(Number.isFinite(value) ? String(value) : "null");
        return;
    }
    if (typeof value === "boolean") {
        writer.write(String(value));
        return;
    }
    if (typeof value !== "object") {
        writer.write(String(value));
        return;
    }
    if (ancestors.has(value)) {
        writeQuotedString(writer, "[Circular]");
        return;
    }

    ancestors.add(value);
    const array = Array.isArray(value);
    writer.write(array ? "[" : "{");
    const first = array
        ? writePreviewArray(writer, value, depth, ancestors)
        : writePreviewObject(writer, value, depth, ancestors);
    if (!writer.exhausted && !first) {
        writer.write(`\n${"  ".repeat(depth)}`);
    }
    if (writer.exhausted) {
        writer.truncate();
    } else {
        writer.write(array ? "]" : "}");
    }
    ancestors.delete(value);
}

export function serializeDetailValue(value: unknown): string {
    return typeof value === "string" ? value : JSON.stringify(value, null, 2);
}

export function formatDetailPreview(value: unknown, options: DetailPreviewOptions): DetailPreview {
    const writer = new PreviewWriter(
        Math.max(0, Math.floor(options.maxCharacters)),
        Math.max(0, Math.floor(options.maxTraversalNodes ?? DefaultPreviewTraversalNodes))
    );
    writePreviewValue(writer, value, 0, new WeakSet(), true);
    return { text: writer.text, truncated: writer.truncated };
}
