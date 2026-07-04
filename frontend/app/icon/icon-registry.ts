// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0
//
// Icon registry — the single source-of-truth for Hugeicons names
// available to crest.  All names use the kebab-case Hugeicons
// convention (`arrow-down-01`, NOT `ArrowDown01` and NOT `fa-arrow-down`).
//
// Why a registry instead of letting callers import individual icons:
//   - The kebab string is the canonical "icon name" used in data
//     layers (mimetypes.json, settings, widget.icon, terminal
//     metadata).  Centralizing the name→component map means swapping
//     to a different icon family (e.g. lucide, phosphor) is a
//     single-file change.
//   - Icon picks are cross-referenced with terax's actual usage so
//     crest stays visually consistent with the reference app.  See
//     scripts/generate-icon-mock.ts for the FA → Hugeicons mapping
//     table and per-pick rationale.
//
// Adding a new icon:
//   1. Find the kebab name in @hugeicons/core-free-icons (or on
//      https://hugeicons.com).  Kebab = lower-camel → dash-split
//      (ArrowDown01 → arrow-down-01).
//   2. Import the icon here and add it to the REGISTRY map.
//   3. Use via <Icon name="arrow-down-01" />.

import {
    Add01Icon,
    AddSquareIcon,
    AiContentGenerator02Icon,
    Alert02Icon,
    AlertCircleIcon,
    AlertDiamondIcon,
    AntennaIcon,
    ArrowDown01Icon,
    ArrowExpand01Icon,
    ArrowLeft01Icon,
    ArrowRight01Icon,
    ArrowShrink01Icon,
    ArrowTurnBackwardIcon,
    ArrowUp01Icon,
    ArrowUpIcon,
    ArrowUpRight01Icon,
    AsteriskIcon,
    BellIcon,
    BellOffIcon,
    Book01Icon,
    BoxIcon,
    Brain01Icon,
    Bug01Icon,
    Cancel01Icon,
    CancelCircleIcon,
    CellularNetworkIcon,
    ChartLineData02Icon,
    ChatGptIcon,
    CheckListIcon,
    CheckmarkCircle01Icon,
    CheckmarkCircle02Icon,
    CheckmarkSquare02Icon,
    ChevronDownIcon,
    ChevronLeftIcon,
    ChevronRightIcon,
    ChevronUpIcon,
    CircleIcon,
    ClaudeIcon,
    Clock01Icon,
    CodeIcon,
    ColorPickerIcon,
    CommandIcon,
    CommandLineIcon,
    ComputerIcon,
    ComputerTerminal02Icon,
    CopyIcon,
    CpuIcon,
    CubeIcon,
    Delete02Icon,
    DiamondIcon,
    DiscordIcon,
    Dollar01Icon,
    Drag01Icon,
    Download01Icon,
    Edit02Icon,
    EllipsisVerticalIcon,
    ExpandIcon,
    EyeIcon,
    File01Icon,
    FileAddIcon,
    FileCodeIcon,
    FileEditIcon,
    FilePenIcon,
    FilePlusIcon,
    FloppyDiskIcon,
    Folder01Icon,
    FolderAddIcon,
    FolderCloudIcon,
    FolderGitTwoIcon,
    FolderOpenIcon,
    FolderShared01Icon,
    GithubIcon,
    GitBranchIcon,
    GitPullRequestIcon,
    Globe02Icon,
    GlobeIcon,
    GoogleGeminiIcon,
    Grid02Icon,
    Grid2X2Icon,
    HammerIcon,
    HashtagIcon,
    HeartIcon,
    Home03Icon,
    InformationCircleIcon,
    Key01Icon,
    KeyboardIcon,
    Link01Icon,
    Link02Icon,
    LinkSquare01Icon,
    LinkSquare02Icon,
    ListTreeIcon,
    ListViewIcon,
    Loading01Icon,
    Loading03Icon,
    LockIcon,
    Mail01Icon,
    MapPinIcon,
    Menu01Icon,
    Message01Icon,
    Mic01Icon,
    Minimize01Icon,
    MinusSignIcon,
    MobileProgramming01Icon,
    Moon02Icon,
    MoreHorizontalCircle01Icon,
    MoreHorizontalIcon,
    Package01Icon,
    PaintBoardIcon,
    Pen01Icon,
    PencilIcon,
    PieChartIcon,
    PlusSignIcon,
    PlusSignCircleIcon,
    Refresh01Icon,
    Rocket01Icon,
    RotateRight01Icon,
    SaveIcon,
    Search01Icon,
    SearchAddIcon,
    SearchIcon,
    SearchMinusIcon,
    SecurityIcon,
    Settings01Icon,
    Share01Icon,
    Shield01Icon,
    ShieldBanIcon,
    ShoppingBag01Icon,
    SidebarLeftIcon,
    SidebarRight01Icon,
    SlidersHorizontalIcon,
    SmartPhone01Icon,
    WifiOff01Icon,
    SmileIcon,
    SortByDown01Icon,
    SortByUp01Icon,
    SourceCodeIcon,
    SparklesIcon,
    SquareIcon,
    Sun03Icon,
    TableColumnsSplitIcon,
    TableRowsSplitIcon,
    Tag01Icon,
    TerminalIcon,
    Tick02Icon,
    ToolsIcon,
    Tree01Icon,
    Triangle01Icon,
    UnfoldMoreIcon,
    Upload01Icon,
    UserGroupIcon,
    Video01Icon,
    ViewIcon,
    ViewOffSlashIcon,
    VolumeHighIcon,
    VolumeMute01Icon,
    WindowsOldIcon,
    Wrench01Icon,
    ZoomInAreaIcon,
    ZoomOutAreaIcon,
} from "@hugeicons/core-free-icons";

