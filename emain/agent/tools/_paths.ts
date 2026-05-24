// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0
//
// Path helpers for the agent tools.
//
// The resolveToCwd / pathExists / resolveReadPath* / normalizePath /
// resolvePath family is ported from pi's
// packages/coding-agent/src/utils/paths.ts + core/tools/path-utils.ts
// (earendil-works/pi), trimmed to what the tools' execute paths need —
// the cloud-sync xattr helper (its only child_process dependency) is
// dropped, and all TUI render helpers stay out. pi tools are cwd-bound:
// path args may be relative and resolve against the pane's cwd. The
// macOS screenshot-name variants (narrow no-break space, NFD, curly
// quotes) are kept because pi relies on them to find files the LLM
// references by their displayed names.

import { accessSync, constants, realpathSync } from "node:fs";
import { access } from "node:fs/promises";
import { homedir } from "node:os";
import * as os from "node:os";
import { isAbsolute, join, relative, resolve as nodeResolvePath, sep } from "node:path";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

const UNICODE_SPACES = /[  -   　]/g;
const NARROW_NO_BREAK_SPACE = " ";

/**
 * Expand a leading ~ or ~/ to the user's home dir. Crest tools accept
 * tilde-prefixed paths because they're natural for terminal users;
 * the agent's tool execution should mirror that.
 */
export function expandHome(p: string): string {
    if (p === "~") return os.homedir();
    if (p.startsWith("~/")) return path.join(os.homedir(), p.slice(2));
    return p;
}

/**
 * Resolve a path argument to absolute form, expanding ~ first. Throws
 * if the result is not absolute — tools require absolute inputs to
 * avoid ambiguity with the harness env's cwd (which is the pane cwd
 * at construction time, not at call time).
 */
export function requireAbsolute(p: string, toolName: string): string {
    const expanded = expandHome(p);
    if (!path.isAbsolute(expanded)) {
        throw new Error(`${toolName}: path must be absolute or ~-prefixed; got "${p}"`);
    }
    return expanded;
}

export interface PathInputOptions {
    trim?: boolean;
    expandTilde?: boolean;
    homeDir?: string;
    stripAtPrefix?: boolean;
    normalizeUnicodeSpaces?: boolean;
}

export function canonicalizePath(p: string): string {
    try {
        return realpathSync(p);
    } catch {
        return p;
    }
}

export function normalizePath(input: string, options: PathInputOptions = {}): string {
    let normalized = options.trim ? input.trim() : input;
    if (options.normalizeUnicodeSpaces) {
        normalized = normalized.replace(UNICODE_SPACES, " ");
    }
    if (options.stripAtPrefix && normalized.startsWith("@")) {
        normalized = normalized.slice(1);
    }
    if (options.expandTilde ?? true) {
        const home = options.homeDir ?? homedir();
        if (normalized === "~") return home;
        if (normalized.startsWith("~/") || (process.platform === "win32" && normalized.startsWith("~\\"))) {
            return join(home, normalized.slice(2));
        }
    }
    if (/^file:\/\//.test(normalized)) {
        return fileURLToPath(normalized);
    }
    return normalized;
}

export function resolvePath(
    input: string,
    baseDir: string = process.cwd(),
    options: PathInputOptions = {},
): string {
    const normalized = normalizePath(input, options);
    const normalizedBaseDir = normalizePath(baseDir);
    return isAbsolute(normalized)
        ? nodeResolvePath(normalized)
        : nodeResolvePath(normalizedBaseDir, normalized);
}

export function getCwdRelativePath(filePath: string, cwd: string): string | undefined {
    const resolvedCwd = resolvePath(cwd);
    const resolvedPath = resolvePath(filePath, resolvedCwd);
    const relativePath = relative(resolvedCwd, resolvedPath);
    const isInsideCwd =
        relativePath === "" ||
        (relativePath !== ".." && !relativePath.startsWith(`..${sep}`) && !isAbsolute(relativePath));
    return isInsideCwd ? relativePath || "." : undefined;
}

export function formatPathRelativeToCwdOrAbsolute(filePath: string, cwd: string): string {
    const absolutePath = resolvePath(filePath, cwd);
    return (getCwdRelativePath(absolutePath, cwd) ?? absolutePath).split(sep).join("/");
}

export async function pathExists(filePath: string): Promise<boolean> {
    try {
        await access(filePath, constants.F_OK);
        return true;
    } catch {
        return false;
    }
}

function fileExistsSync(filePath: string): boolean {
    try {
        accessSync(filePath, constants.F_OK);
        return true;
    } catch {
        return false;
    }
}

/** Resolve a (possibly relative / ~-prefixed) path against cwd. */
export function resolveToCwd(filePath: string, cwd: string): string {
    return resolvePath(filePath, cwd, { normalizeUnicodeSpaces: true, stripAtPrefix: true });
}

function macScreenshotVariant(filePath: string): string {
    return filePath.replace(/ (AM|PM)\./gi, `${NARROW_NO_BREAK_SPACE}$1.`);
}
function curlyQuoteVariant(filePath: string): string {
    return filePath.replace(/'/g, "’");
}

/**
 * Resolve a read path, falling back through macOS filename variants
 * (narrow no-break space before AM/PM, NFD decomposition, curly quotes)
 * so the LLM can reference screenshots etc. by their displayed names.
 */
export async function resolveReadPathAsync(filePath: string, cwd: string): Promise<string> {
    const resolved = resolveToCwd(filePath, cwd);
    if (await pathExists(resolved)) return resolved;

    const amPm = macScreenshotVariant(resolved);
    if (amPm !== resolved && (await pathExists(amPm))) return amPm;

    const nfd = resolved.normalize("NFD");
    if (nfd !== resolved && (await pathExists(nfd))) return nfd;

    const curly = curlyQuoteVariant(resolved);
    if (curly !== resolved && (await pathExists(curly))) return curly;

    const nfdCurly = curlyQuoteVariant(nfd);
    if (nfdCurly !== resolved && (await pathExists(nfdCurly))) return nfdCurly;

    return resolved;
}

/** Sync variant of resolveReadPathAsync. */
export function resolveReadPath(filePath: string, cwd: string): string {
    const resolved = resolveToCwd(filePath, cwd);
    if (fileExistsSync(resolved)) return resolved;

    const amPm = macScreenshotVariant(resolved);
    if (amPm !== resolved && fileExistsSync(amPm)) return amPm;

    const nfd = resolved.normalize("NFD");
    if (nfd !== resolved && fileExistsSync(nfd)) return nfd;

    const curly = curlyQuoteVariant(resolved);
    if (curly !== resolved && fileExistsSync(curly)) return curly;

    const nfdCurly = curlyQuoteVariant(nfd);
    if (nfdCurly !== resolved && fileExistsSync(nfdCurly)) return nfdCurly;

    return resolved;
}
