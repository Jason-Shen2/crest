// Based on assistant-ui (MIT): https://r.assistant-ui.com/thread.json
"use client";

import { Button } from "@/shadcn/ui/button";
import { cn } from "@/util/util";
import {
    ActionBarMorePrimitive,
    ActionBarPrimitive,
    AuiIf,
    BranchPickerPrimitive,
    ComposerPrimitive,
    ErrorPrimitive,
    groupPartByType,
    MessagePrimitive,
    SelectionToolbarPrimitive,
    SuggestionPrimitive,
    ThreadPrimitive,
    unstable_useComposerInputHistory,
    unstable_useSlashCommandAdapter,
    unstable_useTriggerPopoverScopeContext,
    useAui,
    useAuiState,
    type AssistantState,
    type ImageMessagePartProps,
    type ToolCallMessagePartComponent,
    type Unstable_TriggerItem,
} from "@assistant-ui/react";
import {
    ArrowDownIcon,
    ArrowUpIcon,
    CheckIcon,
    ChevronLeftIcon,
    ChevronRightIcon,
    CopyIcon,
    DownloadIcon,
    FolderTreeIcon,
    GitForkIcon,
    HistoryIcon,
    InfoIcon,
    MicIcon,
    Minimize2Icon,
    MoreHorizontalIcon,
    PencilIcon,
    PlusIcon,
    QuoteIcon,
    RefreshCwIcon,
    Settings2Icon,
    SquareIcon,
    UploadIcon,
    XIcon,
} from "lucide-react";
import {
    createContext,
    memo,
    useCallback,
    useContext,
    useEffect,
    useMemo,
    useRef,
    useState,
    type ComponentType,
    type FC,
    type PropsWithChildren,
    type DragEvent as ReactDragEvent,
    type ReactNode,
    type RefObject,
} from "react";
import { ComposerAddAttachment, ComposerAttachments, UserMessageAttachments } from "./attachment";
import { ContextDisplayRing, type CrestContextUsage } from "./context-display";
import { ContextProjectionBadge } from "./context-projection-badge";
import { getCrestImageAlt, getCrestToolRenderer } from "./crest-message";
import { ThreadFollowupSuggestions } from "./follow-up-suggestions";
import { MarkdownText } from "./markdown-text";
import { Reasoning, ReasoningContent, ReasoningRoot, ReasoningText, ReasoningTrigger } from "./reasoning";
import { ToolGroupContent, ToolGroupRoot, ToolGroupTrigger } from "./tool-group";
import { ToolFallback } from "./tools/tool-fallback";
import { TooltipIconButton } from "./tooltip-icon-button";

export type ThreadGroupPart = MessagePrimitive.GroupedParts.GroupPart;

/**
 * Optional component overrides for the thread. `AssistantMessage` and
 * `Welcome` replace whole sections; the remaining slots override how the
 * assistant message renders tool calls and part groups. Tool UIs registered
 * by name (toolkit `render`, `useAssistantDataUI`) take precedence over
 * `ToolFallback`.
 */
export type ThreadComponents = {
    AssistantMessage?: ComponentType | undefined;
    Welcome?: ComponentType | undefined;
    ToolFallback?: ToolCallMessagePartComponent | undefined;
    ToolGroup?: ComponentType<PropsWithChildren<{ group: ThreadGroupPart }>> | undefined;
    ReasoningGroup?: ComponentType<PropsWithChildren<{ group: ThreadGroupPart }>> | undefined;
};

export type ThreadProps = {
    components?: ThreadComponents | undefined;
    modelLabel?: string | undefined;
    onOpenModelPicker?: (() => void) | undefined;
    contextUsage?: CrestContextUsage | undefined;
    modelContextWindow?: number | undefined;
    beforeComposer?: ReactNode | undefined;
    composerAnchorRef?: RefObject<HTMLDivElement | null> | undefined;
    hideScrollToBottom?: boolean | undefined;
};

const EMPTY_COMPONENTS: ThreadComponents = {};

export const ComposerContext = createContext<
    Pick<ThreadProps, "modelLabel" | "onOpenModelPicker" | "contextUsage" | "modelContextWindow">
>({});
const ThreadComponentsContext = createContext<ThreadComponents>(EMPTY_COMPONENTS);
const ThreadExtrasContext = createContext<
    Pick<ThreadProps, "beforeComposer" | "composerAnchorRef" | "hideScrollToBottom">
>({});
const DefaultAssistantPartGrouping = groupPartByType<"group-chainOfThought" | "group-reasoning" | "group-tool">({
    reasoning: ["group-chainOfThought", "group-reasoning"],
    "tool-call": ["group-chainOfThought", "group-tool"],
    "standalone-tool-call": [],
});

function groupCrestAssistantPart(
    part: Parameters<typeof DefaultAssistantPartGrouping>[0],
    context?: Parameters<typeof DefaultAssistantPartGrouping>[1]
) {
    if (part.type === "tool-call" && (part.toolName === "edit" || part.toolName === "write")) return [];
    return DefaultAssistantPartGrouping(part, context);
}

// Startup exposes a loading placeholder thread; treat it as a new chat so
// the composer mounts centered. Loads after startup keep the docked layout.
const isNewChatView = (s: AssistantState) =>
    s.thread.messages.length === 0 && (!s.thread.isLoading || s.threads.isLoading);

export const Thread: FC<ThreadProps> = ({
    components = EMPTY_COMPONENTS,
    modelLabel,
    onOpenModelPicker,
    contextUsage,
    modelContextWindow,
    beforeComposer,
    composerAnchorRef,
    hideScrollToBottom,
}) => {
    const isEmpty = useAuiState(isNewChatView);

    return (
        <ThreadComponentsContext.Provider value={components}>
            <ComposerContext.Provider value={{ modelLabel, onOpenModelPicker, contextUsage, modelContextWindow }}>
                <ThreadExtrasContext.Provider value={{ beforeComposer, composerAnchorRef, hideScrollToBottom }}>
                    <ThreadRoot isEmpty={isEmpty} />
                </ThreadExtrasContext.Provider>
            </ComposerContext.Provider>
        </ThreadComponentsContext.Provider>
    );
};

