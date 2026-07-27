import { isAbsoluteLocalPath } from "@/util/local-path";

export type ActiveContent =
    | { kind: "agent" }
    | { kind: "terminal"; terminalTabId: string }
    | { kind: "top-tab"; topTabId: string };

export type GitDiffMode = "+" | "-";

export type TopTab =
    | { id: string; kind: "file"; path: string; title: string }
    | { id: string; kind: "preview"; path: string; title: string }
    | {
          id: string;
          kind: "git-diff";
          repoRoot: string;
          path: string;
          mode: GitDiffMode;
          originalPath: string;
          title: string;
      };

export interface WorkspaceContentState {
    activeContent: ActiveContent;
    topTabs: TopTab[];
    lastActiveTopTabId: string;
}

export interface PersistedActiveContent {
    kind: string;
    terminaltabid?: string;
    toptabid?: string;
}

export interface PersistedTopTab {
    id: string;
    kind: string;
    path?: string;
    url?: string;
    title: string;
    reporoot?: string;
    mode?: string;
    originalpath?: string;
}

export interface PersistedWorkspaceContentState {
    activecontent: PersistedActiveContent;
    toptabs: PersistedTopTab[];
    lastactivetoptabid?: string;
}

export type TopTabUpdates =
    | { kind: "file"; title?: string; path?: string }
    | { kind: "preview"; title?: string; path?: string }
    | {
          kind: "git-diff";
          title?: string;
          repoRoot?: string;
          path?: string;
          mode?: GitDiffMode;
          originalPath?: string;
      };

export type WorkspaceContentAction =
    | { type: "activate-agent" }
    | { type: "activate-terminal"; terminalTabId: string }
    | { type: "activate-top-tab"; topTabId: string }
    | { type: "open-top-tab"; tab: TopTab }
    | { type: "close-top-tab"; topTabId: string; activeTerminalTabId?: string }
    | { type: "reorder-top-tab"; topTabId: string; targetIndex: number }
    | { type: "update-top-tab"; topTabId: string; updates: TopTabUpdates };

export function normalizeFileTabPath(filePath: string): string {
    const normalized = filePath.replace(/\\/g, "/");
    const isUnc = normalized.startsWith("//");
    const isDriveAbsolute = /^[A-Za-z]:\//.test(normalized);
    const isPosixAbsolute = !isUnc && normalized.startsWith("/");
    const rawSegments = normalized.split("/").filter(Boolean);
    const rootDepth = isUnc ? Math.min(2, rawSegments.length) : isDriveAbsolute ? 1 : 0;
    const segments: string[] = [];
    for (const segment of rawSegments) {
        if (segment === ".") {
            continue;
        }
        if (segment === "..") {
            if (segments.length > rootDepth) {
                segments.pop();
            }
            continue;
        }
        segments.push(segment);
    }
    if (isUnc) {
        return "//" + segments.join("/");
    }
    if (isDriveAbsolute && segments.length === 1) {
        return segments[0] + "/";
    }
    return (isPosixAbsolute ? "/" : "") + segments.join("/");
}

export function makeDefaultWorkspaceContentState(): WorkspaceContentState {
    return {
        activeContent: { kind: "agent" },
        topTabs: [],
        lastActiveTopTabId: "",
    };
}

function cloneTopTab(tab: TopTab): TopTab {
    return { ...tab };
}

function cloneState(state: WorkspaceContentState): WorkspaceContentState {
    return {
        activeContent: { ...state.activeContent },
        topTabs: [...state.topTabs],
        lastActiveTopTabId: state.lastActiveTopTabId,
    };
}

function hasTopTab(topTabs: { id: string }[], topTabId: string): boolean {
    return Boolean(topTabId) && topTabs.some((tab) => tab.id === topTabId);
}

function isNonEmptyString(value: unknown): value is string {
    return typeof value === "string" && value !== "";
}

function normalizeTerminalTabId(value: unknown): string {
    return isNonEmptyString(value) ? value : "";
}

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === "object" && value != null;
}

function isAbsoluteTopTabPath(value: unknown): value is string {
    return isAbsoluteLocalPath(value);
}

function pathIdentityKey(filePath: string): string {
    const normalized = normalizeFileTabPath(filePath);
    if (/^[A-Za-z]:\//.test(normalized) || normalized.startsWith("//")) {
        return normalized.replace(/[A-Z]/g, (character) => character.toLowerCase());
    }
    return normalized;
}

