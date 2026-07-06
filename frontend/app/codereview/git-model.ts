// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

import { workspaceDirAtom } from "@/app/fileexplorer/file-explorer-atoms";
import { globalStore } from "@/app/store/jotaiStore";
import { RpcApi } from "@/app/store/wshclientapi";
import { TabRpcClient } from "@/app/store/wshrpcutil";
import { fireAndForget } from "@/util/util";
import { getApi } from "@/store/global";
import { debounce } from "throttle-debounce";
import * as jotai from "jotai";

export type GitChangedFile = {
    status: string;
    path: string;
    origPath?: string;
};

export type DiffLine = {
    type: "header" | "hunk" | "add" | "remove" | "context";
    content: string;
};

export type FileStats = {
    add: number;
    del: number;
};

export type DiffMode = "Head" | "MainBranch" | "Other";

export type ReviewComment = {
    id: string;
    path: string;
    // Line number in the new (post-change) file the comment is anchored to.
    // null means file-level (not tied to a specific line).
    line: number | null;
    body: string;
    createdAt: number;
};

// Status group ordering for the review panel — modified files first, then
// added, then deleted, then renamed.  The `status` field of GitChangedFile
// is the two-char porcelain code from `git status --short`.
export function statusGroup(status: string): "modified" | "added" | "deleted" | "renamed" | "other" {
    const s = status.trim();
    if (s.startsWith("R")) return "renamed";
    if (s === "??" || s === "A" || s.startsWith("A")) return "added";
    if (s === "D" || s.startsWith("D")) return "deleted";
    if (s === "M" || s.startsWith("M") || s === "MM" || s.endsWith("M")) return "modified";
    return "other";
}

const StatusGroupOrder: Record<string, number> = {
    modified: 0,
    added: 1,
    deleted: 2,
    renamed: 3,
    other: 4,
};

export function sortFilesForReview(files: GitChangedFile[]): GitChangedFile[] {
    return [...files].sort((a, b) => {
        const ga = StatusGroupOrder[statusGroup(a.status)];
        const gb = StatusGroupOrder[statusGroup(b.status)];
        if (ga !== gb) return ga - gb;
        return a.path.localeCompare(b.path);
    });
}

export function parseStatusOutput(raw: string): GitChangedFile[] {
    const files: GitChangedFile[] = [];
    for (const line of raw.split("\n")) {
        if (!line.trim()) continue;
        const status = line.slice(0, 2).trim() || "M";
        const rest = line.slice(3);
        if (!rest) continue;
        if (rest.includes(" -> ")) {
            const [origPath, path] = rest.split(" -> ");
            files.push({ status, path, origPath });
        } else {
            files.push({ status, path: rest });
        }
    }
    return files;
}

// `git diff --name-status` output, one file per line:
//   M\tpath/to/file
//   A\tnew/file
//   D\tdeleted/file
//   R100\told/path\tnew/path
export function parseNameStatusOutput(raw: string): GitChangedFile[] {
    const files: GitChangedFile[] = [];
    for (const line of raw.split("\n")) {
        if (!line.trim()) continue;
        const parts = line.split("\t");
        if (parts.length < 2) continue;
        const code = parts[0];
        if (code.startsWith("R") && parts.length >= 3) {
            files.push({ status: "R", path: parts[2], origPath: parts[1] });
        } else if (code.startsWith("C") && parts.length >= 3) {
            files.push({ status: "C", path: parts[2], origPath: parts[1] });
        } else {
            files.push({ status: code, path: parts.slice(1).join("\t") });
        }
    }
    return files;
}

export function parseDiffOutput(raw: string): DiffLine[] {
    const lines: DiffLine[] = [];
    for (const line of raw.split("\n")) {
        if (line.startsWith("diff --git") || line.startsWith("index ") || line.startsWith("--- ") || line.startsWith("+++ ")) {
            lines.push({ type: "header", content: line });
        } else if (line.startsWith("@@")) {
            lines.push({ type: "hunk", content: line });
        } else if (line.startsWith("+")) {
            lines.push({ type: "add", content: line.slice(1) });
        } else if (line.startsWith("-")) {
            lines.push({ type: "remove", content: line.slice(1) });
        } else if (line.startsWith(" ")) {
            lines.push({ type: "context", content: line.slice(1) });
        }
    }
    return lines;
}

export function countStats(lines: DiffLine[]): FileStats {
    let add = 0;
    let del = 0;
    for (const l of lines) {
        if (l.type === "add") add++;
        if (l.type === "remove") del++;
    }
    return { add, del };
}