const ThreadRoot: FC<{ isEmpty: boolean }> = ({ isEmpty }) => {
    const { Welcome = ThreadWelcome } = useContext(ThreadComponentsContext);
    const { beforeComposer, composerAnchorRef, hideScrollToBottom } = useContext(ThreadExtrasContext);

    return (
        <ThreadPrimitive.Root
            className="aui-root aui-thread-root bg-background @container flex h-full flex-col"
            data-testid="crest-thread"
            style={{
                ["--thread-max-width" as string]: "44rem",
                ["--composer-bg" as string]: "var(--color-background)",
                ["--composer-radius" as string]: "1.5rem",
                ["--composer-padding" as string]: "8px",
            }}
        >
            <ThreadPrimitive.Viewport
                turnAnchor="top"
                data-slot="aui_thread-viewport"
                className="relative flex flex-1 flex-col overflow-x-auto overflow-y-scroll scroll-smooth"
            >
                <div
                    className={cn(
                        "mx-auto flex w-full max-w-(--thread-max-width) flex-1 flex-col px-4 pt-4",
                        isEmpty && "justify-center"
                    )}
                >
                    <AuiIf condition={isNewChatView}>
                        <Welcome />
                    </AuiIf>

                    <div data-slot="aui_message-group" className="mb-14 flex flex-col gap-y-6 empty:hidden">
                        <ThreadPrimitive.Messages>{() => <ThreadMessage />}</ThreadPrimitive.Messages>
                    </div>

                    <ThreadPrimitive.ViewportFooter
                        className={cn(
                            "aui-thread-viewport-footer bg-background flex flex-col gap-4 overflow-visible pb-4 md:pb-6",
                            !isEmpty && "sticky bottom-0 mt-auto rounded-t-(--composer-radius)"
                        )}
                    >
                        {!hideScrollToBottom && <ThreadScrollToBottom />}
                        <div ref={composerAnchorRef} className="flex flex-col gap-4">
                            <ThreadFollowupSuggestions />
                            <div className="aui-composer-before-panel-stack flex flex-col gap-2">
                                {beforeComposer}
                                <Composer />
                            </div>
                            <AuiIf condition={(s) => isNewChatView(s) && s.composer.isEmpty}>
                                <ThreadSuggestions />
                            </AuiIf>
                        </div>
                    </ThreadPrimitive.ViewportFooter>
                </div>
                <MessageSelectionToolbar />
            </ThreadPrimitive.Viewport>
        </ThreadPrimitive.Root>
    );
};

const MessageSelectionToolbar: FC = () => {
    const [mounted, setMounted] = useState(false);
    useEffect(() => {
        setMounted(true);
    }, []);
    if (!mounted) return null;
    return (
        <SelectionToolbarPrimitive.Root className={SelectionToolbarRootClassName}>
            <SelectionToolbarPrimitive.Quote asChild>
                <button type="button" className={SelectionToolbarQuoteClassName} aria-label="Quote selected text">
                    <QuoteIcon className={SelectionToolbarQuoteIconClassName} />
                    <span className="sr-only">Quote selected text</span>
                </button>
            </SelectionToolbarPrimitive.Quote>
        </SelectionToolbarPrimitive.Root>
    );
};

const ThreadMessage: FC = () => {
    const { AssistantMessage: AssistantMessageComponent = AssistantMessage } = useContext(ThreadComponentsContext);
    const role = useAuiState((s) => s.message.role);
    const isEditing = useAuiState((s) => s.message.composer.isEditing);

    if (isEditing) return <EditComposer />;
    if (role === "user") return <UserMessage />;
    return <AssistantMessageComponent />;
};

const ThreadScrollToBottom: FC = () => {
    return (
        <ThreadPrimitive.ScrollToBottom asChild>
            <TooltipIconButton
                tooltip="Scroll to bottom"
                variant="outline"
                className="aui-thread-scroll-to-bottom dark:border-border dark:bg-background dark:hover:bg-accent absolute -top-12 z-10 self-center rounded-full p-4 disabled:invisible"
            >
                <ArrowDownIcon />
            </TooltipIconButton>
        </ThreadPrimitive.ScrollToBottom>
    );
};

const ThreadWelcome: FC = () => {
    return (
        <div className="aui-thread-welcome-root mb-6 flex flex-col items-center px-4 text-center">
            <h1 className="aui-thread-welcome-message-inner fade-in slide-in-from-bottom-1 animate-in fill-mode-both text-2xl font-semibold duration-200">
                How can I help you today?
            </h1>
        </div>
    );
};

const ThreadSuggestions: FC = () => {
    return (
        <div className="aui-thread-welcome-suggestions flex w-full flex-wrap items-center justify-center gap-2 px-4">
            <ThreadPrimitive.Suggestions>{() => <ThreadSuggestionItem />}</ThreadPrimitive.Suggestions>
        </div>
    );
};

const ThreadSuggestionItem: FC = () => {
    return (
        <div className="aui-thread-welcome-suggestion-display fade-in slide-in-from-bottom-2 animate-in fill-mode-both duration-200">
            <SuggestionPrimitive.Trigger send asChild>
                <Button
                    variant="ghost"
                    className="aui-thread-welcome-suggestion text-foreground hover:bg-muted border-border/60 h-auto gap-1.5 rounded-full border px-3.5 py-1.5 text-sm font-normal whitespace-nowrap transition-colors"
                >
                    <SuggestionPrimitive.Title className="aui-thread-welcome-suggestion-text-1" />
                    <SuggestionPrimitive.Description className="aui-thread-welcome-suggestion-text-2 empty:hidden" />
                </Button>
            </SuggestionPrimitive.Trigger>
        </div>
    );
};

type SlashCommandDef = {
    id: string;
    label: string;
    description: string;
    icon: string;
};

const SLASH_COMMANDS: SlashCommandDef[] = [
    { id: "tree", label: "/tree", description: "Browse and navigate the session tree", icon: "FolderTree" },
    { id: "fork", label: "/fork", description: "Create a fork from a previous message", icon: "GitFork" },
    { id: "clone", label: "/clone", description: "Clone the current session", icon: "Copy" },
    { id: "model", label: "/model", description: "Change the AI model", icon: "Settings2" },
    { id: "new", label: "/new", description: "Start a new session", icon: "Plus" },
    { id: "compact", label: "/compact", description: "Compact the conversation context", icon: "Minimize2" },
    { id: "session", label: "/session", description: "Manage, resume, or reference sessions", icon: "History" },
    { id: "info", label: "/info", description: "Show current session information", icon: "Info" },
    { id: "copy", label: "/copy", description: "Copy the current session", icon: "Copy" },
    { id: "export", label: "/export", description: "Export the session as markdown", icon: "Download" },
    { id: "import", label: "/import", description: "Import a session from markdown", icon: "Upload" },
    { id: "reload", label: "/reload", description: "Reload the current session", icon: "RefreshCw" },
];

