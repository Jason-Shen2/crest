// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

import { globalStore } from "@/app/store/jotaiStore";
import { useWaveEnv } from "@/app/waveenv/waveenv";
import { cn, fireAndForget } from "@/util/util";
import { Icon } from "@/app/icon/Icon";
import * as jotai from "jotai";
import type { WebviewTag } from "electron";
import {
    memo,
    useCallback,
    useEffect,
    useLayoutEffect,
    useMemo,
    useRef,
    useState,
    type KeyboardEvent,
} from "react";

const USER_AGENT_IPHONE =
    "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1";
const USER_AGENT_ANDROID =
    "Mozilla/5.0 (Linux; Android 13) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.6099.43 Mobile Safari/537.36";

type BrowserUserAgentType = "default" | "mobile:iphone" | "mobile:android";

type BrowserTabState = {
    id: string;
    url: string;
    title: string;
    isLoading: boolean;
    canGoBack: boolean;
    canGoForward: boolean;
    mediaPlaying: boolean;
    mediaMuted: boolean;
    domReady: boolean;
    userAgentType: BrowserUserAgentType;
    zoomFactor: number;
    errorText: string;
    urlInputValue: string;
    partition: string;
};

type RightBrowserState = {
    tabs: BrowserTabState[];
    activeTabId: string | null;
};

function genTabId(): string {
    return "tab_" + Math.random().toString(36).slice(2, 10);
}

function getWebviewPreloadUrl(electron: { getWebviewPreload: () => string }): string | null {
    const preloadPath = electron.getWebviewPreload();
    if (!preloadPath) return null;
    return "file://" + preloadPath;
}

function ensureUrlScheme(url: string): string {
    if (!url) return "about:blank";
    const trimmed = url.trim();
    if (/^(http|https|file|about):/.test(trimmed)) return trimmed;
    const isLocal = /^(localhost|(\d{1,3}\.){3}\d{1,3})(:\d+)?$/.test(trimmed.split("/")[0]);
    if (isLocal) return `http://${trimmed}`;
    const domainRegex = /^[a-z0-9.-]+\.[a-z]{2,}$/i;
    const isDomain = domainRegex.test(trimmed.split("/")[0]);
    if (isDomain) return `https://${trimmed}`;
    return `https://www.google.com/search?q=${encodeURIComponent(trimmed)}`;
}

function getUserAgentString(type: BrowserUserAgentType): string | undefined {
    switch (type) {
        case "mobile:iphone":
            return USER_AGENT_IPHONE;
        case "mobile:android":
            return USER_AGENT_ANDROID;
        default:
            return undefined;
    }
}

function createNewTabState(initialUrl: string = "about:blank"): BrowserTabState {
    return {
        id: genTabId(),
        url: initialUrl,
        title: initialUrl === "about:blank" ? "New Tab" : initialUrl,
        isLoading: initialUrl !== "about:blank",
        canGoBack: false,
        canGoForward: false,
        mediaPlaying: false,
        mediaMuted: false,
        domReady: false,
        userAgentType: "default",
        zoomFactor: 1,
        errorText: "",
        urlInputValue: initialUrl,
        partition: "right-browser",
    };
}

export class RightBrowserModel {
    private static instance: RightBrowserModel | null = null;
    readonly stateAtom: jotai.PrimitiveAtom<RightBrowserState>;
    private webviewRefs = new Map<string, React.RefObject<WebviewTag>>();

    private constructor() {
        const firstTab = createNewTabState();
        this.stateAtom = jotai.atom<RightBrowserState>({
            tabs: [firstTab],
            activeTabId: firstTab.id,
        });
    }

    static getInstance(): RightBrowserModel {
        if (!RightBrowserModel.instance) {
            RightBrowserModel.instance = new RightBrowserModel();
        }
        return RightBrowserModel.instance;
    }

    static resetInstance(): void {
        RightBrowserModel.instance = null;
    }

    getStateNow(): RightBrowserState {
        return globalStore.get(this.stateAtom);
    }

    getActiveTab(): BrowserTabState | null {
        const state = this.getStateNow();
        if (!state.activeTabId) return null;
        return state.tabs.find((t) => t.id === state.activeTabId) ?? null;
    }

    getTab(tabId: string): BrowserTabState | null {
        return this.getStateNow().tabs.find((t) => t.id === tabId) ?? null;
    }

