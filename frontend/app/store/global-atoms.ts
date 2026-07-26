// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

import { atom, Atom, PrimitiveAtom } from "jotai";
import { globalStore } from "./jotaiStore";
import { setWaveWindowType } from "./windowtype";
import * as WOS from "./wos";

let atoms!: GlobalAtomsType;
let globalAtomListenersInitialized = false;
let reducedMotionQuery: MediaQueryList = null;
let reducedMotionSystemPreferenceAtomRef: PrimitiveAtom<boolean> = null;
const blockComponentModelMap = new Map<string, BlockComponentModel>();
const ConnStatusMapAtom = atom(new Map<string, PrimitiveAtom<ConnStatus>>());
const orefAtomCache = new Map<string, Map<string, Atom<any>>>();

function initGlobalAtoms(initOpts: GlobalInitOptions) {
    validateRendererIdentity(initOpts);
    const windowIdAtom = atom(initOpts.windowId) as PrimitiveAtom<string>;
    const builderIdAtom = atom(
        initOpts.rendererKind === "builder" ? initOpts.builderId : null
    ) as PrimitiveAtom<string>;
    const builderAppIdAtom = atom<string>(null) as PrimitiveAtom<string>;
    setWaveWindowType(initOpts.rendererKind === "terminal" ? "tab" : initOpts.rendererKind);
    const uiContextAtom = atom((get) => {
        const uiContext: UIContext = {
            windowid: initOpts.windowId,
            activetabid: initOpts.rendererKind === "terminal" ? initOpts.tabId : null,
        };
        return uiContext;
    }) as Atom<UIContext>;

    const isFullScreenAtom = atom(false) as PrimitiveAtom<boolean>;
    try {
        const initial = getApi().getIsFullScreen?.();
        if (typeof initial === "boolean") {
            globalStore.set(isFullScreenAtom, initial);
        }
    } catch (e) {
        console.log("failed to read initial isFullScreen", e);
    }

    const zoomFactorAtom = atom(1.0) as PrimitiveAtom<number>;
    try {
        globalStore.set(zoomFactorAtom, getApi().getZoomFactor());
    } catch (e) {
        console.log("failed to initialize zoomFactorAtom", e);
    }

    const workspaceIdAtom: Atom<string> =
        initOpts.rendererKind === "workspace"
            ? atom(initOpts.workspaceId)
            : atom((get) => {
                  const windowData = WOS.getObjectValue<WaveWindow>(WOS.makeORef("window", get(windowIdAtom)), get);
                  return windowData?.workspaceid ?? null;
              });
    const workspaceGenerationAtom: Atom<number> =
        initOpts.rendererKind === "workspace" ? atom(initOpts.generation ?? 1) : atom(0);
    const workspaceAtom: Atom<Workspace> = atom((get) => {
        const workspaceId = get(workspaceIdAtom);
        if (workspaceId == null) {
            return null;
        }
        return WOS.getObjectValue(WOS.makeORef("workspace", workspaceId), get);
    });
    const fullConfigAtom = atom(null) as PrimitiveAtom<FullConfigType>;
    const settingsAtom = atom((get) => {
        return get(fullConfigAtom)?.settings ?? {};
    }) as Atom<SettingsType>;
    const hasConfigErrors = atom((get) => {
        const fullConfig = get(fullConfigAtom);
        return fullConfig?.configerrors != null && fullConfig.configerrors.length > 0;
    }) as Atom<boolean>;
    // this is *the* tab that this tabview represents.  it should never change.
    const staticTabIdAtom: Atom<string> = initOpts.rendererKind === "terminal" ? atom(initOpts.tabId) : null;
    const controlShiftDelayAtom = atom(false);
    const updaterStatusAtom = atom<UpdaterStatus>("up-to-date") as PrimitiveAtom<UpdaterStatus>;
    try {
        globalStore.set(updaterStatusAtom, getApi().getUpdaterStatus());
    } catch (e) {
        console.log("failed to initialize updaterStatusAtom", e);
    }

    const reducedMotionSettingAtom = atom((get) => get(settingsAtom)?.["window:reducedmotion"]);
    const reducedMotionSystemPreferenceAtom = atom(false);
    reducedMotionSystemPreferenceAtomRef = reducedMotionSystemPreferenceAtom;

    // Composite of the prefers-reduced-motion media query and the window:reducedmotion user setting.
    const prefersReducedMotionAtom = atom((get) => {
        const reducedMotionSetting = get(reducedMotionSettingAtom);
        const reducedMotionSystemPreference = get(reducedMotionSystemPreferenceAtom);
        return reducedMotionSetting || reducedMotionSystemPreference;
    });

    const documentHasFocusAtom = atom(true) as PrimitiveAtom<boolean>;

    const modalOpen = atom(false);
    const allConnStatusAtom = atom<ConnStatus[]>((get) => {
        const connStatusMap = get(ConnStatusMapAtom);
        const connStatuses = Array.from(connStatusMap.values()).map((atom) => get(atom));
        return connStatuses;
    });
    const reinitVersion = atom(0);
    atoms = {
        // initialized in wave.ts (will not be null inside of application)
        builderId: builderIdAtom,
        builderAppId: builderAppIdAtom,
        uiContext: uiContextAtom,
        workspaceId: workspaceIdAtom,
        workspaceGeneration: workspaceGenerationAtom,
        workspace: workspaceAtom,
        fullConfigAtom,
        settingsAtom,
        hasConfigErrors,
        ...(staticTabIdAtom == null ? {} : { staticTabId: staticTabIdAtom }),
        isFullScreen: isFullScreenAtom,
        zoomFactorAtom,
        controlShiftDelayAtom,
        updaterStatusAtom,
        prefersReducedMotionAtom,
        documentHasFocus: documentHasFocusAtom,
        modalOpen,
        allConnStatus: allConnStatusAtom,
        reinitVersion,
    } as GlobalAtomsType;
    initializeGlobalAtomListeners();
    if (globalThis.window != null) {
        globalStore.set(reducedMotionSystemPreferenceAtom, !reducedMotionQuery || reducedMotionQuery.matches);
        globalStore.set(documentHasFocusAtom, document.hasFocus());
    }
}

