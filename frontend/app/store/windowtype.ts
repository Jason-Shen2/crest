// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

// waveWindowType is set once at startup and never changes.
type WaveWindowType = "workspace" | "tab" | "builder" | "preview";

let waveWindowType: WaveWindowType = "tab";

function getWaveWindowType(): WaveWindowType {
    return waveWindowType;
}

function isBuilderWindow(): boolean {
    return waveWindowType === "builder";
}

function isTabWindow(): boolean {
    return waveWindowType === "tab";
}

function isPreviewWindow(): boolean {
    return waveWindowType === "preview";
}

function isWorkspaceWindow(): boolean {
    return waveWindowType === "workspace";
}

function setWaveWindowType(windowType: WaveWindowType) {
    waveWindowType = windowType;
}

export { getWaveWindowType, isBuilderWindow, isPreviewWindow, isTabWindow, isWorkspaceWindow, setWaveWindowType };
