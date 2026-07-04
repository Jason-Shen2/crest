// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0
//
// About section — model adapts terax's AboutSection.tsx onto crest's About
// data. Crest already has AboutModalV that does most of the heavy lifting;
// this version renders the same content in the settings section style
// (no gradient bg, no overlay buttons — those lived behind the legacy
// modal frame).

import Logo from "@/app/asset/logo.svg";
import { Icon } from "@/app/icon/Icon";
import { atoms } from "@/app/store/global";
import { isDev } from "@/util/isdev";
import { useAtomValue } from "jotai";
import { useEffect } from "react";
import { RpcApi } from "@/app/store/wshclientapi";
import { TabRpcClient } from "@/app/store/wshrpcutil";
import { fireAndForget } from "@/util/util";
import { SectionHeader } from "./SectionHeader";

const REPO_URL = "https://github.com/s-zx/crest";

export function AboutSection() {
    const fullConfig = useAtomValue(atoms.fullConfigAtom);
    const versionString = `${fullConfig?.version ?? ""} (${isDev() ? "dev-" : ""}${fullConfig?.buildtime ?? ""})`;
    const updaterChannel = fullConfig?.settings?.["autoupdate:channel"] ?? "latest";
    const currentYear = new Date().getFullYear();

    useEffect(() => {
        fireAndForget(async () => {
            RpcApi.RecordTEventCommand(
                TabRpcClient,
                { event: "action:other", props: { "action:type": "settings.about" } },
                { noresponse: true }
            );
        });
    }, []);

    return (
        <div className="flex flex-col gap-6">
            <SectionHeader title="About" description="Build info, license, and links." />

            <div className="flex items-center gap-4 rounded-xl border border-modal-border bg-white/[0.02] p-5">
                <div className="size-12 shrink-0">
                    <Logo />
                </div>
                <div className="flex min-w-0 flex-col">
                    <span className="text-[15px] font-semibold tracking-tight">Wave Terminal</span>
                    <span className="text-[11px] text-white/55">Open-source AI-integrated terminal</span>
                    <span className="mt-1 font-mono text-[11px] text-white/55">v{versionString}</span>
                </div>
            </div>

            <dl className="grid grid-cols-[110px_1fr] gap-y-2.5 text-[12px]">
                <dt className="text-white/55">Update channel</dt>
                <dd className="font-mono text-[11.5px]">{updaterChannel}</dd>

                <dt className="text-white/55">License</dt>
                <dd>Apache 2.0</dd>

                <dt className="text-white/55">Source code</dt>
                <dd>
                    <a
                        href={REPO_URL}
                        target="_blank"
                        rel="noopener"
                        className="inline-flex items-center gap-1.5 rounded-md text-[12px] underline-offset-2 hover:text-foreground hover:underline"
                    >
                        <Icon name="github" size={12} className="opacity-80" />
                        s-zx/crest
                    </a>
                </dd>
            </dl>

            <div className="flex flex-wrap gap-2">
                <a
                    href={REPO_URL}
                    target="_blank"
                    rel="noopener"
                    className="inline-flex items-center gap-1.5 h-7 px-3 rounded-md bg-white/[0.06] hover:bg-white/[0.10] text-[12px] text-white transition-colors"
                >
                    <Icon name="github" size={12} className="opacity-90" />
                    View on GitHub
                </a>
                <a
                    href={`${REPO_URL}/issues/new`}
                    target="_blank"
                    rel="noopener"
                    className="inline-flex items-center gap-1.5 h-7 px-3 rounded-md hover:bg-white/[0.06] text-[12px] text-white/75 transition-colors"
                >
                    Report an issue
                </a>
            </div>

            <div className="text-[11px] text-white/45 text-center">
                &copy; {currentYear} Command Line Inc.
            </div>
        </div>
    );
}