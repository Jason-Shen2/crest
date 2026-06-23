// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0
//
// CmdBlockInput — bottom-anchored prompt aligned to warp's actual
// rendered layout.
//
// Layout reference: warp agent view screenshot.  Visible structure
// (top → bottom):
//
//   ┌──────────────────────────────────────────────────────────┐
//   │ ↵ submit  ⇧↵ newline  /commands  ⌘F find    [topRight]   │  ← help row
//   ├──────────────────────────────────────────────────────────┤
//   │                                                          │
//   │ <editor — placeholder or typed text>                     │
//   │                                                          │
//   ├──────────────────────────────────────────────────────────┤
//   │ [📁 cwd]  [Term|Agt|Auto]   [/] [@] [+]   [Default ⌄]    │  ← button bar
//   └──────────────────────────────────────────────────────────┘
//
// Source citations:
//   - warp app/src/terminal/input/universal.rs:36       composition order
//   - warp universal_developer_input.rs:790-885         button bar
//   - warp prompt_render_helper.rs:669                  prompt chip
//   - warp action_button.rs:1313-1340                   UDIButton sizing
//   - warp context_chips/spacing.rs                     chip padding constants
//   - warp agent.rs:43-67                               cloud-mode constants

import { Tooltip } from "@/app/element/tooltip";
import { UIcon } from "@/app/element/ui-icon";
import { isMacOS } from "@/util/platformutil";
import { cn } from "@/util/util";
import { CornerDownLeft } from "lucide-react";
import { memo, type RefObject, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { formatPromptCwd } from "./cmdblock-status";
import { ModelPickerInline, ModelPickerPopover } from "./model-picker-popover";
import { ProviderEntry } from "@/app/store/ai-catalog";
import { AgentSelection, AIUserConfig } from "@/app/store/ai-types";
import { AIUserConfigStatus } from "@/app/store/ai-user-config";

// "auto" maps to warp's InputToggleMode::AutoDetection
// (universal_developer_input.rs:440).  Visual-only for crest until we
// wire an actual content classifier.
export type InputMode = "terminal" | "agent" | "auto";

export interface CmdBlockInputProps {
    cwd?: string;
    home?: string;
    branch?: string;
    venv?: string;
    nodeVersion?: string;
    // SSH session context — non-empty `sshHost` makes the SshChip appear.
    sshHost?: string;
    sshUser?: string;
    // Git diff stats for the working tree.  Both 0 / undefined → chip hides.
    gitAdded?: number;
    gitRemoved?: number;
    // GitHub pull request linked to this branch.  `prNumber` lights the chip.
    prNumber?: number;
    prTitle?: string;
    onPrClick?: (e: React.MouseEvent<HTMLButtonElement>) => void;
    // Agent plan progress (completed / total).  total > 0 → chip appears.
    agentPlanCompleted?: number;
    agentPlanTotal?: number;
    onAgentPlanClick?: (e: React.MouseEvent<HTMLButtonElement>) => void;
    // Context window usage in tokens.  Both set → chip appears.
    usedTokens?: number;
    maxTokens?: number;
    onContextWindowClick?: (e: React.MouseEvent<HTMLButtonElement>) => void;
    // Active kubectl context name (warp KubernetesContext chip).
    kubernetesContext?: string;
    // Voice input — threaded only when the feature is wired.
    onVoiceInput?: () => void;
    voiceRecording?: boolean;
    mode: InputMode;
    // Pass the current buffer text alongside the new mode so the parent
    // can fire a one-shot NLD trigger when the user toggles Auto on with
    // existing content (otherwise the stale effective mode would persist
    // until the next keystroke).
    onModeChange: (next: InputMode, currentText?: string) => void;
    onSubmit: (text: string, mode: InputMode) => boolean | void;
    submitting?: boolean;
    disabled?: boolean;
    // Label shown on the model chip.  Computed by the parent from
    // resolveAIConfig(selection, userConfig, catalog) so the chip reads
    // the resolved displayName ("GPT-5 high" rather than the raw id).
    modelDisplayLabel?: string;
    // Picker data — when `onSelectionChange` is provided the chip
    // opens a popover backed by these.  See docs/ai-config-architecture.md §9.
    catalog?: ProviderEntry[];
    userConfig?: AIUserConfig | null;
    userConfigStatus?: AIUserConfigStatus;
    userConfigError?: string;
    selection?: AgentSelection | null;
    onSelectionChange?: (next: AgentSelection) => void;
    onOpenAIConfigFile?: () => void;
    openModelPickerRequest?: number;
    placeholder?: string;
    // Grid font size — only used by Editor.  Chrome (chips, buttons,
    // help row) uses fixed UI sizes for legibility.  Reference: warp's
    // ui_font_family / monospace_ui_scalar split
    // (universal_developer_input.rs:924).
    fontSize?: number;
    focusRequest?: number;
    banner?: React.ReactNode;
    promptAlert?: React.ReactNode;
    onFilesDropped?: (files: File[]) => void;
    onPromptContextMenu?: (e: React.MouseEvent) => void;
    hideHelpRow?: boolean;
    // Optional content rendered at the far right of the top help row.
    // Warp uses this for "1000 free cloud agent credits" pill
    // (zero_state_block.rs:1232).  crest leaves it null by default.
    topRightSlot?: React.ReactNode;
    // External command history (oldest → newest).  When provided, used
    // for ↑/↓ navigation in place of in-component local state — lets the
    // model survive component remounts and share history across tabs.
    history?: string[];
    // Fires on every editor keystroke with the latest buffer text.  The
    // NLD model (parent-owned) consumes this to drive autodetection.
    onTextChange?: (text: string) => void;
    restoredTextRequest?: { text: string; requestId: number };
    // When `mode === "auto"`, this is the classifier's current verdict
    // and the value that will be used on submit.  Defaults to "terminal"
    // when omitted so the component degrades gracefully without NLD.
    effectiveMode?: "terminal" | "agent";
}

// =========================================================================
// Visual constants — all UI chrome sizes are decoupled from grid fontSize.
// Matches the spirit of warp's `monospace_ui_scalar`
// (universal_developer_input.rs:924) which derives UI sizes from a base
// of 10 px scaled by a UI-specific scalar.  We hard-code crest's values:
// =========================================================================
const UI_FONT_PX = 15;       // chrome text (chips, segmented labels)
const UI_HELP_FONT_PX = 13;  // top help row hints (slightly smaller)
const UI_BUTTON_PX = 30;     // chip/button height — comfortable click target
const UI_ICON_PX = 17;       // icon size inside buttons
const UI_GAP_PX = 6;         // gap between adjacent chrome elements
const UI_CHIP_RADIUS_PX = 6; // chip corner radius (warp uses ~6 for chips)

export function shouldFocusCmdBlockEditor(activeElement: Element | null, container: HTMLElement | null): boolean {
    if (!activeElement) return true;
    if (container?.contains(activeElement)) return true;
    const tagName = activeElement.tagName.toLowerCase();
    if (tagName === "input" || tagName === "textarea" || tagName === "select") return false;
    if ((activeElement as HTMLElement).isContentEditable) return false;
    return true;
}

export type EditorEnterAction = "submit" | "submit-override";

export interface EditorEnterKeyLike {
    key: string;
    shiftKey?: boolean;
    altKey?: boolean;
    metaKey?: boolean;
    ctrlKey?: boolean;
}

export function resolveEditorEnterAction(e: EditorEnterKeyLike): EditorEnterAction | null {
    if (e.key !== "Enter") return null;
    if (e.shiftKey || e.altKey) return null;
    if (e.metaKey || e.ctrlKey) return "submit-override";
    return "submit";
}

export function resolveShortcutOverrideMode(current: "terminal" | "agent"): "terminal" | "agent" {
    return current === "terminal" ? "agent" : "terminal";
}

export function resolveSubmitMode(mode: InputMode, effectiveMode?: "terminal" | "agent"): "terminal" | "agent" {
    if (mode === "auto") return effectiveMode ?? "agent";
    if (mode === "terminal") return "terminal";
    return "agent";
}

export function shouldShowAgentShellShortcutHint(mode: InputMode, text: string): boolean {
    if (mode !== "agent") return false;
    return text.trim().length > 0;
}

export function getAgentShellShortcutModifierKey(isMac: boolean): string {
    return isMac ? "⌘" : "⌃";
}

export function shouldClearInputAfterSubmit(result: boolean | void): boolean {
    return result !== false;
}

// =========================================================================
// HelpRow — kbd hint strip at TOP of the input.  Warp screenshot shows
// `? for help  / for commands  ⌘Y open conversation  ⇧⌘+ for code review`
// flushed to the left with optional credits chip on the right.  We mirror
// the left-aligned kbd hints; the right slot is parametric.
// =========================================================================
interface HelpRowProps {
    rightSlot?: React.ReactNode;
}

const HelpRow = memo(({ rightSlot }: HelpRowProps) => (
    <div
        className="flex items-center gap-x-4 gap-y-1 font-sans leading-none text-secondary/70"
        style={{ fontSize: `${UI_HELP_FONT_PX}px` }}
    >
        <Hint keys={["!"]} label="shell" />
        <Hint keys={["/"]} label="commands" />
        {rightSlot && <div className="ml-auto flex shrink-0 items-center">{rightSlot}</div>}
    </div>
));
HelpRow.displayName = "HelpRow";

// =========================================================================
// ShellPrefixHintRow — replaces HelpRow when the buffer starts with `!`.
// Visually parallels AutodetectHintRow so the user gets the same kind of
// "you're about to run X, not Y" feedback that auto-detect mode provides.
// =========================================================================
interface ShellPrefixHintRowProps {
    rightSlot?: React.ReactNode;
}

// =========================================================================
// AgentHintRow — shown when the buffer has typed content in the default
// agent mode (no `!` prefix, mode !== "auto").  Mirrors ShellPrefixHintRow
// so the user always sees which side of the rail their input will run on.
// =========================================================================
interface AgentHintRowProps {
    rightSlot?: React.ReactNode;
    showShellShortcutHint?: boolean;
}

const AgentHintRow = memo(({ rightSlot, showShellShortcutHint }: AgentHintRowProps) => (
    <div
        className="flex items-center gap-x-2 font-sans leading-none text-secondary/70"
        style={{ fontSize: `${UI_HELP_FONT_PX}px` }}
    >
        <span className="inline-flex items-center gap-1.5 text-[var(--ansi-yellow)]">
            <UIcon name="stars-01" size={UI_HELP_FONT_PX} />
            <span>agent mode</span>
        </span>
        {showShellShortcutHint && (
            <ShortcutOverrideHint targetMode="terminal" />
        )}
        {rightSlot && <div className="ml-auto flex shrink-0 items-center">{rightSlot}</div>}
    </div>
));
AgentHintRow.displayName = "AgentHintRow";

interface ShortcutOverrideHintProps {
    targetMode: "terminal" | "agent";
}

const ShortcutOverrideHint = memo(({ targetMode }: ShortcutOverrideHintProps) => (
    <span className="ml-2 inline-flex items-center gap-1.5 text-secondary/65">
        <span className="inline-flex items-center gap-[3px]">
            <Kbd char={getAgentShellShortcutModifierKey(isMacOS())} />
            <KbdIcon>
                <CornerDownLeft size={UI_HELP_FONT_PX + 1} strokeWidth={2} />
            </KbdIcon>
        </span>
        <span>overwrite to {targetMode === "terminal" ? "shell command" : "agent"}</span>
    </span>
));
ShortcutOverrideHint.displayName = "ShortcutOverrideHint";

const ShellPrefixHintRow = memo(({ rightSlot }: ShellPrefixHintRowProps) => (
    <div
        className="flex items-center gap-x-2 font-sans leading-none text-secondary/70"
        style={{ fontSize: `${UI_HELP_FONT_PX}px` }}
    >
        <span className="inline-flex items-center gap-1.5 text-[var(--ansi-blue)]">
            <UIcon name="terminal" size={UI_HELP_FONT_PX} />
            <span>shell mode</span>
        </span>
        {rightSlot && <div className="ml-auto flex shrink-0 items-center">{rightSlot}</div>}
    </div>
));
ShellPrefixHintRow.displayName = "ShellPrefixHintRow";

// Each modifier / key renders as its own small chip; combos like ⇧↵ are
// two adjacent chips with a tiny gap (matches warp's help-row style).
// Single-char chips use a square box; multi-char (e.g. "esc") expand
// horizontally with a comfortable pad so the text doesn't crowd the edges.
const Kbd = memo(({ char }: { char: string }) => {
    const multi = char.length > 1;
    return (
        <kbd
            className="inline-flex items-center justify-center rounded-[5px] bg-fg-overlay-2/70 font-sans text-secondary/85"
            style={{
                height: `${UI_HELP_FONT_PX + 7}px`,
                minWidth: `${UI_HELP_FONT_PX + 7}px`,
                padding: multi ? "0 6px" : 0,
                fontSize: `${UI_HELP_FONT_PX}px`,
                lineHeight: 1,
            }}
        >
            {char}
        </kbd>
    );
});
Kbd.displayName = "Kbd";

const KbdIcon = memo(({ children }: { children: React.ReactNode }) => (
    <kbd
        className="inline-flex items-center justify-center rounded-[5px] bg-fg-overlay-2/70 font-sans text-secondary/85"
        style={{
            height: `${UI_HELP_FONT_PX + 7}px`,
            minWidth: `${UI_HELP_FONT_PX + 7}px`,
            padding: 0,
            lineHeight: 1,
        }}
    >
        {children}
    </kbd>
));
KbdIcon.displayName = "KbdIcon";

const Hint = memo(({ keys, label }: { keys: string[]; label: string }) => (
    <span className="inline-flex items-center gap-1.5">
        <span className="inline-flex items-center gap-[3px]">
            {keys.map((k, i) => (
                <Kbd key={`${k}-${i}`} char={k} />
            ))}
        </span>
        <span>for {label}</span>
    </span>
));
Hint.displayName = "Hint";

// =========================================================================
// TooltipBody — content layout for a chip / button tooltip.  Mirrors warp's
// `Tooltip` component (warp/crates/ui_components/src/tooltip.rs:35-83):
// label text on the left, optional keystroke chip on the right with 10px
// gap.  Font is one step smaller than the UI base (warp's
// UI_FONT_SIZE_ADJUSTMENT = -2).  Pure content — the outer
// <Tooltip content=...> shell handles positioning + fade + portal.
// =========================================================================
interface TooltipBodyProps {
    label: string;
    keys?: string[];
}

const TooltipBody = memo(({ label, keys }: TooltipBodyProps) => (
    <span className="inline-flex items-center gap-2.5 whitespace-nowrap leading-none">
        <span className="font-sans text-foreground/95" style={{ fontSize: `${UI_HELP_FONT_PX}px` }}>
            {label}
        </span>
        {keys && keys.length > 0 && (
            <span className="inline-flex items-center gap-[3px] text-secondary/70">
                {keys.map((k, i) => (
                    <Kbd key={`${k}-${i}`} char={k} />
                ))}
            </span>
        )}
    </span>
));
TooltipBody.displayName = "TooltipBody";

// withTooltip — shorthand around <Tooltip> to render a warp-style body and
// preserve the chip's flex alignment.  `display: contents` on the wrapper
// keeps the chip a direct flex item of its parent row (the chip row uses
// `gap`, so we don't want an extra inline-block to disturb spacing).
interface WithTooltipProps {
    label?: string;
    keys?: string[];
    children: React.ReactNode;
}

const WithTooltip = memo(({ label, keys, children }: WithTooltipProps) => {
    if (!label) return <>{children}</>;
    return (
        <Tooltip
            content={<TooltipBody label={label} keys={keys} />}
            divClassName="inline-flex shrink-0"
        >
            {children}
        </Tooltip>
    );
});
WithTooltip.displayName = "WithTooltip";

// =========================================================================
// AutodetectHintRow — replaces HelpRow when auto-detect is active and the
// classifier has a verdict for the current input.  Visual reference:
// warp's "autodetected shell command, ⌘ I to override" banner.  Colors
// mirror the SegmentedControl: terminal → blue, agent → yellow.
// =========================================================================
interface AutodetectHintRowProps {
    effectiveMode: "terminal" | "agent";
    rightSlot?: React.ReactNode;
    showShortcutOverrideHint?: boolean;
}

const AutodetectHintRow = memo(({ effectiveMode, rightSlot, showShortcutOverrideHint }: AutodetectHintRowProps) => {
    const label = effectiveMode === "terminal" ? "shell command" : "natural language";
    const accent =
        effectiveMode === "terminal" ? "text-[var(--ansi-blue)]" : "text-[var(--ansi-yellow)]";
    const shortcutTarget = resolveShortcutOverrideMode(effectiveMode);
    return (
        <div
            className="flex items-center gap-x-2 font-sans leading-none text-secondary/70"
            style={{ fontSize: `${UI_HELP_FONT_PX}px` }}
        >
            <span className={cn("inline-flex items-center gap-1.5", accent)}>
                <UIcon name="lightning-02" size={UI_HELP_FONT_PX} />
                <span>autodetected {label}</span>
            </span>
            {showShortcutOverrideHint && <ShortcutOverrideHint targetMode={shortcutTarget} />}
            <span className="text-secondary/45">— click Auto to override</span>
            {rightSlot && <div className="ml-auto flex shrink-0 items-center">{rightSlot}</div>}
        </div>
    );
});
AutodetectHintRow.displayName = "AutodetectHintRow";

// =========================================================================
// ContextChip — shared pill shell used by every footer chip.  Visual
// reference: warp context_chips/spacing.rs (UDI_CHIP_HORIZONTAL_PADDING=4,
// UDI_CHIP_VERTICAL_PADDING=2, UDI_CHIP_ICON_GAP=4) + the chip pill
// rendered by display_chips in agent_input_footer/.  Renders as a button
// when interactive (onClick / onContextMenu), otherwise a span.
// =========================================================================
interface ContextChipProps {
    icon: string;
    children?: React.ReactNode;
    title?: string;
    tooltipKeys?: string[];
    onClick?: (e: React.MouseEvent<HTMLButtonElement>) => void;
    onContextMenu?: (e: React.MouseEvent) => void;
    className?: string;
}

const ContextChip = memo(
    ({ icon, children, title, tooltipKeys, onClick, onContextMenu, className }: ContextChipProps) => {
        const interactive = onClick != null || onContextMenu != null;
        const inner = (
            <>
                <UIcon
                    name={icon}
                    size={UI_ICON_PX - 1}
                    className="shrink-0 opacity-70"
                />
                {children}
            </>
        );
        // Higher-contrast palette than fg-overlay-{1,2,3} so the chips
        // don't visually merge with the input bar's own border / bg.
        // border 30% white + bg 10% white reliably reads on dark themes
        // even when the input bar is unfocused (bg-transparent).
        const sharedClass = cn(
            "inline-flex shrink-0 items-center gap-1.5 rounded-[6px] border border-white/25 bg-white/[0.08] px-2 font-sans text-foreground/85 transition-colors",
            interactive && "cursor-pointer hover:bg-white/[0.14] hover:text-foreground",
            className
        );
        const sharedStyle = { height: `${UI_BUTTON_PX}px`, fontSize: `${UI_FONT_PX}px` } as const;
        const chipEl = interactive ? (
            <button
                type="button"
                onClick={onClick}
                onContextMenu={onContextMenu}
                aria-label={title}
                className={sharedClass}
                style={sharedStyle}
            >
                {inner}
            </button>
        ) : (
            <span
                onContextMenu={onContextMenu}
                className={sharedClass}
                style={sharedStyle}
            >
                {inner}
            </span>
        );
        return (
            <WithTooltip label={title} keys={tooltipKeys}>
                {chipEl}
            </WithTooltip>
        );
    }
);
ContextChip.displayName = "ContextChip";

// =========================================================================
// Per-kind chips.  Each takes optional data and returns null when the
// data isn't available — matches warp's `should_render(app)` predicate
// (display_chip.rs).  Layout order mirrors warp's `default_left()` /
// `default_right()` in agent_input_footer/toolbar_item.rs:182-214.
// =========================================================================

// SshChip — warp ContextChipKind::Ssh.  Shown when the active session is
// running on a remote host.  Format: `user@host` (or `host` if user empty).
interface SshChipProps {
    user?: string;
    host?: string;
    onClick?: (e: React.MouseEvent<HTMLButtonElement>) => void;
}

const SshChip = memo(({ user, host, onClick }: SshChipProps) => {
    if (!host) return null;
    const label = user ? `${user}@${host}` : host;
    return (
        <ContextChip icon="compass-3" title={`SSH session: ${label}`} onClick={onClick}>
            <span className="max-w-[160px] truncate">{label}</span>
        </ContextChip>
    );
});
SshChip.displayName = "SshChip";

// CwdChip — warp ContextChipKind::WorkingDirectory.  Just the working
// directory (no branch — that lives in GitBranchChip).  An env-marker
// (venv name / node version) renders ahead of the path when present.
interface CwdChipProps {
    cwd?: string;
    home?: string;
    venv?: string;
    nodeVersion?: string;
    onContextMenu?: (e: React.MouseEvent) => void;
}

const CwdChip = memo(({ cwd, home, venv, nodeVersion, onContextMenu }: CwdChipProps) => {
    const prettyCwd = formatPromptCwd(cwd, home ?? "");
    if (!prettyCwd && !venv && !nodeVersion) return null;
    const env = venv ?? nodeVersion;
    return (
        <ContextChip icon="notebook" title={cwd} onContextMenu={onContextMenu}>
            {env && <span className="shrink-0 opacity-70">{env}</span>}
            {prettyCwd && <span className="max-w-[260px] truncate">{prettyCwd}</span>}
        </ContextChip>
    );
});
CwdChip.displayName = "CwdChip";

// GitBranchChip — warp ContextChipKind::ShellGitBranch.
interface GitBranchChipProps {
    branch?: string;
}

const GitBranchChip = memo(({ branch }: GitBranchChipProps) => {
    if (!branch) return null;
    return (
        <ContextChip icon="git-branch-02" title={`Git branch: ${branch}`}>
            <span className="max-w-[140px] truncate">{branch}</span>
        </ContextChip>
    );
});
GitBranchChip.displayName = "GitBranchChip";

// GitDiffStatsChip — warp ContextChipKind::GitDiffStats.  Shows working
// tree changes as `+added -removed`, colored to match warp's `ansi_green`
// / `ansi_red` accents.  Renders only when one of the counts is non-zero.
interface GitDiffStatsChipProps {
    added?: number;
    removed?: number;
}

const GitDiffStatsChip = memo(({ added = 0, removed = 0 }: GitDiffStatsChipProps) => {
    if (added <= 0 && removed <= 0) return null;
    return (
        <ContextChip icon="file-code-02" title="Working tree changes (added / removed lines)">
            <span className="inline-flex items-center gap-1.5 font-mono">
                {added > 0 && (
                    <span className="text-[var(--ansi-green)]">+{added}</span>
                )}
                {removed > 0 && (
                    <span className="text-[var(--ansi-red)]">-{removed}</span>
                )}
            </span>
        </ContextChip>
    );
});
GitDiffStatsChip.displayName = "GitDiffStatsChip";

// GithubPrChip — warp ContextChipKind::GithubPullRequest.  Shows the PR
// number with the title as tooltip; click navigates (future hook).
interface GithubPrChipProps {
    number?: number;
    title?: string;
    onClick?: (e: React.MouseEvent<HTMLButtonElement>) => void;
}

const GithubPrChip = memo(({ number, title, onClick }: GithubPrChipProps) => {
    if (!number) return null;
    return (
        <ContextChip
            icon="share-01"
            title={title ? `PR #${number}: ${title}` : `PR #${number}`}
            onClick={onClick}
        >
            <span className="font-mono">#{number}</span>
        </ContextChip>
    );
});
GithubPrChip.displayName = "GithubPrChip";

// KubernetesContextChip — warp `kubernetes_current_context()` shell
// command generator (builtins.rs:207-212).  Shows the active kubectl
// context name; hides when kubectl isn't installed or no context is set.
interface KubernetesContextChipProps {
    context?: string;
    onClick?: (e: React.MouseEvent<HTMLButtonElement>) => void;
}

const KubernetesContextChip = memo(({ context, onClick }: KubernetesContextChipProps) => {
    if (!context) return null;
    return (
        <ContextChip icon="workflow" title={`Kubernetes context: ${context}`} onClick={onClick}>
            <span className="max-w-[160px] truncate">{context}</span>
        </ContextChip>
    );
});
KubernetesContextChip.displayName = "KubernetesContextChip";

// AgentPlanChip — warp ContextChipKind::AgentPlanAndTodoList.  Shows the
// progress of an agent's plan as `done / total` with a small fill bar.
interface AgentPlanChipProps {
    completed?: number;
    total?: number;
    onClick?: (e: React.MouseEvent<HTMLButtonElement>) => void;
}

const AgentPlanChip = memo(({ completed, total, onClick }: AgentPlanChipProps) => {
    if (!total || total <= 0) return null;
    const done = Math.max(0, Math.min(total, completed ?? 0));
    return (
        <ContextChip
            icon="check-circle-broken"
            title={`Agent plan: ${done} / ${total} steps complete`}
            onClick={onClick}
        >
            <span className="font-mono">
                {done}/{total}
            </span>
        </ContextChip>
    );
});
AgentPlanChip.displayName = "AgentPlanChip";

// ContextWindowUsageChip — warp AgentToolbarItemKind::ContextWindowUsage.
// Shows current vs max token usage on the active conversation.  Format
// matches warp's compact `8k/200k` layout (kilo-tokens for the eye).
interface ContextWindowUsageChipProps {
    usedTokens?: number;
    maxTokens?: number;
    onClick?: (e: React.MouseEvent<HTMLButtonElement>) => void;
}

function formatTokens(n: number): string {
    if (n >= 1000) {
        const k = n / 1000;
        return k >= 10 ? `${Math.round(k)}k` : `${k.toFixed(1)}k`;
    }
    return `${n}`;
}

const ContextWindowUsageChip = memo(
    ({ usedTokens, maxTokens, onClick }: ContextWindowUsageChipProps) => {
        if (!usedTokens || !maxTokens || maxTokens <= 0) return null;
        const ratio = Math.min(1, usedTokens / maxTokens);
        const accent =
            ratio < 0.6
                ? "text-secondary/85"
                : ratio < 0.85
                  ? "text-[var(--ansi-yellow)]"
                  : "text-[var(--ansi-red)]";
        return (
            <ContextChip
                icon="clock-loader"
                title={`Context: ${usedTokens.toLocaleString()} / ${maxTokens.toLocaleString()} tokens (${Math.round(ratio * 100)}%)`}
                onClick={onClick}
            >
                <span className={cn("font-mono", accent)}>
                    {formatTokens(usedTokens)}/{formatTokens(maxTokens)}
                </span>
            </ContextChip>
        );
    }
);
ContextWindowUsageChip.displayName = "ContextWindowUsageChip";

// VoiceInputBtn — warp AgentToolbarItemKind::VoiceInput.  Stubbed: only
// renders when the parent threads `onVoiceInput` (= the feature is wired).
interface VoiceInputBtnProps {
    onVoiceInput?: () => void;
    recording?: boolean;
}

const VoiceInputBtn = memo(({ onVoiceInput, recording }: VoiceInputBtnProps) => {
    if (onVoiceInput == null) return null;
    return (
        <IconButton
            icon="lightning-02"
            title={recording ? "Stop voice input" : "Voice input"}
            onClick={onVoiceInput}
            active={recording}
        />
    );
});
VoiceInputBtn.displayName = "VoiceInputBtn";

// =========================================================================
// AutoToggle — single binary toggle replacing the Terminal | Agent | Auto
// SegmentedControl.  Auto is an opt-in that lets NLD reroute ↵ based on
// the detected input type; Cmd/Ctrl+↵ is the one-shot shell override.
// Visual: pill button, fills with the NLD accent (yellow) when on, dim
// outline when off.
// =========================================================================
interface AutoToggleProps {
    on: boolean;
    onToggle: () => void;
}

const AutoToggle = memo(({ on, onToggle }: AutoToggleProps) => {
    // Tooltip wording matches warp agent_input_footer/mod.rs:130-131:
    //   ENABLE_NLD_TOOLTIP  = "Enable terminal command autodetection"
    //   DISABLE_NLD_TOOLTIP = "Disable terminal command autodetection"
    const label = on ? "Disable terminal command autodetection" : "Enable terminal command autodetection";
    return (
        <WithTooltip label={label}>
            <button
                type="button"
                onClick={onToggle}
                style={{ width: `${UI_BUTTON_PX}px`, height: `${UI_BUTTON_PX}px` }}
                className={cn(
                    "flex shrink-0 cursor-pointer items-center justify-center rounded-[6px] border transition-colors",
                    on
                        ? "border-[var(--ansi-yellow)]/60 bg-[var(--ansi-yellow)]/15 text-[var(--ansi-yellow)]"
                        : "border-white/25 bg-white/[0.08] text-foreground/85 hover:bg-white/[0.14] hover:text-foreground"
                )}
                aria-pressed={on}
                aria-label={label}
            >
                <UIcon name="lightning-02" size={UI_ICON_PX} />
            </button>
        </WithTooltip>
    );
});
AutoToggle.displayName = "AutoToggle";

// =========================================================================
// IconButton — plain icon button (slash / mic / @ / +).  No border, hover
// fill from fg_overlay_2.  Visual reference: warp
// universal_developer_input.rs:338-394 ActionButton with
// PromptIconButtonTheme + ButtonSize::UDIButton.
// =========================================================================
interface IconButtonProps {
    icon: string;
    title: string;
    onClick: (e: React.MouseEvent<HTMLButtonElement>) => void;
    disabled?: boolean;
    active?: boolean;
}

const IconButton = memo(({ icon, title, onClick, disabled, active }: IconButtonProps) => (
    <WithTooltip label={title}>
        <button
            type="button"
            onClick={onClick}
            disabled={disabled}
            aria-label={title}
            style={{ width: `${UI_BUTTON_PX}px`, height: `${UI_BUTTON_PX}px` }}
            className={cn(
                "flex shrink-0 cursor-pointer items-center justify-center rounded-[6px] transition-colors",
                "text-secondary/70 hover:bg-fg-overlay-2 hover:text-foreground",
                active && "bg-fg-overlay-2 text-foreground",
                disabled && "cursor-default opacity-40 hover:bg-transparent hover:text-secondary/70"
            )}
        >
            <UIcon name={icon} size={UI_ICON_PX} />
        </button>
    </WithTooltip>
));
IconButton.displayName = "IconButton";


// =========================================================================
// ModelChip — pill on the right showing current model.  Warp screenshot:
// rounded border, icon + "Default | auto (genius)" + chevron.  Visual
// reference: warp universal_developer_input.rs:396-422 ProfileModelSelector.
// =========================================================================
interface ModelChipProps {
    label: string;
    onClick?: (e: React.MouseEvent<HTMLButtonElement>) => void;
    buttonRef?: React.RefObject<HTMLButtonElement>;
    expanded?: boolean;
}

const ModelChip = memo(({ label, onClick, buttonRef, expanded }: ModelChipProps) => (
    <WithTooltip label="Pick model">
        <button
            type="button"
            ref={buttonRef}
            onClick={onClick}
            style={{ height: `${UI_BUTTON_PX}px`, fontSize: `${UI_FONT_PX}px` }}
            className={cn(
                "inline-flex shrink-0 cursor-pointer items-center gap-1.5 rounded-[6px] border border-white/25 px-2 font-sans text-foreground/85 transition-colors hover:bg-white/[0.14] hover:text-foreground",
                expanded ? "bg-white/[0.18] text-foreground" : "bg-white/[0.08]"
            )}
            aria-label="Pick model"
            aria-haspopup="listbox"
            aria-expanded={expanded}
        >
            <UIcon name="stars-01" size={UI_ICON_PX - 1} />
            <span className="max-w-[180px] truncate">{label}</span>
            <UIcon name="chevron-down" size={UI_ICON_PX - 4} className="text-secondary" />
        </button>
    </WithTooltip>
));
ModelChip.displayName = "ModelChip";

// =========================================================================
// Editor — contentEditable.  Supports ↑/↓ history navigation when caret
// is at start of buffer (warp inline_history equivalent — warp's
// `inline_history` menu under input/inline_history/ is wired through the
// editor's key handler).
// =========================================================================
interface EditorProps {
    value: string;
    onChange: (next: string) => void;
    onSubmit: () => void;
    onSubmitOverride: () => void;
    placeholder?: string;
    disabled?: boolean;
    fontSize: number;
    focusRequest: number;
    focusContainerRef: RefObject<HTMLElement>;
    onSlashCommandHint?: (open: boolean) => void;
    onAtCommandHint?: (open: boolean) => void;
    onHistoryPrev?: () => boolean;
    onHistoryNext?: () => boolean;
    onCancelMenus?: () => void;
    // When non-null, an inline menu is open; ↑/↓ moves selection (returns
    // true if consumed) and ↵ commits the selected row instead of submitting.
    menuOpen?: boolean;
    onMenuNavigate?: (delta: -1 | 1) => boolean;
    onMenuAccept?: () => boolean;
}

const Editor = memo(({
    value,
    onChange,
    onSubmit,
    onSubmitOverride,
    placeholder,
    disabled,
    fontSize,
    focusRequest,
    focusContainerRef,
    onSlashCommandHint,
    onAtCommandHint,
    onHistoryPrev,
    onHistoryNext,
    onCancelMenus,
    menuOpen,
    onMenuNavigate,
    onMenuAccept,
}: EditorProps) => {
    const ref = useRef<HTMLDivElement>(null);

    useLayoutEffect(() => {
        const el = ref.current;
        if (!el) return;
        if (el.textContent !== value) {
            el.textContent = value;
            // Place caret at end after programmatic value change so a
            // history pick lets the user keep editing without re-positioning.
            const range = document.createRange();
            range.selectNodeContents(el);
            range.collapse(false);
            const sel = window.getSelection();
            if (sel && document.activeElement === el) {
                sel.removeAllRanges();
                sel.addRange(range);
            }
        }
    }, [value]);

    useEffect(() => {
        const el = ref.current;
        if (!el || disabled) return;
        if (!shouldFocusCmdBlockEditor(document.activeElement, focusContainerRef.current)) return;
        el.focus({ preventScroll: true });
        const range = document.createRange();
        range.selectNodeContents(el);
        range.collapse(false);
        const sel = window.getSelection();
        if (!sel) return;
        sel.removeAllRanges();
        sel.addRange(range);
    }, [focusRequest, disabled, focusContainerRef]);

    const flush = useCallback(() => {
        const el = ref.current;
        if (!el) return;
        const text = el.textContent ?? "";
        onChange(text);
        onSlashCommandHint?.(text.startsWith("/"));
        // @-trigger: open when buffer contains an `@token` segment at the
        // caret (simplified — warp parses positions, we just look at the
        // last `@` token).  Toggled off when no `@` is present.
        onAtCommandHint?.(/(^|\s)@\S*$/.test(text));
    }, [onChange, onSlashCommandHint, onAtCommandHint]);

    const handleKeyDown = useCallback(
        (e: React.KeyboardEvent<HTMLDivElement>) => {
            if (disabled) return;
            const enterAction = resolveEditorEnterAction(e);
            if (enterAction === "submit-override") {
                e.preventDefault();
                onSubmitOverride();
                return;
            }
            if (enterAction === "submit") {
                // When a slash / @ menu is open, ↵ commits the highlighted
                // row instead of submitting the editor buffer.
                if (menuOpen && onMenuAccept?.()) {
                    e.preventDefault();
                    return;
                }
                e.preventDefault();
                onSubmit();
                return;
            }
            if (e.key === "Tab" && !e.shiftKey && !e.altKey) {
                e.preventDefault();
                document.execCommand("insertText", false, "\t");
                return;
            }
            if (e.key === "Escape") {
                onCancelMenus?.();
                return;
            }
            // Inline-menu navigation wins over history when a menu is open
            // — matches warp's inline_menu/view.rs key handling.
            if ((e.key === "ArrowUp" || e.key === "ArrowDown") && !e.shiftKey && !e.altKey) {
                if (menuOpen) {
                    if (onMenuNavigate?.(e.key === "ArrowUp" ? -1 : 1)) {
                        e.preventDefault();
                        return;
                    }
                }
            }
            // History navigation — only fires when the caret is on the
            // first line (so multi-line edits use ↑/↓ normally).  Warp
            // does the same in its inline_history wire-up.
            if ((e.key === "ArrowUp" || e.key === "ArrowDown") && !e.shiftKey && !e.altKey) {
                const el = ref.current;
                if (!el) return;
                const sel = window.getSelection();
                const range = sel?.rangeCount ? sel.getRangeAt(0) : null;
                if (!range || !range.collapsed) return;
                const onFirstLine = isCaretOnFirstLine(el, range);
                const onLastLine = isCaretOnLastLine(el, range);
                if (e.key === "ArrowUp" && onFirstLine && onHistoryPrev?.()) {
                    e.preventDefault();
                    return;
                }
                if (e.key === "ArrowDown" && onLastLine && onHistoryNext?.()) {
                    e.preventDefault();
                    return;
                }
            }
        },
        [disabled, onSubmit, onSubmitOverride, onCancelMenus, onHistoryPrev, onHistoryNext, menuOpen, onMenuNavigate, onMenuAccept]
    );

    const lineHeight = Math.round(fontSize * 1.4);
    // Min editor height from warp agent.rs:59 CLOUD_MODE_V2_INPUT_MIN_EDITOR_HEIGHT = 80.
    return (
        <div
            ref={ref}
            contentEditable={!disabled}
            suppressContentEditableWarning
            role="textbox"
            aria-multiline="true"
            aria-disabled={disabled}
            spellCheck={false}
            data-placeholder={placeholder ?? ""}
            onInput={flush}
            onKeyDown={handleKeyDown}
            style={{ fontSize: `${fontSize}px`, lineHeight: `${lineHeight}px`, minHeight: "80px" }}
            className={cn(
                "max-h-[50vh] w-full overflow-y-auto whitespace-pre-wrap break-words",
                "bg-transparent font-mono text-foreground outline-none",
                "empty:before:pointer-events-none empty:before:text-secondary/55 empty:before:content-[attr(data-placeholder)]",
                disabled && "opacity-60"
            )}
        />
    );
});
Editor.displayName = "Editor";

// Caret-position helpers for ↑/↓ history navigation.  Without a real
// editor we approximate by measuring the caret's clientRect against the
// editor element's top/bottom: a caret that overlaps the first 1.5×
// line-height counts as "on first line"; ditto for last line.
function isCaretOnFirstLine(host: HTMLElement, range: Range): boolean {
    const caretRect = caretRectOf(host, range);
    const hostRect = host.getBoundingClientRect();
    const lineHeight = parseFloat(getComputedStyle(host).lineHeight || "20");
    return caretRect.top - hostRect.top < lineHeight * 1.5;
}

function isCaretOnLastLine(host: HTMLElement, range: Range): boolean {
    const caretRect = caretRectOf(host, range);
    const hostRect = host.getBoundingClientRect();
    const lineHeight = parseFloat(getComputedStyle(host).lineHeight || "20");
    return hostRect.bottom - caretRect.bottom < lineHeight * 1.5;
}

function caretRectOf(host: HTMLElement, range: Range): DOMRect {
    // Empty editor: range.getBoundingClientRect() returns a zero rect.
    // Fall back to the host's top-left in that case.
    const r = range.getBoundingClientRect();
    if (r.width === 0 && r.height === 0) {
        const hostRect = host.getBoundingClientRect();
        return new DOMRect(hostRect.left, hostRect.top, 0, hostRect.height);
    }
    return r;
}

// =========================================================================
// SlashCommandMenu — inline menu when buffer starts with '/'.  Warp
// reference: app/src/terminal/input/slash_commands/.  We hardcode a small
// crest-specific list until a registry is wired through the model.
// =========================================================================
interface InlineCommand {
    name: string;
    description: string;
    icon: string;
    // Optional alternate keystroke chips shown in the trailing slot
    // when this row is selected.
    altKeys?: string[];
}

const SlashCommands: InlineCommand[] = [
    { name: "/agent", icon: "stars-01", description: "Send input to the agent" },
    { name: "/model", icon: "stars-01", description: "Pick the AI model" },
    { name: "/tree", icon: "git-branch-01", description: "Show the current agent session tree" },
    { name: "/fork", icon: "git-branch-01", description: "Fork from a previous agent message" },
    { name: "/clone", icon: "copy-01", description: "Clone the current agent session branch" },
    { name: "/terminal", icon: "terminal", description: "Switch input to shell mode" },
    { name: "/auto", icon: "lightning-02", description: "Auto-detect shell vs natural language" },
    { name: "/clear", icon: "x-close", description: "Clear the current terminal output" },
    { name: "/find", icon: "search", description: "Open the find bar" },
    { name: "/history", icon: "clock", description: "Browse command history" },
    { name: "/help", icon: "book-open", description: "Show keyboard shortcuts and commands" },
    { name: "/settings", icon: "settings", description: "Open settings" },
    { name: "/reload", icon: "refresh", description: "Reload the terminal pane" },
];

// =========================================================================
// AtMenu — inline @ context menu.  Warp reference: input/inline_menu/.
// Triggered by `@<token>` at the end of the editor buffer.  Stubbed list
// for now — the parent will populate with real context sources later.
// =========================================================================
const AtCommands: InlineCommand[] = [
    { name: "@file", icon: "file", description: "Attach a file" },
    { name: "@block", icon: "code-02", description: "Reference a terminal block" },
    { name: "@selection", icon: "copy", description: "Use the current selection" },
    { name: "@diff", icon: "file-code-02", description: "Include current git diff" },
    { name: "@branch", icon: "git-branch-02", description: "Reference the current git branch" },
];

// Substring match — warp's slash search ranks by score; the crest stub
// just keeps anything whose name contains the query.  Empty query → all.
function filterCommands(query: string, items: InlineCommand[]): InlineCommand[] {
    const q = query.toLowerCase();
    if (!q || q === "/" || q === "@") return items;
    return items.filter((c) => c.name.toLowerCase().includes(q));
}

// =========================================================================
// InlineMenu — slash / @ command palette.  Visual reference: warp
// inline_menu/view.rs:708-851 (header), styles.rs (constants), and
// message_provider.rs (footer hints).  Structure:
//
//   ┌─────────────────────────────────────────────────────┐
//   │ /COMMANDS                                       ⋮⋮  │  header
//   ├─────────────────────────────────────────────────────┤
//   │ ☰  /agent           Send input to the agent         │  ← selected
//   │ ▷  /terminal        Switch input to shell mode      │
//   │ …                                                   │
//   ├─────────────────────────────────────────────────────┤
//   │ ↑ ↓ to navigate   esc to dismiss                    │  footer
//   └─────────────────────────────────────────────────────┘
// =========================================================================
const INLINE_MENU_ROW_PX = 28;
const INLINE_MENU_ICON_PX = 14;

interface InlineMenuProps {
    label: string;          // header label ("commands" → "/COMMANDS")
    items: InlineCommand[]; // already filtered by caller
    selectedIdx: number;
    onPick: (name: string) => void;
    onHover: (idx: number) => void;
}

const InlineMenu = memo(({ label, items, selectedIdx, onPick, onHover }: InlineMenuProps) => {
    if (items.length === 0) return null;
    return (
        <div
            className="border-t border-fg-overlay-2 bg-fg-overlay-1/40 font-sans"
            style={{ fontSize: `${UI_FONT_PX}px` }}
        >
            <InlineMenuHeader label={label} />
            <div className="flex max-h-[40vh] flex-col overflow-y-auto py-1">
                {items.map((c, idx) => (
                    <InlineMenuRow
                        key={c.name}
                        item={c}
                        selected={idx === selectedIdx}
                        onMouseEnter={() => onHover(idx)}
                        onPick={() => onPick(c.name)}
                    />
                ))}
            </div>
            <InlineMenuFooter />
        </div>
    );
});
InlineMenu.displayName = "InlineMenu";

const InlineMenuHeader = memo(({ label }: { label: string }) => (
    <div
        className="flex items-center justify-between border-b border-fg-overlay-2 bg-fg-overlay-1/60 px-3"
        style={{ height: "24px" }}
    >
        <span
            className="font-mono uppercase tracking-wider text-foreground/85"
            style={{ fontSize: `${UI_HELP_FONT_PX + 1}px` }}
        >
            /{label}
        </span>
        <UIcon name="dots-vertical" size={UI_ICON_PX - 2} className="text-secondary/50" />
    </div>
));
InlineMenuHeader.displayName = "InlineMenuHeader";

interface InlineMenuRowProps {
    item: InlineCommand;
    selected: boolean;
    onMouseEnter: () => void;
    onPick: () => void;
}

const InlineMenuRow = memo(({ item, selected, onMouseEnter, onPick }: InlineMenuRowProps) => (
    <button
        type="button"
        onMouseDown={(e) => {
            // mouseDown not click — click fires after blur and the editor's
            // focusout would already close the menu.
            e.preventDefault();
            onPick();
        }}
        onMouseEnter={onMouseEnter}
        style={{ height: `${INLINE_MENU_ROW_PX}px` }}
        className={cn(
            "flex w-full cursor-pointer items-center gap-3 px-3 text-left transition-colors",
            selected ? "bg-fg-overlay-2/70" : "hover:bg-fg-overlay-1/60"
        )}
    >
        <UIcon
            name={item.icon}
            size={INLINE_MENU_ICON_PX}
            className={cn("shrink-0", selected ? "text-foreground/90" : "text-secondary/75")}
        />
        <span className="flex shrink-0 items-center gap-2 font-mono text-foreground/90">
            <span>{item.name}</span>
            {selected && item.altKeys && (
                <span className="inline-flex items-center gap-1 font-sans text-secondary/55">
                    <span style={{ fontSize: `${UI_HELP_FONT_PX}px` }}>or</span>
                    <span className="inline-flex items-center gap-[3px]">
                        {item.altKeys.map((k, i) => (
                            <Kbd key={`${k}-${i}`} char={k} />
                        ))}
                    </span>
                </span>
            )}
        </span>
        <span className="ml-6 truncate text-secondary/70">{item.description}</span>
    </button>
));
InlineMenuRow.displayName = "InlineMenuRow";

const InlineMenuFooter = memo(() => (
    <div
        className="flex items-center gap-x-4 border-t border-fg-overlay-2 bg-fg-overlay-1/60 px-3 py-1.5 font-sans text-secondary/70"
        style={{ fontSize: `${UI_HELP_FONT_PX}px` }}
    >
        <span className="inline-flex items-center gap-1.5">
            <span className="inline-flex items-center gap-[3px]">
                <Kbd char="↑" />
                <Kbd char="↓" />
            </span>
            <span>to navigate</span>
        </span>
        <span className="inline-flex items-center gap-1.5">
            <Kbd char="esc" />
            <span>to dismiss</span>
        </span>
    </div>
));
InlineMenuFooter.displayName = "InlineMenuFooter";

// =========================================================================
// CmdBlockInput — composition matches warp's agent-view screenshot.
// =========================================================================
export const CmdBlockInput = memo(
    ({
        cwd,
        home,
        branch,
        venv,
        nodeVersion,
        sshHost,
        sshUser,
        gitAdded,
        gitRemoved,
        prNumber,
        prTitle,
        onPrClick,
        agentPlanCompleted,
        agentPlanTotal,
        onAgentPlanClick,
        usedTokens,
        maxTokens,
        onContextWindowClick,
        kubernetesContext,
        onVoiceInput,
        voiceRecording,
        mode,
        onModeChange,
        onSubmit,
        submitting,
        disabled,
        modelDisplayLabel,
        catalog,
        userConfig,
        userConfigStatus,
        userConfigError,
        selection,
        onSelectionChange,
        onOpenAIConfigFile,
        openModelPickerRequest,
        placeholder,
        fontSize = 16,
        focusRequest: externalFocusRequest = 0,
        banner,
        promptAlert,
        onFilesDropped,
        onPromptContextMenu,
        hideHelpRow,
        topRightSlot,
        history: externalHistory,
        onTextChange,
        restoredTextRequest,
        effectiveMode,
    }: CmdBlockInputProps) => {
        const [text, setText] = useState("");
        const handleTextChange = useCallback(
            (next: string) => {
                setText(next);
                onTextChange?.(next);
            },
            [onTextChange]
        );
        // A leading `!` on the buffer is the user's explicit shell escape
        // hatch.  When detected, the help row swaps to a shell-mode banner
        // so the user knows ↵ will run as a shell command instead of
        // going to the agent (the new default).
        const hasShellPrefix = /^\s*!/.test(text);
        // Show the NLD autodetect hint in the top bar only when we're in
        // auto mode and the user has actually typed something — otherwise
        // the kbd hints (HelpRow) remain.  Shell-prefix wins over the
        // autodetect banner because `!` is a stronger signal than the
        // classifier verdict.
        const showShellPrefixHint = hasShellPrefix;
        const showAutodetectHint =
            !showShellPrefixHint && mode === "auto" && text.trim().length > 0;
        // Plain agent banner: default mode, user is typing, no `!` prefix
        // and not in auto-detect.  Tells the user ↵ will route to the
        // agent.  Suppressed in terminal-locked mode (then HelpRow stays).
        const showAgentHint =
            !showShellPrefixHint &&
            !showAutodetectHint &&
            mode === "agent" &&
            text.trim().length > 0;
        const [focused, setFocused] = useState(false);
        const [slashOpen, setSlashOpen] = useState(false);
        const [atOpen, setAtOpen] = useState(false);
        const [modelPickerOpen, setModelPickerOpen] = useState(false);
        const showAgentShellShortcutHint = shouldShowAgentShellShortcutHint(
            mode,
            text
        );
        const modelChipRef = useRef<HTMLButtonElement>(null);
        const chipLabel = modelDisplayLabel || "Pick model";
        // hasModelPicker — true whenever the parent wires a write path.
        // The popover handles empty / error states internally via the
        // userConfigStatus prop, so the chip can always open it.
        const hasModelPicker = !!onSelectionChange;

        useEffect(() => {
            if (!openModelPickerRequest || !hasModelPicker) return;
            setModelPickerOpen(true);
        }, [openModelPickerRequest, hasModelPicker]);
        const [slashSelectedIdx, setSlashSelectedIdx] = useState(0);
        const [atSelectedIdx, setAtSelectedIdx] = useState(0);
        const [dragOver, setDragOver] = useState(false);
        const atQuery = (/(^|\s)(@\S*)$/.exec(text)?.[2] ?? "@");
        // Filter both menus in parent so we can index the result list for
        // keyboard navigation (↑/↓ → setSelectedIdx).  Memoising keeps the
        // arrays reference-stable across keystrokes that don't change them.
        const slashFiltered = useMemo(
            () => filterCommands(text, SlashCommands),
            [text]
        );
        const atFiltered = useMemo(
            () => filterCommands(atQuery, AtCommands),
            [atQuery]
        );
        // Clamp selected index whenever the filtered list shrinks past it
        // (e.g. the user typed more characters and the matches narrowed).
        useEffect(() => {
            if (slashSelectedIdx >= slashFiltered.length) setSlashSelectedIdx(0);
        }, [slashFiltered.length, slashSelectedIdx]);
        useEffect(() => {
            if (atSelectedIdx >= atFiltered.length) setAtSelectedIdx(0);
        }, [atFiltered.length, atSelectedIdx]);
        // History ring — most recent at the end.  navIndex == null when
        // not navigating; the saved draft restores when the user dismisses
        // history with Escape or types over.  Reference: warp
        // input/inline_history/.
        const [localHistory, setLocalHistory] = useState<string[]>([]);
        const history = externalHistory ?? localHistory;
        const [navIndex, setNavIndex] = useState<number | null>(null);
        const draftRef = useRef("");
        const containerRef = useRef<HTMLDivElement>(null);
        const fileInputRef = useRef<HTMLInputElement>(null);
        const [focusRequest, setFocusRequest] = useState(0);
        const requestEditorFocus = useCallback(() => setFocusRequest((prev) => prev + 1), []);

        useEffect(() => {
            if (!restoredTextRequest) return;
            setText(restoredTextRequest.text);
            onTextChange?.(restoredTextRequest.text);
            requestEditorFocus();
        }, [restoredTextRequest?.requestId, restoredTextRequest, onTextChange, requestEditorFocus]);

        useEffect(() => {
            const el = containerRef.current;
            if (!el) return;
            const onIn = () => setFocused(true);
            const onOut = (e: FocusEvent) => {
                const next = e.relatedTarget as Node | null;
                if (next && el.contains(next)) return;
                setFocused(false);
            };
            el.addEventListener("focusin", onIn);
            el.addEventListener("focusout", onOut);
            return () => {
                el.removeEventListener("focusin", onIn);
                el.removeEventListener("focusout", onOut);
            };
        }, []);

        useEffect(() => {
            if (disabled || submitting) return;
            if (modelPickerOpen || slashOpen || atOpen) return;
            requestEditorFocus();
        }, [externalFocusRequest, disabled, submitting, modelPickerOpen, slashOpen, atOpen, requestEditorFocus]);

        const submitWith = useCallback(
            (resolved: "terminal" | "agent", payload: string) => {
                if (disabled || submitting) return;
                if (!payload) return;
                const result = onSubmit(payload, resolved);
                if (!shouldClearInputAfterSubmit(result)) return;
                requestEditorFocus();
                setText("");
                setSlashOpen(false);
                setAtOpen(false);
                setNavIndex(null);
                // Push to local history ring (used only when no external
                // history prop is wired).  When the parent threads model
                // history through, the model already owns the push path.
                if (externalHistory == null) {
                    setLocalHistory((prev) => {
                        if (prev[prev.length - 1] === payload) return prev;
                        const next = [...prev, payload];
                        if (next.length > 200) next.shift();
                        return next;
                    });
                }
            },
            [disabled, submitting, onSubmit, externalHistory, requestEditorFocus]
        );

        // Default ↵ — `!` prefix always wins (strip and send to shell).
        // Otherwise: auto mode follows the NLD verdict; locked modes pin
        // to themselves.  The new default mode is "agent", so a plain ↵
        // on natural-language input sends to the agent.
        const submit = useCallback(() => {
            const trimmedTail = text.replace(/\s+$/g, "");
            if (!trimmedTail) return;
            // Action-style slash commands are intercepted before any
            // shell/agent routing — typing `/model` and pressing Enter
            // opens the picker, doesn't submit the literal text.
            if (trimmedTail === "/model" && hasModelPicker) {
                setText("");
                setModelPickerOpen(true);
                return;
            }
            const shellPrefixMatch = /^\s*!(.*)$/s.exec(trimmedTail);
            if (shellPrefixMatch) {
                // Drop the `!` and any whitespace right after it.  An empty
                // command after the prefix (`!  ` etc.) is a no-op.
                const payload = shellPrefixMatch[1].replace(/^\s+/, "");
                if (!payload) return;
                submitWith("terminal", payload);
                return;
            }
            submitWith(resolveSubmitMode(mode, effectiveMode), trimmedTail);
        }, [submitWith, mode, effectiveMode, text, hasModelPicker]);

        const submitOverride = useCallback(() => {
            const trimmedTail = text.replace(/\s+$/g, "");
            if (!trimmedTail) return;
            const shellPrefixMatch = /^\s*!(.*)$/s.exec(trimmedTail);
            const payload = shellPrefixMatch ? shellPrefixMatch[1].replace(/^\s+/, "") : trimmedTail;
            if (!payload) return;
            const currentMode = shellPrefixMatch ? "terminal" : resolveSubmitMode(mode, effectiveMode);
            submitWith(resolveShortcutOverrideMode(currentMode), payload);
        }, [submitWith, mode, effectiveMode, text]);

        // History navigation — return true when consumed so the editor
        // suppresses the default caret motion.
        const historyPrev = useCallback((): boolean => {
            if (history.length === 0) return false;
            setNavIndex((prev) => {
                if (prev == null) {
                    // First ↑ press — stash the current draft and walk
                    // backwards from the latest entry.
                    draftRef.current = text;
                    const idx = history.length - 1;
                    setText(history[idx]);
                    return idx;
                }
                const next = Math.max(0, prev - 1);
                setText(history[next]);
                return next;
            });
            return true;
        }, [history, text]);

        const historyNext = useCallback((): boolean => {
            if (navIndex == null) return false;
            const next = navIndex + 1;
            if (next >= history.length) {
                setText(draftRef.current);
                setNavIndex(null);
                return true;
            }
            setNavIndex(next);
            setText(history[next]);
            return true;
        }, [history, navIndex]);

        const cancelMenus = useCallback(() => {
            setSlashOpen(false);
            setAtOpen(false);
            if (navIndex != null) {
                setText(draftRef.current);
                setNavIndex(null);
            }
        }, [navIndex]);

        // Replace the trailing /-token or @-token with `pick` and close
        // the menu.  Mirrors how warp's inline menus commit selections by
        // replacing the trigger token in the editor buffer.
        const replaceLastToken = useCallback(
            (pick: string, sigil: string) => {
                const m = new RegExp(`(^|\\s)\\${sigil}\\S*$`).exec(text);
                if (m) {
                    const head = text.slice(0, m.index + m[1].length);
                    setText(`${head}${pick} `);
                } else {
                    setText(`${pick} `);
                }
            },
            [text]
        );

        // Slash dispatch — most picks just insert the command name into
        // the editor buffer, but action-style commands like /model open
        // a UI directly and clear whatever the user typed instead. Used
        // by both mouse-pick (InlineMenu onPick) and keyboard-pick
        // (onMenuAccept via Enter).
        const pickSlashCommand = useCallback(
            (cmd: string) => {
                if (cmd === "/model" && hasModelPicker) {
                    setText("");
                    setSlashOpen(false);
                    setModelPickerOpen(true);
                    return;
                }
                replaceLastToken(cmd, "/");
                setSlashOpen(false);
            },
            [hasModelPicker, replaceLastToken]
        );

        // Editor-side menu callbacks: ↑/↓ moves selection within the
        // currently open menu; ↵ commits the highlighted row.
        const menuOpen = slashOpen || atOpen;
        const onMenuNavigate = useCallback(
            (delta: -1 | 1): boolean => {
                if (slashOpen) {
                    if (slashFiltered.length === 0) return false;
                    setSlashSelectedIdx((prev) =>
                        (prev + delta + slashFiltered.length) % slashFiltered.length
                    );
                    return true;
                }
                if (atOpen) {
                    if (atFiltered.length === 0) return false;
                    setAtSelectedIdx((prev) =>
                        (prev + delta + atFiltered.length) % atFiltered.length
                    );
                    return true;
                }
                return false;
            },
            [slashOpen, atOpen, slashFiltered.length, atFiltered.length]
        );
        const onMenuAccept = useCallback((): boolean => {
            if (slashOpen && slashFiltered.length > 0) {
                const pick = slashFiltered[slashSelectedIdx]?.name;
                if (pick) {
                    pickSlashCommand(pick);
                }
                return true;
            }
            if (atOpen && atFiltered.length > 0) {
                const pick = atFiltered[atSelectedIdx]?.name;
                if (pick) {
                    replaceLastToken(pick, "@");
                    setAtOpen(false);
                }
                return true;
            }
            return false;
        }, [slashOpen, atOpen, slashFiltered, atFiltered, slashSelectedIdx, atSelectedIdx, replaceLastToken, pickSlashCommand]);

        const placeholderText =
            placeholder ??
            (mode === "terminal"
                ? "Run a command…"
                : mode === "auto"
                  ? "Type a command or question (use `!` for explicit shell)…"
                  : "Ask the agent (use `!` for shell commands)…");

        const handleDragOver = useCallback((e: React.DragEvent) => {
            if (!onFilesDropped) return;
            if (e.dataTransfer.types.includes("Files")) {
                e.preventDefault();
                setDragOver(true);
            }
        }, [onFilesDropped]);

        const handleDragLeave = useCallback((e: React.DragEvent) => {
            if (e.currentTarget === e.target) setDragOver(false);
        }, []);

        const handleDrop = useCallback((e: React.DragEvent) => {
            if (!onFilesDropped) return;
            setDragOver(false);
            const files = Array.from(e.dataTransfer.files ?? []);
            if (files.length === 0) return;
            e.preventDefault();
            onFilesDropped(files);
        }, [onFilesDropped]);

        return (
            <div ref={containerRef} className="shrink-0">
                {/* Inline menu sits ABOVE the input card, full-width and
                    flush with the pane edges.  Visual reference: warp
                    inline_menu/view.rs — the menu is a separate panel
                    docked to the top of the input area, not nested inside
                    the editor frame. */}
                {slashOpen && (
                    <InlineMenu
                        label="commands"
                        items={slashFiltered}
                        selectedIdx={slashSelectedIdx}
                        onHover={setSlashSelectedIdx}
                        onPick={pickSlashCommand}
                    />
                )}
                {atOpen && !slashOpen && (
                    <InlineMenu
                        label="context"
                        items={atFiltered}
                        selectedIdx={atSelectedIdx}
                        onHover={setAtSelectedIdx}
                        onPick={(cmd) => {
                            replaceLastToken(cmd, "@");
                            setAtOpen(false);
                        }}
                    />
                )}
                {/* Inline model picker — warp-style menu docked above the
                    input card, sharing its frame. Replaces the floating
                    ModelPickerPopover when hasModelPicker is true. */}
                {hasModelPicker && (
                    <ModelPickerInline
                        open={modelPickerOpen}
                        onOpenChange={setModelPickerOpen}
                        selection={selection ?? null}
                        onSelectionChange={(next) => onSelectionChange!(next)}
                        userConfig={userConfig ?? null}
                        userConfigStatus={userConfigStatus ?? "loading"}
                        userConfigError={userConfigError}
                        catalog={catalog}
                        onOpenConfigFile={onOpenAIConfigFile}
                        anchorRef={modelChipRef}
                    />
                )}
                <div
                    onDragOver={handleDragOver}
                    onDragLeave={handleDragLeave}
                    onDrop={handleDrop}
                    className={cn(
                        // Visual reference: warp agent.rs:609-664 — the
                        // input container is full-width, edge-to-edge, with
                        // just a top divider against the content above (and
                        // against the inline menu when it's open).  No
                        // rounded corners; sectioning is done with border-b
                        // dividers between rows.
                        "border-t transition-colors",
                        focused
                            ? "bg-fg-overlay-1 border-fg-overlay-3"
                            : "bg-transparent border-fg-overlay-2",
                        dragOver && "border-[var(--color-term-accent)] bg-[var(--color-term-accent-10)]",
                        disabled && "opacity-60"
                    )}
                >
                {/* 1. Optional banner (vim status / errors / hints).
                    Visual reference: warp universal.rs:64-72. */}
                {banner && <div className="px-4 pt-4">{banner}</div>}

                {/* 2. Top help row — kbd hints flushed left, optional
                    slot on the right.  Inner padding 16px horizontal,
                    matches warp agent.rs:49 CLOUD_MODE_V2_INPUT_HORIZONTAL_PADDING.
                    When in auto mode with non-empty input, replace the
                    kbd hints with the NLD autodetect banner so the user
                    can see which mode would run on Enter. */}
                {!hideHelpRow && (
                    <div
                        className={cn(
                            "px-4 pt-3 pb-2 border-b border-fg-overlay-1/50 transition-colors",
                            (showAutodetectHint || showShellPrefixHint || showAgentHint) &&
                                "bg-fg-overlay-1/30"
                        )}
                    >
                        {showShellPrefixHint ? (
                            <ShellPrefixHintRow rightSlot={topRightSlot} />
                        ) : showAutodetectHint ? (
                            <AutodetectHintRow
                                effectiveMode={effectiveMode ?? "agent"}
                                rightSlot={topRightSlot}
                                showShortcutOverrideHint
                            />
                        ) : showAgentHint ? (
                            <AgentHintRow
                                rightSlot={topRightSlot}
                                showShellShortcutHint={showAgentShellShortcutHint}
                            />
                        ) : (
                            <HelpRow rightSlot={topRightSlot} />
                        )}
                    </div>
                )}

                {/* 3. Editor. */}
                <div className="px-4 pt-3 pb-2">
                    <Editor
                        value={text}
                        onChange={handleTextChange}
                        onSubmit={submit}
                        onSubmitOverride={submitOverride}
                        placeholder={placeholderText}
                        disabled={disabled || submitting}
                        fontSize={fontSize}
                        focusRequest={focusRequest}
                        focusContainerRef={containerRef}
                        onSlashCommandHint={setSlashOpen}
                        onAtCommandHint={setAtOpen}
                        onHistoryPrev={historyPrev}
                        onHistoryNext={historyNext}
                        onCancelMenus={cancelMenus}
                        menuOpen={menuOpen}
                        onMenuNavigate={onMenuNavigate}
                        onMenuAccept={onMenuAccept}
                    />
                </div>

                {/* 4. Bottom footer — chip row.  Visual + ordering reference:
                    warp agent_input_footer/toolbar_item.rs:182-214
                    (`default_left()` / `default_right()`).  Left = context
                    chips (SSH, cwd, branch, diff, PR) + NLD toggle.
                    Right = agent-plan / context-window / model selector /
                    fast-forward / voice / file-attach.  Bottom & horizontal
                    padding match warp agent.rs:49,55 (16 px). */}
                <div
                    className="flex flex-wrap items-center px-4 pb-4 pt-2"
                    style={{ gap: `${UI_GAP_PX}px` }}
                >
                    <SshChip user={sshUser} host={sshHost} />
                    <CwdChip
                        cwd={cwd}
                        home={home}
                        venv={venv}
                        nodeVersion={nodeVersion}
                        onContextMenu={onPromptContextMenu}
                    />
                    <GitBranchChip branch={branch} />
                    <GitDiffStatsChip added={gitAdded} removed={gitRemoved} />
                    <GithubPrChip number={prNumber} title={prTitle} onClick={onPrClick} />
                    <KubernetesContextChip context={kubernetesContext} />
                    <AutoToggle
                        on={mode === "auto"}
                        onToggle={() =>
                            onModeChange(mode === "auto" ? "agent" : "auto", text)
                        }
                    />

                    <div className="ml-auto flex shrink-0 items-center" style={{ gap: `${UI_GAP_PX}px` }}>
                        <AgentPlanChip
                            completed={agentPlanCompleted}
                            total={agentPlanTotal}
                            onClick={onAgentPlanClick}
                        />
                        <ContextWindowUsageChip
                            usedTokens={usedTokens}
                            maxTokens={maxTokens}
                            onClick={onContextWindowClick}
                        />
                        {promptAlert && (
                            <div
                                className="flex shrink-0 items-center font-sans text-[var(--color-term-warning)]"
                                style={{ fontSize: `${UI_HELP_FONT_PX}px` }}
                            >
                                {promptAlert}
                            </div>
                        )}
                        <ModelChip
                            label={chipLabel}
                            buttonRef={modelChipRef}
                            expanded={hasModelPicker && modelPickerOpen}
                            onClick={() => {
                                if (!hasModelPicker) return;
                                setModelPickerOpen((v) => !v);
                            }}
                        />
                        {/* Floating popover variant — superseded by the
                            inline ModelPickerInline above the input card.
                            Left in place (and importable) so we can flip
                            back during evaluation; void reference keeps
                            the named export reachable for bundlers / IDEs. */}
                        {false && hasModelPicker && (
                            <ModelPickerPopover
                                anchorRef={modelChipRef}
                                open={modelPickerOpen}
                                onOpenChange={setModelPickerOpen}
                                selection={selection ?? null}
                                onSelectionChange={(next) => onSelectionChange!(next)}
                                userConfig={userConfig ?? null}
                                userConfigStatus={userConfigStatus ?? "loading"}
                                userConfigError={userConfigError}
                                catalog={catalog}
                                onOpenConfigFile={onOpenAIConfigFile}
                            />
                        )}
                        <VoiceInputBtn onVoiceInput={onVoiceInput} recording={voiceRecording} />
                        <IconButton
                            icon="plus"
                            title="Attach file"
                            onClick={() => fileInputRef.current?.click()}
                            disabled={!onFilesDropped}
                        />
                        <input
                            ref={fileInputRef}
                            type="file"
                            multiple
                            hidden
                            onChange={(e) => {
                                const files = Array.from(e.target.files ?? []);
                                if (files.length === 0) return;
                                onFilesDropped?.(files);
                                // Reset so the same file can be picked again.
                                e.target.value = "";
                            }}
                        />
                        {submitting && (
                            <UIcon
                                name="clock-loader"
                                size={UI_ICON_PX}
                                className="animate-spin text-secondary/70"
                            />
                        )}
                    </div>
                </div>
                </div>
            </div>
        );
    }
);
CmdBlockInput.displayName = "CmdBlockInput";
