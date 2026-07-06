// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

import { focusedCwdAtom } from "@/app/fileexplorer/file-explorer-atoms";
import { globalStore } from "@/app/store/jotaiStore";
import { RpcApi } from "@/app/store/wshclientapi";
import { TabRpcClient } from "@/app/store/wshrpcutil";
import { fireAndForget } from "@/util/util";
import * as jotai from "jotai";
import { debounce } from "throttle-debounce";
import { openGitDiffTab } from "./open-git-diff-tab";

type PanelState = "closed" | "loading" | "no-repo" | "ready" | "error";
type CheckState = "checked" | "indeterminate" | "unchecked";
export type SourceControlView = "changes" | "graph";

export type SourceControlFileEntry = {
    key: string;
    path: string;
    originalpath: string | null;
    statuscode: string;
    statuslabel: string;
    checkstate: CheckState;
    staged: boolean;
    unstaged: boolean;
    untracked: boolean;
    indexstatus: string;
    worktreestatus: string;
};

export type PendingDiscard = {
    scope: "single" | "all";
    count: number;
    label: string;
    paths: { path: string; untracked: boolean }[];
};

function normalizeStatusCode(idx: string, wt: string): string {
    const code = (wt !== " " ? wt : idx).trim().toUpperCase();
    switch (code) {
        case "?":
            return "U";
        case "A":
            return "A";
        case "M":
            return "M";
        case "D":
            return "D";
        case "R":
        case "C":
            return "R";
        case "U":
            return "U";
        default:
            return code || "M";
    }
}

function optimisticStage(status: GitStatusSnapshot, paths: Set<string>): GitStatusSnapshot {
    let changed = false;
    const next = status.changedfiles.map((file) => {
        if (!paths.has(file.path)) return file;
        if (file.staged && !file.unstaged) return file;
        changed = true;
        const wt = file.worktreestatus !== " " ? file.worktreestatus : file.indexstatus;
        return {
            ...file,
            indexstatus: wt,
            worktreestatus: " ",
            staged: true,
            unstaged: false,
            untracked: false,
        };
    });
    if (!changed) return status;
    return { ...status, changedfiles: next };
}

function optimisticUnstage(status: GitStatusSnapshot, paths: Set<string>): GitStatusSnapshot {
    let changed = false;
    const next: GitChangedFile[] = [];
    for (const file of status.changedfiles) {
        if (!paths.has(file.path)) {
            next.push(file);
            continue;
        }
        if (!file.staged && file.unstaged) {
            next.push(file);
            continue;
        }
        changed = true;
        const idx = file.indexstatus !== " " ? file.indexstatus : file.worktreestatus;
        if (idx === "R" && file.originalpath) {
            next.push({
                path: file.originalpath,
                originalpath: "",
                indexstatus: " ",
                worktreestatus: "D",
                staged: false,
                unstaged: true,
                untracked: false,
                statuslabel: "Deleted",
            });
            next.push({
                path: file.path,
                originalpath: "",
                indexstatus: " ",
                worktreestatus: "?",
                staged: false,
                unstaged: true,
                untracked: true,
                statuslabel: "Untracked",
            });
            continue;
        }
        next.push({
            ...file,
            originalpath: "",
            indexstatus: " ",
            worktreestatus: idx === "A" ? "?" : idx,
            staged: false,
            unstaged: true,
            untracked: idx === "A",
        });
    }
    if (!changed) return status;
    return { ...status, changedfiles: next };
}

function optimisticDiscard(status: GitStatusSnapshot, paths: Set<string>): GitStatusSnapshot {
    let changed = false;
    const next: GitChangedFile[] = [];
    for (const file of status.changedfiles) {
        if (!paths.has(file.path)) {
            next.push(file);
            continue;
        }
        if (file.staged) {
            changed = true;
            next.push({
                ...file,
                worktreestatus: " ",
                unstaged: false,
                untracked: false,
            });
        } else {
            changed = true;
        }
    }
    if (!changed) return status;
    return { ...status, changedfiles: next };
}

export class SourceControlModel {
    private static instance: SourceControlModel | null = null;

