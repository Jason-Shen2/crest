// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

type RendererInitEvent =
    | { kind: "workspace"; initOpts: WorkspaceInitOpts }
    | { kind: "wave"; initOpts: WaveInitOpts }
    | { kind: "builder"; initOpts: BuilderInitOpts };

type RendererBootstrapLoaders = {
    workspace: () => Promise<{
        initializeWorkspaceRenderer: (initOpts: WorkspaceInitOpts) => void | Promise<void>;
    }>;
    terminal: () => Promise<{
        initializeTerminalRenderer: (initOpts: WaveInitOpts) => void | Promise<void>;
    }>;
    builder: () => Promise<{
        initializeBuilderRenderer: (initOpts: BuilderInitOpts) => void | Promise<void>;
    }>;
};

type RendererFamily = keyof RendererBootstrapLoaders;

function rendererFamilyForEvent(event: RendererInitEvent): RendererFamily {
    if (event.kind === "workspace") {
        return "workspace";
    }
    if (event.kind === "builder") {
        return "builder";
    }
    if (event.initOpts.rendererKind === "terminal") {
        return "terminal";
    }
    throw new Error("wave renderer requires an explicit rendererKind");
}

export function createRendererDispatcher(loaders: RendererBootstrapLoaders) {
    let selectedFamily: RendererFamily = null;
    let dispatchQueue = Promise.resolve();

    return {
        dispatch(event: RendererInitEvent): Promise<void> {
            let family: RendererFamily;
            try {
                family = rendererFamilyForEvent(event);
            } catch (error) {
                return Promise.reject(error);
            }
            if (selectedFamily != null && selectedFamily !== family) {
                return Promise.reject(new Error(`renderer already initialized as ${selectedFamily}`));
            }
            selectedFamily = family;
            const run = async () => {
                if (event.kind === "workspace") {
                    const bootstrap = await loaders.workspace();
                    await bootstrap.initializeWorkspaceRenderer(event.initOpts);
                    return;
                }
                if (event.kind === "builder") {
                    const bootstrap = await loaders.builder();
                    await bootstrap.initializeBuilderRenderer(event.initOpts);
                    return;
                }
                if (family === "terminal") {
                    const bootstrap = await loaders.terminal();
                    await bootstrap.initializeTerminalRenderer(event.initOpts);
                    return;
                }
                throw new Error("non-Terminal Wave renderer is not supported");
            };
            const result = dispatchQueue.then(run);
            dispatchQueue = result.catch(() => undefined);
            return result;
        },
    };
}

function startRendererEntry(): void {
    const api = window.api;
    const dispatcher = createRendererDispatcher({
        workspace: () => import("./wave"),
        terminal: () => import("./app/terminal/terminal-bootstrap"),
        builder: () => import("./app/legacy/builder-bootstrap"),
    });
    const dispatch = (event: RendererInitEvent) => {
        void dispatcher.dispatch(event).catch((error) => {
            api.sendLog(`Renderer bootstrap failed: ${error.message}\n${error.stack}`);
            console.error("Renderer bootstrap failed", error);
        });
    };

    document.body.style.visibility = "hidden";
    document.body.style.opacity = "0";
    document.body.classList.add("is-transparent");
    api.onWorkspaceInit((initOpts) => dispatch({ kind: "workspace", initOpts }));
    api.onWorkspaceInitFatal((status) => {
        const root = document.getElementById("root") ?? document.body;
        root.replaceChildren();
        const fallback = document.createElement("main");
        fallback.setAttribute("role", "alert");
        fallback.className = "flex h-screen flex-col items-center justify-center gap-3";
        const title = document.createElement("h1");
        title.textContent = "Workspace failed to initialize";
        const detail = document.createElement("p");
        detail.textContent = `Workspace ${status.workspaceId} could not be loaded after retrying.`;
        const reload = document.createElement("button");
        reload.type = "button";
        reload.className = "cursor-pointer rounded bg-accent/80 px-3 py-1 text-primary";
        reload.textContent = "Reload window";
        reload.addEventListener("click", () => window.location.reload());
        fallback.append(title, detail, reload);
        root.append(fallback);
        document.body.style.visibility = "visible";
        document.body.style.opacity = "1";
        document.body.classList.remove("is-transparent");
    });
    api.onWaveInit((initOpts) => dispatch({ kind: "wave", initOpts }));
    api.onBuilderInit((initOpts) => dispatch({ kind: "builder", initOpts }));

    const zoomFactor = api.getZoomFactor();
    document.documentElement.style.setProperty("--zoomfactor", String(zoomFactor));
    document.documentElement.style.setProperty("--zoomfactor-inv", String(1 / zoomFactor));
    api.onZoomFactorChange((nextZoomFactor) => {
        document.documentElement.style.setProperty("--zoomfactor", String(nextZoomFactor));
        document.documentElement.style.setProperty("--zoomfactor-inv", String(1 / nextZoomFactor));
    });
    void (document.fonts?.ready ?? Promise.resolve()).then(() => api.setWindowInitStatus("ready"));
}

if (typeof window !== "undefined" && typeof document !== "undefined") {
    if (document.readyState === "loading") {
        document.addEventListener("DOMContentLoaded", startRendererEntry, { once: true });
    } else {
        startRendererEntry();
    }
}
