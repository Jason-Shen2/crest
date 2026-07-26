// Copyright 2025, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

import { TabClient } from "@/app/store/tabrpcclient";
import { setWpsRpcClient, wpsReconnectHandler } from "@/app/store/wps";
import { WshClient } from "@/app/store/wshclient";
import { WshRouter } from "@/app/store/wshrouter";
import { getWSServerEndpoint } from "@/util/endpoints";
import { addWSReconnectHandler, globalWS, initGlobalWS, removeWSReconnectHandler, WSControl } from "./ws";
import { DefaultRouter, setDefaultRouter } from "./wshrpcutil-base";

type RendererRpcClientFactory = (routeId: string) => WshClient;

let RendererRpcClient: WshClient;
let TabRpcClient: WshClient;
let RendererRouter: WshRouter;
let RendererWSControl: WSControl;
let RendererReconnectHandlers: Array<() => void> = [];

function shutdownRendererWshrpc(): void {
    if (RendererRouter != null && RendererRpcClient != null) {
        RendererRouter.unregisterRoute(RendererRpcClient.routeId);
    }
    for (const handler of RendererReconnectHandlers) {
        removeWSReconnectHandler(handler);
    }
    RendererReconnectHandlers = [];
    RendererWSControl?.shutdown();
    RendererRouter = undefined;
    RendererWSControl = undefined;
    RendererRpcClient = undefined;
    TabRpcClient = undefined;
}

function initWshrpc(routeId: string, clientFactory: RendererRpcClientFactory = (id) => new TabClient(id)): WSControl {
    shutdownRendererWshrpc();
    const router = new WshRouter(new UpstreamWshRpcProxy());
    RendererRouter = router;
    setDefaultRouter(router);
    const handleFn = (event: WSEventType) => {
        DefaultRouter.recvRpcMessage(event.data);
    };
    initGlobalWS(getWSServerEndpoint(), routeId, handleFn);
    RendererWSControl = globalWS;
    globalWS.connectNow("connectWshrpc");
    RendererRpcClient = clientFactory(routeId);
    TabRpcClient = RendererRpcClient;
    setWpsRpcClient(RendererRpcClient);
    DefaultRouter.registerRoute(RendererRpcClient.routeId, RendererRpcClient);
    const reannounceHandler = () => router.reannounceRoutes();
    RendererReconnectHandlers = [reannounceHandler, wpsReconnectHandler];
    addWSReconnectHandler(reannounceHandler);
    addWSReconnectHandler(wpsReconnectHandler);
    return globalWS;
}

class UpstreamWshRpcProxy implements AbstractWshClient {
    recvRpcMessage(msg: RpcMessage): void {
        const wsMsg: WSRpcCommand = { wscommand: "rpc", message: msg };
        globalWS?.pushMessage(wsMsg);
    }
}

export { initElectronWshrpc, sendRpcCommand, sendRpcResponse, shutdownWshrpc } from "./wshrpcutil-base";
export { DefaultRouter, initWshrpc, RendererRpcClient, shutdownRendererWshrpc, TabRpcClient };
