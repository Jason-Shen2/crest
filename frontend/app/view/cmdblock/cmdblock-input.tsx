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

import { UIcon } from "@/app/element/ui-icon";
import { cn } from "@/util/util";
import { memo, useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { formatPromptCwd } from "./cmdblock-status";

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
    mode: InputMode;
    // Pass the current buffer text alongside the new mode so the parent
    // can fire a one-shot NLD trigger when the user toggles Auto on with
    // existing content (otherwise the stale effective mode would persist
    // until the next keystroke).
    onModeChange: (next: InputMode, currentText?: string) => void;
    onSubmit: (text: string, mode: InputMode) => void;
    submitting?: boolean;
    disabled?: boolean;
    modelName?: string;
    onModelClick?: (e: React.MouseEvent<HTMLButtonElement>) => void;
    placeholder?: string;
    // Grid font size — only used by Editor.  Chrome (chips, buttons,
    // help row) uses fixed UI sizes for legibility.  Reference: warp's
    // ui_font_family / monospace_ui_scalar split
    // (universal_developer_input.rs:924).
    fontSize?: number;
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
const UI_FONT_PX = 12;       // chrome text (chips, segmented labels)
const UI_HELP_FONT_PX = 11;  // top help row hints (slightly smaller)
const UI_BUTTON_PX = 26;     // chip/button height — comfortable click target
const UI_ICON_PX = 14;       // icon size inside buttons
const UI_GAP_PX = 6;         // gap between adjacent chrome elements
const UI_CHIP_RADIUS_PX = 6; // chip corner radius (warp uses ~6 for chips)
const UI_DIVIDER_HEIGHT_PX = 22; // 1px wide divider, slightly shorter than button

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
        className="flex items-center gap-x-4 gap-y-1 font-sans leading-none text-secondary/60"
        style={{ fontSize: `${UI_HELP_FONT_PX}px` }}
    >
        <Hint kbd="↵" label="shell" />
        <Hint kbd="⌘↵" label="agent" />
        <Hint kbd="⇧↵" label="newline" />
        <Hint kbd="/" label="commands" />
        <Hint kbd="⌘F" label="find" />
        {rightSlot && <div className="ml-auto flex shrink-0 items-center">{rightSlot}</div>}
    </div>
));
HelpRow.displayName = "HelpRow";

const Hint = memo(({ kbd, label }: { kbd: string; label: string }) => (
    <span className="inline-flex items-center gap-1.5">
        <kbd
            className="inline-flex items-center justify-center rounded border border-fg-overlay-2 bg-fg-overlay-1 px-1.5 py-0.5 font-mono"
            style={{ fontSize: `${UI_HELP_FONT_PX - 1}px`, minWidth: "16px", lineHeight: 1 }}
        >
            {kbd}
        </kbd>
        <span>{label}</span>
    </span>
));
Hint.displayName = "Hint";

// =========================================================================
// AutodetectHintRow — replaces HelpRow when auto-detect is active and the
// classifier has a verdict for the current input.  Visual reference:
// warp's "autodetected shell command, ⌘ I to override" banner.  Colors
// mirror the SegmentedControl: terminal → blue, agent → yellow.
// =========================================================================
interface AutodetectHintRowProps {
    effectiveMode: "terminal" | "agent";
    rightSlot?: React.ReactNode;
}

const AutodetectHintRow = memo(({ effectiveMode, rightSlot }: AutodetectHintRowProps) => {
    const label = effectiveMode === "terminal" ? "shell command" : "natural language";
    const accent =
        effectiveMode === "terminal" ? "text-[var(--ansi-blue)]" : "text-[var(--ansi-yellow)]";
    return (
        <div
            className="flex items-center gap-x-2 font-sans leading-none text-secondary/70"
            style={{ fontSize: `${UI_HELP_FONT_PX}px` }}
        >
            <span className={cn("inline-flex items-center gap-1.5", accent)}>
                <UIcon name="lightning-02" size={UI_HELP_FONT_PX} />
                <span>autodetected {label}</span>
            </span>
            <span className="text-secondary/45">— click Auto to override</span>
            {rightSlot && <div className="ml-auto flex shrink-0 items-center">{rightSlot}</div>}
        </div>
    );
});
AutodetectHintRow.displayName = "AutodetectHintRow";