    panelstateAtom: jotai.PrimitiveAtom<PanelState>;
    repoAtom: jotai.PrimitiveAtom<GitRepoInfo | null>;
    statusAtom: jotai.PrimitiveAtom<GitStatusSnapshot | null>;
    commitmessageAtom: jotai.PrimitiveAtom<string>;
    actionbusyAtom: jotai.PrimitiveAtom<string | null>;
    statuserrorAtom: jotai.PrimitiveAtom<string | null>;
    actionerrorAtom: jotai.PrimitiveAtom<string | null>;
    actionmessageAtom: jotai.PrimitiveAtom<string | null>;
    pendingdiscardAtom: jotai.PrimitiveAtom<PendingDiscard | null>;
    selectedpathAtom: jotai.PrimitiveAtom<string | null>;
	viewAtom: jotai.PrimitiveAtom<SourceControlView>;
    cwdAtom: jotai.PrimitiveAtom<string>;

    private inFlight: boolean = false;
    private pendingRefreshPaths: Set<string> = new Set();
    private debouncedRefresh: () => void;

    private constructor() {
        this.panelstateAtom = jotai.atom("closed" as PanelState) as jotai.PrimitiveAtom<PanelState>;
        this.repoAtom = jotai.atom(null) as jotai.PrimitiveAtom<GitRepoInfo | null>;
        this.statusAtom = jotai.atom(null) as jotai.PrimitiveAtom<GitStatusSnapshot | null>;
        this.commitmessageAtom = jotai.atom("") as jotai.PrimitiveAtom<string>;
        this.actionbusyAtom = jotai.atom(null) as jotai.PrimitiveAtom<string | null>;
        this.statuserrorAtom = jotai.atom(null) as jotai.PrimitiveAtom<string | null>;
        this.actionerrorAtom = jotai.atom(null) as jotai.PrimitiveAtom<string | null>;
        this.actionmessageAtom = jotai.atom(null) as jotai.PrimitiveAtom<string | null>;
        this.pendingdiscardAtom = jotai.atom(null) as jotai.PrimitiveAtom<PendingDiscard | null>;
        this.selectedpathAtom = jotai.atom(null) as jotai.PrimitiveAtom<string | null>;
		this.viewAtom = jotai.atom("changes" as SourceControlView) as jotai.PrimitiveAtom<SourceControlView>;
        this.cwdAtom = jotai.atom("") as jotai.PrimitiveAtom<string>;

        this.debouncedRefresh = debounce(200, () => {
            const paths = new Set(this.pendingRefreshPaths);
            this.pendingRefreshPaths.clear();
            fireAndForget(() => this.doRefresh());
        });
    }

    static getInstance(): SourceControlModel {
        if (!SourceControlModel.instance) {
            SourceControlModel.instance = new SourceControlModel();
        }
        return SourceControlModel.instance;
    }

    setCwd(cwd: string): void {
        const current = globalStore.get(this.cwdAtom);
        if (current === cwd) return;
        globalStore.set(this.cwdAtom, cwd);
        globalStore.set(this.statusAtom, null);
        globalStore.set(this.repoAtom, null);
        globalStore.set(this.panelstateAtom, "loading");
        globalStore.set(this.statuserrorAtom, null);
        fireAndForget(() => this.doRefresh());
    }

    syncCwd(): void {
        const cwd = globalStore.get(focusedCwdAtom);
        if (cwd && cwd !== globalStore.get(this.cwdAtom)) {
            this.setCwd(cwd);
        }
    }

    getFileEntries(): SourceControlFileEntry[] {
        const status = globalStore.get(this.statusAtom);
        if (!status) return [];
        const seen = new Set<string>();
        const out: SourceControlFileEntry[] = [];
        for (const file of status.changedfiles) {
            if (seen.has(file.path)) continue;
            seen.add(file.path);
            const checkstate: CheckState =
                file.staged && file.unstaged
                    ? "indeterminate"
                    : file.staged
                      ? "checked"
                      : "unchecked";
            const statuscode = file.unstaged
                ? normalizeStatusCode(file.indexstatus, file.worktreestatus)
                : normalizeStatusCode(file.indexstatus, file.worktreestatus);
            out.push({
                key: file.path,
                path: file.path,
                originalpath: file.originalpath || null,
                statuscode,
                statuslabel: file.statuslabel,
                checkstate,
                staged: file.staged,
                unstaged: file.unstaged,
                untracked: file.untracked,
                indexstatus: file.indexstatus,
                worktreestatus: file.worktreestatus,
            });
        }
        return out;
    }