const SLASH_ICON_MAP = {
    FolderTree: FolderTreeIcon,
    GitFork: GitForkIcon,
    Copy: CopyIcon,
    Settings2: Settings2Icon,
    Plus: PlusIcon,
    History: HistoryIcon,
    Minimize2: Minimize2Icon,
    Info: InfoIcon,
    Download: DownloadIcon,
    Upload: UploadIcon,
    RefreshCw: RefreshCwIcon,
};

const SlashCommandPopoverClassName =
    "bg-[rgba(34,34,36,0.62)] text-popover-foreground absolute bottom-full left-0 z-50 mb-2 w-full overflow-hidden rounded-2xl border border-white/[0.12] p-1 shadow-[0_10px_32px_-24px_rgba(0,0,0,0.65)] backdrop-blur-2xl backdrop-saturate-150";
const SlashCommandScrollAreaClassName =
    "max-h-64 overflow-y-auto pr-1 [scrollbar-color:transparent_transparent] [scrollbar-width:none] [&::-webkit-scrollbar]:w-1.5 [&::-webkit-scrollbar-track]:bg-transparent [&::-webkit-scrollbar-thumb]:rounded-full [&::-webkit-scrollbar-thumb]:bg-transparent [&::-webkit-scrollbar-thumb:hover]:bg-transparent data-[scrolling=true]:[scrollbar-color:rgba(255,255,255,0.22)_transparent] data-[scrolling=true]:[scrollbar-width:thin] data-[scrolling=true]:[&::-webkit-scrollbar-thumb]:bg-white/20 data-[scrolling=true]:[&::-webkit-scrollbar-thumb:hover]:bg-white/30";
const SlashCommandItemClassName =
    "group flex w-full cursor-pointer items-center gap-2.5 rounded-xl px-2.5 py-2 text-left text-sm outline-none hover:bg-white/[0.06] data-[highlighted]:bg-white/[0.10] [&:focus-visible]:outline-none [&::-moz-focus-inner]:border-0";
const SlashCommandIconClassName =
    "text-secondary flex size-7 shrink-0 items-center justify-center rounded-lg bg-white/[0.06] group-data-[highlighted]:bg-white/[0.12] group-data-[highlighted]:text-foreground group-hover:bg-white/[0.10] group-hover:text-foreground";
const SelectionToolbarRootClassName =
    "aui-selection-toolbar bg-[rgba(24,24,26,0.46)] text-popover-foreground z-50 flex items-center rounded-[0.95rem] border border-white/[0.07] p-[2px] shadow-[0_8px_18px_-16px_rgba(0,0,0,0.70)] backdrop-blur-xl backdrop-saturate-150";
const SelectionToolbarQuoteClassName =
    "aui-selection-toolbar-quote flex size-7 cursor-pointer items-center justify-center rounded-[0.8rem] text-secondary/80 outline-none transition-[background-color,color,transform,opacity] duration-100 hover:bg-white/[0.07] hover:text-foreground active:scale-95 disabled:pointer-events-none disabled:opacity-50";
const SelectionToolbarQuoteIconClassName = "size-3.5 shrink-0 stroke-[1.75]";
const AssistantActionBarMoreContentClassName =
    "aui-action-bar-more-content bg-[rgba(34,34,36,0.82)] text-popover-foreground data-[state=open]:fade-in-0 data-[state=open]:zoom-in-95 data-[state=open]:animate-in data-[state=closed]:fade-out-0 data-[state=closed]:zoom-out-95 data-[state=closed]:animate-out data-[side=bottom]:slide-in-from-top-1 data-[side=left]:slide-in-from-right-1 data-[side=right]:slide-in-from-left-1 data-[side=top]:slide-in-from-bottom-1 z-50 min-w-[11rem] overflow-hidden rounded-xl border border-white/[0.08] p-1 shadow-[0_10px_32px_-24px_rgba(0,0,0,0.65)] backdrop-blur-xl";
const AssistantActionBarMoreItemClassName =
    "aui-action-bar-more-item flex h-8 cursor-pointer items-center gap-2 rounded-md border-0 bg-transparent px-2 text-sm text-secondary outline-none select-none hover:bg-fg-overlay-1 hover:text-foreground focus:bg-fg-overlay-1 focus:text-foreground data-[highlighted]:bg-fg-overlay-1 data-[highlighted]:text-foreground";
const AssistantActionBarMoreIconClassName = "size-3.5 shrink-0";
const ComposerDropzoneShellClassName =
    "border-border/60 data-[dragging=true]:border-ring focus-within:border-border dark:border-muted-foreground/15 dark:focus-within:border-muted-foreground/30 flex w-full flex-col gap-2 rounded-(--composer-radius) border bg-(--composer-bg) p-(--composer-padding) shadow-[0_4px_16px_-8px_rgba(0,0,0,0.08),0_1px_2px_rgba(0,0,0,0.04)] transition-[border-color,box-shadow] focus-within:shadow-[0_6px_24px_-8px_rgba(0,0,0,0.12),0_1px_2px_rgba(0,0,0,0.05)] data-[dragging=true]:border-dashed data-[dragging=true]:bg-[color-mix(in_oklab,var(--color-accent)_50%,var(--color-background))] dark:shadow-none";

type SlashCommandScrollBounds = {
    currentScrollTop: number;
    maxScrollTop: number;
    itemTop: number;
    itemBottom: number;
    viewportTop: number;
    viewportBottom: number;
    margin: number;
};

const SlashCommandScrollMargin = 8;
const SlashCommandKeyboardKeys = new Set(["ArrowUp", "ArrowDown", "Home", "End", "PageUp", "PageDown"]);

type ComposerDragAction = "enter" | "leave" | "drop" | "reset";

