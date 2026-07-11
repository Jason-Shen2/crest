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
    useAui,
    useAuiState,
    type AssistantState,
    type ImageMessagePartProps,
    type ToolCallMessagePartComponent,
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
} from "lucide-react";
import {
    createContext,
    memo,
    useContext,
    useEffect,
    useState,
    type ComponentType,
    type FC,
    type PropsWithChildren,
} from "react";
import { ComposerAddAttachment, ComposerAttachments, UserMessageAttachments } from "./attachment";
import { getCrestImageAlt } from "./crest-message";
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
};

const EMPTY_COMPONENTS: ThreadComponents = {};

export const ComposerContext = createContext<Pick<ThreadProps, "modelLabel" | "onOpenModelPicker">>({});
const ThreadComponentsContext = createContext<ThreadComponents>(EMPTY_COMPONENTS);

// Startup exposes a loading placeholder thread; treat it as a new chat so
// the composer mounts centered. Loads after startup keep the docked layout.
const isNewChatView = (s: AssistantState) =>
    s.thread.messages.length === 0 && (!s.thread.isLoading || s.threads.isLoading);

export const Thread: FC<ThreadProps> = ({ components = EMPTY_COMPONENTS, modelLabel, onOpenModelPicker }) => {
    const isEmpty = useAuiState(isNewChatView);

    return (
        <ThreadComponentsContext.Provider value={components}>
            <ComposerContext.Provider value={{ modelLabel, onOpenModelPicker }}>
                <ThreadRoot isEmpty={isEmpty} />
            </ComposerContext.Provider>
        </ThreadComponentsContext.Provider>
    );
};

