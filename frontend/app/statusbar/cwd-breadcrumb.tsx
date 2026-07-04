// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0
//
// CwdBreadcrumb — direct port of terax-ai/src/modules/statusbar/CwdBreadcrumb.tsx.
//
// Structure parity with terax (verified line-by-line):
//   - File mode:   first → CollapsedSegments → middle.map → <BreadcrumbItem><BreadcrumbPage className="text-foreground">{name}</BreadcrumbPage></BreadcrumbItem>
//   - Cwd mode:    firstParent → CollapsedSegments → middleParents.map → <BreadcrumbItem><CurrentSegmentDropdown /></BreadcrumbItem>
//   - Cwd empty:   <span className="text-xs text-muted-foreground/70">no directory</span>
//
// shadcn primitives crest doesn't have are inlined:
//   - <Breadcrumb>           → <nav>
//   - <BreadcrumbList>       → <ol>           (className="gap-1 text-xs sm:gap-1.5")
//   - <BreadcrumbItem>       → <li>
//   - <BreadcrumbLink>       → wrap-asChild not needed (button directly)
//   - <BreadcrumbPage>       → <span>         (with the className terax passes)
//   - <BreadcrumbSeparator>  → <li> + chevron icon (size-3)
//   - Badge variant="outline"→ <button class="crumb-chip"> (with the same tokens)
//   - <DropdownMenu>         → useFloating + FloatingPortal (radix → floating-ui)
//   - <DropdownMenuItem>     → <button> (radix's onSelect auto-closes; we close manually)
//   - <DropdownMenuTrigger>  → trigger span with onClick + getReferenceProps
//
// Click on a dir segment invokes `onCd(fullPath)`.  StatusBar wires it
// to `cd <path>\n` via ControllerInputCommand for terminal blocks.

import { Icon } from "@/app/icon/Icon";
import { getSettingsKeyAtom } from "@/app/store/global";
import {
    autoUpdate,
    FloatingPortal,
    offset,
    shift,
    useClick,
    useDismiss,
    useFloating,
    useInteractions,
} from "@floating-ui/react";
import { useAtomValue } from "jotai";
import { Fragment, useCallback, useEffect, useState } from "react";
import { listSubdirsRpc } from "./list-subdirs";
import { segmentsFromCwd } from "./path-utils";

type Props = {
    cwd: string | null;
    filePath?: string | null;
    home: string | null;
    onCd: (path: string) => void;
};

function dirname(path: string): string {
    const i = Math.max(path.lastIndexOf("/"), path.lastIndexOf("\\"));
    if (i <= 0) return "/";
    return path.slice(0, i);
}

function basename(path: string): string {
    const i = Math.max(path.lastIndexOf("/"), path.lastIndexOf("\\"));
    return i === -1 ? path : path.slice(i + 1);
}

// Direct port of terax's BreadcrumbSeparator (shadcn primitive) —
// a <li> wrapping a chevron-right icon.  terax uses
// `[&>svg]:size-3` (12px) for the chevron.  The className on
// the <li> itself is "crumb-sep" for layout purposes.
function ChevronSep() {
    return (
        <li className="crumb-sep" aria-hidden="true">
            <Icon name="chevron-right" size={12} strokeWidth={2} />
        </li>
    );
}

// Direct port of terax's BreadcrumbSegment.  Returns a fragment
// of (li + chip button) and (li + chevron separator).  Crest
// inlines shadcn's <BreadcrumbItem> + <BreadcrumbLink asChild>
// + <Badge variant="outline" className="gap-1 text-muted-foreground
// hover:text-foreground">.  Crest's "house" icon = terax's
// Home03Icon (see icon-registry).
function BreadcrumbSegment({ label, isHome, onClick }: { label: string; isHome: boolean; onClick: () => void }) {
    return (
        <Fragment>
            <li>
                <button type="button" onClick={onClick} className="crumb-chip" title={label}>
                    {isHome ? <Icon name="house" size={12} strokeWidth={1.75} /> : null}
                    {isHome ? "Home" : label}
                </button>
            </li>
            <ChevronSep />
        </Fragment>
    );
}

