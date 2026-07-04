// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0
//
// Generates a side-by-side comparison HTML page for **UI controls only**:
//   - left  = Font Awesome class as currently rendered in crest's JSX
//   - right = Hugeicons SVG (kebab-case name + terax-aligned pick)
//
// File-tree / brand icons are EXCLUDED from this mock:
//   - crest's file-explorer already uses `simple-icons` (~40 imported
//     brand marks: siJavascript, siPython, siRust, etc.) for the file
//     tree.  That doesn't change — simple-icons renders the colored
//     brand SVGs directly.
//   - The data layer (mimetypes.json / widgets.json) still uses FA-style
//     strings like `"js fa-brands"` for icon names, but the rendering
//     path is `file-icon.ts → file-icons.tsx → simple-icons` — not FA
//     CSS.  So no migration is needed there.
//
// What IS in this mock: every FA name that appears in crest's JSX
// (the 207 places we'll be editing in a follow-up codemod).  Icon
// picks are cross-referenced against terax's actual usage so crest
// stays visually consistent with the reference app.
//
// Run via:  node --experimental-strip-types scripts/generate-icon-mock.ts

import { writeFileSync } from "node:fs";
import { join } from "node:path";

// 80 FA names that actually appear in crest's JSX (file-tree brand
// icons are filtered out).  Each row: [faLabel, faClass, hugeName, note]
const PAIRS: Array<[string, string, string, string?]> = [
    // --- navigation / arrows ---
    ["angle-down", "fa-solid fa-angle-down", "chevron-down", "FA: angle bracket; Hugeicons: chevron — semantically similar (down-pointing)"],
    ["arrow-down", "fa-solid fa-arrow-down", "arrow-down-01", "terax: 12x (dominant)"],
    ["arrow-left", "fa-solid fa-arrow-left", "arrow-left-01", "terax: 1x"],
    ["arrow-right", "fa-solid fa-arrow-right", "arrow-right-01", "terax: 11x (dominant)"],
    ["arrow-right-arrow-left", "fa-solid fa-arrow-right-arrow-left", "arrow-turn-backward", "terax: 2x (ArrowTurnBackwardIcon — same visual, different name)"],
    ["arrow-up", "fa-solid fa-arrow-up", "arrow-up-01", "FA: arrow-up; Hugeicons has no raw ArrowUp (only ArrowUp01+). Registry aliases `arrow-up` → ArrowUp01Icon for convenience"],
    ["arrow-up-right-from-square", "fa-solid fa-arrow-up-right-from-square", "arrow-up-right-01", "terax: 2x"],
    ["asterisk", "fa-solid fa-asterisk", "asterisk"],

    // --- feedback / status ---
    ["bell", "fa-solid fa-bell", "bell", "terax: not used (uses Notification01Icon instead)"],
    ["check", "fa-solid fa-check", "tick-02", "terax: 14x (the dominant checkmark)"],
    ["circle-exclamation", "fa-solid fa-circle-exclamation", "alert-circle", "terax: 3x (uses AlertCircleIcon, not FA's specific circle-x shape)"],
    ["circle-info", "fa-solid fa-circle-info", "information-circle", "terax: 1x"],
    ["circle-notch", "fa-solid fa-circle-notch", "loading-03", "terax: 2x (Loading03Icon — the loading animation they actually use)"],
    ["circle-xmark", "fa-solid fa-circle-xmark", "cancel-circle"],
    ["triangle-exclamation", "fa-solid fa-triangle-exclamation", "alert-02", "terax: 2x (uses Alert02Icon for 'warning', not a triangle shape)"],
    ["spinner", "fa-solid fa-spinner", "loading-03", "terax: 2x (Loading03Icon)"],

    // --- ui actions ---
    ["chevron-down", "fa-solid fa-chevron-down", "chevron-down"],
    ["chevron-left", "fa-solid fa-chevron-left", "chevron-left"],
    ["chevron-right", "fa-solid fa-chevron-right", "chevron-right"],
    ["chevron-up", "fa-solid fa-chevron-up", "chevron-up"],
    ["ellipsis", "fa-solid fa-ellipsis", "more-horizontal", "FIX: was ellipsis-vertical (3 vertical dots); now more-horizontal (3 horizontal dots matching FA)"],
    ["expand", "fa-solid fa-expand", "expand"],
    ["pen-to-square", "fa-regular fa-pen-to-square", "pen-01"],
    ["pen", "fa-solid fa-pen", "pen-01", "FA-only name; alias for pen-01"],
    ["plus", "fa-solid fa-plus", "add-01", "terax: 4x uses Add01Icon for 'add' (not PlusSign)"],
    ["rotate", "fa-solid fa-rotate", "rotate-right-01"],
    ["rotate-right", "fa-solid fa-rotate-right", "rotate-right-01"],
    ["trash", "fa-solid fa-trash", "delete-02", "terax: 5x (uses Delete02Icon, NOT Delete01)"],
    ["xmark", "fa-solid fa-xmark", "cancel-01", "terax: 17x (the dominant cancel/close)"],
    ["xmark-large", "fa-solid fa-xmark", "cancel-01", "Hugeicons has no 'large' variant — same as xmark"],
    ["down-left-and-up-right-to-center", "fa-solid fa-down-left-and-up-right-to-center", "minimize-01"],
    ["sort-down", "fa-solid fa-sort-down", "sort-by-down-01"],
    ["sort-up", "fa-solid fa-sort-up", "sort-by-up-01"],
    ["magnifying-glass", "fa-solid fa-magnifying-glass", "search-01", "terax: 7x (Hugeicons uses 'Search' naming)"],
    ["magnifying-glass-minus", "fa-solid fa-magnifying-glass-minus", "search-minus"],
    ["magnifying-glass-plus", "fa-solid fa-magnifying-glass-plus", "search-add", "FIX: was search-01 (plain search, no +); now search-add (search with +)"],
    ["face-smile", "fa-regular fa-face-smile", "smile"],

    // --- file/folder (UI usage, not data layer) ---
    ["file", "fa-solid fa-file", "file-01", "terax: 3x"],
    ["file-circle-plus", "fa-solid fa-file-circle-plus", "file-plus", "terax: 3x uses FilePlusIcon"],
    ["file-code", "fa-regular fa-file-code", "file-code", "Hugeicons has FileCodeIcon directly"],
    ["file-pen", "fa-solid fa-file-pen", "file-edit", "terax: 4x uses FileEditIcon"],
    ["folder", "fa-solid fa-folder", "folder-01", "terax: 7x (dominant). UI usage: commandpalette directory label, workspaceswitcher, etc."],
    ["folder-open", "fa-solid fa-folder-open", "folder-open", "terax: 1x"],
    ["folder-plus", "fa-solid fa-folder-plus", "folder-add", "terax: 4x uses FolderAddIcon (specific icon, not Folder01)"],
    ["floppy-disk", "fa-regular fa-floppy-disk", "floppy-disk"],

    // --- system / chrome ---
    ["gear", "fa-solid fa-gear", "settings-01", "terax: 5x"],
    ["globe", "fa-solid fa-globe", "globe-02", "terax: 5x. UI usage: right-tool-panel, workspaceswitcher, rightbrowser"],
    ["house", "fa-solid fa-house", "home-03", "terax: 1x uses Home03Icon"],
    ["cube", "fa-solid fa-cube", "cube"],
    ["box", "fa-solid fa-box", "box", "FIX: was cube (3D w/ depth lines, different); now box (flat 3D box outline matching FA)"],
    ["hammer", "fa-solid fa-hammer", "hammer"],
    ["wrench", "fa-solid fa-wrench", "wrench-01"],
    ["shield", "fa-regular fa-shield", "shield-ban", "FIX: was shield-01 (plain shield, no X); now shield-ban (shield with ban/X mark)"],
    ["key", "fa-solid fa-key", "key-01", "terax: 1x"],
    ["laptop", "fa-solid fa-laptop", "computer", "terax: 3x uses ComputerIcon for 'laptop' semantic"],
    ["mobile-screen", "fa-solid fa-mobile-screen", "smart-phone-01"],
    ["palette", "fa-solid fa-palette", "color-picker", "FIX: was paint-board (canvas/board, different concept); now color-picker (color selection, closer to FA's color wheel)"],
    ["grid-2", "fa-solid fa-grid-2", "grid-2-x2", "FIX: was grid-02 (just lines, no grid); now grid-2-x2 (actual 2x2 grid)"],
    ["sidebar", "fa-solid fa-sidebar", "sidebar-left", "terax: 2x uses SidebarLeftIcon (without 01)"],
    ["sliders", "fa-solid fa-sliders", "sliders-horizontal"],
    ["terminal", "fa-solid fa-terminal", "terminal", "terax: 10x (dominant)"],
    ["list-tree", "fa-solid fa-list-tree", "list-tree", "Hugeicons has ListTreeIcon directly. UI usage: onboarding"],
    ["chart-line", "fa-solid fa-chart-line", "chart-line-data-02", "UI usage: onboarding"],

    // --- charts / data ---
    ["pie-chart (not in JSX, but registered for completeness)", "fa-solid fa-chart-pie", "pie-chart", "Not used in JSX but kept in registry for data layer"],
    ["network-wired", "fa-solid fa-network-wired", "antenna", "FIX: was cellular-network (wireless signal); now antenna (also wireless, but different shape). Hugeicons has no wired-network icon"],

    // --- people / account ---
    ["people-group", "fa-solid fa-people-group", "user-group"],

    // --- volume ---
    ["volume-high", "fa-solid fa-volume-high", "volume-high"],
    ["volume-xmark", "fa-solid fa-volume-xmark", "volume-mute-01", "FIX: was 'mute' (Hugeicons MuteIcon is actually a smiley face, not a speaker); now volume-mute-01 (actual speaker with X)"],

    // --- link ---
    ["link", "fa-solid fa-link", "link-01", "FIX: was link-square-02 (external-link style, wrong); now link-01 (actual chain link)"],
    ["link-slash", "fa-solid fa-link-slash", "link-square-01", "FA: chain with diagonal slash; Hugeicons: empty square (no slash variant exists)"],

    // --- misc UI ---
    ["sharp (placeholder)", "fa-solid fa-sharp", "square"],
    ["stack-1x (placeholder)", "fa-solid fa-stack-1x", "square"],
    ["table-columns", "fa-solid fa-table-columns", "table-columns-split"],
    ["table-rows", "fa-solid fa-table-rows", "table-rows-split"],
    ["sparkles", "fa-solid fa-sparkles", "sparkles", "terax: 6x (the 'AI/feature' icon)"],

    // --- brand / social (used in UI, not file tree) ---
    ["dev (brands)", "fa-brands fa-dev", "code", "UI usage: workspace widgets list (3x). Hugeicons has no Dev.to icon — falls back to code"],
    ["discord (brands)", "fa-brands fa-discord", "discord", "UI usage: quicktips (1x). Hugeicons has DiscordIcon"],
    ["github (brands)", "fa-brands fa-github", "github", "UI usage: about modal (1x). terax: 1x uses GithubIcon (without 01)"],
    ["windows (brands)", "fa-brands fa-windows", "windows-old", "UI usage: onboarding (1x). terax: 1x"],

    // --- code (general, used as UI icon) ---
    ["code", "fa-solid fa-code", "code", "terax: 3x (generic). File-tree uses simple-icons for per-language"],
];