    getWebviewRef(tabId: string): React.RefObject<WebviewTag> {
        let ref = this.webviewRefs.get(tabId);
        if (!ref) {
            ref = { current: null };
            this.webviewRefs.set(tabId, ref);
        }
        return ref;
    }

    removeWebviewRef(tabId: string): void {
        this.webviewRefs.delete(tabId);
    }

    newTab(initialUrl: string = "about:blank", activate: boolean = true): string {
        const tab = createNewTabState(initialUrl);
        const state = this.getStateNow();
        globalStore.set(this.stateAtom, {
            tabs: [...state.tabs, tab],
            activeTabId: activate ? tab.id : state.activeTabId,
        });
        return tab.id;
    }

    selectTab(tabId: string): void {
        const state = this.getStateNow();
        if (!state.tabs.find((t) => t.id === tabId)) return;
        globalStore.set(this.stateAtom, { ...state, activeTabId: tabId });
    }

    closeTab(tabId: string): void {
        const state = this.getStateNow();
        const idx = state.tabs.findIndex((t) => t.id === tabId);
        if (idx < 0) return;
        const newTabs = state.tabs.filter((t) => t.id !== tabId);
        let newActiveId = state.activeTabId;
        if (state.activeTabId === tabId) {
            if (newTabs.length === 0) {
                const replacement = createNewTabState();
                newTabs.push(replacement);
                newActiveId = replacement.id;
            } else {
                newActiveId = newTabs[Math.max(0, idx - 1)]?.id ?? newTabs[0]?.id ?? null;
            }
        }
        this.webviewRefs.delete(tabId);
        globalStore.set(this.stateAtom, { tabs: newTabs, activeTabId: newActiveId });
    }

    patchTab(tabId: string, patch: Partial<BrowserTabState>): void {
        const state = this.getStateNow();
        globalStore.set(this.stateAtom, {
            ...state,
            tabs: state.tabs.map((t) => (t.id === tabId ? { ...t, ...patch } : t)),
        });
    }

    updateNavState(tabId: string): void {
        const ref = this.webviewRefs.get(tabId);
        const wv = ref?.current;
        if (!wv) return;
        try {
            this.patchTab(tabId, {
                canGoBack: wv.canGoBack?.() ?? false,
                canGoForward: wv.canGoForward?.() ?? false,
            });
        } catch {
            // webview not ready
        }
    }

    loadUrl(tabId: string, rawUrl: string): void {
        const ref = this.webviewRefs.get(tabId);
        const wv = ref?.current;
        if (!wv) return;
        const url = ensureUrlScheme(rawUrl);
        this.patchTab(tabId, { urlInputValue: url });
        try {
            if (wv.getURL?.() !== url) {
                fireAndForget(() => wv.loadURL(url));
            }
        } catch { /* ignore */ }
    }

    goBack(tabId: string): void {
        const wv = this.webviewRefs.get(tabId)?.current;
        if (!wv) return;
        try { wv.goBack?.(); } catch { /* ignore */ }
    }

    goForward(tabId: string): void {
        const wv = this.webviewRefs.get(tabId)?.current;
        if (!wv) return;
        try { wv.goForward?.(); } catch { /* ignore */ }
    }

    reload(tabId: string): void {
        const ref = this.webviewRefs.get(tabId);
        const wv = ref?.current;
        if (!wv) return;
        const tab = this.getTab(tabId);
        try {
            if (tab?.isLoading) {
                wv.stop?.();
            } else {
                wv.reload?.();
            }
        } catch { /* ignore */ }
    }

    goHome(tabId: string): void {
        this.loadUrl(tabId, "about:blank");
    }

    toggleMute(tabId: string): void {
        const ref = this.webviewRefs.get(tabId);
        const wv = ref?.current;
        const tab = this.getTab(tabId);
        if (!wv || !tab) return;
        try {
            const newMuted = !wv.isAudioMuted?.();
            wv.setAudioMuted?.(newMuted);
            this.patchTab(tabId, { mediaMuted: newMuted });
        } catch {
            // ignore
        }
    }