// Direct port of terax's CurrentSegmentDropdown.  Trigger is a
// <BreadcrumbPage> (= <span className="flex cursor-pointer items-center
// gap-1 rounded-sm px-1 py-0.5 text-foreground hover:bg-accent">),
// not a <button>.  Menu content uses DropdownMenuItem
// (= <button> with hover bg).  Closes on outside click via useDismiss.
function CurrentSegmentDropdown({ label, path, onCd }: { label: string; path: string; onCd: (p: string) => void }) {
    const [open, setOpen] = useState(false);
    const [children, setChildren] = useState<string[] | null>(null);
    const [error, setError] = useState<string | null>(null);
    // terax uses usePreferencesStore((s) => s.showHidden).  Crest
    // reads the same setting via getSettingsKeyAtom — the value
    // comes from the same preview:showhiddenfiles config key.
    const showHiddenAtom = getSettingsKeyAtom("preview:showhiddenfiles");
    const showHidden = useAtomValue(showHiddenAtom) ?? false;

    const load = useCallback(async () => {
        setError(null);
        try {
            const dirs = await listSubdirsRpc(path, { showHidden });
            setChildren(dirs);
        } catch (e) {
            setError(String(e));
            setChildren([]);
        }
    }, [path, showHidden]);

    useEffect(() => {
        if (open) load();
    }, [open, load]);

    // placement: "top-start" — status bar is pinned to the bottom of
    // the screen, so the menu must open above.  No `flip` (we
    // never want below).  `whileElementsMounted: autoUpdate` is the
    // equivalent of radix's auto-positioning — keeps the menu
    // anchored as its content resizes (Loading… → list).
    const { refs, floatingStyles, context } = useFloating({
        open,
        onOpenChange: setOpen,
        placement: "top-start",
        middleware: [offset(6), shift({ padding: 8 })],
        whileElementsMounted: autoUpdate,
    });
    const click = useClick(context);
    const dismiss = useDismiss(context);
    const { getReferenceProps, getFloatingProps } = useInteractions([click, dismiss]);

    return (
        <Fragment>
            <span
                ref={refs.setReference}
                {...getReferenceProps()}
                className="flex cursor-pointer items-center gap-1 rounded-sm px-1 py-0.5 text-foreground hover:bg-accent"
                title={path}
            >
                {label === "~" ? (
                    <>
                        <Icon name="house" size={12} strokeWidth={1.75} />
                        Home
                    </>
                ) : (
                    label
                )}
                <Icon name="arrow-down-01" size={12} strokeWidth={2} className="opacity-70" />
            </span>
            {open && (
                <FloatingPortal>
                    <div
                        ref={refs.setFloating}
                        style={{ ...floatingStyles, zIndex: 1000 }}
                        {...getFloatingProps()}
                        className="crumb-dropdown"
                    >
                        {children === null ? (
                            <div className="crumb-dropdown-empty">Loading…</div>
                        ) : children.length === 0 ? (
                            <div className="crumb-dropdown-empty">{error ?? "No subfolders"}</div>
                        ) : (
                            children.map((name) => (
                                <button
                                    type="button"
                                    key={name}
                                    className="crumb-dropdown-item"
                                    onClick={() => {
                                        setOpen(false);
                                        onCd(path.endsWith("/") ? `${path}${name}` : `${path}/${name}`);
                                    }}
                                >
                                    <Icon
                                        name="folder-01"
                                        size={14}
                                        strokeWidth={1.75}
                                        className="text-muted-foreground"
                                    />
                                    {name}
                                </button>
                            ))
                        )}
                    </div>
                </FloatingPortal>
            )}
        </Fragment>
    );
}