// =========================================================================
// CwdChip — bottom-left chip showing the working directory (and env /
// branch when present).  Warp screenshot: `📁 ...ents/open-source/...`
// rendered as a rounded pill with a subtle border.  Visual reference:
// warp prompt_render_helper.rs:669 + context_chips/spacing.rs
// (UDI_CHIP_HORIZONTAL_PADDING = 4, UDI_CHIP_VERTICAL_PADDING = 2,
// UDI_CHIP_ICON_GAP = 4).
// =========================================================================
interface CwdChipProps {
    cwd?: string;
    home?: string;
    branch?: string;
    venv?: string;
    nodeVersion?: string;
    onContextMenu?: (e: React.MouseEvent) => void;
}

const CwdChip = memo(({ cwd, home, branch, venv, nodeVersion, onContextMenu }: CwdChipProps) => {
    const prettyCwd = formatPromptCwd(cwd, home ?? "");
    if (!prettyCwd && !branch && !venv && !nodeVersion) return null;
    const env = venv ?? nodeVersion;
    return (
        <div
            onContextMenu={onContextMenu}
            className="inline-flex shrink-0 items-center gap-1.5 rounded-[6px] border border-fg-overlay-2 bg-fg-overlay-1/40 px-2 font-sans text-secondary/80 hover:bg-fg-overlay-1"
            style={{ height: `${UI_BUTTON_PX}px`, fontSize: `${UI_FONT_PX}px` }}
            title={cwd}
        >
            <UIcon name="folder" size={UI_ICON_PX - 1} className="opacity-70" />
            {env && <span className="shrink-0 opacity-70">{env}</span>}
            {prettyCwd && (
                <span className="max-w-[280px] truncate">{prettyCwd}</span>
            )}
            {branch && (
                <span className="inline-flex shrink-0 items-center gap-1 border-l border-fg-overlay-2 pl-1.5">
                    <UIcon name="git-branch-02" size={UI_ICON_PX - 1} className="opacity-70" />
                    <span className="max-w-[100px] truncate">{branch}</span>
                </span>
            )}
        </div>
    );
});
CwdChip.displayName = "CwdChip";

// =========================================================================
// AutoToggle — single binary toggle replacing the Terminal | Agent | Auto
// SegmentedControl.  crest's keyboard model now treats ↵ as shell and
// ⌘↵ as agent by default; Auto is an opt-in that lets NLD reroute ↵ to
// agent when natural-language input is detected.  Visual: pill button,
// fills with the NLD accent (yellow) when on, dim outline when off.
// =========================================================================
interface AutoToggleProps {
    on: boolean;
    onToggle: () => void;
}

const AutoToggle = memo(({ on, onToggle }: AutoToggleProps) => (
    <button
        type="button"
        onClick={onToggle}
        style={{ width: `${UI_BUTTON_PX}px`, height: `${UI_BUTTON_PX}px` }}
        className={cn(
            "flex shrink-0 cursor-pointer items-center justify-center rounded-[6px] border transition-colors",
            on
                ? "border-[var(--ansi-yellow)]/60 bg-[var(--ansi-yellow)]/15 text-[var(--ansi-yellow)]"
                : "border-fg-overlay-2 bg-fg-overlay-1/60 text-secondary/70 hover:text-foreground"
        )}
        title={on ? "Disable NL auto detection" : "Enable NL auto detection"}
        aria-pressed={on}
        aria-label={on ? "Disable NL auto detection" : "Enable NL auto detection"}
    >
        <UIcon name="lightning-02" size={UI_ICON_PX} />
    </button>
));
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
    <button
        type="button"
        onClick={onClick}
        disabled={disabled}
        title={title}
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
));
IconButton.displayName = "IconButton";

