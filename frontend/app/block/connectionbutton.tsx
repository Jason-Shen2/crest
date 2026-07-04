// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

import { computeConnColorNum } from "@/app/block/blockutil";
import { recordTEvent } from "@/app/store/global";
import { useWaveEnv } from "@/app/waveenv/waveenv";
import { IconButton } from "@/element/iconbutton";
import { Icon } from "@/app/icon/Icon";
import { cn } from "@/util/util";
import * as jotai from "jotai";
import * as React from "react";
import DotsSvg from "../asset/dots-anim-4.svg";
import { BlockEnv } from "./blockenv";

interface ConnectionButtonProps {
    connection: string;
    changeConnModalAtom: jotai.PrimitiveAtom<boolean>;
    isTerminalBlock?: boolean;
}

export const ConnectionButton = React.memo(
    React.forwardRef<HTMLDivElement, ConnectionButtonProps>(
        ({ connection, changeConnModalAtom, isTerminalBlock }: ConnectionButtonProps, ref) => {
            const waveEnv = useWaveEnv<BlockEnv>();
            const [_connModalOpen, setConnModalOpen] = jotai.useAtom(changeConnModalAtom);
            const isLocal = isLocalConnName(connection);
            const connStatus = jotai.useAtomValue(waveEnv.getConnStatusAtom(connection));
            const localName = jotai.useAtomValue(waveEnv.getLocalHostDisplayNameAtom());
            let showDisconnectedSlash = false;
            let connIconElem: React.ReactNode = null;
            const connColorNum = computeConnColorNum(connStatus);
            let color = `var(--conn-icon-color-${connColorNum})`;
            const clickHandler = function () {
                recordTEvent("action:other", { "action:type": "conndropdown", "action:initiator": "mouse" });
                setConnModalOpen(true);
            };
            let titleText = null;
            let shouldSpin = false;
            let connDisplayName: string = null;
            let extraDisplayNameClassName = "";
            if (isLocal) {
                color = "var(--color-secondary)";
                if (connection === "local:gitbash") {
                    titleText = "Connected to Git Bash";
                    connDisplayName = "Git Bash";
                } else {
                    titleText = "Connected to Local Machine";
                    if (localName) {
                        titleText += ` (${localName})`;
                    }
                    if (isTerminalBlock) {
                        connDisplayName = localName;
                        extraDisplayNameClassName = "text-muted group-hover:text-secondary";
                    }
                }
                connIconElem = (
                    <Icon name="computer" size={14} className="mr-[2px]" style={{ color: color }} />
                );
            } else {
                titleText = "Connected to " + connection;
                let iconName = "arrow-turn-backward";
                let iconSvg = null;
                if (connStatus?.status == "connecting") {
                    color = "var(--warning-color)";
                    titleText = "Connecting to " + connection;
                    shouldSpin = false;
                    iconSvg = (
                        <div className="relative top-[5px] left-[9px] [&_svg]:fill-warning">
                            <DotsSvg />
                        </div>
                    );
                } else if (connStatus?.status == "error") {
                    color = "var(--error-color)";
                    titleText = "Error connecting to " + connection;
                    if (connStatus?.error != null) {
                        titleText += " (" + connStatus.error + ")";
                    }
                    showDisconnectedSlash = true;
                } else if (!connStatus?.connected) {
                    color = "var(--grey-text-color)";
                    titleText = "Disconnected from " + connection;
                    showDisconnectedSlash = true;
                } else if (connStatus?.connhealthstatus === "degraded" || connStatus?.connhealthstatus === "stalled") {
                    color = "var(--warning-color)";
                    iconName = "wifi-off-01";
                    if (connStatus.connhealthstatus === "degraded") {
                        titleText = "Connection degraded: " + connection;
                    } else {
                        titleText = "Connection stalled: " + connection;
                    }
                }
                if (iconSvg != null) {
                    connIconElem = iconSvg;
                } else {
                    connIconElem = (
                        <Icon name={iconName} size={14} className="mr-[2px]" style={{ color: color }} />
                    );
                }
            }

            const wshProblem = connection && !connStatus?.wshenabled && connStatus?.status == "connected";
            const showNoWshButton = wshProblem && !isLocal;

            return (
                <>
                    <div
                        ref={ref}
                        className="group flex items-center flex-nowrap overflow-hidden text-ellipsis min-w-0 font-normal text-primary rounded-sm hover:bg-highlightbg cursor-pointer"
                        onClick={clickHandler}
                        title={titleText}
                    >
                        <span
                            className={cn(
                                "relative inline-flex items-center justify-center flex-[1_1_auto] overflow-hidden",
                                shouldSpin ? "animate-spin" : null
                            )}
                        >
                            {connIconElem}
                            <Icon
                                name="wifi-off-01"
                                size={14}
                                className={cn(
                                    "absolute mr-[2px] [text-shadow:0_1px_black,0_1.5px_black]",
                                    showDisconnectedSlash ? "opacity-100" : "opacity-0"
                                )}
                                style={{ color: color }}
                            />
                        </span>
                        {connDisplayName ? (
                            <div
                                className={cn(
                                    "flex-[1_2_auto] overflow-hidden pr-1 ellipsis",
                                    extraDisplayNameClassName
                                )}
                            >
                                {connDisplayName}
                            </div>
                        ) : isLocal ? null : (
                            <div className="flex-[1_2_auto] overflow-hidden pr-1 ellipsis">{connection}</div>
                        )}
                    </div>
                    {showNoWshButton && (
                        <IconButton
                            decl={{
                                elemtype: "iconbutton",
                                icon: "link-square-01",
                                title: "wsh is not installed for this connection",
                            }}
                        />
                    )}
                </>
            );
        }
    )
);
ConnectionButton.displayName = "ConnectionButton";

// Local copy of util.isLocalConnName — we don't import * as util because
// the only function we need is this one, and dropping makeIconClass
// from util.ts means there's no util namespace usage left here anyway.
function isLocalConnName(connection: string): boolean {
    if (!connection) return false;
    return connection.startsWith("local:");
}