    getHeaderCheckState(): CheckState {
        const entries = this.getFileEntries();
        if (entries.length === 0) return "unchecked";
        const allChecked = entries.every((e) => e.checkstate === "checked");
        if (allChecked) return "checked";
        const anyStaged = entries.some((e) => e.staged);
        return anyStaged ? "indeterminate" : "unchecked";
    }

    getStagedCount(): number {
        return this.getFileEntries().filter((e) => e.staged).length;
    }

    getAllClean(): boolean {
        return this.getFileEntries().length === 0;
    }

    canPush(): boolean {
        const repo = globalStore.get(this.repoAtom);
        const status = globalStore.get(this.statusAtom);
        return !!repo?.upstream && (status?.behind ?? 0) === 0 && (status?.ahead ?? 0) > 0;
    }

    getPushHint(): string | null {
        const repo = globalStore.get(this.repoAtom);
        const status = globalStore.get(this.statusAtom);
        if (!repo) return null;
        if (!repo.upstream) {
            return "No upstream configured.";
        }
        if ((status?.behind ?? 0) > 0) {
            return "Pull remote changes before pushing.";
        }
        if ((status?.ahead ?? 0) === 0) {
            return `No local commits to push to ${repo.upstream}.`;
        }
        return `Pushes to ${repo.upstream}.`;
    }

    async refresh(): Promise<void> {
        await this.doRefresh();
    }

    private scheduleRefresh(): void {
        this.debouncedRefresh();
    }

    private async doRefresh(): Promise<void> {
        const cwd = globalStore.get(this.cwdAtom);
        if (!cwd) {
            globalStore.set(this.panelstateAtom, "closed");
            return;
        }
        if (this.inFlight) {
            this.pendingRefreshPaths.add(cwd);
            return;
        }
        this.inFlight = true;
        const wasClosed = globalStore.get(this.panelstateAtom) === "closed";
        if (wasClosed) {
            globalStore.set(this.panelstateAtom, "loading");
        }
        globalStore.set(this.statuserrorAtom, null);
        try {
            const snapshot = await RpcApi.GitGetPanelSnapshotCommand(TabRpcClient, cwd);
            globalStore.set(this.repoAtom, snapshot.repo);
            globalStore.set(this.statusAtom, snapshot.status);
            globalStore.set(this.panelstateAtom, "ready");
        } catch (e: any) {
            const msg = e?.message ?? String(e);
            if (msg.includes("not a git repository") || msg.includes("Not a git repository")) {
                globalStore.set(this.repoAtom, null);
                globalStore.set(this.statusAtom, null);
                globalStore.set(this.panelstateAtom, "no-repo");
            } else {
                globalStore.set(this.statuserrorAtom, msg);
                globalStore.set(this.panelstateAtom, "error");
            }
        } finally {
            this.inFlight = false;
        }
    }

    private async runMutation(
        busyKey: string,
        optimistic: ((status: GitStatusSnapshot) => GitStatusSnapshot) | null,
        ipc: () => Promise<void>,
        affected: string[]
    ): Promise<void> {
        const repo = globalStore.get(this.repoAtom);
        if (!repo) return;
        if (globalStore.get(this.actionbusyAtom)) return;
        globalStore.set(this.actionbusyAtom, busyKey);
        globalStore.set(this.actionmessageAtom, null);
        globalStore.set(this.actionerrorAtom, null);
        const currentStatus = globalStore.get(this.statusAtom);
        if (optimistic && currentStatus) {
            globalStore.set(this.statusAtom, optimistic(currentStatus));
        }
        try {
            await ipc();
            this.scheduleRefresh();
        } catch (error: any) {
            globalStore.set(this.actionerrorAtom, error?.message ?? String(error));
            await this.doRefresh();
        } finally {
            globalStore.set(this.actionbusyAtom, null);
        }
    }