function tupleIdentityKey(components: string[]): string {
    return components.map((component) => `${component.length}:${component}`).join("");
}

function fileTabIdentityKey(tab: Extract<TopTab, { kind: "file" }>): string {
    return tupleIdentityKey(["file", pathIdentityKey(tab.path)]);
}

function previewTabIdentityKey(tab: Extract<TopTab, { kind: "preview" }>): string {
    return tupleIdentityKey(["preview", pathIdentityKey(tab.path)]);
}

function gitDiffTabIdentityKey(tab: Extract<TopTab, { kind: "git-diff" }>): string {
    return tupleIdentityKey([
        "git-diff",
        pathIdentityKey(tab.repoRoot),
        pathIdentityKey(tab.path),
        tab.mode,
        pathIdentityKey(tab.originalPath),
    ]);
}

export function topTabIdentityKey(tab: TopTab): string {
    switch (tab.kind) {
        case "file":
            return fileTabIdentityKey(tab);
        case "preview":
            return previewTabIdentityKey(tab);
        case "git-diff":
            return gitDiffTabIdentityKey(tab);
    }
}

function fromPersistedTopTab(tab: unknown): TopTab | undefined {
    if (!isRecord(tab)) {
        return undefined;
    }
    if (!isNonEmptyString(tab.id) || typeof tab.title !== "string") {
        return undefined;
    }
    switch (tab.kind) {
        case "file":
            return isAbsoluteTopTabPath(tab.path)
                ? { id: tab.id, kind: "file", path: tab.path, title: tab.title }
                : undefined;
        case "preview":
            return isAbsoluteTopTabPath(tab.path)
                ? { id: tab.id, kind: "preview", path: tab.path, title: tab.title }
                : undefined;
        case "git-diff":
            return isNonEmptyString(tab.reporoot) &&
                isNonEmptyString(tab.path) &&
                (tab.mode === "+" || tab.mode === "-") &&
                (tab.originalpath == null || typeof tab.originalpath === "string")
                ? {
                      id: tab.id,
                      kind: "git-diff",
                      repoRoot: tab.reporoot,
                      path: tab.path,
                      mode: tab.mode,
                      originalPath: typeof tab.originalpath === "string" ? tab.originalpath : "",
                      title: tab.title,
                  }
                : undefined;
        default:
            return undefined;
    }
}

function malformedDescriptorMetadata(tab: unknown, index: number) {
    const kind =
        isRecord(tab) && (tab.kind === "file" || tab.kind === "preview" || tab.kind === "git-diff")
            ? tab.kind
            : "unknown";
    let reason = "invalid-shape";
    if (isRecord(tab) && isNonEmptyString(tab.id) && typeof tab.title === "string") {
        reason =
            (kind === "file" || kind === "preview") && !isAbsoluteTopTabPath(tab.path)
                ? "invalid-path"
                : kind === "unknown"
                  ? "unsupported-kind"
                  : "invalid-fields";
    }
    return { index, kind, reason };
}

function normalizePersistedTopTabs(topTabs: unknown): TopTab[] {
    if (!Array.isArray(topTabs)) {
        return [];
    }
    const validIds = new Set<string>();
    const validIdentities = new Set<string>();
    const normalized: TopTab[] = [];
    for (const [index, tab] of topTabs.entries()) {
        const hydrated = fromPersistedTopTab(tab);
        if (!hydrated) {
            console.warn("workspace-top-tab-descriptor-dropped", malformedDescriptorMetadata(tab, index));
            continue;
        }
        const identity = topTabIdentityKey(hydrated);
        if (validIds.has(hydrated.id)) {
            console.warn("workspace-top-tab-descriptor-dropped", {
                index,
                kind: hydrated.kind,
                reason: "duplicate-id",
            });
            continue;
        }
        if (validIdentities.has(identity)) {
            console.warn("workspace-top-tab-descriptor-dropped", {
                index,
                kind: hydrated.kind,
                reason: "duplicate-identity",
            });
            continue;
        }
        validIds.add(hydrated.id);
        validIdentities.add(identity);
        normalized.push(hydrated);
    }
    return normalized;
}

