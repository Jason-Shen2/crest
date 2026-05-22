// Copyright 2026, s-zx
// SPDX-License-Identifier: Apache-2.0
//
// ContextChipModel — frontend half of crest's port of warp's
// `context_chips` framework.  The Go side (`pkg/contextchip`) implements
// the stateless `Fetch(kind, cwd)` leaf operation; this model owns the
// stateful pieces warp puts in its `ChipState` + orchestrator:
//
//   - Fingerprint cache keyed by chip kind (warp ChipFingerprintInput[])
//   - Invalidate-on-command counter (warp `invalidate_on_commands`)
//   - Per-chip in-flight de-duplication
//   - Jotai atoms the input bar reads to render chips
//
// Lifecycle parallels NLDModel: one instance per outer terminal block,
// created in TerminalView, disposed on unmount.

import { globalStore } from "@/app/store/jotaiStore";
import { RpcApi } from "@/app/store/wshclientapi";
import { TabRpcClient } from "@/app/store/wshrpcutil";
import * as jotai from "jotai";

// Chip kinds — must match the string constants in pkg/contextchip/types.go.
export type ChipKind =
    | "shell_git_branch"
    | "git_diff_stats"
    | "github_pull_request"
    | "kubernetes_context";

// Inputs that feed each chip's fingerprint — must match
// pkg/contextchip/types.go.
type FingerprintInput =
    | "working_directory"
    | "git_branch"
    | "session_id"
    | "invalidating_command_count";

// Local replica of pkg/contextchip's RuntimePolicy — only the fields the
// orchestrator needs to know about at fetch time.  Built-ins below mirror
// pkg/contextchip/builtins.go 1:1 so the two stay in sync; if you add a
// chip on the Go side, add the matching entry here.
interface ChipPolicy {
    kind: ChipKind;
    fingerprintInputs: FingerprintInput[];
    invalidateOnCommands: string[];
    // Periodic-refresh interval in ms.  Matches warp's
    // RefreshConfig::Periodically { interval }.  Omit / 0 = on-demand only.
    refreshIntervalMs?: number;
}

const CHIP_POLICIES: ChipPolicy[] = [
    {
        kind: "shell_git_branch",
        fingerprintInputs: ["working_directory", "invalidating_command_count"],
        invalidateOnCommands: ["git", "gh", "gt"],
        // warp GIT_REFRESH_CONFIG = Periodically 30s (mod.rs:118-122).
        // crest deviation: warp pairs this with a `.git/HEAD` watcher
        // (current_prompt.rs:1485-1499) that bypasses the timer when
        // active — we don't have that yet, so the 30s tick + the
        // command-based invalidation are the only freshness drivers.
        refreshIntervalMs: 30_000,
    },
    {
        kind: "git_diff_stats",
        fingerprintInputs: ["working_directory", "git_branch", "invalidating_command_count"],
        invalidateOnCommands: ["git"],
        refreshIntervalMs: 30_000,
    },
    {
        kind: "github_pull_request",
        fingerprintInputs: ["working_directory", "git_branch", "invalidating_command_count"],
        // Matches warp invalidate_on_commands at context_chips/mod.rs:320.
        invalidateOnCommands: ["git", "gh", "gt"],
        refreshIntervalMs: 30_000,
    },
    {
        kind: "kubernetes_context",
        fingerprintInputs: ["invalidating_command_count"],
        // Matches warp's default for kubernetes_current_context — pure
        // OnDemandOnly refresh policy (builtins.rs:207-212 has no
        // RefreshConfig override, so it falls through to the
        // RefreshConfig::OnDemandOnly default at context_chip.rs:359-368).
        // `invalidate_on_commands` covers the in-process triggers
        // (`kubectl`, `kubectx`, `kubens`); out-of-band context flips in
        // other panes will go stale until the user runs one of those.
        invalidateOnCommands: ["kubectl", "kubectx", "kubens"],
    },
];

// Parsed value shapes the input bar consumes.  Each chip kind has its own
// post-processing: diff stats parses "+N -M" out of git's shortstat,
// github_pull_request parses the JSON, etc.  Kept here (not in cmdblock-input)
// so the input bar receives pre-digested numbers / structs.
export interface ChipValuesSnapshot {
    gitBranch?: string;
    gitDiffAdded?: number;
    gitDiffRemoved?: number;
    gitDiffFiles?: number;
    prNumber?: number;
    prTitle?: string;
    kubernetesContext?: string;
}