    async toggleStageFile(entry: SourceControlFileEntry): Promise<void> {
        const repo = globalStore.get(this.repoAtom);
        if (!repo) return;
        const paths = new Set([entry.path]);
        if (entry.checkstate === "checked") {
            await this.runMutation(
                `unstage:${entry.path}`,
                (s) => optimisticUnstage(s, paths),
                () => RpcApi.GitUnstageFileCommand(TabRpcClient, { cwd: repo.reporoot, path: entry.path }),
                [entry.path]
            );
        } else {
            await this.runMutation(
                `stage:${entry.path}`,
                (s) => optimisticStage(s, paths),
                () => RpcApi.GitStageFileCommand(TabRpcClient, { cwd: repo.reporoot, path: entry.path }),
                [entry.path]
            );
        }
    }

    async toggleAll(): Promise<void> {
        const headerState = this.getHeaderCheckState();
        if (headerState === "checked") {
            await this.unstageAll();
        } else {
            await this.stageAll();
        }
    }

    async stageAll(): Promise<void> {
        const repo = globalStore.get(this.repoAtom);
        if (!repo) return;
        const entries = this.getFileEntries().filter((e) => !e.staged);
        if (entries.length === 0) return;
        const paths = new Set(entries.map((e) => e.path));
        await this.runMutation(
            "stage:all",
            (s) => optimisticStage(s, paths),
            () => RpcApi.GitStageAllCommand(TabRpcClient, repo.reporoot),
            [...paths]
        );
    }

    async unstageAll(): Promise<void> {
        const repo = globalStore.get(this.repoAtom);
        if (!repo) return;
        const entries = this.getFileEntries().filter((e) => e.staged);
        if (entries.length === 0) return;
        const paths = new Set(entries.map((e) => e.path));
        await this.runMutation(
            "unstage:all",
            (s) => optimisticUnstage(s, paths),
            () => RpcApi.GitUnstageAllCommand(TabRpcClient, repo.reporoot),
            [...paths]
        );
    }

    requestDiscardFile(entry: SourceControlFileEntry): void {
        const repo = globalStore.get(this.repoAtom);
        if (!repo || globalStore.get(this.actionbusyAtom)) return;
        if (!entry.unstaged) return;
        globalStore.set(this.pendingdiscardAtom, {
            scope: "single",
            count: 1,
            label: entry.path,
            paths: [{ path: entry.path, untracked: entry.untracked }],
        });
    }

    requestDiscardAll(): void {
        const repo = globalStore.get(this.repoAtom);
        if (!repo || globalStore.get(this.actionbusyAtom)) return;
        const entries = this.getFileEntries().filter((e) => e.unstaged);
        if (entries.length === 0) return;
        globalStore.set(this.pendingdiscardAtom, {
            scope: "all",
            count: entries.length,
            label: `${entries.length} unstaged ${entries.length === 1 ? "file" : "files"}`,
            paths: entries.map((e) => ({ path: e.path, untracked: e.untracked })),
        });
    }

    cancelPendingDiscard(): void {
        globalStore.set(this.pendingdiscardAtom, null);
    }

    async confirmPendingDiscard(): Promise<void> {
        const repo = globalStore.get(this.repoAtom);
        const pending = globalStore.get(this.pendingdiscardAtom);
        if (!repo || !pending) return;
        const paths = new Set(pending.paths.map((p) => p.path));
        globalStore.set(this.pendingdiscardAtom, null);
        await this.runMutation(
            pending.scope === "single" ? `discard:${pending.paths[0].path}` : "discard:all",
            (s) => optimisticDiscard(s, paths),
            () => RpcApi.GitDiscardChangesCommand(TabRpcClient, { cwd: repo.reporoot, paths: pending.paths }),
            [...paths]
        );
    }

