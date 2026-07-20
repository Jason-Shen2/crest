// Copyright (c) 2023-2026 Langfuse GmbH
// SPDX-License-Identifier: MIT

import { useId, useRef, type KeyboardEvent, type ReactNode } from "react";

export type DetailTab = "preview" | "json";

const DetailTabOrder: DetailTab[] = ["preview", "json"];

export function DetailTabs({
    label,
    value,
    onChange,
    preview,
    json,
}: {
    label: string;
    value: DetailTab;
    onChange: (value: DetailTab) => void;
    preview: ReactNode;
    json: ReactNode;
}) {
    const id = useId();
    const tabRefs = useRef<Record<DetailTab, HTMLButtonElement | null>>({ preview: null, json: null });

    const activateFromKeyboard = (event: KeyboardEvent<HTMLButtonElement>, currentIndex: number) => {
        let targetIndex: number;
        switch (event.key) {
            case "ArrowRight":
                targetIndex = (currentIndex + 1) % DetailTabOrder.length;
                break;
            case "ArrowLeft":
                targetIndex = (currentIndex - 1 + DetailTabOrder.length) % DetailTabOrder.length;
                break;
            case "Home":
                targetIndex = 0;
                break;
            case "End":
                targetIndex = DetailTabOrder.length - 1;
                break;
            default:
                return;
        }
        event.preventDefault();
        const target = DetailTabOrder[targetIndex];
        onChange(target);
        tabRefs.current[target]?.focus();
    };

    return (
        <>
            <div role="tablist" aria-label={label} className="flex shrink-0 border-b border-border px-3">
                {DetailTabOrder.map((tab, index) => {
                    const selected = value === tab;
                    const tabId = `${id}-${tab}-tab`;
                    const panelId = `${id}-${tab}-panel`;
                    return (
                        <button
                            key={tab}
                            ref={(element) => {
                                tabRefs.current[tab] = element;
                            }}
                            id={tabId}
                            type="button"
                            role="tab"
                            aria-controls={panelId}
                            aria-selected={selected}
                            tabIndex={selected ? 0 : -1}
                            className="cursor-pointer border-b-2 border-transparent px-3 py-2 text-xs capitalize text-muted-foreground aria-selected:border-accent aria-selected:text-foreground"
                            onClick={() => onChange(tab)}
                            onKeyDown={(event) => activateFromKeyboard(event, index)}
                        >
                            {tab === "json" ? "JSON" : "Preview"}
                        </button>
                    );
                })}
            </div>
            {DetailTabOrder.map((tab) => (
                <div
                    key={tab}
                    id={`${id}-${tab}-panel`}
                    role="tabpanel"
                    aria-labelledby={`${id}-${tab}-tab`}
                    tabIndex={0}
                    hidden={value !== tab}
                    className="min-h-0 flex-1 overflow-auto"
                >
                    {tab === "preview" ? preview : json}
                </div>
            ))}
        </>
    );
}
