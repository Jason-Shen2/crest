// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

import { Icon } from "@/app/icon/Icon";
import { makeORef } from "@/app/store/wos";
import { TabRpcClient } from "@/app/store/wshrpcutil";
import { useWaveEnv } from "@/app/waveenv/waveenv";
import { WorkspaceLayoutModel } from "@/app/workspace/workspace-layout-model";
import { deleteLayoutModelForTab } from "@/layout/index";
import { isMacOSTahoeOrLater } from "@/util/platformutil";
import { fireAndForget } from "@/util/util";
import { useAtomValue } from "jotai";
import { OverlayScrollbars } from "overlayscrollbars";
import { createRef, memo, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { debounce } from "throttle-debounce";
import { Tab } from "./tab";
import "./tabbar.scss";
import { TabBarEnv } from "./tabbarenv";
import { UpdateStatusBanner } from "./updatebanner";

const TabDefaultWidth = 130;
const TabMinWidth = 100;
const MacOSTrafficLightsWidth = 74;
const MacOSTahoeTrafficLightsWidth = 80;

const OSOptions = {
    overflow: {
        x: "scroll",
        y: "hidden",
    },
    scrollbars: {
        theme: "os-theme-dark",
        visibility: "auto",
        autoHide: "leave",
        autoHideDelay: 1300,
        autoHideSuspend: false,
        dragScroll: true,
        clickScroll: false,
        pointers: ["mouse", "touch", "pen"],
    },
};

interface TabBarProps {
    workspace: Workspace;
    noTabs?: boolean;
    embedded?: boolean;
}

function strArrayIsEqual(a: string[], b: string[]) {
    // null check
    if (a == null && b == null) {
        return true;
    }
    if (a == null || b == null) {
        return false;
    }
    if (a.length !== b.length) {
        return false;
    }
    for (let i = 0; i < a.length; i++) {
        if (a[i] !== b[i]) {
            return false;
        }
    }
    return true;
}

const TabBar = memo(({ workspace, noTabs, embedded = false }: TabBarProps) => {
    const env = useWaveEnv<TabBarEnv>();
    const workspaceLayoutModel = WorkspaceLayoutModel.getInstance();
    const [tabIds, setTabIds] = useState<string[]>([]);
    const [allTabIds, setAllTabIds] = useState<string[]>([]);
    const [dragStartPositions, setDragStartPositions] = useState<number[]>([]);
    const [draggingTab, setDraggingTab] = useState<string>();
    const [tabsLoaded, setTabsLoaded] = useState({});
    // Kept for the Tab `isNew` grow-in animation hook; current create-tab flow
    // does not mark the new id locally.
    const [newTabId] = useState<string | null>(null);

    const tabbarWrapperRef = useRef<HTMLDivElement>(null);
    const tabBarRef = useRef<HTMLDivElement>(null);
    const tabsWrapperRef = useRef<HTMLDivElement>(null);
    const tabRefs = useRef<React.RefObject<HTMLDivElement>[]>([]);
    const addBtnRef = useRef<HTMLButtonElement>(null);
    const draggingRemovedRef = useRef(false);
    const draggingTabDataRef = useRef({
        tabId: "",
        ref: { current: null },
        tabStartX: 0,
        tabStartIndex: 0,
        tabIndex: 0,
        initialOffsetX: null,
        totalScrollOffset: null,
        dragged: false,
    });
    const osInstanceRef = useRef<OverlayScrollbars>(null);
    const draggerLeftRef = useRef<HTMLDivElement>(null);
    const rightContainerRef = useRef<HTMLDivElement>(null);
    const waveAIButtonRef = useRef<HTMLDivElement>(null);
    const appMenuButtonRef = useRef<HTMLDivElement>(null);
    const agentTabBtnRef = useRef<HTMLButtonElement>(null);
    const tabWidthRef = useRef<number>(TabDefaultWidth);
    const scrollableRef = useRef<boolean>(false);
    const prevAllLoadedRef = useRef<boolean>(false);
    const activeTabId = useAtomValue(env.atoms.staticTabId);
    const isFullScreen = useAtomValue(env.atoms.isFullScreen);
    const zoomFactor = useAtomValue(env.atoms.zoomFactorAtom);
    const showMenuBar = useAtomValue(env.getSettingsKeyAtom("window:showmenubar"));
    const confirmClose = useAtomValue(env.getSettingsKeyAtom("tab:confirmclose")) ?? false;
    const hideAiButton = useAtomValue(env.getSettingsKeyAtom("app:hideaibutton"));
    const appUpdateStatus = useAtomValue(env.atoms.updaterStatusAtom);
    const persistedAgentTabId = useAtomValue(workspaceLayoutModel.agentTabIdAtom);

    // Agent-view tabs are detected reactively (see AgentTabProbe): on a fresh
    // project load the tab/block WaveObjects aren't in the sync cache yet, so a
    // synchronous check would miss the backend's starter agent tab and let it
    // leak into the strip.  New/starter tabs default to view:"agent", so a
    // workspace can hold several — every one is reachable only through the
    // fixed Agent button, never as its own strip tab.
    const [agentTabIdSet, setAgentTabIdSet] = useState<Set<string>>(new Set());
    const reportAgentTab = useCallback((tabId: string, isAgent: boolean) => {
        setAgentTabIdSet((prev) => {
            const has = prev.has(tabId);
            if (isAgent === has) return prev;
            const next = new Set(prev);
            if (isAgent) {
                next.add(tabId);
            } else {
                next.delete(tabId);
            }
            return next;
        });
    }, []);
    const agentTabIds = useMemo(
        () => allTabIds.filter((tabId) => agentTabIdSet.has(tabId)),
        [allTabIds, agentTabIdSet]
    );

    const activeTabIsAgent = agentTabIdSet.has(activeTabId);

    // Persist the first detected agent tab as the canonical fixed Agent tab so
    // reloads reuse it instead of ever creating a second one.
    useEffect(() => {
        if (agentTabIds.length === 0) return;
        if (persistedAgentTabId && agentTabIds.includes(persistedAgentTabId)) return;
        workspaceLayoutModel.setAgentTabId(agentTabIds[0]);
    }, [agentTabIds, persistedAgentTabId, workspaceLayoutModel]);

    let prevDelta: number;
    let prevDragDirection: string;

    // Update refs when tabIds change
    useEffect(() => {
        tabRefs.current = tabIds.map((_, index) => tabRefs.current[index] || createRef());
    }, [tabIds]);

    useEffect(() => {
        if (!workspace) {
            return;
        }
        const newTabIdsArr = workspace.tabids ?? [];

        const areEqual = strArrayIsEqual(allTabIds, newTabIdsArr);

        if (!areEqual) {
            setAllTabIds(newTabIdsArr);
        }
    }, [workspace, allTabIds]);

    useEffect(() => {
        setAgentTabIdSet((prev) => {
            let changed = false;
            const next = new Set(prev);
            for (const tabId of prev) {
                if (!allTabIds.includes(tabId)) {
                    next.delete(tabId);
                    changed = true;
                }
            }
            return changed ? next : prev;
        });
    }, [allTabIds]);

    useEffect(() => {
        const visibleTabIds = allTabIds.filter((tabId) => !agentTabIdSet.has(tabId));
        if (strArrayIsEqual(tabIds, visibleTabIds)) return;
        setTabIds(visibleTabIds);
    }, [allTabIds, agentTabIdSet, tabIds]);

    const saveTabsPosition = useCallback(() => {
        const tabs = tabRefs.current;
        if (tabs === null) return;

        const newStartPositions: number[] = [];
        let cumulativeLeft = 0; // Start from the left edge

        tabRefs.current.forEach((ref) => {
            if (ref.current) {
                newStartPositions.push(cumulativeLeft);
                cumulativeLeft += ref.current.getBoundingClientRect().width; // Add each tab's actual width to the cumulative position
            }
        });

        setDragStartPositions(newStartPositions);
    }, []);

    const setSizeAndPosition = (animate?: boolean) => {
        const tabBar = tabBarRef.current;
        if (tabBar === null) return;

        const getOuterWidth = (el: HTMLElement): number => {
            const rect = el.getBoundingClientRect();
            const style = getComputedStyle(el);
            return rect.width + parseFloat(style.marginLeft) + parseFloat(style.marginRight);
        };

        const tabbarWrapperWidth = tabbarWrapperRef.current.getBoundingClientRect().width;
        const windowDragLeftWidth = draggerLeftRef.current.getBoundingClientRect().width;
        const rightContainerWidth = rightContainerRef.current?.getBoundingClientRect().width ?? 0;
        const addBtnWidth = getOuterWidth(addBtnRef.current);
        const appMenuButtonWidth = appMenuButtonRef.current?.getBoundingClientRect().width ?? 0;
        const waveAIButtonWidth =
            !hideAiButton && waveAIButtonRef.current != null ? getOuterWidth(waveAIButtonRef.current) : 0;
        const agentTabBtnWidth = agentTabBtnRef.current != null ? getOuterWidth(agentTabBtnRef.current) : 0;

        const nonTabElementsWidth =
            windowDragLeftWidth +
            rightContainerWidth +
            addBtnWidth +
            appMenuButtonWidth +
            waveAIButtonWidth +
            agentTabBtnWidth;
        const spaceForTabs = tabbarWrapperWidth - nonTabElementsWidth;

        const numberOfTabs = tabIds.length;

        // Compute the ideal width per tab by dividing the available space by the number of tabs
        let idealTabWidth = numberOfTabs > 0 ? spaceForTabs / numberOfTabs : TabDefaultWidth;

        // Apply min/max constraints
        idealTabWidth = Math.max(TabMinWidth, Math.min(idealTabWidth, TabDefaultWidth));

        // Determine if the tab bar needs to be scrollable
        const newScrollable = numberOfTabs > 0 && idealTabWidth * numberOfTabs > spaceForTabs;

        // Apply the calculated width and position to all tabs
        tabRefs.current.forEach((ref, index) => {
            if (ref.current) {
                if (animate) {
                    ref.current.classList.add("animate");
                } else {
                    ref.current.classList.remove("animate");
                }
                ref.current.style.width = `${idealTabWidth}px`;
                ref.current.style.transform = `translate3d(${index * idealTabWidth}px,0,0)`;
                ref.current.style.opacity = "1";
            }
        });

        // Update the state with the new tab width if it has changed
        if (idealTabWidth !== tabWidthRef.current) {
            tabWidthRef.current = idealTabWidth;
        }

        // Update the state with the new scrollable state if it has changed
        if (newScrollable !== scrollableRef.current) {
            scrollableRef.current = newScrollable;
        }

        // Initialize/destroy overlay scrollbars
        if (newScrollable) {
            osInstanceRef.current = OverlayScrollbars(tabBarRef.current, { ...(OSOptions as any) });
        } else {
            if (osInstanceRef.current) {
                osInstanceRef.current.destroy();
            }
        }
    };

    const saveTabsPositionDebounced = useCallback(
        debounce(100, () => saveTabsPosition()),
        [saveTabsPosition]
    );

    const handleResizeTabs = useCallback(() => {
        setSizeAndPosition();
        saveTabsPositionDebounced();
    }, [tabIds, newTabId, isFullScreen]);

    // update layout on reinit version
    const reinitVersion = useAtomValue(env.atoms.reinitVersion);
    useEffect(() => {
        if (reinitVersion > 0) {
            setSizeAndPosition();
        }
    }, [reinitVersion]);

    // update layout on resize
    useEffect(() => {
        window.addEventListener("resize", handleResizeTabs);
        return () => {
            window.removeEventListener("resize", handleResizeTabs);
        };
    }, [handleResizeTabs]);

    // update layout on changed tabIds, tabsLoaded, newTabId, hideAiButton, appUpdateStatus, or zoomFactor
    useEffect(() => {
        // Check if all tabs are loaded
        const allLoaded = tabIds.length > 0 && tabIds.every((id) => tabsLoaded[id]);
        if (allLoaded) {
            setSizeAndPosition(false);
            saveTabsPosition();
            if (!prevAllLoadedRef.current) {
                prevAllLoadedRef.current = true;
            }
        }
    }, [tabIds, tabsLoaded, newTabId, saveTabsPosition, hideAiButton, appUpdateStatus, zoomFactor, showMenuBar]);

    const getDragDirection = (currentX: number) => {
        let dragDirection: string;
        if (currentX - prevDelta > 0) {
            dragDirection = "+";
        } else if (currentX - prevDelta === 0) {
            dragDirection = prevDragDirection;
        } else {
            dragDirection = "-";
        }
        prevDelta = currentX;
        prevDragDirection = dragDirection;
        return dragDirection;
    };

    const getNewTabIndex = (currentX: number, tabIndex: number, dragDirection: string) => {
        let newTabIndex = tabIndex;
        const tabWidth = tabWidthRef.current;
        if (dragDirection === "+") {
            // Dragging to the right
            for (let i = tabIndex + 1; i < tabIds.length; i++) {
                const otherTabStart = dragStartPositions[i];
                if (currentX + tabWidth > otherTabStart + tabWidth / 2) {
                    newTabIndex = i;
                }
            }
        } else {
            // Dragging to the left
            for (let i = tabIndex - 1; i >= 0; i--) {
                const otherTabEnd = dragStartPositions[i] + tabWidth;
                if (currentX < otherTabEnd - tabWidth / 2) {
                    newTabIndex = i;
                }
            }
        }
        return newTabIndex;
    };

    const handleMouseMove = (event: MouseEvent) => {
        const { tabId, ref, tabStartX } = draggingTabDataRef.current;

        let initialOffsetX = draggingTabDataRef.current.initialOffsetX;
        let totalScrollOffset = draggingTabDataRef.current.totalScrollOffset;
        if (initialOffsetX === null) {
            initialOffsetX = event.clientX - tabStartX;
            draggingTabDataRef.current.initialOffsetX = initialOffsetX;
        }
        let currentX = event.clientX - initialOffsetX - totalScrollOffset;
        let tabBarRectWidth = tabBarRef.current.getBoundingClientRect().width;
        // for macos, it's offset to make space for the window buttons
        const tabBarRectLeftOffset = tabBarRef.current.getBoundingClientRect().left;
        const incrementDecrement = tabBarRectLeftOffset * 0.05;
        const dragDirection = getDragDirection(currentX);
        const scrollable = scrollableRef.current;
        const tabWidth = tabWidthRef.current;

        // Scroll the tab bar if the dragged tab overflows the container bounds
        if (scrollable) {
            const { viewport } = osInstanceRef.current.elements();
            const currentScrollLeft = viewport.scrollLeft;

            if (event.clientX <= tabBarRectLeftOffset) {
                viewport.scrollLeft = Math.max(0, currentScrollLeft - incrementDecrement); // Scroll left
                if (viewport.scrollLeft !== currentScrollLeft) {
                    // Only adjust if the scroll actually changed
                    draggingTabDataRef.current.totalScrollOffset += currentScrollLeft - viewport.scrollLeft;
                }
            } else if (event.clientX >= tabBarRectWidth + tabBarRectLeftOffset) {
                viewport.scrollLeft = Math.min(viewport.scrollWidth, currentScrollLeft + incrementDecrement); // Scroll right
                if (viewport.scrollLeft !== currentScrollLeft) {
                    // Only adjust if the scroll actually changed
                    draggingTabDataRef.current.totalScrollOffset -= viewport.scrollLeft - currentScrollLeft;
                }
            }
        }

        // Re-calculate currentX after potential scroll adjustment
        initialOffsetX = draggingTabDataRef.current.initialOffsetX;
        totalScrollOffset = draggingTabDataRef.current.totalScrollOffset;
        currentX = event.clientX - initialOffsetX - totalScrollOffset;

        setDraggingTab((prev) => (prev !== tabId ? tabId : prev));

        // Check if the tab has moved 5 pixels
        if (Math.abs(currentX - tabStartX) >= 50) {
            draggingTabDataRef.current.dragged = true;
        }

        // Constrain movement within the container bounds
        if (tabBarRef.current) {
            const numberOfTabs = tabIds.length;
            const totalDefaultTabWidth = numberOfTabs * TabDefaultWidth;
            if (totalDefaultTabWidth < tabBarRectWidth) {
                // Set to the total default tab width if there's vacant space
                tabBarRectWidth = totalDefaultTabWidth;
            } else if (scrollable) {
                // Set to the scrollable width if the tab bar is scrollable
                tabBarRectWidth = tabsWrapperRef.current.scrollWidth;
            }

            const minLeft = 0;
            const maxRight = tabBarRectWidth - tabWidth;

            // Adjust currentX to stay within bounds
            currentX = Math.min(Math.max(currentX, minLeft), maxRight);
        }

        ref.current!.style.transform = `translate3d(${currentX}px,0,0)`;
        ref.current!.style.zIndex = "100";

        const tabIndex = draggingTabDataRef.current.tabIndex;
        const newTabIndex = getNewTabIndex(currentX, tabIndex, dragDirection);

        if (newTabIndex !== tabIndex) {
            // Remove the dragged tab if not already done
            if (!draggingRemovedRef.current) {
                tabIds.splice(tabIndex, 1);
                draggingRemovedRef.current = true;
            }

            // Find current index of the dragged tab in tempTabs
            const currentIndexOfDraggingTab = tabIds.indexOf(tabId);

            // Move the dragged tab to its new position
            if (currentIndexOfDraggingTab !== -1) {
                tabIds.splice(currentIndexOfDraggingTab, 1);
            }
            tabIds.splice(newTabIndex, 0, tabId);

            // Update visual positions of the tabs
            tabIds.forEach((localTabId, index) => {
                const ref = tabRefs.current.find((ref) => ref.current.dataset.tabId === localTabId);
                if (ref.current && localTabId !== tabId) {
                    ref.current.style.transform = `translate3d(${index * tabWidth}px,0,0)`;
                    ref.current.classList.add("animate");
                }
            });

            draggingTabDataRef.current.tabIndex = newTabIndex;
        }
    };

    const mergeAgentTabIds = useCallback(
        (visibleTabIds: string[]): string[] => {
            if (agentTabIds.length === 0) return visibleTabIds;
            // Re-anchor every hidden agent tab at the index it held in the
            // full (backend) order so a reorder of visible tabs never drops
            // or reshuffles the agent surfaces the strip doesn't render.
            const next = visibleTabIds.filter((tabId) => !agentTabIds.includes(tabId));
            for (const agentTabId of [...allTabIds].filter((tabId) => agentTabIds.includes(tabId))) {
                const backingIndex = allTabIds.indexOf(agentTabId);
                const insertIndex = Math.max(0, Math.min(backingIndex, next.length));
                next.splice(insertIndex, 0, agentTabId);
            }
            return next;
        },
        [allTabIds, agentTabIds]
    );

    const setUpdatedTabsDebounced = useCallback(
        debounce(300, (tabIds: string[]) => {
            // Reset styles
            tabRefs.current.forEach((ref) => {
                ref.current.style.zIndex = "0";
                ref.current.classList.remove("animate");
            });
            // Reset dragging state
            setDraggingTab(null);
            // Update workspace tab ids
            fireAndForget(() =>
                env.rpc.UpdateWorkspaceTabIdsCommand(TabRpcClient, workspace.oid, mergeAgentTabIds(tabIds))
            );
        }),
        [env, mergeAgentTabIds, workspace.oid]
    );

    const handleMouseUp = (_event: MouseEvent) => {
        const { tabIndex, dragged } = draggingTabDataRef.current;

        // Update the final position of the dragged tab
        const draggingTab = tabIds[tabIndex];
        const tabWidth = tabWidthRef.current;
        const finalLeftPosition = tabIndex * tabWidth;
        const ref = tabRefs.current.find((ref) => ref.current.dataset.tabId === draggingTab);
        if (ref.current) {
            ref.current.classList.add("animate");
            ref.current.style.transform = `translate3d(${finalLeftPosition}px,0,0)`;
        }

        if (dragged) {
            setUpdatedTabsDebounced(tabIds);
        } else {
            // Reset styles
            tabRefs.current.forEach((ref) => {
                ref.current.style.zIndex = "0";
                ref.current.classList.remove("animate");
            });
            // Reset dragging state
            setDraggingTab(null);
        }

        document.removeEventListener("mouseup", handleMouseUp);
        document.removeEventListener("mousemove", handleMouseMove);
        draggingRemovedRef.current = false;
    };

    const handleDragStart = useCallback(
        (event: React.MouseEvent<HTMLDivElement, MouseEvent>, tabId: string, ref: React.RefObject<HTMLDivElement>) => {
            if (event.button !== 0) return;

            const tabIndex = tabIds.indexOf(tabId);
            const tabStartX = dragStartPositions[tabIndex]; // Starting X position of the tab

            console.log("handleDragStart", tabId, tabIndex, tabStartX);
            if (ref.current) {
                draggingTabDataRef.current = {
                    tabId: ref.current.dataset.tabId,
                    ref,
                    tabStartX,
                    tabIndex,
                    tabStartIndex: tabIndex,
                    initialOffsetX: null,
                    totalScrollOffset: 0,
                    dragged: false,
                };

                document.addEventListener("mousemove", handleMouseMove);
                document.addEventListener("mouseup", handleMouseUp);
            }
        },
        [tabIds, dragStartPositions]
    );

    const handleSelectTab = (tabId: string) => {
        if (!draggingTabDataRef.current.dragged) {
            workspaceLayoutModel.setFileExplorerVisible(true);
            env.electron.setActiveTab(tabId);
        }
    };

    const handleAgentClick = useCallback(() => {
        fireAndForget(() => workspaceLayoutModel.openAgentTab());
    }, [workspaceLayoutModel]);

    const handleAddTab = () => {
        env.electron.createTab();
        tabsWrapperRef.current.style.setProperty("--tabs-wrapper-transition", "width 0.1s ease");
    };

    const handleCloseTab = (event: React.MouseEvent<HTMLButtonElement, MouseEvent> | null, tabId: string) => {
        event?.stopPropagation();
        env.electron
            .closeTab(workspace.oid, tabId, confirmClose)
            .then((didClose) => {
                if (didClose) {
                    tabsWrapperRef.current?.style.setProperty("--tabs-wrapper-transition", "width 0.3s ease");
                    deleteLayoutModelForTab(tabId);
                }
            })
            .catch((e) => {
                console.log("error closing tab", e);
            });
    };

    const handleTabLoaded = useCallback((tabId: string) => {
        setTabsLoaded((prev) => {
            if (!prev[tabId]) {
                // Only update if the tab isn't already marked as loaded
                return { ...prev, [tabId]: true };
            }
            return prev;
        });
    }, []);

    const activeTabIndex = tabIds.indexOf(activeTabId);

    function onEllipsisClick() {
        env.electron.showWorkspaceAppMenu(workspace.oid);
    }

    const tabsWrapperWidth = tabIds.length * tabWidthRef.current;
    const showAppMenuButton = !embedded && (env.isWindows() || (!env.isMacOS() && !showMenuBar));

    // Calculate window drag left width based on platform and state
    let windowDragLeftWidth = 10;
    if (embedded) {
        windowDragLeftWidth = 0;
    } else if (env.isMacOS() && !isFullScreen) {
        const trafficLightsWidth = isMacOSTahoeOrLater() ? MacOSTahoeTrafficLightsWidth : MacOSTrafficLightsWidth;
        if (zoomFactor > 0) {
            windowDragLeftWidth = trafficLightsWidth / zoomFactor;
        } else {
            windowDragLeftWidth = trafficLightsWidth;
        }
    }

    // Calculate window drag right width
    let windowDragRightWidth = 12;
    if (embedded) {
        windowDragRightWidth = 0;
    } else if (env.isWindows()) {
        if (zoomFactor > 0) {
            windowDragRightWidth = 139 / zoomFactor;
        } else {
            windowDragRightWidth = 139;
        }
    }

    return (
        <div ref={tabbarWrapperRef} className={`tab-bar-wrapper${embedded ? " embedded" : ""}`}>
            {allTabIds.map((tabId) => (
                <AgentTabProbe key={`probe:${tabId}`} tabId={tabId} onResult={reportAgentTab} />
            ))}
            <div
                ref={draggerLeftRef}
                className="h-full shrink-0 z-window-drag"
                style={{ width: windowDragLeftWidth, WebkitAppRegion: "drag" } as any}
            />
            {showAppMenuButton && (
                <div
                    ref={appMenuButtonRef}
                    className="flex items-center justify-center pr-1.5 text-[30px] select-none cursor-pointer text-secondary hover:text-primary"
                    style={{ WebkitAppRegion: "no-drag" } as React.CSSProperties}
                    onClick={onEllipsisClick}
                >
                    <i className="fa fa-ellipsis" />
                </div>
            )}
            <button
                ref={agentTabBtnRef}
                type="button"
                title="Agent"
                className={
                    "agent-tab-btn flex items-center gap-1.5 shrink-0 cursor-pointer rounded-md px-2 text-[13px] font-medium transition-colors " +
                    (embedded ? "h-[22px] mx-0.5 " : "h-[22px] mx-1 mb-[2px] ") +
                    (activeTabIsAgent
                        ? "bg-white/[0.1] text-foreground"
                        : "text-secondary hover:bg-hoverbg hover:text-primary")
                }
                style={{ WebkitAppRegion: "no-drag" } as React.CSSProperties}
                onClick={handleAgentClick}
            >
                <Icon name="sparkles" size={13} strokeWidth={1.75} />
                <span>Agent</span>
            </button>
            <div className="tab-bar" ref={tabBarRef} data-overlayscrollbars-initialize>
                <div
                    className="tabs-wrapper"
                    ref={tabsWrapperRef}
                    style={{
                        width: noTabs ? 0 : tabsWrapperWidth,
                        ...(noTabs ? ({ WebkitAppRegion: "drag" } as React.CSSProperties) : {}),
                    }}
                >
                    {!noTabs &&
                        tabIds.map((tabId, index) => {
                            const isActive = activeTabId === tabId;
                            const showDivider = index !== 0 && !isActive && index !== activeTabIndex + 1;
                            return (
                                <Tab
                                    key={tabId}
                                    ref={tabRefs.current[index]}
                                    id={tabId}
                                    showDivider={showDivider}
                                    onSelect={() => handleSelectTab(tabId)}
                                    active={isActive}
                                    onDragStart={(event) => handleDragStart(event, tabId, tabRefs.current[index])}
                                    onClose={(event) => handleCloseTab(event, tabId)}
                                    onLoaded={() => handleTabLoaded(tabId)}
                                    isDragging={draggingTab === tabId}
                                    tabWidth={tabWidthRef.current}
                                    isNew={tabId === newTabId}
                                />
                            );
                        })}
                </div>
            </div>
            <button
                ref={addBtnRef}
                title="Add Tab"
                className={`add-tab flex h-[22px] px-2 mx-1 items-center justify-center rounded-md box-border cursor-pointer hover:bg-hoverbg transition-colors text-[15px] text-secondary hover:text-primary${noTabs ? " invisible" : ""}`}
                style={{ WebkitAppRegion: "no-drag" } as React.CSSProperties}
                onClick={handleAddTab}
            >
                <Icon name="plus-sign" size={13} strokeWidth={1.75} />
            </button>
            <div className="flex-1" />
            <div ref={rightContainerRef} className="flex flex-row gap-1 items-end">
                {!embedded && <UpdateStatusBanner />}
                <div
                    className="h-full shrink-0 z-window-drag"
                    style={{ width: windowDragRightWidth, WebkitAppRegion: "drag" } as any}
                />
            </div>
        </div>
    );
});

export { TabBar };

// AgentTabProbe — reactively reports whether a tab is an agent-view tab.
// Rendered (invisibly) once per tab so detection survives the async load of
// the tab + first-block WaveObjects on a fresh project, which a synchronous
// cache read would miss (letting the starter agent tab leak into the strip).
const AgentTabProbe = memo(
    ({ tabId, onResult }: { tabId: string; onResult: (tabId: string, isAgent: boolean) => void }) => {
        const env = useWaveEnv<TabBarEnv>();
        const [tab] = env.wos.useWaveObjectValue<Tab>(makeORef("tab", tabId));
        const firstBlockId = tab?.blockids?.[0];
        const [firstBlock] = env.wos.useWaveObjectValue<Block>(firstBlockId ? makeORef("block", firstBlockId) : null);
        const isAgent = firstBlock?.meta?.view === "agent";
        useEffect(() => {
            onResult(tabId, isAgent);
        }, [tabId, isAgent, onResult]);
        useEffect(() => {
            return () => onResult(tabId, false);
        }, [tabId, onResult]);
        return null;
    }
);
AgentTabProbe.displayName = "AgentTabProbe";