import { resolveIconName } from "./icon-aliases";

// IconSvgObject is declared in @hugeicons/core-free-icons' types but
// not exported.  Define the equivalent shape here so callers can type
// the result of getIconByName() without re-declaring the tuple
// structure.  Mirrors the readonly tuple form of Hugeicons' internal
// IconSvgObject (see node_modules/@hugeicons/core-free-icons/dist/
// types/index.d.ts).
export type IconComponent = readonly (readonly [string, { readonly [key: string]: string | number }])[];

// The registry: kebab-case Hugeicons name → icon component.  Order is
// roughly "most used first" so visual scans of the file land on the
// common cases.  Each entry has a // terax: Nx comment when terax
// uses that icon, so it's obvious which picks are the "established"
// ones vs crest-only additions.
const REGISTRY: Record<string, IconComponent> = {
    // --- navigation / arrows ---
    "arrow-down-01": ArrowDown01Icon, // terax: 12x (dominant down-arrow)
    "arrow-up-01": ArrowUp01Icon, // terax: 3x
    "arrow-up": ArrowUpIcon, // terax: 1x (variant, no-01)
    "arrow-left-01": ArrowLeft01Icon, // terax: 1x
    "arrow-right-01": ArrowRight01Icon, // terax: 11x (dominant right-arrow)
    "arrow-up-right-01": ArrowUpRight01Icon, // terax: 2x
    "arrow-turn-backward": ArrowTurnBackwardIcon, // terax: 2x (for "swap" / "go back")
    "arrow-expand-01": ArrowExpand01Icon,
    "arrow-shrink-01": ArrowShrink01Icon,
    "minimize-01": Minimize01Icon,
    "chevron-down": ChevronDownIcon,
    "chevron-up": ChevronUpIcon,
    "chevron-left": ChevronLeftIcon,
    "chevron-right": ChevronRightIcon,
    "unfold-more": UnfoldMoreIcon, // terax: 1x
    "rotate-right-01": RotateRight01Icon,

    // --- file / folder ---
    "file-01": File01Icon, // terax: 3x
    "file-code": FileCodeIcon,
    "file-edit": FileEditIcon, // terax: 4x (NOT FilePenIcon — same shape, different name)
    "file-pen": FilePenIcon,
    "file-plus": FilePlusIcon, // terax: 3x
    "file-add": FileAddIcon, // terax: 1x
    "folder-01": Folder01Icon, // terax: 7x (dominant)
    "folder-open": FolderOpenIcon, // terax: 1x
    "folder-add": FolderAddIcon, // terax: 4x (specific icon, NOT Folder01)
    "folder-cloud": FolderCloudIcon, // terax: 1x (source control fetch)
    "folder-git-two": FolderGitTwoIcon, // terax: 1x (source control branch)
    "folder-shared-01": FolderShared01Icon,
    "floppy-disk": FloppyDiskIcon,
    "save": SaveIcon,
    "tag-01": Tag01Icon,

    // --- ui actions ---
    "search-01": Search01Icon, // terax: 7x (the dominant search)
    "search": SearchIcon, // terax: 1x
    "search-add": SearchAddIcon, // FA fa-magnifying-glass-plus: search with + (zoom-in)
    "search-minus": SearchMinusIcon,
    "zoom-in-area": ZoomInAreaIcon,
    "zoom-out-area": ZoomOutAreaIcon,
    "plus-sign": PlusSignIcon, // terax: 3x
    "plus-sign-circle": PlusSignCircleIcon,
    "add-01": Add01Icon, // terax: 4x (the "add" semantic icon)
    "add-square": AddSquareIcon,
    "minus-sign": MinusSignIcon, // terax: 2x
    "cancel-01": Cancel01Icon, // terax: 17x (the dominant cancel/close)
    "cancel-circle": CancelCircleIcon,
    "tick-02": Tick02Icon, // terax: 14x (the dominant checkmark)
    "checkmark-circle-01": CheckmarkCircle01Icon, // terax: 3x
    "checkmark-circle-02": CheckmarkCircle02Icon, // terax: 4x
    "checkmark-square-02": CheckmarkSquare02Icon,
    "check-list": CheckListIcon, // terax: 2x
    "edit-02": Edit02Icon, // terax: 5x
    "pen-01": Pen01Icon,
    "pencil": PencilIcon,
    "copy": CopyIcon,
    "trash": Delete02Icon, // terax: 5x (uses Delete02, NOT Delete01)
    "delete-02": Delete02Icon, // alias
    "download-01": Download01Icon, // terax: 2x
    "upload-01": Upload01Icon,
    "share-01": Share01Icon,
    "menu-01": Menu01Icon,
    "ellipsis-vertical": EllipsisVerticalIcon,
    "more-horizontal": MoreHorizontalIcon, // FA fa-ellipsis: 3 horizontal dots
    "more-horizontal-circle-01": MoreHorizontalCircle01Icon, // terax: 1x
    "sort-by-down-01": SortByDown01Icon,
    "sort-by-up-01": SortByUp01Icon,
    "loading-01": Loading01Icon,
    "loading-03": Loading03Icon, // terax: 2x (the loading animation they actually use)
    "refresh-01": Refresh01Icon, // terax: 5x
    "expand": ExpandIcon,
    "square": SquareIcon,

    // --- feedback / status ---
    "alert-circle": AlertCircleIcon, // terax: 3x
    "alert-02": Alert02Icon, // terax: 2x (different shape from AlertCircle, used for "warning")
    "alert-diamond": AlertDiamondIcon,
    "information-circle": InformationCircleIcon, // terax: 1x
    "triangle-01": Triangle01Icon,
    "circle": CircleIcon,
    "diamond": DiamondIcon,
    "checkmark": Tick02Icon, // alias

    // --- provider / brand glyphs (provider settings cards, not in regular nav) ---
    "chat-gpt": ChatGptIcon, // OpenAI provider icon
    "claude": ClaudeIcon, // Anthropic provider icon
    "google-gemini": GoogleGeminiIcon, // Google Gemini provider icon
    "globe": GlobeIcon, // OpenRouter (aggregator) — simpler globe, NOT globe-02
    "view": ViewIcon, // password reveal
    "view-off-slash": ViewOffSlashIcon, // password hide

    // --- content / tools ---
    "code": CodeIcon, // terax: 3x (generic)
    "source-code": SourceCodeIcon, // terax: 2x (for "code in editor" context — different shape)
    "command-line": CommandLineIcon, // terax: 3x
    "command": CommandIcon, // terax: 2x
    "terminal": TerminalIcon, // terax: 10x (the dominant terminal icon)
    // ComputerTerminal02Icon is the "monitor + terminal window" shape
    // terax uses for terminal tabs in its SpaceSwitcher.  The plain
    // TerminalIcon above renders as a `>_` prompt glyph which reads as
    // a command-line character at 14px — too noisy in tab lists.
    "computer-terminal-02": ComputerTerminal02Icon,
    "hashtag": HashtagIcon, // terax: 2x
    "asterisk": AsteriskIcon,
    "tree-01": Tree01Icon,
    "list-tree": ListTreeIcon,
    "list-view": ListViewIcon,
    "sliders-horizontal": SlidersHorizontalIcon,
    "palette": PaintBoardIcon, // terax: 2x (uses PaintBoard for "color palette" concept)
    "paint-board": PaintBoardIcon,
    "color-picker": ColorPickerIcon, // alternative for fa-palette (color selection)
    "wrench-01": Wrench01Icon,
    "hammer": HammerIcon,
    "key-01": Key01Icon, // terax: 1x
    "lock": LockIcon,
    "shield-01": Shield01Icon,
    "shield-ban": ShieldBanIcon, // FA fa-shield: shield with X mark (broken shield)
    "link-01": Link01Icon,
    "link-02": Link02Icon,
    "link-square-01": LinkSquare01Icon,
    "link-square-02": LinkSquare02Icon, // terax: 2x (preferred over plain Link01)
    "settings-01": Settings01Icon, // terax: 5x
    "sparkles": SparklesIcon, // terax: 6x
    "ai-content-generator-02": AiContentGenerator02Icon, // terax: 1x (source control AI commit)
    "eye": EyeIcon,
    "tools": ToolsIcon, // terax: 2x
    "mic-01": Mic01Icon, // terax: 2x

    // --- system / shell ---
    "cube": CubeIcon,
    "box": BoxIcon, // FA fa-box: flat 3D box outline (different from cube's depth lines)
    "grid-02": Grid02Icon,
    "grid-2-x2": Grid2X2Icon, // FA fa-grid-2: actual 2x2 grid
    "table-columns-split": TableColumnsSplitIcon,
    "table-rows-split": TableRowsSplitIcon,
    "sidebar-left": SidebarLeftIcon, // terax: 2x (uses SidebarLeft WITHOUT 01)
    "sidebar-right-01": SidebarRight01Icon,
    "windows-old": WindowsOldIcon, // terax: 1x
    "smart-phone-01": SmartPhone01Icon,
    "mobile-programming-01": MobileProgramming01Icon,
    "wifi-off-01": WifiOff01Icon,
    "computer": ComputerIcon, // terax: 3x (uses Computer for "laptop" semantic)

    // --- network / connectivity ---
    "globe-02": Globe02Icon, // terax: 5x
    "github": GithubIcon, // terax: 1x (uses raw Github, NOT Github01)
    "git-pull-request": GitPullRequestIcon, // FA fa-code-pull-request / fa-pull-request
    "cellular-network": CellularNetworkIcon,
    "antenna": AntennaIcon,
    "mail-01": Mail01Icon,
    "message-01": Message01Icon, // terax: 1x
    "rocket-01": Rocket01Icon,
    "video-01": Video01Icon,
    "discord": DiscordIcon,

    // --- people / account ---
    "user-group": UserGroupIcon,
    "smile": SmileIcon,
    "book-01": Book01Icon,
    "heart": HeartIcon,
    "shopping-bag-01": ShoppingBag01Icon,
    "map-pin": MapPinIcon,
    "dollar-01": Dollar01Icon,

    // --- charts / data ---
    "chart-line-data-02": ChartLineData02Icon,
    "pie-chart": PieChartIcon,
    "cpu": CpuIcon, // settings tab "Models" — compute provider catalog
    "keyboard": KeyboardIcon, // settings tab "Shortcuts" — keyboard binding
    "brain-01": Brain01Icon, // settings tab "Agents" — AI persona

    // --- time ---
    "clock-01": Clock01Icon, // terax: 4x

    // --- security / debug ---
    "security": SecurityIcon,
    "bug-01": Bug01Icon,

    // --- theme ---
    "sun-03": Sun03Icon, // terax: 1x (uses Sun03, NOT Sun01)
    "moon-02": Moon02Icon, // terax: 1x (uses Moon02, NOT Moon01)

    // --- volume ---
    "volume-high": VolumeHighIcon,
    "volume-mute-01": VolumeMute01Icon, // FA fa-volume-xmark: speaker with X (real mute)
    // "mute" alias removed — was mapping to MuteIcon (a smiley face), not the actual
    // speaker-mute.  Use volume-mute-01 explicitly.

    // --- aliases for FA names that crest's legacy data uses. ---
    // The kebab entries above are the *canonical* Hugeicons names.
    // `getIconByName()` first routes through resolveIconName() (in
    // icon-aliases.ts) which maps FA-style names to these kebab
    // entries.  So callers can pass either "xmark" (legacy FA) OR
    // "cancel-01" (canonical Hugeicons) and get the same icon.
    //
    // The handful of entries below are pure alias duplicates —
    // hugeicons-form name that also matches a legacy FA name without
    // any translation.  They live here only to make the docs explicit.
    "bell": BellIcon,
    "house": Home03Icon,
    "home-03": Home03Icon,
    "home-01": Home03Icon,
    "house-01": Home03Icon,
    // Newly added for crest's iconographic breadth — these are pure
    // canonical entries that mirror the kebab form found elsewhere in
    // this map:
    "package-01": Package01Icon,
    "bell-off-01": BellOffIcon,
    "drag-01": Drag01Icon,
    "git-branch-01": GitBranchIcon,
};

// Look up an icon by its kebab-case Hugeicons name.  Returns null when
// the name is not in the registry — callers should treat that as
// "render nothing" or fall back to a generic icon, not crash.  This
// shape (null | component) is friendlier than throwing because the
// icon name often comes from user-editable config.
//
// FA-style names are auto-resolved through FA_TO_HUGEICONS before
// lookup (see icon-aliases.ts).  Pass either form.
export function getIconByName(name: string): IconComponent | null {
    const resolved = resolveIconName(name);
    return REGISTRY[resolved] ?? null;
}

// List every registered name.  Used by the settings UI's icon picker
// (if we ever add one) and by tests.  Sorted alphabetically so the
// output is stable across runs.
export function listRegisteredIconNames(): string[] {
    return Object.keys(REGISTRY).sort();
}

// Type-level guarantee that callers pass a registered name.  This
// stops typos like `<Icon name="chevron-dwon" />` from silently
// rendering nothing in production — TS catches them at build time.
export type RegisteredIconName = keyof typeof REGISTRY;