function initializeGlobalAtomListeners(): void {
    if (globalAtomListenersInitialized) {
        return;
    }
    globalAtomListenersInitialized = true;
    try {
        getApi().onFullScreenChange((isFullScreen) => {
            globalStore.set(atoms.isFullScreen, isFullScreen);
        });
    } catch (e) {
        console.log("failed to subscribe to isFullScreen changes", e);
    }
    try {
        getApi().onZoomFactorChange((zoomFactor) => {
            globalStore.set(atoms.zoomFactorAtom, zoomFactor);
        });
    } catch (e) {
        console.log("failed to subscribe to zoomFactor changes", e);
    }
    try {
        getApi().onUpdaterStatusChange((status) => {
            globalStore.set(atoms.updaterStatusAtom, status);
        });
    } catch (e) {
        console.log("failed to subscribe to updater status changes", e);
    }
    if (globalThis.window == null) {
        return;
    }
    reducedMotionQuery = window.matchMedia("(prefers-reduced-motion: reduce)");
    reducedMotionQuery?.addEventListener("change", () => {
        globalStore.set(reducedMotionSystemPreferenceAtomRef, reducedMotionQuery.matches);
    });
    window.addEventListener("focus", () => {
        globalStore.set(atoms.documentHasFocus, true);
    });
    window.addEventListener("blur", () => {
        globalStore.set(atoms.documentHasFocus, false);
    });
}

function validateRendererIdentity(initOpts: GlobalInitOptions) {
    const rendererKind: string = initOpts.rendererKind;
    switch (initOpts.rendererKind) {
        case "workspace":
            if (!initOpts.workspaceId) {
                throw new Error("workspace renderer requires workspaceId");
            }
            return;
        case "terminal":
            if (!initOpts.tabId) {
                throw new Error("terminal renderer requires tabId");
            }
            return;
        case "builder":
            if (!initOpts.builderId) {
                throw new Error("builder renderer requires builderId");
            }
            return;
        case "preview":
            return;
        default:
            throw new Error(`unknown renderer kind: ${rendererKind}`);
    }
}

function getAtoms(): GlobalAtomsType {
    if (atoms == null) {
        throw new Error("Global atoms accessed before initialization");
    }
    return atoms;
}

function getApi(): ElectronApi {
    return (window as any).api;
}

export { atoms, blockComponentModelMap, ConnStatusMapAtom, getAtoms, initGlobalAtoms, orefAtomCache };