export class GitModel {
    private static instance: GitModel | null = null;

    isRepoAtom: jotai.PrimitiveAtom<boolean>;
    branchAtom: jotai.PrimitiveAtom<string>;
    mainBranchAtom: jotai.PrimitiveAtom<string>;
    totalAddAtom: jotai.PrimitiveAtom<number>;
    totalDelAtom: jotai.PrimitiveAtom<number>;
    filesAtom: jotai.PrimitiveAtom<GitChangedFile[]>;
    expandedFilesAtom: jotai.PrimitiveAtom<Set<string>>;
    fileDiffsAtom: jotai.PrimitiveAtom<Map<string, DiffLine[]>>;
    fileStatsAtom: jotai.PrimitiveAtom<Map<string, FileStats>>;
    loadingAtom: jotai.PrimitiveAtom<boolean>;
    loadingFilesAtom: jotai.PrimitiveAtom<Set<string>>;
    errorAtom: jotai.PrimitiveAtom<string | null>;
    cwdAtom: jotai.PrimitiveAtom<string>;
    diffModeAtom: jotai.PrimitiveAtom<DiffMode>;
    selectedFileAtom: jotai.PrimitiveAtom<string | null>;
    fileSidebarCollapsedAtom: jotai.PrimitiveAtom<boolean>;
    commentsAtom: jotai.PrimitiveAtom<ReviewComment[]>;

    private watchedGitDir: string | null = null;
    private watchedCwd: string | null = null;
    private gitDirCallback: (() => void) | null = null;
    private cwdCallback: (() => void) | null = null;
    private debouncedRefresh!: () => void;

    private constructor() {
        this.isRepoAtom = jotai.atom(false) as jotai.PrimitiveAtom<boolean>;
        this.branchAtom = jotai.atom("") as jotai.PrimitiveAtom<string>;
        this.mainBranchAtom = jotai.atom("") as jotai.PrimitiveAtom<string>;
        this.totalAddAtom = jotai.atom(0) as jotai.PrimitiveAtom<number>;
        this.totalDelAtom = jotai.atom(0) as jotai.PrimitiveAtom<number>;
        this.filesAtom = jotai.atom([]) as jotai.PrimitiveAtom<GitChangedFile[]>;
        this.expandedFilesAtom = jotai.atom(new Set<string>()) as jotai.PrimitiveAtom<Set<string>>;
        this.fileDiffsAtom = jotai.atom(new Map()) as jotai.PrimitiveAtom<Map<string, DiffLine[]>>;
        this.fileStatsAtom = jotai.atom(new Map()) as jotai.PrimitiveAtom<Map<string, FileStats>>;
        this.loadingAtom = jotai.atom(false) as jotai.PrimitiveAtom<boolean>;
        this.loadingFilesAtom = jotai.atom(new Set<string>()) as jotai.PrimitiveAtom<Set<string>>;
        this.errorAtom = jotai.atom(null) as jotai.PrimitiveAtom<string | null>;
        this.cwdAtom = jotai.atom("~") as jotai.PrimitiveAtom<string>;
        this.diffModeAtom = jotai.atom("Head") as jotai.PrimitiveAtom<DiffMode>;
        this.selectedFileAtom = jotai.atom(null) as jotai.PrimitiveAtom<string | null>;
        this.fileSidebarCollapsedAtom = jotai.atom(false) as jotai.PrimitiveAtom<boolean>;
        this.commentsAtom = jotai.atom([]) as jotai.PrimitiveAtom<ReviewComment[]>;
        this.debouncedRefresh = debounce(1000, () => fireAndForget(() => this.refresh()));
    }

    startAutoRefresh(): void {
        const cwd = globalStore.get(this.cwdAtom);
        const gitDir = `${cwd}/.git`;
        if (this.watchedGitDir === gitDir && this.watchedCwd === cwd) return;
        this.stopAutoRefresh();
        // Watch the .git directory — any git operation (add, commit, checkout...)
        // modifies files under .git, triggering an immediate refresh.
        this.gitDirCallback = () => this.debouncedRefresh();
        getApi().watchDir(gitDir, this.gitDirCallback);
        this.watchedGitDir = gitDir;
        // Also watch the working tree root for new/deleted untracked files.
        this.cwdCallback = () => this.debouncedRefresh();
        getApi().watchDir(cwd, this.cwdCallback);
        this.watchedCwd = cwd;
    }