const ThreadRoot: FC<{ isEmpty: boolean }> = ({ isEmpty }) => {
    const { Welcome = ThreadWelcome } = useContext(ThreadComponentsContext);

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
                        <ThreadScrollToBottom />
                        <ThreadFollowupSuggestions />
                        <Composer />
                        <AuiIf condition={(s) => isNewChatView(s) && s.composer.isEmpty}>
                            <ThreadSuggestions />
                        </AuiIf>
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
        <SelectionToolbarPrimitive.Root className="aui-selection-toolbar bg-popover text-popover-foreground z-50 flex items-center gap-1 rounded-xl border p-1 shadow-lg">
            <SelectionToolbarPrimitive.Quote asChild>
                <TooltipIconButton tooltip="Quote" variant="ghost" size="icon" className="size-7 rounded-full">
                    <QuoteIcon className="size-4" />
                </TooltipIconButton>
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

const SLASH_COMMANDS = [
    { id: "tree", label: "/tree", description: "Browse and navigate the session tree", icon: "FolderTree" },
    { id: "fork", label: "/fork", description: "Create a fork from a previous message", icon: "GitFork" },
    { id: "clone", label: "/clone", description: "Clone the current session", icon: "Copy" },
    { id: "model", label: "/model", description: "Change the AI model", icon: "Settings2" },
    { id: "new", label: "/new", description: "Start a new session", icon: "Plus" },
    { id: "resume", label: "/resume", description: "Resume a previous session", icon: "History" },
    { id: "compact", label: "/compact", description: "Compact the conversation context", icon: "Minimize2" },
    { id: "session", label: "/session", description: "Show current session info", icon: "Info" },
    { id: "copy", label: "/copy", description: "Copy the current session", icon: "Copy" },
    { id: "export", label: "/export", description: "Export the session as markdown", icon: "Download" },
    { id: "import", label: "/import", description: "Import a session from markdown", icon: "Upload" },
    { id: "reload", label: "/reload", description: "Reload the current session", icon: "RefreshCw" },
] as const;

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

const SlashCommandPopover: FC = () => {
    const aui = useAui();

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

    return (
        <ComposerPrimitive.Unstable_TriggerPopover
            char="/"
            adapter={slash.adapter}
            className="bg-popover text-popover-foreground absolute bottom-full left-0 z-50 mb-1 w-full max-h-80 overflow-y-auto rounded-xl border p-1 shadow-lg"
        >
            <ComposerPrimitive.Unstable_TriggerPopover.Action {...slash.action} />
            <ComposerPrimitive.Unstable_TriggerPopoverItems>
                {(items) => (
                    <div className="flex flex-col">
                        {items.map((item) => (
                            <ComposerPrimitive.Unstable_TriggerPopoverItem
                                key={item.id}
                                item={item}
                                className="hover:bg-accent focus:bg-accent data-[highlighted]:bg-accent flex cursor-pointer items-center gap-2.5 rounded-lg px-2.5 py-2 text-sm outline-none"
                            >
                                {item.metadata?.icon &&
                                    slash.iconMap?.[item.metadata.icon as keyof typeof SLASH_ICON_MAP] && (
                                        <span className="text-muted-foreground flex size-6 shrink-0 items-center justify-center">
                                            {(() => {
                                                const Icon =
                                                    slash.iconMap![item.metadata.icon as keyof typeof SLASH_ICON_MAP];
                                                return <Icon className="size-4" />;
                                            })()}
                                        </span>
                                    )}
                                <span className="flex flex-col">
                                    <span className="font-medium">{item.label}</span>
                                    {item.description && (
                                        <span className="text-muted-foreground text-xs">{item.description}</span>
                                    )}
                                </span>
                            </ComposerPrimitive.Unstable_TriggerPopoverItem>
                        ))}
                    </div>
                )}
            </ComposerPrimitive.Unstable_TriggerPopoverItems>
        </ComposerPrimitive.Unstable_TriggerPopover>
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
                <ComposerPrimitive.AttachmentDropzone asChild>
                    <div
                        data-slot="aui_composer-shell"
                        className="border-border/60 data-[dragging=true]:border-ring focus-within:border-border dark:border-muted-foreground/15 dark:focus-within:border-muted-foreground/30 flex w-full flex-col gap-2 rounded-(--composer-radius) border bg-(--composer-bg) p-(--composer-padding) shadow-[0_4px_16px_-8px_rgba(0,0,0,0.08),0_1px_2px_rgba(0,0,0,0.04)] transition-[border-color,box-shadow] focus-within:shadow-[0_6px_24px_-8px_rgba(0,0,0,0.12),0_1px_2px_rgba(0,0,0,0.05)] data-[dragging=true]:border-dashed data-[dragging=true]:bg-[color-mix(in_oklab,var(--color-accent)_50%,var(--color-background))] dark:shadow-none"
                    >
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
                    </div>
                </ComposerPrimitive.AttachmentDropzone>
                <SlashCommandPopover />
            </ComposerPrimitive.Root>
        </ComposerPrimitive.Unstable_TriggerPopoverRoot>
    );
};

const ComposerAction: FC = () => {
    const { modelLabel, onOpenModelPicker } = useContext(ComposerContext);
    const hasModelPicker = onOpenModelPicker != null;

    return (
        <div className="aui-composer-action-wrapper relative flex items-center justify-between">
            <div className="flex items-center gap-1">
                <ComposerAddAttachment />
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
            </div>
            <div className="flex items-center gap-1.5">
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
                <MessagePrimitive.GroupedParts
                    groupBy={groupPartByType<"group-chainOfThought" | "group-reasoning" | "group-tool">({
                        reasoning: ["group-chainOfThought", "group-reasoning"],
                        "tool-call": ["group-chainOfThought", "group-tool"],
                        "standalone-tool-call": [],
                    })}
                >
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
                                    <ReasoningRoot streaming={running}>
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
                            case "tool-call":
                                return part.toolUI ?? <ToolFallbackComponent {...part} />;
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
            <ActionBarPrimitive.Reload asChild>
                <TooltipIconButton tooltip="Refresh">
                    <RefreshCwIcon />
                </TooltipIconButton>
            </ActionBarPrimitive.Reload>
            <ActionBarMorePrimitive.Root>
                <ActionBarMorePrimitive.Trigger asChild>
                    <TooltipIconButton tooltip="More" className="data-[state=open]:bg-accent">
                        <MoreHorizontalIcon />
                    </TooltipIconButton>
                </ActionBarMorePrimitive.Trigger>
                <ActionBarMorePrimitive.Content
                    side="bottom"
                    align="start"
                    sideOffset={6}
                    className="aui-action-bar-more-content bg-popover/95 text-popover-foreground data-[state=open]:fade-in-0 data-[state=open]:zoom-in-95 data-[state=open]:animate-in data-[state=closed]:fade-out-0 data-[state=closed]:zoom-out-95 data-[state=closed]:animate-out data-[side=bottom]:slide-in-from-top-2 data-[side=left]:slide-in-from-right-2 data-[side=right]:slide-in-from-left-2 data-[side=top]:slide-in-from-bottom-2 z-50 min-w-[8rem] overflow-hidden rounded-xl border p-1.5 shadow-lg backdrop-blur-sm"
                >
                    <ActionBarPrimitive.ExportMarkdown asChild>
                        <ActionBarMorePrimitive.Item className="aui-action-bar-more-item hover:bg-accent hover:text-accent-foreground focus:bg-accent focus:text-accent-foreground flex cursor-pointer items-center gap-2 rounded-lg px-2.5 py-1.5 text-sm outline-none select-none">
                            <DownloadIcon className="size-4" />
                            Export as Markdown
                        </ActionBarMorePrimitive.Item>
                    </ActionBarPrimitive.ExportMarkdown>
                </ActionBarMorePrimitive.Content>
            </ActionBarMorePrimitive.Root>
        </ActionBarPrimitive.Root>
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
            <ActionBarPrimitive.Edit asChild>
                <TooltipIconButton tooltip="Edit" side="top" size="icon-xs" className="aui-user-action-edit">
                    <PencilIcon />
                </TooltipIconButton>
            </ActionBarPrimitive.Edit>
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