export class ContextChipModel {
    readonly outerBlockId: string;

    readonly valuesAtom = jotai.atom<ChipValuesSnapshot>({}) as jotai.PrimitiveAtom<ChipValuesSnapshot>;

    // Inputs that drive fingerprints.  Initialised on construction; the
    // parent calls setCwd / setGitBranch / onCommandCompleted whenever the
    // shell precmd reports new data.
    private cwd: string = "";
    private gitBranch: string = "";
    // Per-chip InvalidatingCommandCount counters.  Each chip's counter
    // only advances when a command matching *that chip's*
    // `invalidate_on_commands` list completes — matches warp's
    // ChipFingerprintInput::InvalidatingCommandCount, which is documented
    // as "a per-chip monotonic counter" (context_chip.rs:220-222).  A
    // single global counter would invalidate every chip on every git/gh/
    // kubectl run, defeating the cache.
    private invalidatingCmdCounts = new Map<ChipKind, number>();
    private disposed = false;

    // Last fingerprint we successfully fetched per chip — chip skips its
    // fetch when the recomputed fingerprint matches.  Mirrors warp's
    // ChipState.last_fetched_fingerprint.
    private fingerprints = new Map<ChipKind, string>();
    private inflight = new Map<ChipKind, AbortController>();
    // Periodic-refresh timers — one per chip whose policy has
    // refreshIntervalMs.  Cleared on dispose.
    private timers = new Map<ChipKind, ReturnType<typeof setInterval>>();

    constructor(outerBlockId: string) {
        this.outerBlockId = outerBlockId;
        // Arm periodic refreshers for chips that need clock-driven updates
        // (warp RefreshConfig::Periodically).  The handler forces a
        // re-fetch by ignoring the fingerprint check on this tick.
        for (const policy of CHIP_POLICIES) {
            if (!policy.refreshIntervalMs || policy.refreshIntervalMs <= 0) continue;
            const t = setInterval(() => {
                void this.refreshChip(policy, /*force=*/ true);
            }, policy.refreshIntervalMs);
            this.timers.set(policy.kind, t);
        }
    }

    setCwd(cwd: string): void {
        if (this.disposed) return;
        if (this.cwd === cwd) return;
        this.cwd = cwd;
        this.refreshAll();
    }

    setGitBranch(branch: string | undefined): void {
        if (this.disposed) return;
        const next = branch ?? "";
        if (this.gitBranch === next) return;
        this.gitBranch = next;
        this.refreshAll();
    }

    // The terminal model calls this whenever a command finishes.  Bumps
    // only the counters of chips whose invalidateOnCommands matches —
    // per warp's per-chip counter semantics, an unrelated chip's
    // fingerprint shouldn't change when, say, `kubectl` runs and only
    // the K8s chip cares.
    onCommandCompleted(cmd: string): void {
        if (this.disposed) return;
        const top = firstToken(cmd);
        if (!top) return;
        const affected: ChipPolicy[] = [];
        for (const policy of CHIP_POLICIES) {
            if (policy.invalidateOnCommands.includes(top)) {
                this.invalidatingCmdCounts.set(
                    policy.kind,
                    (this.invalidatingCmdCounts.get(policy.kind) ?? 0) + 1
                );
                affected.push(policy);
            }
        }
        for (const policy of affected) {
            void this.refreshChip(policy);
        }
    }

    dispose(): void {
        this.disposed = true;
        for (const ctrl of this.inflight.values()) {
            ctrl.abort();
        }
        this.inflight.clear();
        for (const t of this.timers.values()) {
            clearInterval(t);
        }
        this.timers.clear();
    }

    private fingerprintOf(policy: ChipPolicy): string {
        const parts: string[] = [];
        for (const input of policy.fingerprintInputs) {
            switch (input) {
                case "working_directory":
                    parts.push(this.cwd);
                    break;
                case "git_branch":
                    parts.push(this.gitBranch);
                    break;
                case "session_id":
                    // Single local session for now — placeholder until
                    // multi-host sessions land.
                    parts.push("local");
                    break;
                case "invalidating_command_count":
                    parts.push(String(this.invalidatingCmdCounts.get(policy.kind) ?? 0));
                    break;
            }
        }
        return parts.join("|");
    }