    stopAutoRefresh(): void {
        if (this.watchedGitDir && this.gitDirCallback) {
            getApi().unwatchDir(this.watchedGitDir, this.gitDirCallback);
        }
        this.watchedGitDir = null;
        this.gitDirCallback = null;
        if (this.watchedCwd && this.cwdCallback) {
            getApi().unwatchDir(this.watchedCwd, this.cwdCallback);
        }
        this.watchedCwd = null;
        this.cwdCallback = null;
    }

    static getInstance(): GitModel {
        if (!GitModel.instance) {
            GitModel.instance = new GitModel();
        }
        return GitModel.instance;
    }

    syncCwd(): void {
        const cwd = globalStore.get(workspaceDirAtom);
        if (cwd && cwd !== globalStore.get(this.cwdAtom)) {
            globalStore.set(this.cwdAtom, cwd);
            globalStore.set(this.expandedFilesAtom, new Set());
            globalStore.set(this.fileDiffsAtom, new Map());
            globalStore.set(this.fileStatsAtom, new Map());
            // Re-install watchers against the new cwd if auto-refresh was active.
            if (this.watchedGitDir || this.watchedCwd) {
                this.startAutoRefresh();
            }
        }
    }

    // detectMainBranch resolves the repo's main/integration branch.
    // Order: origin/HEAD symbolic-ref → main → master → empty (no remote default).
    private async detectMainBranch(cwd: string): Promise<string> {
        try {
            const r = await RpcApi.RunLocalCmdCommand(TabRpcClient, {
                cmd: "git",
                args: ["symbolic-ref", "--short", "refs/remotes/origin/HEAD"],
                cwd,
            });
            const ref = r.stdout.trim();
            if (ref) return ref;
        } catch {
            // expected when origin/HEAD isn't set
        }
        for (const candidate of ["origin/main", "origin/master", "main", "master"]) {
            try {
                const r = await RpcApi.RunLocalCmdCommand(TabRpcClient, {
                    cmd: "git",
                    args: ["rev-parse", "--verify", "--quiet", candidate],
                    cwd,
                });
                if (r.exitcode === 0 && r.stdout.trim()) return candidate;
            } catch {
                // try next candidate
            }
        }
        return "";
    }

    // Comparison ref used by diff commands.  For Head we diff against the
    // current HEAD (working tree changes).  For MainBranch we use three-dot
    // syntax (`<main>...HEAD`) which mirrors GitHub's PR view: commits on this
    // branch since it diverged.  Other isn't wired up yet — it falls back to
    // Head with a console warning so the panel still renders.
    private comparisonRef(): string {
        const mode = globalStore.get(this.diffModeAtom);
        if (mode === "Head") return "HEAD";
        if (mode === "MainBranch") {
            const main = globalStore.get(this.mainBranchAtom);
            return main ? `${main}...HEAD` : "HEAD";
        }
        return "HEAD";
    }

    async refresh(): Promise<void> {
        const cwd = globalStore.get(this.cwdAtom);
        if (!cwd) return;
        globalStore.set(this.loadingAtom, true);
        globalStore.set(this.errorAtom, null);
        try {
            const [info, mainBranch] = await Promise.all([
                RpcApi.GetGitInfoCommand(TabRpcClient, cwd),
                this.detectMainBranch(cwd),
            ]);
            globalStore.set(this.isRepoAtom, info.isrepo);
            globalStore.set(this.branchAtom, info.branch ?? "");
            globalStore.set(this.mainBranchAtom, mainBranch);
            if (info.isrepo) {
                const files = await this.loadFiles();
                globalStore.set(this.filesAtom, files);
                this.maybeAutoSelectFile(files);
                // Populate per-file stats up front so the panel shows
                // real counts (not +0/-0) before the user expands a row.
                fireAndForget(() => this.loadAllStats(files));
                // Reload diff for the currently selected file, plus any
                // already-expanded rows in the file list.
                const selected = globalStore.get(this.selectedFileAtom);
                if (selected) fireAndForget(() => this.loadDiff(selected));
                const expanded = globalStore.get(this.expandedFilesAtom);
                for (const path of expanded) {
                    if (path !== selected) fireAndForget(() => this.loadDiff(path));
                }
                // Compute total +/- for the current diff mode.
                this.recomputeTotalsFromStats();
            } else {
                globalStore.set(this.totalAddAtom, info.additions ?? 0);
                globalStore.set(this.totalDelAtom, info.deletions ?? 0);
            }
        } catch (e: any) {
            globalStore.set(this.errorAtom, e?.message ?? String(e));
        } finally {
            globalStore.set(this.loadingAtom, false);
        }
    }