function getNextComposerDragDepth(currentDepth: number, action: ComposerDragAction): number {
    if (action === "enter") return currentDepth + 1;
    if (action === "leave") return Math.max(0, currentDepth - 1);
    return 0;
}

function getComposerDragFiles(dataTransfer: DataTransfer | null | undefined): File[] {
    return Array.from(dataTransfer?.files ?? []);
}

function hasComposerDragFiles(dataTransfer: DataTransfer | null | undefined): boolean {
    const types = Array.from(dataTransfer?.types ?? []);
    return types.includes("Files") || getComposerDragFiles(dataTransfer).length > 0;
}

function getSlashCommandScrollTop(bounds: SlashCommandScrollBounds): number | null {
    const topLimit = bounds.viewportTop + bounds.margin;
    const bottomLimit = bounds.viewportBottom - bounds.margin;
    let nextScrollTop: number | null = null;

    if (bounds.itemTop < topLimit) {
        nextScrollTop = bounds.currentScrollTop + bounds.itemTop - topLimit;
    } else if (bounds.itemBottom > bottomLimit) {
        nextScrollTop = bounds.currentScrollTop + bounds.itemBottom - bottomLimit;
    }
    if (nextScrollTop == null) return null;

    const clampedScrollTop = Math.min(bounds.maxScrollTop, Math.max(0, nextScrollTop));
    if (Math.abs(clampedScrollTop - bounds.currentScrollTop) < 1) return null;
    return clampedScrollTop;
}

function scrollSlashCommandItemIntoView(itemEl: HTMLElement, containerEl: HTMLElement | null) {
    if (!containerEl) return;

    const itemRect = itemEl.getBoundingClientRect();
    const containerRect = containerEl.getBoundingClientRect();
    const currentScrollTop = containerEl.scrollTop;
    const itemTop = currentScrollTop + itemRect.top - containerRect.top;
    const itemBottom = currentScrollTop + itemRect.bottom - containerRect.top;
    const nextScrollTop = getSlashCommandScrollTop({
        currentScrollTop,
        maxScrollTop: Math.max(0, containerEl.scrollHeight - containerEl.clientHeight),
        itemTop,
        itemBottom,
        viewportTop: currentScrollTop,
        viewportBottom: currentScrollTop + containerEl.clientHeight,
        margin: SlashCommandScrollMargin,
    });
    if (nextScrollTop == null) return;
    containerEl.scrollTop = nextScrollTop;
}

export const __testing = {
    SlashCommands: SLASH_COMMANDS,
    SlashCommandPopoverClassName,
    SlashCommandScrollAreaClassName,
    SlashCommandItemClassName,
    SlashCommandIconClassName,
    SelectionToolbarRootClassName,
    SelectionToolbarQuoteClassName,
    SelectionToolbarQuoteIconClassName,
    AssistantActionBarMoreContentClassName,
    AssistantActionBarMoreItemClassName,
    AssistantActionBarMoreIconClassName,
    ComposerDropzoneShellClassName,
    getNextComposerDragDepth,
    getSlashCommandScrollTop,
};

const SlashCommandPopoverDismiss: FC = () => {
    const scope = unstable_useTriggerPopoverScopeContext();
    const ref = useRef<HTMLDivElement>(null);

    useEffect(() => {
        if (!scope.open) return;

        const handlePointerDown = (e: MouseEvent) => {
            const target = e.target as Node;
            const el = ref.current;
            if (!el) return;
            const popoverEl = el.closest('[role="listbox"]');
            if (popoverEl && popoverEl.contains(target)) return;
            const composerRoot = el.closest("[data-testid='crest-composer']");
            if (composerRoot && composerRoot.contains(target)) return;
            scope.close();
        };

        document.addEventListener("mousedown", handlePointerDown, true);
        return () => document.removeEventListener("mousedown", handlePointerDown, true);
    }, [scope.open, scope.close]);

    return <div ref={ref} className="contents" />;
};