    private refreshAll(): void {
        for (const policy of CHIP_POLICIES) {
            void this.refreshChip(policy);
        }
    }

    private async refreshChip(policy: ChipPolicy, force = false): Promise<void> {
        if (this.disposed) return;
        const fp = this.fingerprintOf(policy);
        if (!force && this.fingerprints.get(policy.kind) === fp) return;
        // Cancel any in-flight request for this chip — its result would
        // belong to a stale fingerprint.
        this.inflight.get(policy.kind)?.abort();
        const ac = new AbortController();
        this.inflight.set(policy.kind, ac);

        try {
            const resp = await RpcApi.FetchContextChipCommand(TabRpcClient, {
                kind: policy.kind,
                cwd: this.cwd,
            });
            if (ac.signal.aborted || this.disposed) return;
            this.fingerprints.set(policy.kind, fp);
            this.applyChipValue(policy.kind, resp.value, resp.failed === true);
        } catch (e) {
            if (ac.signal.aborted || this.disposed) return;
            // RPC error → record the fingerprint anyway so we don't hot-loop
            // on a broken chip; mark failed so the UI can hide it.
            this.fingerprints.set(policy.kind, fp);
            this.applyChipValue(policy.kind, "", true);
        } finally {
            if (this.inflight.get(policy.kind) === ac) {
                this.inflight.delete(policy.kind);
            }
        }
    }

    // Translate raw shell output into the structured ChipValuesSnapshot
    // fields the input bar's chips consume.  Failures and empty values
    // clear the corresponding fields so chips disappear when their data
    // is no longer applicable.
    private applyChipValue(kind: ChipKind, raw: string, failed: boolean): void {
        const prev = globalStore.get(this.valuesAtom);
        const next: ChipValuesSnapshot = { ...prev };
        const trimmed = raw.trim();
        switch (kind) {
            case "shell_git_branch":
                next.gitBranch = failed || !trimmed ? undefined : trimmed;
                break;
            case "git_diff_stats": {
                if (failed || !trimmed) {
                    next.gitDiffAdded = undefined;
                    next.gitDiffRemoved = undefined;
                    next.gitDiffFiles = undefined;
                } else {
                    // "3 files changed, 12 insertions(+), 3 deletions(-)"
                    const files = /([0-9]+) files? changed/.exec(trimmed);
                    const added = /([0-9]+) insertion/.exec(trimmed);
                    const removed = /([0-9]+) deletion/.exec(trimmed);
                    next.gitDiffFiles = files ? parseInt(files[1], 10) : 0;
                    next.gitDiffAdded = added ? parseInt(added[1], 10) : 0;
                    next.gitDiffRemoved = removed ? parseInt(removed[1], 10) : 0;
                }
                break;
            }
            case "github_pull_request": {
                if (failed || !trimmed) {
                    next.prNumber = undefined;
                    next.prTitle = undefined;
                } else {
                    try {
                        const parsed = JSON.parse(trimmed) as { number?: number; title?: string };
                        next.prNumber = parsed.number;
                        next.prTitle = parsed.title;
                    } catch {
                        next.prNumber = undefined;
                        next.prTitle = undefined;
                    }
                }
                break;
            }
            case "kubernetes_context":
                next.kubernetesContext = failed || !trimmed ? undefined : trimmed;
                break;
        }
        globalStore.set(this.valuesAtom, next);
    }
}

// Top-level binary token of a command line, used to match against each
// chip's `invalidate_on_commands` list.  Strips a leading sudo so
// `sudo git commit -m …` invalidates the git chips.
function firstToken(cmd: string): string {
    const trimmed = cmd.replace(/^\s+/, "");
    const space = trimmed.search(/\s/);
    const head = space < 0 ? trimmed : trimmed.slice(0, space);
    if (head === "sudo") {
        const rest = trimmed.slice(space).replace(/^\s+/, "");
        const restSpace = rest.search(/\s/);
        return restSpace < 0 ? rest : rest.slice(0, restSpace);
    }
    return head;
}