    async commit(message: string): Promise<void> {
        const repo = globalStore.get(this.repoAtom);
        if (!repo || globalStore.get(this.actionbusyAtom)) return;
        const trimmed = message.trim();
        if (!trimmed) {
            globalStore.set(this.actionerrorAtom, "Enter a commit message.");
            return;
        }
        if (this.getStagedCount() === 0) {
            globalStore.set(this.actionerrorAtom, "Stage changes to enable commit.");
            return;
        }
        globalStore.set(this.actionbusyAtom, "commit");
        globalStore.set(this.actionmessageAtom, null);
        globalStore.set(this.actionerrorAtom, null);
        try {
            const result = await RpcApi.GitCommitCommand(TabRpcClient, { cwd: repo.reporoot, message: trimmed });
            globalStore.set(this.commitmessageAtom, "");
            globalStore.set(
                this.actionmessageAtom,
                `Committed ${result.commitsha.slice(0, 7)} ${result.summary}`
            );
            await this.doRefresh();
        } catch (error: any) {
            globalStore.set(this.actionerrorAtom, error?.message ?? String(error));
        } finally {
            globalStore.set(this.actionbusyAtom, null);
        }
    }

    setCommitMessage(value: string): void {
        globalStore.set(this.commitmessageAtom, value);
    }

    async push(): Promise<void> {
        const repo = globalStore.get(this.repoAtom);
        if (!repo) return;
        globalStore.set(this.actionbusyAtom, "push");
        globalStore.set(this.actionmessageAtom, null);
        globalStore.set(this.actionerrorAtom, null);
        try {
            const result = await RpcApi.GitPushCommand(TabRpcClient, repo.reporoot);
            if (result.pushed) {
                globalStore.set(
                    this.actionmessageAtom,
                    `Pushed to ${result.remote}/${result.branch}`
                );
            }
            await this.doRefresh();
        } catch (error: any) {
            globalStore.set(this.actionerrorAtom, error?.message ?? String(error));
        } finally {
            globalStore.set(this.actionbusyAtom, null);
        }
    }

    async pull(): Promise<void> {
        const repo = globalStore.get(this.repoAtom);
        if (!repo) return;
        globalStore.set(this.actionbusyAtom, "pull");
        globalStore.set(this.actionmessageAtom, null);
        globalStore.set(this.actionerrorAtom, null);
        try {
            await RpcApi.GitPullCommand(TabRpcClient, repo.reporoot);
            globalStore.set(this.actionmessageAtom, "Pull completed successfully.");
            await this.doRefresh();
        } catch (error: any) {
            globalStore.set(this.actionerrorAtom, error?.message ?? String(error));
        } finally {
            globalStore.set(this.actionbusyAtom, null);
        }
    }

    async fetch(): Promise<void> {
        const repo = globalStore.get(this.repoAtom);
        if (!repo) return;
        globalStore.set(this.actionbusyAtom, "fetch");
        globalStore.set(this.actionmessageAtom, null);
        globalStore.set(this.actionerrorAtom, null);
        try {
            await RpcApi.GitFetchCommand(TabRpcClient, repo.reporoot);
            globalStore.set(this.actionmessageAtom, "Fetch completed.");
            await this.doRefresh();
        } catch (error: any) {
            globalStore.set(this.actionerrorAtom, error?.message ?? String(error));
        } finally {
            globalStore.set(this.actionbusyAtom, null);
        }
    }

    async listBranches(): Promise<GitBranchListResult> {
        const repo = globalStore.get(this.repoAtom);
        if (!repo) return { branches: [] };
        return RpcApi.GitListBranchesCommand(TabRpcClient, repo.reporoot);
    }

    async checkoutBranch(branch: string): Promise<void> {
        const repo = globalStore.get(this.repoAtom);
        if (!repo) return;
        await RpcApi.GitCheckoutBranchCommand(TabRpcClient, { cwd: repo.reporoot, branch });
        await this.doRefresh();
    }

    selectPath(path: string | null): void {
        globalStore.set(this.selectedpathAtom, path);
    }

    selectEntry(entry: SourceControlFileEntry): void {
        this.selectPath(entry.path);
        const repo = globalStore.get(this.repoAtom);
        if (!repo) return;
        fireAndForget(() =>
            openGitDiffTab({
                repoRoot: repo.reporoot,
                path: entry.path,
                mode: entry.unstaged ? "-" : "+",
                originalPath: entry.originalpath,
            })
        );
    }

    dismissActionMessage(): void {
        globalStore.set(this.actionmessageAtom, null);
    }

    dismissActionError(): void {
        globalStore.set(this.actionerrorAtom, null);
    }
}
