// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

import { globalStore } from "@/app/store/jotaiStore";
import { getTabModelByTabId, TabModelContext } from "@/app/store/tab-model";
import { TabContent } from "@/app/tab/tabcontent";
import { WaveEnvContext } from "@/app/waveenv/waveenv";
import { makeWaveEnvImpl } from "@/app/waveenv/waveenvimpl";
import { Provider } from "jotai";
import { useEffect, useMemo, useRef } from "react";
import { DndProvider } from "react-dnd";
import { HTML5Backend } from "react-dnd-html5-backend";

type TerminalAppProps = {
    tabId: string;
    onFirstRender: () => void;
};

export function TerminalApp({ tabId, onFirstRender }: TerminalAppProps) {
    const waveEnvRef = useRef(makeWaveEnvImpl());
    const tabModel = useMemo(() => (tabId ? getTabModelByTabId(tabId, waveEnvRef.current) : null), [tabId]);

    useEffect(() => {
        onFirstRender();
    }, [onFirstRender]);

    return (
        <Provider store={globalStore}>
            <WaveEnvContext.Provider value={waveEnvRef.current}>
                <DndProvider backend={HTML5Backend}>
                    <div className="flex h-full w-full min-h-0 overflow-hidden" data-testid="terminal-renderer-root">
                        {tabModel == null ? (
                            <div
                                className="flex h-full w-full items-center justify-center text-sm text-muted-foreground"
                                data-testid="terminal-empty-state"
                            >
                                No Terminal selected
                            </div>
                        ) : (
                            <TabModelContext.Provider value={tabModel}>
                                <TabContent key={tabId} tabId={tabId} noTopPadding={true} />
                            </TabModelContext.Provider>
                        )}
                    </div>
                </DndProvider>
            </WaveEnvContext.Provider>
        </Provider>
    );
}