function resolveActiveContentFromTopTabs(
    active: unknown,
    lastActiveTopTabId: unknown,
    topTabs: TopTab[],
    activeTerminalTabId: string
): ActiveContent {
    if (isRecord(active) && active.kind === "agent") {
        return { kind: "agent" };
    }
    if (
        isRecord(active) &&
        active.kind === "terminal" &&
        isNonEmptyString(active.terminaltabid) &&
        active.terminaltabid === activeTerminalTabId
    ) {
        return { kind: "terminal", terminalTabId: active.terminaltabid };
    }
    if (
        isRecord(active) &&
        active.kind === "top-tab" &&
        isNonEmptyString(active.toptabid) &&
        hasTopTab(topTabs, active.toptabid)
    ) {
        return { kind: "top-tab", topTabId: active.toptabid };
    }
    if (isNonEmptyString(lastActiveTopTabId) && hasTopTab(topTabs, lastActiveTopTabId)) {
        return { kind: "top-tab", topTabId: lastActiveTopTabId };
    }
    if (activeTerminalTabId) {
        return { kind: "terminal", terminalTabId: activeTerminalTabId };
    }
    return { kind: "agent" };
}

export function resolveActiveContent(
    snapshot: PersistedWorkspaceContentState,
    activeTerminalTabId: string
): ActiveContent {
    const terminalTabId = normalizeTerminalTabId(activeTerminalTabId);
    if (!isRecord(snapshot)) {
        return terminalTabId ? { kind: "terminal", terminalTabId } : { kind: "agent" };
    }
    const topTabs = normalizePersistedTopTabs(snapshot.toptabs);
    return resolveActiveContentFromTopTabs(snapshot.activecontent, snapshot.lastactivetoptabid, topTabs, terminalTabId);
}

export function hydrateWorkspaceContentState(
    snapshot: PersistedWorkspaceContentState,
    activeTerminalTabId: string
): WorkspaceContentState {
    const terminalTabId = normalizeTerminalTabId(activeTerminalTabId);
    if (!isRecord(snapshot)) {
        return {
            activeContent: terminalTabId ? { kind: "terminal", terminalTabId } : { kind: "agent" },
            topTabs: [],
            lastActiveTopTabId: "",
        };
    }
    const topTabs = normalizePersistedTopTabs(snapshot.toptabs);
    const activeContent = resolveActiveContentFromTopTabs(
        snapshot.activecontent,
        snapshot.lastactivetoptabid,
        topTabs,
        terminalTabId
    );
    const persistedLastActiveTopTabId = isNonEmptyString(snapshot.lastactivetoptabid)
        ? snapshot.lastactivetoptabid
        : "";
    const lastActiveTopTabId = hasTopTab(topTabs, persistedLastActiveTopTabId)
        ? persistedLastActiveTopTabId
        : activeContent.kind === "top-tab"
          ? activeContent.topTabId
          : "";
    return {
        activeContent,
        topTabs,
        lastActiveTopTabId,
    };
}

function findOpenTopTab(topTabs: TopTab[], candidate: TopTab): TopTab | undefined {
    const sameId = topTabs.find((tab) => tab.id === candidate.id);
    if (sameId) {
        return sameId;
    }
    const candidateIdentity = topTabIdentityKey(candidate);
    return topTabs.find((tab) => topTabIdentityKey(tab) === candidateIdentity);
}

export function isValidTopTab(tab: unknown): tab is TopTab {
    if (!isRecord(tab)) {
        return false;
    }
    if (!isNonEmptyString(tab.id) || typeof tab.title !== "string") {
        return false;
    }
    switch (tab.kind) {
        case "file":
        case "preview":
            return isAbsoluteTopTabPath(tab.path);
        case "git-diff":
            return (
                isNonEmptyString(tab.repoRoot) &&
                isNonEmptyString(tab.path) &&
                (tab.mode === "+" || tab.mode === "-") &&
                typeof tab.originalPath === "string"
            );
        default:
            return false;
    }
}

function hasOnlyKeys(value: object, allowedKeys: string[]): boolean {
    return Object.keys(value).every((key) => allowedKeys.includes(key));
}