    // loadFiles returns the file list for the current diff mode.  Head uses
    // `git status` so untracked files surface; MainBranch uses `git diff
    // --name-status` so the listing matches the PR-style comparison.
    private async loadFiles(): Promise<GitChangedFile[]> {
        const cwd = globalStore.get(this.cwdAtom);
        const mode = globalStore.get(this.diffModeAtom);
        if (mode === "Head" || mode === "Other") {
            const statusResult = await RpcApi.RunLocalCmdCommand(TabRpcClient, {
                cmd: "git",
                args: ["status", "--short", "--porcelain"],
                cwd,
            });
            return sortFilesForReview(parseStatusOutput(statusResult.stdout));
        }
        // MainBranch — name-status against the comparison ref.
        const ref = this.comparisonRef();
        const r = await RpcApi.RunLocalCmdCommand(TabRpcClient, {
            cmd: "git",
            args: ["diff", "--name-status", ref],
            cwd,
        });
        return sortFilesForReview(parseNameStatusOutput(r.stdout));
    }

    private maybeAutoSelectFile(files: GitChangedFile[]): void {
        const selected = globalStore.get(this.selectedFileAtom);
        if (selected && files.some((f) => f.path === selected)) return;
        if (files.length === 0) {
            globalStore.set(this.selectedFileAtom, null);
            return;
        }
        const first = files[0].path;
        globalStore.set(this.selectedFileAtom, first);
        fireAndForget(() => this.loadDiff(first));
    }

    private recomputeTotalsFromStats(): void {
        const stats = globalStore.get(this.fileStatsAtom);
        let add = 0;
        let del = 0;
        for (const s of stats.values()) {
            add += s.add;
            del += s.del;
        }
        globalStore.set(this.totalAddAtom, add);
        globalStore.set(this.totalDelAtom, del);
    }

    setDiffMode(mode: DiffMode): void {
        if (globalStore.get(this.diffModeAtom) === mode) return;
        globalStore.set(this.diffModeAtom, mode);
        // Reset diff-derived state so the new mode's data lands cleanly.
        globalStore.set(this.fileDiffsAtom, new Map());
        globalStore.set(this.fileStatsAtom, new Map());
        globalStore.set(this.expandedFilesAtom, new Set());
        fireAndForget(() => this.refresh());
    }

    selectFile(path: string | null): void {
        globalStore.set(this.selectedFileAtom, path);
        if (!path) return;
        const diffs = globalStore.get(this.fileDiffsAtom);
        if (!diffs.has(path)) {
            fireAndForget(() => this.loadDiff(path));
        }
    }

    toggleFileSidebar(): void {
        globalStore.set(this.fileSidebarCollapsedAtom, !globalStore.get(this.fileSidebarCollapsedAtom));
    }