    setZoom(tabId: string, factor: number): void {
        const ref = this.webviewRefs.get(tabId);
        const wv = ref?.current;
        const tab = this.getTab(tabId);
        if (!wv || !tab?.domReady) return;
        const clamped = Math.max(0.25, Math.min(5, factor));
        try {
            wv.setZoomFactor?.(clamped);
        } catch { /* ignore */ }
        this.patchTab(tabId, { zoomFactor: clamped });
    }

    cycleUserAgent(tabId: string): void {
        const tab = this.getTab(tabId);
        if (!tab) return;
        const next: BrowserUserAgentType =
            tab.userAgentType === "default"
                ? "mobile:iphone"
                : tab.userAgentType === "mobile:iphone"
                  ? "mobile:android"
                  : "default";
        this.patchTab(tabId, { userAgentType: next });
    }
}

function getTabDisplayTitle(tab: BrowserTabState): string {
    if (tab.url === "about:blank") return "New Tab";
    try {
        const u = new URL(tab.url);
        return tab.title && tab.title !== tab.url ? tab.title : u.hostname + u.pathname;
    } catch {
        return tab.url;
    }
}

function ToolButton({
    icon,
    onClick,
    disabled,
    title,
}: {
    icon: string;
    onClick: () => void;
    disabled?: boolean;
    title: string;
}) {
    return (
        <button
            type="button"
            onClick={onClick}
            disabled={disabled}
            title={title}
            className={cn(
                "flex h-7 w-7 shrink-0 cursor-pointer items-center justify-center rounded text-[#a1a1aa] transition-colors",
                disabled ? "cursor-not-allowed opacity-40" : "hover:bg-[#2a2b2f] hover:text-[#f4f4f5]"
            )}
        >
            <i className={cn("text-[12px]", icon)} />
        </button>
    );
}

function MenuItem({ onClick, label, icon }: { onClick: () => void; label: string; icon: string }) {
    return (
        <button
            type="button"
            onClick={onClick}
            className="flex w-full cursor-pointer items-center gap-2 rounded px-2 py-1.5 text-left text-[#d4d4d8] hover:bg-[#2a2b2f] hover:text-[#f4f4f5]"
        >
            <i className={cn("w-3.5 text-center text-[11px]", icon)} />
            <span>{label}</span>
        </button>
    );
}

function WebViewFallback() {
    return (
        <div className="flex h-full w-full items-center justify-center bg-panel">
            <div className="mx-6 flex max-w-md flex-col gap-2 rounded-lg border border-dashed border-border bg-background px-6 py-5 text-center shadow-sm">
                <div className="text-xs font-mono text-muted">webview unavailable (preview/test env)</div>
                <div className="text-sm text-foreground">Browser placeholder</div>
            </div>
        </div>
    );
}

type BrowserWebViewProps = {
    model: RightBrowserModel;
    tab: BrowserTabState;
    isActive: boolean;
    preloadUrl: string | null;
};

