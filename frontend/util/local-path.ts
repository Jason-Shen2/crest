// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

export function isAbsoluteLocalPath(value: unknown): value is string {
    if (typeof value !== "string" || value === "" || value.includes("\0")) {
        return false;
    }
    const path = value.replace(/\\/g, "/");
    if (/^[A-Za-z]:\//.test(path)) {
        return true;
    }
    if (path.startsWith("//")) {
        return path.split("/").filter(Boolean).length >= 2;
    }
    return path.startsWith("/");
}

export function joinLocalPath(parent: string, child: string): string {
    const normalizedParent = parent.replace(/\\/g, "/");
    const separator = normalizedParent.endsWith("/") ? "" : "/";
    return `${normalizedParent}${separator}${child}`;
}

export function getParentLocalPath(path: string): string {
    const normalizedPath = path.replace(/\\/g, "/");
    const lastSeparatorIndex = normalizedPath.lastIndexOf("/");
    if (lastSeparatorIndex === -1) {
        return ".";
    }
    if (lastSeparatorIndex === 0) {
        return "/";
    }
    if (lastSeparatorIndex === 2 && /^[A-Za-z]:$/.test(normalizedPath.slice(0, 2))) {
        return normalizedPath.slice(0, 3);
    }
    return normalizedPath.slice(0, lastSeparatorIndex);
}