function updateTopTab(tab: TopTab, updates: TopTabUpdates): TopTab | undefined {
    if (!updates || tab.kind !== updates.kind || (updates.title != null && typeof updates.title !== "string")) {
        return undefined;
    }
    let updated: TopTab;
    switch (tab.kind) {
        case "file":
            if (
                updates.kind !== "file" ||
                !hasOnlyKeys(updates, ["kind", "title", "path"]) ||
                (updates.path != null && typeof updates.path !== "string")
            ) {
                return undefined;
            }
            updated = { ...tab, ...updates, id: tab.id, kind: "file" };
            break;
        case "preview":
            if (
                updates.kind !== "preview" ||
                !hasOnlyKeys(updates, ["kind", "title", "path"]) ||
                (updates.path != null && typeof updates.path !== "string")
            ) {
                return undefined;
            }
            updated = { ...tab, ...updates, id: tab.id, kind: "preview" };
            break;
        case "git-diff":
            if (
                updates.kind !== "git-diff" ||
                !hasOnlyKeys(updates, ["kind", "title", "repoRoot", "path", "mode", "originalPath"]) ||
                (updates.repoRoot != null && typeof updates.repoRoot !== "string") ||
                (updates.path != null && typeof updates.path !== "string") ||
                (updates.mode != null && updates.mode !== "+" && updates.mode !== "-") ||
                (updates.originalPath != null && typeof updates.originalPath !== "string")
            ) {
                return undefined;
            }
            updated = { ...tab, ...updates, id: tab.id, kind: "git-diff" };
            break;
    }
    return isValidTopTab(updated) ? updated : undefined;
}

function fallbackAfterClose(remainingTabs: TopTab[], closedIndex: number, activeTerminalTabId: unknown): ActiveContent {
    const adjacent = remainingTabs[Math.min(closedIndex, remainingTabs.length - 1)];
    if (adjacent) {
        return { kind: "top-tab", topTabId: adjacent.id };
    }
    const terminalTabId = normalizeTerminalTabId(activeTerminalTabId);
    if (terminalTabId) {
        return { kind: "terminal", terminalTabId };
    }
    return { kind: "agent" };
}

export function reduceWorkspaceContent(
    state: WorkspaceContentState,
    action: WorkspaceContentAction
): WorkspaceContentState {
    const next = cloneState(state);
    if (!isRecord(action)) {
        return next;
    }
    switch (action.type) {
        case "activate-agent":
            next.activeContent = { kind: "agent" };
            return next;
        case "activate-terminal":
            if (!isNonEmptyString(action.terminalTabId)) {
                return next;
            }
            next.activeContent = { kind: "terminal", terminalTabId: action.terminalTabId };
            return next;
        case "activate-top-tab":
            if (!hasTopTab(next.topTabs, action.topTabId)) {
                return next;
            }
            next.activeContent = { kind: "top-tab", topTabId: action.topTabId };
            next.lastActiveTopTabId = action.topTabId;
            return next;
        case "open-top-tab": {
            if (!isValidTopTab(action.tab)) {
                return next;
            }
            const existing = findOpenTopTab(next.topTabs, action.tab);
            const topTabId = existing?.id ?? action.tab.id;
            if (!existing) {
                next.topTabs.push(cloneTopTab(action.tab));
            }
            next.activeContent = { kind: "top-tab", topTabId };
            next.lastActiveTopTabId = topTabId;
            return next;
        }
        case "close-top-tab": {
            const closedIndex = next.topTabs.findIndex((tab) => tab.id === action.topTabId);
            if (closedIndex === -1) {
                return next;
            }
            next.topTabs.splice(closedIndex, 1);
            if (next.activeContent.kind === "top-tab" && next.activeContent.topTabId === action.topTabId) {
                next.activeContent = fallbackAfterClose(next.topTabs, closedIndex, action.activeTerminalTabId ?? "");
            }
            if (next.lastActiveTopTabId === action.topTabId) {
                next.lastActiveTopTabId = next.activeContent.kind === "top-tab" ? next.activeContent.topTabId : "";
            }
            return next;
        }
        case "reorder-top-tab": {
            const currentIndex = next.topTabs.findIndex((tab) => tab.id === action.topTabId);
            if (currentIndex === -1 || !Number.isInteger(action.targetIndex)) {
                return next;
            }
            const [tab] = next.topTabs.splice(currentIndex, 1);
            const targetIndex = Math.max(0, Math.min(action.targetIndex, next.topTabs.length));
            next.topTabs.splice(targetIndex, 0, tab);
            return next;
        }
        case "update-top-tab": {
            const currentIndex = next.topTabs.findIndex((tab) => tab.id === action.topTabId);
            if (currentIndex === -1) {
                return next;
            }
            const updated = updateTopTab(next.topTabs[currentIndex], action.updates);
            if (!updated) {
                return next;
            }
            if (
                next.topTabs.some(
                    (tab, index) => index !== currentIndex && topTabIdentityKey(tab) === topTabIdentityKey(updated)
                )
            ) {
                return next;
            }
            next.topTabs[currentIndex] = updated;
            return next;
        }
    }
}