const BrowserWebView = memo(function BrowserWebView({ model, tab, isActive, preloadUrl }: BrowserWebViewProps) {
    const env = useWaveEnv();
    const electron = env.electron;
    const webviewRef = model.getWebviewRef(tab.id);
    const [webContentsId, setWebContentsId] = useState<number | null>(null);
    const bgColorSetRef = useRef(false);
    const mountedRef = useRef(true);
    const bgColorTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
    const focusTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
    const loadUrlTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
    const webviewReadyRef = useRef(false);

    const setBgColor = useCallback(() => {
        const wv = webviewRef.current;
        if (!wv || !mountedRef.current) return;
        if (bgColorTimerRef.current != null) {
            clearTimeout(bgColorTimerRef.current);
        }
        bgColorTimerRef.current = setTimeout(() => {
            bgColorTimerRef.current = null;
            if (!mountedRef.current) return;
            const wvNow = webviewRef.current;
            if (!wvNow || !wvNow.isConnected) return;
            wvNow.executeJavaScript(
                `!!document.querySelector('meta[name="color-scheme"]') && document.querySelector('meta[name="color-scheme"]').content?.includes('dark') || false`
            )
                .then((hasDarkMode: boolean) => {
                    if (!mountedRef.current) return;
                    const wvLatest = webviewRef.current;
                    if (wvLatest) wvLatest.style.backgroundColor = hasDarkMode ? "black" : "white";
                })
                .catch(() => {
                    if (!mountedRef.current) return;
                    const wvLatest = webviewRef.current;
                    if (wvLatest) wvLatest.style.backgroundColor = "black";
                });
        }, 100);
    }, [webviewRef]);

    useLayoutEffect(() => {
        mountedRef.current = true;
        webviewReadyRef.current = false;
        bgColorSetRef.current = false;
        return () => {
            mountedRef.current = false;
            webviewReadyRef.current = false;
            if (bgColorTimerRef.current != null) {
                clearTimeout(bgColorTimerRef.current);
                bgColorTimerRef.current = null;
            }
            if (focusTimerRef.current != null) {
                clearTimeout(focusTimerRef.current);
                focusTimerRef.current = null;
            }
            if (loadUrlTimerRef.current != null) {
                clearTimeout(loadUrlTimerRef.current);
                loadUrlTimerRef.current = null;
            }
            const wv = webviewRef.current;
            if (wv) {
                try { if (wv.isDevToolsOpened?.()) wv.closeDevTools(); } catch { /* ignore */ }
            }
            model.patchTab(tab.id, { domReady: false, isLoading: false });
            model.removeWebviewRef(tab.id);
        };
    }, [model, tab.id, webviewRef]);

    useEffect(() => {
        const wv = webviewRef.current;
        if (!wv) return;

        const onNavigate = (e: any) => {
            if (!mountedRef.current) return;
            if (e.isMainFrame) {
                model.patchTab(tab.id, { url: e.url, errorText: "", urlInputValue: e.url, title: e.url });
            }
            model.updateNavState(tab.id);
        };
        const onStartLoading = () => {
            if (!mountedRef.current) return;
            model.patchTab(tab.id, { isLoading: true });
            wv.style.backgroundColor = "transparent";
            bgColorSetRef.current = false;
        };
        const onStopLoading = () => {
            if (!mountedRef.current) return;
            model.patchTab(tab.id, { isLoading: false, domReady: true });
            if (!bgColorSetRef.current) {
                setBgColor();
                bgColorSetRef.current = true;
            }
            model.updateNavState(tab.id);
        };
        const onFailLoad = (e: any) => {
            if (!mountedRef.current) return;
            if (e.errorCode === -3) return;
            const msg = `Failed to load ${e.validatedURL}: ${e.errorDescription}`;
            model.patchTab(tab.id, { errorText: msg });
        };
        const onDomReady = () => {
            if (!mountedRef.current) return;
            webviewReadyRef.current = true;
            model.patchTab(tab.id, { domReady: true });
            if (!bgColorSetRef.current) {
                setBgColor();
                bgColorSetRef.current = true;
            }
            try {
                const id = wv.getWebContentsId?.();
                if (id) setWebContentsId(id);
            } catch {
                // ignore
            }
        };
        const onPageTitleUpdated = (e: any) => {
            if (!mountedRef.current) return;
            if (e.title) {
                model.patchTab(tab.id, { title: e.title });
            }
        };
        const onMediaStart = () => {
            if (!mountedRef.current) return;
            model.patchTab(tab.id, { mediaPlaying: true });
        };
        const onMediaPause = () => {
            if (!mountedRef.current) return;
            model.patchTab(tab.id, { mediaPlaying: false });
        };
        const onFocus = () => {
            if (!mountedRef.current || !webviewReadyRef.current) return;
            try {
                const id = wv.getWebContentsId?.();
                if (id) electron.setWebviewFocus(id);
            } catch { /* ignore */ }
        };
        const onBlur = () => {
            if (!mountedRef.current) return;
            electron.setWebviewFocus(null);
        };
        const newWindowHandler = (e: any) => {
            e.preventDefault();
            void electron.openExternal(e.url);
        };

        wv.addEventListener("did-frame-navigate", onNavigate);
        wv.addEventListener("did-navigate-in-page", onNavigate);
        wv.addEventListener("did-navigate", onNavigate);
        wv.addEventListener("page-title-updated", onPageTitleUpdated);
        wv.addEventListener("did-start-loading", onStartLoading);
        wv.addEventListener("did-stop-loading", onStopLoading);
        wv.addEventListener("did-fail-load", onFailLoad);
        wv.addEventListener("dom-ready", onDomReady);
        wv.addEventListener("media-started-playing", onMediaStart);
        wv.addEventListener("media-paused", onMediaPause);
        wv.addEventListener("focus", onFocus);
        wv.addEventListener("blur", onBlur);
        wv.addEventListener("new-window", newWindowHandler);

        return () => {
            wv.removeEventListener("did-frame-navigate", onNavigate);
            wv.removeEventListener("did-navigate", onNavigate);
            wv.removeEventListener("did-navigate-in-page", onNavigate);
            wv.removeEventListener("page-title-updated", onPageTitleUpdated);
            wv.removeEventListener("did-start-loading", onStartLoading);
            wv.removeEventListener("did-stop-loading", onStopLoading);
            wv.removeEventListener("did-fail-load", onFailLoad);
            wv.removeEventListener("dom-ready", onDomReady);
            wv.removeEventListener("media-started-playing", onMediaStart);
            wv.removeEventListener("media-paused", onMediaPause);
            wv.removeEventListener("focus", onFocus);
            wv.removeEventListener("blur", onBlur);
            wv.removeEventListener("new-window", newWindowHandler);
        };
    }, [model, tab.id, webviewRef, setBgColor, electron]);

    useEffect(() => {
        const wv = webviewRef.current;
        if (!wv || !wv.isConnected || !tab.domReady) return;
        try {
            const ua = getUserAgentString(tab.userAgentType);
            wv.setUserAgent?.(ua ?? "");
        } catch { /* ignore */ }
    }, [tab.userAgentType, tab.domReady, tab.id, webviewRef]);

    useEffect(() => {
        const wv = webviewRef.current;
        if (!wv || !wv.isConnected || !tab.domReady) return;
        try {
            if (wv.getZoomFactor?.() !== tab.zoomFactor) {
                wv.setZoomFactor?.(tab.zoomFactor);
            }
        } catch { /* ignore */ }
    }, [tab.zoomFactor, tab.domReady, tab.id, webviewRef]);

    useEffect(() => {
        const wv = webviewRef.current;
        if (!wv || !preloadUrl || !tab.domReady) return;
        if (tab.url === "about:blank" || tab.url === "") return;
        if (loadUrlTimerRef.current != null) {
            clearTimeout(loadUrlTimerRef.current);
        }
        loadUrlTimerRef.current = setTimeout(() => {
            loadUrlTimerRef.current = null;
            if (!mountedRef.current) return;
            const wvNow = webviewRef.current;
            if (!wvNow || !wvNow.isConnected) return;
            try {
                const currentUrl = wvNow.getURL?.();
                if (currentUrl === "about:blank" || currentUrl === "" || currentUrl !== tab.url) {
                    void wvNow.loadURL?.(tab.url);
                }
            } catch { /* ignore */ }
        }, 50);
        return () => {
            if (loadUrlTimerRef.current != null) {
                clearTimeout(loadUrlTimerRef.current);
                loadUrlTimerRef.current = null;
            }
        };
    }, [tab.id, tab.url, tab.domReady, preloadUrl, webviewRef]);

    const handleWebviewAreaMouseDown = useCallback(() => {
        if (!mountedRef.current) return;
        const wv = webviewRef.current;
        if (wv) {
            if (focusTimerRef.current != null) {
                clearTimeout(focusTimerRef.current);
            }
            focusTimerRef.current = setTimeout(() => {
                focusTimerRef.current = null;
                if (!mountedRef.current) return;
                const wvNow = webviewRef.current;
                try { wvNow?.focus?.(); } catch { /* ignore */ }
            }, 0);
        }
    }, [webviewRef]);

    const userAgent = getUserAgentString(tab.userAgentType);

    if (!preloadUrl) {
        return (
            <div style={{ display: isActive ? "flex" : "none" }} className="h-full w-full flex-col">
                <WebViewFallback />
            </div>
        );
    }

    return (
        <div
            style={{ display: isActive ? "flex" : "none" }}
            className="relative h-full w-full flex-col bg-black"
            onMouseDown={isActive ? handleWebviewAreaMouseDown : undefined}
        >
            <webview
                ref={webviewRef}
                className="h-full w-full"
                src="about:blank"
                preload={preloadUrl}
                // @ts-expect-error Chromium webviewTag expects string; React types expect boolean
                allowpopups="true"
                partition={tab.partition}
                useragent={userAgent}
                data-webcontentsid={webContentsId ?? undefined}
                style={{ pointerEvents: isActive ? "auto" : "none" }}
            />
            {tab.errorText && isActive && (
                <div className="absolute inset-x-0 top-0 bg-rose-500/15 px-3 py-1.5 text-[11px] text-rose-300">
                    {tab.errorText}
                </div>
            )}
        </div>
    );
});