const SlashCommandPopover: FC = () => {
    const aui = useAui();
    const scrollAreaRef = useRef<HTMLDivElement>(null);
    const scrollHideTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
    const highlightInputModeRef = useRef<"keyboard" | "pointer">("keyboard");
    const [isScrolling, setIsScrolling] = useState(false);

    const slash = unstable_useSlashCommandAdapter({
        commands: SLASH_COMMANDS.map((cmd) => ({
            id: cmd.id,
            label: cmd.label,
            description: cmd.description,
            icon: cmd.icon,
            execute: () => {
                aui.composer().setText("/" + cmd.id);
                aui.composer().send();
            },
        })),
        iconMap: SLASH_ICON_MAP,
        removeOnExecute: true,
    });

    const adapter = useMemo(() => {
        const orig = slash.adapter;
        return {
            ...orig,
            search: (query: string) => {
                const lower = query.toLowerCase().replace(/^\//, "");
                if (!lower) return orig.search(query);
                return SLASH_COMMANDS.filter((cmd) => cmd.id.toLowerCase().startsWith(lower)).map((cmd) => ({
                    id: cmd.id,
                    type: "command" as const,
                    label: cmd.label,
                    description: cmd.description,
                    metadata: { icon: cmd.icon },
                }));
            },
        };
    }, [slash.adapter]);

    useEffect(() => {
        const handleKeyDown = (event: KeyboardEvent) => {
            if (SlashCommandKeyboardKeys.has(event.key)) {
                highlightInputModeRef.current = "keyboard";
            }
        };
        document.addEventListener("keydown", handleKeyDown, true);
        return () => document.removeEventListener("keydown", handleKeyDown, true);
    }, []);

    const markPointerHighlight = useCallback(() => {
        highlightInputModeRef.current = "pointer";
    }, []);
    const shouldAutoScrollHighlightedItem = useCallback(() => highlightInputModeRef.current === "keyboard", []);
    const onSlashCommandScroll = useCallback(() => {
        setIsScrolling(true);
        if (scrollHideTimerRef.current) {
            clearTimeout(scrollHideTimerRef.current);
        }
        scrollHideTimerRef.current = setTimeout(() => {
            setIsScrolling(false);
            scrollHideTimerRef.current = null;
        }, 650);
    }, []);

    useEffect(() => {
        return () => {
            if (scrollHideTimerRef.current) {
                clearTimeout(scrollHideTimerRef.current);
            }
        };
    }, []);

    return (
        <ComposerPrimitive.Unstable_TriggerPopover char="/" adapter={adapter} className={SlashCommandPopoverClassName}>
            <SlashCommandPopoverDismiss />
            <ComposerPrimitive.Unstable_TriggerPopover.Action {...slash.action} />
            <ComposerPrimitive.Unstable_TriggerPopoverItems>
                {(items) => (
                    <div
                        ref={scrollAreaRef}
                        data-scrolling={isScrolling ? "true" : undefined}
                        onScroll={onSlashCommandScroll}
                        className={SlashCommandScrollAreaClassName}
                    >
                        <div className="flex flex-col">
                            {items.map((item) => (
                                <SlashCommandItem
                                    key={item.id}
                                    item={item}
                                    iconMap={slash.iconMap}
                                    scrollContainerRef={scrollAreaRef}
                                    onPointerHighlight={markPointerHighlight}
                                    shouldAutoScroll={shouldAutoScrollHighlightedItem}
                                />
                            ))}
                        </div>
                    </div>
                )}
            </ComposerPrimitive.Unstable_TriggerPopoverItems>
        </ComposerPrimitive.Unstable_TriggerPopover>
    );
};

const SlashCommandItem = memo(
    ({
        item,
        iconMap,
        scrollContainerRef,
        onPointerHighlight,
        shouldAutoScroll,
    }: {
        item: Unstable_TriggerItem;
        iconMap: Record<string, ComponentType<{ className?: string }>> | undefined;
        scrollContainerRef: RefObject<HTMLDivElement | null>;
        onPointerHighlight: () => void;
        shouldAutoScroll: () => boolean;
    }) => {
        const ref = useRef<HTMLButtonElement>(null);

        useEffect(() => {
            const el = ref.current;
            if (!el) return;
            const maybeScroll = () => {
                if (el.dataset.highlighted !== "") return;
                if (!shouldAutoScroll()) return;
                scrollSlashCommandItemIntoView(el, scrollContainerRef.current);
            };
            const obs = new MutationObserver(() => {
                maybeScroll();
            });
            obs.observe(el, { attributes: true, attributeFilter: ["data-highlighted"] });
            maybeScroll();
            return () => obs.disconnect();
        }, [scrollContainerRef, shouldAutoScroll]);

        const Icon =
            item.metadata?.icon && iconMap?.[item.metadata.icon as keyof typeof iconMap]
                ? iconMap[item.metadata.icon as keyof typeof iconMap]
                : null;

        return (
            <ComposerPrimitive.Unstable_TriggerPopoverItem
                ref={ref}
                item={item}
                className={SlashCommandItemClassName}
                onMouseMove={onPointerHighlight}
            >
                {Icon && (
                    <span className={SlashCommandIconClassName}>
                        <Icon className="size-4" />
                    </span>
                )}
                <span className="flex min-w-0 flex-1 flex-col items-start">
                    <span className="font-medium leading-tight">{item.label}</span>
                    {item.description && (
                        <span className="text-secondary/90 mt-0.5 text-xs leading-tight">{item.description}</span>
                    )}
                </span>
            </ComposerPrimitive.Unstable_TriggerPopoverItem>
        );
    }
);
SlashCommandItem.displayName = "SlashCommandItem";

const ComposerAttachmentDropzone: FC<PropsWithChildren> = ({ children }) => {
    const aui = useAui();
    const isEditing = useAuiState((s) => s.composer.isEditing);
    const [isDragging, setIsDragging] = useState(false);
    const dragDepthRef = useRef(0);

    const resetDragging = useCallback(() => {
        dragDepthRef.current = getNextComposerDragDepth(dragDepthRef.current, "reset");
        setIsDragging(false);
    }, []);

    useEffect(() => {
        if (!isDragging) return;

        const reset = () => resetDragging();
        window.addEventListener("dragend", reset, true);
        window.addEventListener("drop", reset, true);
        window.addEventListener("blur", reset, true);
        return () => {
            window.removeEventListener("dragend", reset, true);
            window.removeEventListener("drop", reset, true);
            window.removeEventListener("blur", reset, true);
        };
    }, [isDragging, resetDragging]);

    const onDragEnterCapture = useCallback(
        (event: ReactDragEvent<HTMLDivElement>) => {
            if (!isEditing || !hasComposerDragFiles(event.dataTransfer)) return;
            event.preventDefault();
            dragDepthRef.current = getNextComposerDragDepth(dragDepthRef.current, "enter");
            setIsDragging(true);
        },
        [isEditing]
    );

    const onDragOverCapture = useCallback(
        (event: ReactDragEvent<HTMLDivElement>) => {
            if (!isEditing || !hasComposerDragFiles(event.dataTransfer)) return;
            event.preventDefault();
            event.dataTransfer.dropEffect = "copy";
            if (!isDragging) {
                setIsDragging(true);
            }
        },
        [isDragging, isEditing]
    );

    const onDragLeaveCapture = useCallback(
        (event: ReactDragEvent<HTMLDivElement>) => {
            if (!isEditing || !hasComposerDragFiles(event.dataTransfer)) return;
            event.preventDefault();
            const nextTarget = event.relatedTarget as Node | null;
            if (nextTarget && event.currentTarget.contains(nextTarget)) return;

            dragDepthRef.current = getNextComposerDragDepth(dragDepthRef.current, "leave");
            if (dragDepthRef.current === 0) {
                setIsDragging(false);
            }
        },
        [isEditing]
    );

    const onDropCapture = useCallback(
        async (event: ReactDragEvent<HTMLDivElement>) => {
            if (!isEditing || !hasComposerDragFiles(event.dataTransfer)) return;
            event.preventDefault();
            event.stopPropagation();
            const files = getComposerDragFiles(event.dataTransfer);
            resetDragging();
            await Promise.all(
                files.map(async (file) => {
                    try {
                        await aui.composer().addAttachment(file);
                    } catch (error) {
                        console.error("Failed to add attachment:", error);
                    }
                })
            );
        },
        [aui, isEditing, resetDragging]
    );

    return (
        <div
            data-slot="aui_composer-shell"
            data-dragging={isDragging ? "true" : undefined}
            className={ComposerDropzoneShellClassName}
            onDragEnterCapture={onDragEnterCapture}
            onDragOverCapture={onDragOverCapture}
            onDragLeaveCapture={onDragLeaveCapture}
            onDropCapture={onDropCapture}
        >
            {children}
        </div>
    );
};

const ComposerQuotePreview: FC = () => {
    return (
        <ComposerPrimitive.Quote className="aui-composer-quote mx-1 flex items-start gap-2 rounded-2xl border border-white/[0.10] bg-[rgba(34,34,36,0.42)] px-3 py-2 text-sm shadow-[0_10px_28px_-24px_rgba(0,0,0,0.65)] backdrop-blur-xl">
            <QuoteIcon className="mt-0.5 size-3.5 shrink-0 text-secondary/70" />
            <ComposerPrimitive.QuoteText className="aui-composer-quote-text line-clamp-2 min-w-0 flex-1 text-secondary italic" />
            <ComposerPrimitive.QuoteDismiss asChild>
                <button
                    type="button"
                    aria-label="Dismiss quote"
                    className="aui-composer-quote-dismiss shrink-0 cursor-pointer rounded-full p-0.5 text-secondary/70 transition-colors hover:bg-fg-overlay-1 hover:text-foreground active:scale-95"
                >
                    <XIcon className="size-3.5" />
                </button>
            </ComposerPrimitive.QuoteDismiss>
        </ComposerPrimitive.Quote>
    );
};

export const Composer: FC = () => {
    const inputHistory = unstable_useComposerInputHistory();

    return (
        <ComposerPrimitive.Unstable_TriggerPopoverRoot>
            <ComposerPrimitive.Root
                className="aui-composer-root relative flex w-full flex-col"
                data-testid="crest-composer"
            >
                <ComposerAttachmentDropzone>
                    <ComposerQuotePreview />
                    <ComposerAttachments />
                    <ComposerPrimitive.Input
                        placeholder="Send a message or type / for commands..."
                        className="aui-composer-input caret-primary placeholder:text-muted-foreground/80 max-h-32 min-h-10 w-full resize-none bg-transparent px-2.5 py-1 text-base outline-none"
                        rows={1}
                        autoFocus
                        enterKeyHint="send"
                        aria-label="Message input"
                        {...inputHistory}
                    />
                    <ComposerAction />
                </ComposerAttachmentDropzone>
                <SlashCommandPopover />
            </ComposerPrimitive.Root>
        </ComposerPrimitive.Unstable_TriggerPopoverRoot>
    );
};

const ComposerAction: FC = () => {
    const { modelLabel, onOpenModelPicker, contextUsage, modelContextWindow } = useContext(ComposerContext);
    const hasModelPicker = onOpenModelPicker != null;
    const showContextRing = (contextUsage?.totalTokens ?? 0) > 0 && (modelContextWindow ?? 0) > 0;

    return (
        <div className="aui-composer-action-wrapper relative flex items-center justify-between">
            <div className="aui-composer-left-actions flex items-center gap-1">
                <ComposerAddAttachment />
            </div>
            <div className="aui-composer-right-actions flex items-center gap-1.5">
                {modelLabel && (
                    <button
                        type="button"
                        aria-label="Change agent model"
                        aria-disabled={!hasModelPicker}
                        disabled={!hasModelPicker}
                        onClick={onOpenModelPicker}
                        className={cn(
                            "h-7 max-w-[220px] truncate rounded px-2 text-xs text-secondary transition-colors",
                            hasModelPicker
                                ? "cursor-pointer hover:bg-fg-overlay-1 hover:text-foreground"
                                : "text-secondary/55"
                        )}
                        title={modelLabel}
                    >
                        {modelLabel}
                    </button>
                )}
                {showContextRing && (
                    <ContextDisplayRing usage={contextUsage} modelContextWindow={modelContextWindow!} side="top" />
                )}
                <AuiIf condition={(s) => s.thread.capabilities.dictation}>
                    <AuiIf condition={(s) => s.composer.dictation == null}>
                        <ComposerPrimitive.Dictate asChild>
                            <TooltipIconButton
                                tooltip="Voice input"
                                side="bottom"
                                type="button"
                                variant="ghost"
                                size="icon"
                                className="aui-composer-dictate size-7 rounded-full"
                                aria-label="Start voice input"
                            >
                                <MicIcon className="aui-composer-dictate-icon size-4" />
                            </TooltipIconButton>
                        </ComposerPrimitive.Dictate>
                    </AuiIf>
                    <AuiIf condition={(s) => s.composer.dictation != null}>
                        <ComposerPrimitive.StopDictation asChild>
                            <TooltipIconButton
                                tooltip="Stop dictation"
                                side="bottom"
                                type="button"
                                variant="ghost"
                                size="icon"
                                className="aui-composer-stop-dictation text-destructive size-7 rounded-full"
                                aria-label="Stop voice input"
                            >
                                <SquareIcon className="aui-composer-stop-dictation-icon size-3.5 animate-pulse fill-current" />
                            </TooltipIconButton>
                        </ComposerPrimitive.StopDictation>
                    </AuiIf>
                </AuiIf>
                <AuiIf condition={(s) => !s.thread.isRunning}>
                    <ComposerPrimitive.Send asChild>
                        <TooltipIconButton
                            tooltip="Send message"
                            side="bottom"
                            type="button"
                            variant="default"
                            size="icon"
                            className="aui-composer-send size-7 rounded-full"
                            aria-label="Send message"
                        >
                            <ArrowUpIcon className="aui-composer-send-icon size-4.5" />
                        </TooltipIconButton>
                    </ComposerPrimitive.Send>
                </AuiIf>
                <AuiIf condition={(s) => s.thread.isRunning}>
                    <ComposerPrimitive.Cancel asChild>
                        <Button
                            type="button"
                            variant="default"
                            size="icon"
                            className="aui-composer-cancel size-7 rounded-full"
                            aria-label="Stop generating"
                        >
                            <SquareIcon className="aui-composer-cancel-icon size-3.5 fill-current" />
                        </Button>
                    </ComposerPrimitive.Cancel>
                </AuiIf>
            </div>
        </div>
    );
};

const MessageError: FC = () => {
    return (
        <MessagePrimitive.Error>
            <ErrorPrimitive.Root className="aui-message-error-root border-destructive bg-destructive/10 text-destructive dark:bg-destructive/5 mt-2 rounded-md border p-3 text-sm dark:text-red-200">
                <ErrorPrimitive.Message className="aui-message-error-message line-clamp-2" />
            </ErrorPrimitive.Root>
        </MessagePrimitive.Error>
    );
};

const AssistantMessage: FC = () => {
    const {
        ToolFallback: ToolFallbackComponent = ToolFallback,
        ToolGroup,
        ReasoningGroup,
    } = useContext(ThreadComponentsContext);
    const contextProjection = useAuiState(
        (state) =>
            (state.message.metadata.custom as { contextProjection?: AgentContextProjectionReportView } | undefined)
                ?.contextProjection
    );

    const ACTION_BAR_PT = "pt-1.5";
    // Keep the action bar inside the contained root's paint box, then cancel its reserved space in flow.
    const ACTION_BAR_HEIGHT = `min-h-7.5 ${ACTION_BAR_PT}`;

    return (
        <MessagePrimitive.Root
            data-slot="aui_assistant-message-root"
            data-role="assistant"
            data-testid="crest-assistant-message"
            className="fade-in slide-in-from-bottom-1 animate-in relative -mb-7.5 pb-7.5 duration-150 [contain-intrinsic-size:auto_200px] [content-visibility:auto]"
        >
            <div
                data-slot="aui_assistant-message-content"
                className="text-foreground px-2 leading-relaxed wrap-break-word"
            >
                {contextProjection && <ContextProjectionBadge report={contextProjection} />}
                <MessagePrimitive.GroupedParts groupBy={groupCrestAssistantPart}>
                    {({ part, children }) => {
                        switch (part.type) {
                            case "group-chainOfThought":
                                return <div data-slot="aui_chain-of-thought">{children}</div>;
                            case "group-tool":
                                if (ToolGroup) {
                                    return <ToolGroup group={part}>{children}</ToolGroup>;
                                }
                                return (
                                    <ToolGroupRoot variant="ghost">
                                        <ToolGroupTrigger
                                            count={part.indices.length}
                                            active={part.status.type === "running"}
                                        />
                                        <ToolGroupContent>{children}</ToolGroupContent>
                                    </ToolGroupRoot>
                                );
                            case "group-reasoning": {
                                if (ReasoningGroup) {
                                    return <ReasoningGroup group={part}>{children}</ReasoningGroup>;
                                }
                                const running = part.status.type === "running";
                                return (
                                    <ReasoningRoot variant="ghost" streaming={running}>
                                        <ReasoningTrigger active={running} />
                                        <ReasoningContent aria-busy={running}>
                                            <ReasoningText>{children}</ReasoningText>
                                        </ReasoningContent>
                                    </ReasoningRoot>
                                );
                            }
                            case "text":
                                return <MarkdownText />;
                            case "reasoning":
                                return <Reasoning {...part} />;
                            case "tool-call": {
                                if (part.toolUI) return part.toolUI;
                                const ToolRenderer = getCrestToolRenderer(part.toolName, ToolFallbackComponent);
                                return <ToolRenderer {...part} />;
                            }
                            case "image":
                                return <ImagePart {...part} role="assistant" />;
                            case "data":
                                return part.dataRendererUI;
                            case "indicator":
                                return (
                                    <span
                                        data-slot="aui_assistant-message-indicator"
                                        className="animate-pulse font-sans"
                                        aria-label="Assistant is working"
                                    >
                                        {"●"}
                                    </span>
                                );
                            default:
                                return null;
                        }
                    }}
                </MessagePrimitive.GroupedParts>
                <MessageError />
            </div>

            <div data-slot="aui_assistant-message-footer" className={cn("ms-2 flex items-center", ACTION_BAR_HEIGHT)}>
                <BranchPicker />
                <AssistantActionBar />
            </div>
        </MessagePrimitive.Root>
    );
};

const AssistantActionBar: FC = () => {
    return (
        <ActionBarPrimitive.Root
            hideWhenRunning
            autohide="not-last"
            className="aui-assistant-action-bar-root text-muted-foreground animate-in fade-in col-start-3 row-start-2 -ms-1 flex gap-1 duration-200"
        >
            <ActionBarPrimitive.Copy asChild>
                <TooltipIconButton tooltip="Copy">
                    <AuiIf condition={(s) => s.message.isCopied}>
                        <CheckIcon className="animate-in zoom-in-50 fade-in duration-200 ease-out" />
                    </AuiIf>
                    <AuiIf condition={(s) => !s.message.isCopied}>
                        <CopyIcon className="animate-in zoom-in-75 fade-in duration-150" />
                    </AuiIf>
                </TooltipIconButton>
            </ActionBarPrimitive.Copy>
            <AuiIf condition={(s) => s.thread.capabilities.reload}>
                <ActionBarPrimitive.Reload asChild>
                    <TooltipIconButton tooltip="Refresh">
                        <RefreshCwIcon />
                    </TooltipIconButton>
                </ActionBarPrimitive.Reload>
            </AuiIf>
            <ActionBarMorePrimitive.Root>
                <ActionBarMorePrimitive.Trigger asChild>
                    <TooltipIconButton tooltip="More" className="data-[state=open]:!bg-fg-overlay-2">
                        <MoreHorizontalIcon />
                    </TooltipIconButton>
                </ActionBarMorePrimitive.Trigger>
                <ActionBarMorePrimitive.Content
                    side="bottom"
                    align="start"
                    sideOffset={6}
                    className={AssistantActionBarMoreContentClassName}
                >
                    <ActionBarPrimitive.ExportMarkdown asChild>
                        <ActionBarMorePrimitive.Item className={AssistantActionBarMoreItemClassName}>
                            <DownloadIcon className={AssistantActionBarMoreIconClassName} />
                            Export as Markdown
                        </ActionBarMorePrimitive.Item>
                    </ActionBarPrimitive.ExportMarkdown>
                </ActionBarMorePrimitive.Content>
            </ActionBarMorePrimitive.Root>
        </ActionBarPrimitive.Root>
    );
};

const UserQuoteBlock: FC<{ text: string }> = ({ text }) => {
    return (
        <div className="aui-user-quote-block mb-2 flex items-start gap-1.5 rounded-xl border border-white/[0.10] bg-white/[0.05] px-2.5 py-2 text-sm">
            <QuoteIcon className="mt-0.5 size-3.5 shrink-0 text-secondary/70" />
            <p className="aui-user-quote-text line-clamp-2 min-w-0 text-secondary italic">{text}</p>
        </div>
    );
};

const UserMessage: FC = () => {
    return (
        <MessagePrimitive.Root
            data-slot="aui_user-message-root"
            className="group/user-message fade-in slide-in-from-bottom-1 animate-in grid auto-rows-auto grid-cols-[minmax(72px,1fr)_auto] content-start gap-y-0 px-2 duration-150 [contain-intrinsic-size:auto_200px] [content-visibility:auto] [&:where(>*)]:col-start-2"
            data-role="user"
            data-testid="crest-user-message"
        >
            <UserMessageAttachments />

            <div className="aui-user-message-content-wrapper relative col-start-2 min-w-0 justify-self-end">
                <div className="aui-user-message-content bg-muted text-foreground rounded-xl px-4 py-2 wrap-break-word empty:hidden">
                    <MessagePrimitive.Quote>{(quote) => <UserQuoteBlock text={quote.text} />}</MessagePrimitive.Quote>
                    <MessagePrimitive.Parts>
                        {({ part }) => {
                            if (part.type === "text") return <p className="whitespace-pre-wrap">{part.text}</p>;
                            if (part.type === "image") return <ImagePart {...part} role="user" />;
                            return null;
                        }}
                    </MessagePrimitive.Parts>
                </div>
                <div className="aui-user-action-bar-wrapper absolute end-0 top-full z-10 pt-1">
                    <UserActionBar />
                </div>
            </div>

            <div aria-hidden="true" className="col-start-2 h-8 w-0" />

            <BranchPicker
                data-slot="aui_user-branch-picker"
                className="col-span-full col-start-1 row-start-3 -me-1 justify-end"
            />
        </MessagePrimitive.Root>
    );
};

const CopyButtonIcon: FC = () => {
    return (
        <>
            <AuiIf condition={(s) => s.message.isCopied}>
                <CheckIcon className="animate-in zoom-in-50 fade-in duration-200 ease-out" />
            </AuiIf>
            <AuiIf condition={(s) => !s.message.isCopied}>
                <CopyIcon />
            </AuiIf>
        </>
    );
};

const UserActionBar: FC = () => {
    const isLast = useAuiState((s) => s.message.isLast);

    return (
        <ActionBarPrimitive.Root
            hideWhenRunning
            className={cn(
                "aui-user-action-bar-root flex items-center gap-0.5 transition-opacity duration-100",
                isLast
                    ? "opacity-100"
                    : "pointer-events-none opacity-0 group-hover/user-message:pointer-events-auto group-hover/user-message:opacity-100 focus-within:pointer-events-auto focus-within:opacity-100"
            )}
        >
            <ActionBarPrimitive.Copy asChild>
                <TooltipIconButton tooltip="Copy" side="top" size="icon-xs">
                    <CopyButtonIcon />
                </TooltipIconButton>
            </ActionBarPrimitive.Copy>
            <AuiIf condition={(s) => s.thread.capabilities.edit}>
                <ActionBarPrimitive.Edit asChild>
                    <TooltipIconButton tooltip="Edit" side="top" size="icon-xs" className="aui-user-action-edit">
                        <PencilIcon />
                    </TooltipIconButton>
                </ActionBarPrimitive.Edit>
            </AuiIf>
        </ActionBarPrimitive.Root>
    );
};

const EditComposer: FC = () => {
    return (
        <MessagePrimitive.Root
            data-slot="aui_edit-composer-wrapper"
            className="flex flex-col px-2 [contain-intrinsic-size:auto_200px] [content-visibility:auto]"
        >
            <ComposerPrimitive.Root className="aui-edit-composer-root border-border/60 dark:border-muted-foreground/15 ms-auto flex w-full max-w-[85%] flex-col rounded-(--composer-radius) border bg-(--composer-bg) shadow-[0_4px_16px_-8px_rgba(0,0,0,0.08),0_1px_2px_rgba(0,0,0,0.04)] dark:shadow-none">
                <ComposerPrimitive.Input
                    className="aui-edit-composer-input text-foreground min-h-14 w-full resize-none bg-transparent px-4 pt-3 pb-1 text-base outline-none"
                    autoFocus
                />
                <div className="aui-edit-composer-footer mx-2.5 mb-2.5 flex items-center gap-1.5 self-end">
                    <ComposerPrimitive.Cancel asChild>
                        <Button variant="ghost" size="sm" className="h-8 rounded-full px-3.5">
                            Cancel
                        </Button>
                    </ComposerPrimitive.Cancel>
                    <ComposerPrimitive.Send asChild>
                        <Button size="sm" className="h-8 rounded-full px-3.5">
                            Update
                        </Button>
                    </ComposerPrimitive.Send>
                </div>
            </ComposerPrimitive.Root>
        </MessagePrimitive.Root>
    );
};

const BranchPicker: FC<BranchPickerPrimitive.Root.Props> = ({ className, ...rest }) => {
    return (
        <BranchPickerPrimitive.Root
            hideWhenSingleBranch
            className={cn(
                "aui-branch-picker-root text-muted-foreground -ms-2 me-2 inline-flex items-center text-xs",
                className
            )}
            {...rest}
        >
            <BranchPickerPrimitive.Previous asChild>
                <TooltipIconButton tooltip="Previous">
                    <ChevronLeftIcon />
                </TooltipIconButton>
            </BranchPickerPrimitive.Previous>
            <span className="aui-branch-picker-state font-medium">
                <BranchPickerPrimitive.Number /> / <BranchPickerPrimitive.Count />
            </span>
            <BranchPickerPrimitive.Next asChild>
                <TooltipIconButton tooltip="Next">
                    <ChevronRightIcon />
                </TooltipIconButton>
            </BranchPickerPrimitive.Next>
        </BranchPickerPrimitive.Root>
    );
};

const ImagePart = memo((props: ImageMessagePartProps & { role: "user" | "assistant" }) => {
    return (
        <img className="max-w-full rounded-lg" src={props.image} alt={getCrestImageAlt(props.filename, props.role)} />
    );
});
ImagePart.displayName = "ImagePart";