    addComment(path: string, line: number | null, body: string): void {
        const trimmed = body.trim();
        if (!trimmed) return;
        const comment: ReviewComment = {
            id: `c-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
            path,
            line,
            body: trimmed,
            createdAt: Date.now(),
        };
        const next = [...globalStore.get(this.commentsAtom), comment];
        globalStore.set(this.commentsAtom, next);
    }

    removeComment(id: string): void {
        const next = globalStore.get(this.commentsAtom).filter((c) => c.id !== id);
        globalStore.set(this.commentsAtom, next);
    }

    clearComments(): void {
        globalStore.set(this.commentsAtom, []);
    }

    // loadAllStats fetches +/- counts for every changed file in one
    // pass. Tracked changes come from `git diff --numstat HEAD` (single
    // call, tiny output). Untracked files don't appear in numstat, so
    // we fall back to `wc -l` per file — counting all their lines as
    // additions, which matches how loadDiff treats them. Binary files
    // show "-\t-" in numstat; we coerce to 0/0 since FileStats doesn't
    // model binary specially.
    private async loadAllStats(files: GitChangedFile[]): Promise<void> {
        const cwd = globalStore.get(this.cwdAtom);
        if (!cwd || files.length === 0) return;
        const ref = this.comparisonRef();
        const stats = new Map<string, FileStats>();
        try {
            const numstatResult = await RpcApi.RunLocalCmdCommand(TabRpcClient, {
                cmd: "git",
                args: ["diff", "--numstat", ref],
                cwd,
            });
            for (const line of numstatResult.stdout.split("\n")) {
                if (!line) continue;
                const [addStr, delStr, ...pathParts] = line.split("\t");
                const path = pathParts.join("\t");
                if (!path) continue;
                const a = parseInt(addStr, 10);
                const d = parseInt(delStr, 10);
                stats.set(path, { add: isNaN(a) ? 0 : a, del: isNaN(d) ? 0 : d });
            }
        } catch (e: any) {
            console.warn(`git diff --numstat failed:`, e);
        }
        // Untracked files (and anything numstat skipped) — count their
        // lines as additions. Run sequentially to keep this cheap; a
        // typical changeset has at most a handful of untracked files.
        const untracked = files.filter((f) => !stats.has(f.path));
        for (const f of untracked) {
            try {
                const r = await RpcApi.RunLocalCmdCommand(TabRpcClient, {
                    cmd: "wc",
                    args: ["-l", f.path],
                    cwd,
                });
                const n = parseInt(r.stdout.trim().split(/\s+/)[0], 10);
                stats.set(f.path, { add: isNaN(n) ? 0 : n, del: 0 });
            } catch {
                stats.set(f.path, { add: 0, del: 0 });
            }
        }
        // Merge with any existing stats from already-loaded full diffs
        // — those are equivalent to numstat values, but the merge keeps
        // a per-file race (loadDiff finishing after loadAllStats) from
        // dropping richer entries.
        const merged = new Map(globalStore.get(this.fileStatsAtom));
        for (const [path, s] of stats) {
            merged.set(path, s);
        }
        globalStore.set(this.fileStatsAtom, merged);
        this.recomputeTotalsFromStats();
    }

    private async loadDiff(path: string): Promise<void> {
        const cwd = globalStore.get(this.cwdAtom);
        const ref = this.comparisonRef();
        const loading = new Set(globalStore.get(this.loadingFilesAtom));
        loading.add(path);
        globalStore.set(this.loadingFilesAtom, loading);
        try {
            const result = await RpcApi.RunLocalCmdCommand(TabRpcClient, {
                cmd: "git",
                args: ["diff", "--unified=3", ref, "--", path],
                cwd,
            });
            let diffText = result.stdout;
            // If file is untracked, diff against /dev/null
            if (!diffText && result.exitcode !== 0) {
                diffText = result.stderr;
            }
            const lines = parseDiffOutput(diffText);
            const stats = countStats(lines);
            const diffs = new Map(globalStore.get(this.fileDiffsAtom));
            diffs.set(path, lines);
            const fileStats = new Map(globalStore.get(this.fileStatsAtom));
            fileStats.set(path, stats);
            globalStore.set(this.fileDiffsAtom, diffs);
            globalStore.set(this.fileStatsAtom, fileStats);
        } catch (e: any) {
            console.warn(`git diff ${path} failed:`, e);
        } finally {
            const l = new Set(globalStore.get(this.loadingFilesAtom));
            l.delete(path);
            globalStore.set(this.loadingFilesAtom, l);
        }
    }

    async toggleExpand(path: string): Promise<void> {
        const expanded = new Set(globalStore.get(this.expandedFilesAtom));
        if (expanded.has(path)) {
            expanded.delete(path);
            globalStore.set(this.expandedFilesAtom, expanded);
            return;
        }
        expanded.add(path);
        globalStore.set(this.expandedFilesAtom, expanded);
        const diffs = globalStore.get(this.fileDiffsAtom);
        if (!diffs.has(path)) {
            await this.loadDiff(path);
        }
    }

    expandAll(): void {
        const files = globalStore.get(this.filesAtom);
        const expanded = new Set(files.map((f) => f.path));
        globalStore.set(this.expandedFilesAtom, expanded);
        for (const f of files) {
            const diffs = globalStore.get(this.fileDiffsAtom);
            if (!diffs.has(f.path)) {
                fireAndForget(() => this.loadDiff(f.path));
            }
        }
    }

    collapseAll(): void {
        globalStore.set(this.expandedFilesAtom, new Set());
    }

    async discardFile(path: string, opts?: { skipRefresh?: boolean }): Promise<void> {
        const cwd = globalStore.get(this.cwdAtom);
        await RpcApi.RunLocalCmdCommand(TabRpcClient, {
            cmd: "git",
            args: ["checkout", "--", path],
            cwd,
        });
        if (!opts?.skipRefresh) await this.refresh();
    }

    async discardFiles(paths: string[]): Promise<void> {
        await Promise.all(paths.map((p) => this.discardFile(p, { skipRefresh: true })));
        await this.refresh();
    }
}
