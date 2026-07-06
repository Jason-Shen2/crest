// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

export type FileBackedBlockLabel = {
    path: string;
    basename: string;
    fallbackTitle: string;
};

export function isTabAutoNamed(tab: Pick<Tab, "meta"> | undefined | null): boolean {
    const autoName = tab?.meta?.["tab:autoname"];
    return autoName === true;
}

function basename(path: string): string {
    return path.includes("/") ? path.split("/").pop() || path : path;
}

export function getFileBackedBlockLabel(meta: MetaType | undefined | null): FileBackedBlockLabel | null {
    const view = (meta?.view as string) || "";
    if (view !== "preview" && view !== "codeeditor" && view !== "gitdiff") {
        return null;
    }
    const path =
        view === "gitdiff"
            ? ((meta?.["gitdiff:path"] as string) || "").trim()
            : ((meta?.file as string) || (meta?.["file:path"] as string) || "").trim();
    if (!path) {
        return null;
    }
    if (view === "gitdiff") {
        const mode = ((meta?.["gitdiff:mode"] as string) || "-").trim() || "-";
        return {
            path,
            basename: `${basename(path)} (${mode})`,
            fallbackTitle: "Git diff",
        };
    }
    return {
        path,
        basename: basename(path),
        fallbackTitle: view === "codeeditor" ? "Code editor" : "Preview",
    };
}