type BrowserTabStripProps = {
    model: RightBrowserModel;
    tabs: BrowserTabState[];
    activeTabId: string | null;
    onChromeEnter: () => void;
};

function BrowserTabStrip({ model, tabs, activeTabId, onChromeEnter }: BrowserTabStripProps) {
    return (
        <div
            className="flex h-8 shrink-0 items-stretch gap-0 overflow-hidden border-b border-[#2a2b2f] bg-[#111113] text-[11px]"
            aria-label="Browser tabs"
            onMouseEnter={onChromeEnter}
        >
            {tabs.map((tab) => {
                const active = tab.id === activeTabId;
                const displayTitle = getTabDisplayTitle(tab);
                return (
                    <div
                        key={tab.id}
                        className={cn(
                            "group/btab relative flex h-8 min-w-0 max-w-[12rem] flex-1 items-center border-r border-[#2a2b2f]",
                            active
                                ? "bg-[#18181b] text-[#f4f4f5]"
                                : "bg-[#141416] text-[#a1a1aa] hover:bg-[#1a1b1e] hover:text-[#f4f4f5]"
                        )}
                        style={{ containerType: "inline-size" }}
                    >
                        <button
                            className="flex h-full min-w-0 flex-1 cursor-pointer items-center gap-1.5 overflow-hidden px-2"
                            onClick={() => model.selectTab(tab.id)}
                            title={tab.url}
                        >
                            {tab.isLoading ? (
                                <Icon name="loading-03" size={14} className="shrink-0 text-[10px] text-[#a1a1aa]" spin />
                            ) : tab.mediaPlaying ? (
                                <i
                                    className={cn(
                                        "shrink-0 text-[10px]",
                                        tab.mediaMuted ? "volume-mute-01 text-rose-400" : "volume-high text-[#a1a1aa]"
                                    )}
                                />
                            ) : (
                                <Icon name="globe-02" size={14} className="shrink-0 text-[10px] text-[#71717a]" />
                            )}
                            <span className="min-w-0 truncate">{displayTitle}</span>
                        </button>
                        {tabs.length > 1 && (
                            <button
                                type="button"
                                aria-label="Close tab"
                                className={cn(
                                    "pointer-events-none absolute right-1 flex h-4 w-4 shrink-0 cursor-pointer items-center justify-center rounded text-[#71717a] transition-opacity hover:bg-[#3f3f46] hover:text-[#f4f4f5] focus:pointer-events-auto focus:opacity-100",
                                    "opacity-0 group-hover/btab:pointer-events-auto group-hover/btab:opacity-100"
                                )}
                                onClick={(e) => {
                                    e.stopPropagation();
                                    model.closeTab(tab.id);
                                }}
                            >
                                <Icon name="cancel-01" size={14} className="text-[10px]" />
                            </button>
                        )}
                    </div>
                );
            })}
            <button
                type="button"
                aria-label="New tab"
                className="flex h-8 w-8 shrink-0 cursor-pointer items-center justify-center text-[#a1a1aa] transition-colors hover:bg-[#2a2b2f] hover:text-[#f4f4f5]"
                onClick={() => model.newTab("about:blank", true)}
                title="New Tab"
            >
                <Icon name="plus-sign" size={14} className="text-[11px]" />
            </button>
        </div>
    );
}