// Generate the table rows
const rows = PAIRS.map(([faName, faClass, hugeName, note]) => {
    const noteCell = note ? `<td class="note-cell">${note}</td>` : "<td></td>";
    return `<tr>
        <td class="name">${faName}</td>
        <td class="fa-cell"><i class="${faClass}"></i><span class="hint">${faClass}</span></td>
        <td class="hi-cell" data-huge-name="${hugeName}"></td>
        <td class="huge-name">${hugeName}</td>
        ${noteCell}
    </tr>`;
}).join("\n");

const html = `<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <title>Icon migration mock — FA → Hugeicons (UI controls only)</title>
    <link rel="stylesheet" href="https://cdnjs.cloudflare.com/ajax/libs/font-awesome/6.7.2/css/all.min.css">
    <style>
        :root { color-scheme: dark; }
        body {
            background: #0a0a0a;
            color: #e4e4e7;
            font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
            margin: 0;
            padding: 32px;
        }
        h1 { font-size: 20px; font-weight: 600; margin: 0 0 8px; }
        .subtitle { color: #71717a; font-size: 13px; margin-bottom: 24px; }
        table { width: 100%; border-collapse: collapse; font-size: 13px; }
        th {
            text-align: left;
            padding: 8px 12px;
            background: #18181b;
            color: #a1a1aa;
            font-weight: 500;
            font-size: 11px;
            text-transform: uppercase;
            letter-spacing: 0.05em;
            border-bottom: 1px solid #27272a;
            position: sticky;
            top: 0;
        }
        td {
            padding: 10px 12px;
            border-bottom: 1px solid #1f1f23;
            vertical-align: middle;
        }
        .name {
            font-family: ui-monospace, "SF Mono", Menlo, monospace;
            color: #a1a1aa;
            font-size: 12px;
            white-space: nowrap;
        }
        .fa-cell, .hi-cell { font-size: 18px; color: #e4e4e7; min-width: 200px; }
        .huge-name {
            font-family: ui-monospace, "SF Mono", Menlo, monospace;
            color: #71717a;
            font-size: 12px;
            white-space: nowrap;
        }
        .note-cell { color: #71717a; font-size: 11px; line-height: 1.5; max-width: 400px; }
        .hint {
            margin-left: 12px;
            font-family: ui-monospace, "SF Mono", Menlo, monospace;
            color: #52525b;
            font-size: 11px;
        }
        tr td.fa-cell, tr td.hi-cell { font-size: 24px; }
        .note-block {
            background: #18181b;
            border: 1px solid #27272a;
            border-radius: 6px;
            padding: 12px 16px;
            margin-bottom: 24px;
            color: #a1a1aa;
            font-size: 12px;
            line-height: 1.6;
        }
        .note-block strong { color: #e4e4e7; }
        .note-block ul { margin: 6px 0 0 0; padding-left: 20px; }
        .note-block code { background: #27272a; padding: 1px 4px; border-radius: 3px; }
    </style>
</head>
<body>
    <h1>Icon migration mock — FA → Hugeicons (UI controls only)</h1>
    <p class="subtitle">80 unique FA names that appear in crest's JSX.  Each row shows the old FA icon next to the proposed Hugeicons replacement.  Picks are cross-referenced against terax's actual usage.</p>
    <div class="note-block">
        <strong>Scope: UI controls only (not file tree).</strong>
        <ul>
            <li><strong>In scope (this mock):</strong> 80 FA names that appear in crest's <code>frontend/</code> JSX — buttons, toolbars, tabbar, modals, settings, sidebars, navigation.  201 actual FA class usages across 53 files.  This is what the codemod will rewrite.</li>
            <li><strong>Out of scope (not in mock):</strong> 17 FA names that appear <em>only</em> in <code>mimetypes.json</code> / <code>widgets.json</code> (file tree + brand-only): <code>js</code>, <code>golang</code>, <code>rust</code>, <code>dart-lang</code>, <code>markdown</code>, <code>less</code>, <code>sass</code>, <code>css3-alt</code>, <code>html5</code>, <code>dev</code> (oh wait, dev is in scope — used in widget list), <code>file-audio</code>, <code>file-csv</code>, <code>file-image</code>, <code>file-lines</code>, <code>file-pdf</code>, <code>file-video</code>, <code>book-font</code>, <code>square-terminal</code>.  These are already rendered through <code>simple-icons</code> in <code>file-icons.tsx</code> — colored brand SVGs, no migration needed.</li>
        </ul>
        <strong style="display:block; margin-top:8px;">How the migration works:</strong>
        <ul>
            <li>The data layer keeps FA-style strings: <code>"icon": "js fa-brands"</code> stays as-is.  The translation <code>"js" → siJavascript</code> happens in <code>file-icon.ts</code>.</li>
            <li>The JSX layer rewrites: <code>&lt;i className="fa-solid fa-xmark" /&gt;</code> → <code>&lt;Icon name="cancel-01" /&gt;</code>.  The <code>Icon</code> component renders Hugeicons SVG.</li>
        </ul>
    </div>
    <table>
        <thead>
            <tr>
                <th>FA name</th>
                <th>old (FA, 24px)</th>
                <th>new (Hugeicons, 24px)</th>
                <th>Hugeicons name</th>
                <th>note</th>
            </tr>
        </thead>
        <tbody>
            ${rows}
        </tbody>
    </table>

    <script type="module">
        // Import every Hugeicons icon we reference, render them into the cells.
        const imports = await import("https://cdn.jsdelivr.net/npm/@hugeicons/core-free-icons@4.2.2/+esm");
        const cells = document.querySelectorAll(".hi-cell");
        for (const cell of cells) {
            const name = cell.dataset.hugeName;
            const exportName = name
                .split("-")
                .map((s) => s.charAt(0).toUpperCase() + s.slice(1))
                .join("") + "Icon";
            const exportVal = imports[exportName];
            const icon = exportVal?.default ?? exportVal;
            if (!icon) {
                cell.innerHTML = '<span style="color:#f87171">missing: ' + exportName + "</span>";
                continue;
            }
            const size = 24;
            const strokeWidth = 1.5;
            const inner = icon
                .map(([tag, attrs]) => {
                    const a = Object.entries(attrs)
                        .map(([k, v]) => k + '="' + v + '"')
                        .join(" ");
                    return "<" + tag + " " + a + " />";
                })
                .join("");
            cell.innerHTML =
                '<svg xmlns="http://www.w3.org/2000/svg" width="' + size + '" height="' + size +
                '" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="' + strokeWidth +
                '" stroke-linecap="round" stroke-linejoin="round">' + inner + "</svg>";
        }
    </script>
</body>
</html>
`;

const outPath = join(process.cwd(), "icon-mock.html");
writeFileSync(outPath, html);
console.log("Wrote " + outPath);
console.log("UI control icons: " + PAIRS.length);
console.log("Open in browser to review the side-by-side mapping.");