// =========================================================================
// ButtonBarDivider — 1px wide vertical line between button-bar sections.
// Visual reference: warp universal_developer_input.rs:797-808 — 1×20 px,
// color theme.surface_3, 4 px margin left + right.
// =========================================================================
const ButtonBarDivider = memo(() => (
    <div
        className="mx-1 w-px shrink-0 bg-surface-3"
        style={{ height: `${UI_DIVIDER_HEIGHT_PX}px` }}
    />
));
ButtonBarDivider.displayName = "ButtonBarDivider";

// =========================================================================
// ModelChip — pill on the right showing current model.  Warp screenshot:
// rounded border, icon + "Default | auto (genius)" + chevron.  Visual
// reference: warp universal_developer_input.rs:396-422 ProfileModelSelector.
// =========================================================================
interface ModelChipProps {
    label: string;
    onClick?: (e: React.MouseEvent<HTMLButtonElement>) => void;
}

const ModelChip = memo(({ label, onClick }: ModelChipProps) => (
    <button
        type="button"
        onClick={onClick}
        style={{ height: `${UI_BUTTON_PX}px`, fontSize: `${UI_FONT_PX}px` }}
        className="inline-flex shrink-0 cursor-pointer items-center gap-1.5 rounded-[6px] border border-fg-overlay-2 bg-fg-overlay-1/60 px-2 font-sans text-secondary/85 transition-colors hover:bg-fg-overlay-2"
        title="Pick model"
    >
        <UIcon name="stars-01" size={UI_ICON_PX - 1} />
        <span className="max-w-[180px] truncate">{label}</span>
        <UIcon name="chevron-down" size={UI_ICON_PX - 4} className="text-secondary" />
    </button>
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
    // Fires on ⌘↵ / Ctrl+↵ — explicit "send to agent regardless of mode".
    onSubmitAgent?: () => void;
    placeholder?: string;
    disabled?: boolean;
    fontSize: number;
    onSlashCommandHint?: (open: boolean) => void;
    onAtCommandHint?: (open: boolean) => void;
    onHistoryPrev?: () => boolean;
    onHistoryNext?: () => boolean;
    onCancelMenus?: () => void;
}

const Editor = memo(({
    value,
    onChange,
    onSubmit,
    onSubmitAgent,
    placeholder,
    disabled,
    fontSize,
    onSlashCommandHint,
    onAtCommandHint,
    onHistoryPrev,
    onHistoryNext,
    onCancelMenus,
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
            if (e.key === "Enter" && !e.shiftKey && !e.altKey) {
                // ⌘↵ (macOS) / Ctrl+↵ — explicit "send to agent".  Wins
                // regardless of mode or NLD verdict.  Shift+↵ still
                // inserts a newline (handled by the fallthrough below).
                if (e.metaKey || e.ctrlKey) {
                    if (onSubmitAgent) {
                        e.preventDefault();
                        onSubmitAgent();
                    }
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
        [disabled, onSubmit, onSubmitAgent, onCancelMenus, onHistoryPrev, onHistoryNext]
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
}

const SlashCommands: InlineCommand[] = [
    { name: "/help", description: "Show available commands" },
    { name: "/clear", description: "Clear the current terminal output" },
    { name: "/find", description: "Open the find bar (also Cmd+F)" },
    { name: "/agent", description: "Switch input to agent mode" },
    { name: "/terminal", description: "Switch input to terminal mode" },
    { name: "/auto", description: "Auto-detect command vs question" },
    { name: "/history", description: "Browse command history" },
    { name: "/settings", description: "Open settings" },
    { name: "/reload", description: "Reload the terminal pane" },
];

// =========================================================================
// AtMenu — inline @ context menu.  Warp reference: input/inline_menu/.
// Triggered by `@<token>` at the end of the editor buffer.  Stubbed list
// for now — the parent will populate with real context sources later.
// =========================================================================
const AtCommands: InlineCommand[] = [
    { name: "@file", description: "Attach a file" },
    { name: "@block", description: "Reference a terminal block" },
    { name: "@selection", description: "Use the current selection" },
    { name: "@diff", description: "Include current git diff" },
    { name: "@branch", description: "Reference the current git branch" },
];

interface InlineMenuProps {
    query: string;
    items: InlineCommand[];
    onPick: (name: string) => void;
}

const InlineMenu = memo(({ query, items, onPick }: InlineMenuProps) => {
    const lowerQuery = query.toLowerCase();
    const matches = items.filter((c) => c.name.toLowerCase().startsWith(lowerQuery));
    if (matches.length === 0) return null;
    return (
        <div
            className="mt-1 flex flex-col gap-px overflow-hidden rounded border border-fg-overlay-2 bg-fg-overlay-1/60 font-sans"
            style={{ fontSize: `${UI_FONT_PX}px` }}
        >
            {matches.map((c) => (
                <button
                    key={c.name}
                    type="button"
                    onMouseDown={(e) => {
                        // mouseDown not click — click fires after blur and
                        // the editor's focusout would already close the menu.
                        e.preventDefault();
                        onPick(c.name);
                    }}
                    className="flex cursor-pointer items-center gap-2 px-2 py-1 text-left hover:bg-fg-overlay-2"
                >
                    <span className="font-mono text-foreground">{c.name}</span>
                    <span className="text-secondary/70">{c.description}</span>
                </button>
            ))}
        </div>
    );
});
InlineMenu.displayName = "InlineMenu";

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
        mode,
        onModeChange,
        onSubmit,
        submitting,
        disabled,
        modelName,
        onModelClick,
        placeholder,
        fontSize = 12,
        banner,
        promptAlert,
        onFilesDropped,
        onPromptContextMenu,
        hideHelpRow,
        topRightSlot,
        history: externalHistory,
        onTextChange,
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
        // Show the NLD autodetect hint in the top bar only when we're in
        // auto mode and the user has actually typed something — otherwise
        // the kbd hints (HelpRow) remain.
        const showAutodetectHint = mode === "auto" && text.trim().length > 0;
        const [focused, setFocused] = useState(false);
        const [slashOpen, setSlashOpen] = useState(false);
        const [atOpen, setAtOpen] = useState(false);
        const [dragOver, setDragOver] = useState(false);
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

        const submitWith = useCallback(
            (resolved: "terminal" | "agent") => {
                if (disabled || submitting) return;
                const trimmed = text.replace(/\s+$/g, "");
                if (!trimmed) return;
                onSubmit(trimmed, resolved);
                setText("");
                setSlashOpen(false);
                setAtOpen(false);
                setNavIndex(null);
                // Push to local history ring (used only when no external
                // history prop is wired).  When the parent threads model
                // history through, the model already owns the push path.
                if (externalHistory == null) {
                    setLocalHistory((prev) => {
                        if (prev[prev.length - 1] === trimmed) return prev;
                        const next = [...prev, trimmed];
                        if (next.length > 200) next.shift();
                        return next;
                    });
                }
            },
            [disabled, submitting, text, onSubmit, externalHistory]
        );

        // Default ↵ — auto mode follows the NLD verdict, otherwise the
        // mode is shell (legacy "agent" locked state still respected).
        const submit = useCallback(() => {
            const resolved: "terminal" | "agent" =
                mode === "auto" ? effectiveMode ?? "terminal" : mode === "agent" ? "agent" : "terminal";
            submitWith(resolved);
        }, [submitWith, mode, effectiveMode]);

        // ⌘↵ — explicit "send to agent" regardless of mode / NLD verdict.
        const submitAgent = useCallback(() => {
            submitWith("agent");
        }, [submitWith]);

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

        const placeholderText =
            placeholder ??
            (mode === "agent"
                ? "Ask the agent…"
                : mode === "auto"
                  ? "Type a command or question…"
                  : "Run a command…");

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
            <div
                ref={containerRef}
                onDragOver={handleDragOver}
                onDragLeave={handleDragLeave}
                onDrop={handleDrop}
                className={cn(
                    // Visual reference: warp universal.rs:182-197.
                    "shrink-0 m-1.5 rounded-lg border transition-colors",
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
                            showAutodetectHint && "bg-fg-overlay-1/30"
                        )}
                    >
                        {showAutodetectHint ? (
                            <AutodetectHintRow
                                effectiveMode={effectiveMode ?? "terminal"}
                                rightSlot={topRightSlot}
                            />
                        ) : (
                            <HelpRow rightSlot={topRightSlot} />
                        )}
                    </div>
                )}

                {/* 3. Editor + inline slash / @ menus. */}
                <div className="px-4 pt-3 pb-2">
                    <Editor
                        value={text}
                        onChange={handleTextChange}
                        onSubmit={submit}
                        onSubmitAgent={submitAgent}
                        placeholder={placeholderText}
                        disabled={disabled || submitting}
                        fontSize={fontSize}
                        onSlashCommandHint={setSlashOpen}
                        onAtCommandHint={setAtOpen}
                        onHistoryPrev={historyPrev}
                        onHistoryNext={historyNext}
                        onCancelMenus={cancelMenus}
                    />
                    {slashOpen && (
                        <InlineMenu
                            query={text}
                            items={SlashCommands}
                            onPick={(cmd) => {
                                replaceLastToken(cmd, "/");
                                setSlashOpen(false);
                            }}
                        />
                    )}
                    {atOpen && !slashOpen && (
                        <InlineMenu
                            // Query is the trailing `@token` segment.
                            query={(/(^|\s)(@\S*)$/.exec(text)?.[2] ?? "@")}
                            items={AtCommands}
                            onPick={(cmd) => {
                                replaceLastToken(cmd, "@");
                                setAtOpen(false);
                            }}
                        />
                    )}
                </div>

                {/* 4. Bottom button bar.  cwd chip on left, tool cluster
                    + model picker on right.  Bottom padding 16px matches
                    warp agent.rs:55 CLOUD_MODE_V2_INPUT_BOTTOM_PADDING.
                    Horizontal padding 16px matches :49. */}
                <div
                    className="flex items-center px-4 pb-4 pt-1"
                    style={{ gap: `${UI_GAP_PX}px` }}
                >
                    <CwdChip
                        cwd={cwd}
                        home={home}
                        branch={branch}
                        venv={venv}
                        nodeVersion={nodeVersion}
                        onContextMenu={onPromptContextMenu}
                    />
                    <AutoToggle
                        on={mode === "auto"}
                        onToggle={() =>
                            onModeChange(mode === "auto" ? "terminal" : "auto", text)
                        }
                    />

                    <div className="ml-auto flex shrink-0 items-center" style={{ gap: `${UI_GAP_PX}px` }}>
                        {/* Visual reference: warp universal_developer_input.rs:382-394 (slash),
                            :356-368 (@), :370-380 (+).  Voice button skipped — warp gates
                            it on feature "voice_input" (:826). */}
                        <IconButton
                            icon="prompt"
                            title="Slash commands"
                            onClick={() => {
                                setText("/");
                                setSlashOpen(true);
                            }}
                        />
                        <IconButton
                            icon="paperclip"
                            title="Add context (@)"
                            onClick={() => {
                                // Insert `@` at the end of buffer and open
                                // the inline menu — mirrors warp clicking
                                // the @ action_button (universal_developer_input.rs:356).
                                setText((prev) => (prev.endsWith(" ") || prev.length === 0 ? `${prev}@` : `${prev} @`));
                                setAtOpen(true);
                            }}
                        />
                        <IconButton
                            icon="plus"
                            title="Attach file"
                            onClick={() => {
                                // Hidden file input — clicking it opens
                                // the native file picker.  Selected files
                                // route through onFilesDropped (same path
                                // as drag-and-drop).
                                fileInputRef.current?.click();
                            }}
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
                        {promptAlert && (
                            <div
                                className="flex shrink-0 items-center font-sans text-[var(--color-term-warning)]"
                                style={{ fontSize: `${UI_HELP_FONT_PX}px` }}
                            >
                                {promptAlert}
                            </div>
                        )}
                        <ButtonBarDivider />
                        <ModelChip label={modelName ?? "Default"} onClick={onModelClick} />
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
        );
    }
);
CmdBlockInput.displayName = "CmdBlockInput";