export const RightBrowser = memo(function RightBrowser() {
    const env = useWaveEnv();
    const model = useMemo(() => RightBrowserModel.getInstance(), []);
    const state = jotai.useAtomValue(model.stateAtom);
    const urlInputRef = useRef<HTMLInputElement>(null);
    const [menuOpen, setMenuOpen] = useState(false);
    const mountedRef = useRef(true);
    const blurRafRef = useRef<number | null>(null);

    useEffect(() => {
        mountedRef.current = true;
        let blurScheduled = false;
        let isMouseOverWebview = false;
        const doBlur = () => {
            if (!mountedRef.current) return;
            const activeId = model.getStateNow().activeTabId;
            if (!activeId) return;
            const wv = model.getWebviewRef(activeId).current;
            if (!wv || !wv.isConnected) return;
            try { wv?.blur?.(); } catch { /* ignore */ }
        };
        const onMove = (e: MouseEvent) => {
            const el = document.elementFromPoint(e.clientX, e.clientY) as HTMLElement | null;
            const overWebview = !!(el && (el.tagName === "WEBVIEW" || el.closest("webview")));
            if (overWebview) {
                isMouseOverWebview = true;
                return;
            }
            if (isMouseOverWebview) {
                isMouseOverWebview = false;
                doBlur();
                return;
            }
            if (blurScheduled) return;
            blurScheduled = true;
            blurRafRef.current = requestAnimationFrame(() => {
                blurRafRef.current = null;
                blurScheduled = false;
                doBlur();
            });
        };
        document.addEventListener("mousemove", onMove, true);
        return () => {
            mountedRef.current = false;
            if (blurRafRef.current != null) {
                cancelAnimationFrame(blurRafRef.current);
                blurRafRef.current = null;
            }
            document.removeEventListener("mousemove", onMove, true);
        };
    }, [model]);

    const activeTab = state.activeTabId ? model.getTab(state.activeTabId) : null;

    const preloadUrl = useMemo(() => {
        try {
            return getWebviewPreloadUrl(env.electron);
        } catch {
            return null;
        }
    }, [env.electron]);

    const handleUrlKeyDown = useCallback(
        (e: KeyboardEvent<HTMLInputElement>) => {
            if (e.key === "Enter" && state.activeTabId) {
                model.loadUrl(state.activeTabId, (e.target as HTMLInputElement).value);
                const activeRef = model.getWebviewRef(state.activeTabId);
                activeRef.current?.focus();
                urlInputRef.current?.blur();
            }
        },
        [model, state.activeTabId]
    );

    const openActiveUrlExternal = useCallback(() => {
        if (activeTab?.url && activeTab.url !== "about:blank") {
            void env.electron.openExternal(activeTab.url);
        }
    }, [env.electron, activeTab?.url]);

    const handleActiveTabAction = useCallback(
        (action: (tabId: string) => void) => {
            if (state.activeTabId) action(state.activeTabId);
        },
        [state.activeTabId]
    );

    const blurActiveWebview = useCallback(() => {
        if (state.activeTabId) {
            const wv = model.getWebviewRef(state.activeTabId).current;
            try { wv?.blur?.(); } catch { /* ignore */ }
        }
    }, [model, state.activeTabId]);

    const tabTitle = activeTab ? getTabDisplayTitle(activeTab) : "Browser";

    return (
        <div className="flex h-full min-h-0 flex-col bg-[#111113]">
            <BrowserTabStrip model={model} tabs={state.tabs} activeTabId={state.activeTabId} onChromeEnter={blurActiveWebview} />
            <div
                className="flex h-9 shrink-0 items-center gap-1.5 border-b border-[#2a2b2f] bg-[#18181b] px-2"
                onMouseEnter={blurActiveWebview}
            >
                <ToolButton
                    icon="chevron-left"
                    onClick={() => handleActiveTabAction((id) => model.goBack(id))}
                    disabled={!activeTab?.canGoBack}
                    title="Go Back"
                />
                <ToolButton
                    icon="chevron-right"
                    onClick={() => handleActiveTabAction((id) => model.goForward(id))}
                    disabled={!activeTab?.canGoForward}
                    title="Go Forward"
                />
                <ToolButton
                    icon={activeTab?.isLoading ? "cancel-01" : "rotate-right-01"}
                    onClick={() => handleActiveTabAction((id) => model.reload(id))}
                    title={activeTab?.isLoading ? "Stop" : "Reload"}
                />
                <ToolButton
                    icon="home-03"
                    onClick={() => handleActiveTabAction((id) => model.goHome(id))}
                    title="Home"
                />
                <div className="relative min-w-0 flex-1">
                    <input
                        ref={urlInputRef}
                        type="text"
                        value={activeTab?.urlInputValue ?? ""}
                        onChange={(e) => {
                            if (state.activeTabId) {
                                model.patchTab(state.activeTabId, { urlInputValue: e.target.value });
                            }
                        }}
                        onKeyDown={handleUrlKeyDown}
                        onFocus={(e) => e.target.select()}
                        placeholder="Enter URL or search..."
                        className="h-7 w-full rounded border border-[#3f3f46] bg-[#202124] px-2.5 text-[12px] text-[#e4e4e7] placeholder:text-[#71717a] focus:border-[#52525b] focus:outline-none"
                    />
                    {activeTab?.isLoading && (
                        <div className="pointer-events-none absolute right-2 top-1/2 -translate-y-1/2">
                            <Icon name="loading-03" size={14} className="text-[11px] text-[#a1a1aa]" spin />
                        </div>
                    )}
                </div>
                {activeTab?.mediaPlaying && (
                    <ToolButton
                        icon={activeTab.mediaMuted ? "volume-mute-01" : "volume-high"}
                        onClick={() => handleActiveTabAction((id) => model.toggleMute(id))}
                        title={activeTab.mediaMuted ? "Unmute" : "Mute"}
                    />
                )}
                <ToolButton
                    icon="arrow-up-right-01"
                    onClick={openActiveUrlExternal}
                    title="Open in External Browser"
                />
                <div className="relative">
                    <button
                        type="button"
                        aria-label="Browser menu"
                        className="flex h-7 w-7 shrink-0 cursor-pointer items-center justify-center rounded text-[#a1a1aa] hover:bg-[#2a2b2f] hover:text-[#f4f4f5]"
                        onClick={() => setMenuOpen((v) => !v)}
                    >
                        <Icon name="more-horizontal" size={14} className="text-xs" />
                    </button>
                    {menuOpen && (
                        <>
                            <button
                                type="button"
                                aria-label="Close menu"
                                className="fixed inset-0 z-40 cursor-default border-0 bg-transparent p-0"
                                onClick={() => setMenuOpen(false)}
                            />
                            <div className="absolute right-0 top-8 z-50 w-44 rounded-md border border-[#3f3f46] bg-[#1f2023] p-1 text-[12px] shadow-xl">
                                <MenuItem
                                    onClick={() => {
                                        setMenuOpen(false);
                                        handleActiveTabAction((id) => model.setZoom(id, (activeTab?.zoomFactor ?? 1) + 0.1));
                                    }}
                                    label="Zoom In"
                                    icon="search-add"
                                />
                                <MenuItem
                                    onClick={() => {
                                        setMenuOpen(false);
                                        handleActiveTabAction((id) => model.setZoom(id, (activeTab?.zoomFactor ?? 1) - 0.1));
                                    }}
                                    label="Zoom Out"
                                    icon="search-minus"
                                />
                                <MenuItem
                                    onClick={() => {
                                        setMenuOpen(false);
                                        handleActiveTabAction((id) => model.setZoom(id, 1));
                                    }}
                                    label={`Reset Zoom (${Math.round((activeTab?.zoomFactor ?? 1) * 100)}%)`}
                                    icon="expand"
                                />
                                <div className="my-1 h-px bg-[#2a2b2f]" />
                                <MenuItem
                                    onClick={() => {
                                        setMenuOpen(false);
                                        handleActiveTabAction((id) => model.cycleUserAgent(id));
                                    }}
                                    label={
                                        activeTab?.userAgentType === "default"
                                            ? "User Agent: Desktop"
                                            : activeTab?.userAgentType === "mobile:iphone"
                                              ? "User Agent: iPhone"
                                              : "User Agent: Android"
                                    }
                                    icon="smart-phone-01"
                                />
                                <div className="my-1 h-px bg-[#2a2b2f]" />
                                <MenuItem
                                    onClick={() => {
                                        setMenuOpen(false);
                                        if (state.activeTabId) {
                                            const wv = model.getWebviewRef(state.activeTabId).current;
                                            try { wv?.openDevTools?.(); } catch { /* ignore */ }
                                        }
                                    }}
                                    label="Open DevTools"
                                    icon="code"
                                />
                            </div>
                        </>
                    )}
                </div>
            </div>
            <div className="relative min-h-0 flex-1 overflow-hidden">
                {!preloadUrl ? (
                    <WebViewFallback />
                ) : (
                    state.tabs.map((tab) => (
                        <BrowserWebView
                            key={tab.id}
                            model={model}
                            tab={tab}
                            isActive={tab.id === state.activeTabId}
                            preloadUrl={preloadUrl}
                        />
                    ))
                )}
            </div>
        </div>
    );
});
