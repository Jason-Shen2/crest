// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

export type FileBackedBlockLabel = {
    path: string;
    basename: string;
    fallbackTitle: string;
};

export function isTabAutoNamed(tab: Pick<Tab, "name" | "meta"> | undefined | null): boolean {
    const autoName = tab?.meta?.["tab:autoname"];
    if (typeof autoName === "boolean") {
        return autoName;
    }
    return /^T\d+$/.test(tab?.name ?? "");
}

function basename(path: string): string {
    return path.includes("/") ? path.split("/").pop() || path : path;
}

export function getFileBackedBlockLabel(meta: MetaType | undefined | null): FileBackedBlockLabel | null {
    const view = (meta?.view as string) || "";
    if (view !== "preview" && view !== "codeeditor") {
        return null;
    }
    const path = ((meta?.file as string) || (meta?.["file:path"] as string) || "").trim();
    if (!path) {
        return null;
    }
    return {
        path,
        basename: basename(path),
        fallbackTitle: view === "codeeditor" ? "Code editor" : "Preview",
    };
}