// Direct port of terax's CollapsedSegments.  Wraps the "…"
// trigger in a <span className="contents md:hidden"> so the
// entire group is hidden on md+ screens.  Inside: a button
// styled as a plain text trigger (not a chip), opening a
// DropdownMenu of all collapsed parents.
function CollapsedSegments({
    segments,
    onCd,
}: {
    segments: { fullPath: string; label: string; isHome: boolean }[];
    onCd: (p: string) => void;
}) {
    const [open, setOpen] = useState(false);
    const { refs, floatingStyles, context } = useFloating({
        open,
        onOpenChange: setOpen,
        placement: "top-start",
        middleware: [offset(6), shift({ padding: 8 })],
        whileElementsMounted: autoUpdate,
    });
    const click = useClick(context);
    const dismiss = useDismiss(context);
    const { getReferenceProps, getFloatingProps } = useInteractions([click, dismiss]);

    return (
        <span className="contents md:hidden">
            <li>
                <button
                    ref={refs.setReference}
                    type="button"
                    {...getReferenceProps()}
                    title="Show hidden folders"
                    className="flex items-center rounded-sm px-1 text-muted-foreground hover:bg-accent hover:text-foreground"
                >
                    <Icon name="more-horizontal" size={12} strokeWidth={1.75} />
                </button>
            </li>
            {open && (
                <FloatingPortal>
                    <div
                        ref={refs.setFloating}
                        style={{ ...floatingStyles, zIndex: 1000 }}
                        {...getFloatingProps()}
                        className="crumb-dropdown crumb-dropdown-wide"
                    >
                        {segments.map((s) => (
                            <button
                                type="button"
                                key={s.fullPath}
                                className="crumb-dropdown-item"
                                onClick={() => {
                                    setOpen(false);
                                    onCd(s.fullPath);
                                }}
                            >
                                <Icon
                                    name={s.isHome ? "house" : "folder-01"}
                                    size={14}
                                    strokeWidth={1.75}
                                    className="text-muted-foreground"
                                />
                                <span className="truncate">{s.isHome ? "Home" : s.label}</span>
                            </button>
                        ))}
                    </div>
                </FloatingPortal>
            )}
            <ChevronSep />
        </span>
    );
}

// Direct port of terax's CwdBreadcrumb export.
export function CwdBreadcrumb({ cwd, filePath, home, onCd }: Props) {
    // File mode — dir segments are clickable chips, filename is
    // plain text inside <BreadcrumbPage className="text-foreground">.
    if (filePath) {
        const dir = dirname(filePath);
        const name = basename(filePath);
        const segments = segmentsFromCwd(dir, home);
        const first = segments[0];
        const middle = segments.slice(1);
        return (
            <nav aria-label="File path" className="crumb-nav">
                <ol className="crumb-list">
                    {first ? (
                        <BreadcrumbSegment
                            label={first.label}
                            isHome={first.isHome}
                            onClick={() => onCd(first.fullPath)}
                        />
                    ) : null}
                    {middle.length > 0 ? <CollapsedSegments segments={middle} onCd={onCd} /> : null}
                    {middle.map((s) => (
                        <span key={s.fullPath} className="contents max-md:hidden">
                            <BreadcrumbSegment label={s.label} isHome={s.isHome} onClick={() => onCd(s.fullPath)} />
                        </span>
                    ))}
                    <li>
                        <span className="text-foreground">{name}</span>
                    </li>
                </ol>
            </nav>
        );
    }

    if (!cwd) {
        return <span className="text-xs text-muted-foreground/70">no directory</span>;
    }

    // Cwd mode — every segment is a chip; the last is a subfolder
    // dropdown wrapped in <BreadcrumbItem> (matches terax JSX
    // structure).
    const segments = segmentsFromCwd(cwd, home);
    const current = segments[segments.length - 1];
    const parents = segments.slice(0, -1);
    const firstParent = parents[0];
    const middleParents = parents.slice(1);

    return (
        <nav aria-label="Working directory" className="crumb-nav">
            <ol className="crumb-list">
                {firstParent ? (
                    <BreadcrumbSegment
                        label={firstParent.label}
                        isHome={firstParent.isHome}
                        onClick={() => onCd(firstParent.fullPath)}
                    />
                ) : null}
                {middleParents.length > 0 ? <CollapsedSegments segments={middleParents} onCd={onCd} /> : null}
                {middleParents.map((s) => (
                    <span key={s.fullPath} className="contents max-md:hidden">
                        <BreadcrumbSegment label={s.label} isHome={s.isHome} onClick={() => onCd(s.fullPath)} />
                    </span>
                ))}
                <li>
                    <CurrentSegmentDropdown label={current.label} path={current.fullPath} onCd={onCd} />
                </li>
            </ol>
        </nav>
    );
}
