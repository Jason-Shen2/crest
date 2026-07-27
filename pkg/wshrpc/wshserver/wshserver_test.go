// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

package wshserver

import (
	"context"
	"sync"
	"testing"

	"github.com/s-zx/crest/pkg/waveobj"
	"github.com/s-zx/crest/pkg/wps"
	"github.com/s-zx/crest/pkg/wshrpc"
	"github.com/s-zx/crest/pkg/wstore"
)

type recordingWPSClient struct {
	lock   sync.Mutex
	events []wps.WaveEvent
}

func (c *recordingWPSClient) SendEvent(_ string, event wps.WaveEvent) {
	c.lock.Lock()
	defer c.lock.Unlock()
	c.events = append(c.events, event)
}

func (c *recordingWPSClient) getEvents() []wps.WaveEvent {
	c.lock.Lock()
	defer c.lock.Unlock()
	return append([]wps.WaveEvent{}, c.events...)
}

func TestPathCommandOpenRejectsUnknownAndNonTerminalTabs(t *testing.T) {
	ctx, workspace, terminalTabId := setupPathCommandWorkspace(t)
	server := &WshServer{}

	if _, err := server.PathCommand(ctx, wshrpc.PathCommandData{PathType: "config", Open: true, TabId: "unknown"}); err == nil {
		t.Fatalf("PathCommand accepted unknown tabId")
	}
	if _, err := server.PathCommand(ctx, wshrpc.PathCommandData{PathType: "config", Open: true, TabId: "legacy-tab"}); err == nil {
		t.Fatalf("PathCommand accepted legacy/non-Terminal tabId in workspace %s", workspace.OID)
	}
	if _, err := server.PathCommand(ctx, wshrpc.PathCommandData{PathType: "config", Open: true, TabId: terminalTabId}); err != nil {
		t.Fatalf("PathCommand rejected registered Terminal: %v", err)
	}
}

func TestPathCommandOpenPublishesExactWorkspaceScopeAndPayload(t *testing.T) {
	ctx, workspace, terminalTabId := setupPathCommandWorkspace(t)
	client := &recordingWPSClient{}
	routeId := "path-command-test"
	previousClient := wps.Broker.GetClient()
	wps.Broker.SetClient(client)
	wps.Broker.Subscribe(routeId, wps.SubscriptionRequest{
		Event:  wps.Event_WorkspaceOpenContent,
		Scopes: []string{"workspace:" + workspace.OID},
	})
	t.Cleanup(func() {
		wps.Broker.UnsubscribeAll(routeId)
		wps.Broker.SetClient(previousClient)
	})

	path, err := (&WshServer{}).PathCommand(ctx, wshrpc.PathCommandData{
		PathType: "config",
		Open:     true,
		TabId:    terminalTabId,
	})
	if err != nil {
		t.Fatalf("PathCommand: %v", err)
	}
	events := client.getEvents()
	if len(events) != 1 {
		t.Fatalf("got %d events, want 1", len(events))
	}
	event := events[0]
	if len(event.Scopes) != 1 || event.Scopes[0] != "workspace:"+workspace.OID {
		t.Fatalf("unexpected scopes: %#v", event.Scopes)
	}
	data, ok := event.Data.(wshrpc.WorkspaceOpenContentEvent)
	if !ok {
		t.Fatalf("unexpected payload type: %T", event.Data)
	}
	if data.WorkspaceId != workspace.OID || data.Kind != "preview" || data.Path != path || data.RequestId == "" {
		t.Fatalf("unexpected payload: %#v", data)
	}
}

func setupPathCommandWorkspace(t *testing.T) (context.Context, *waveobj.Workspace, string) {
	t.Helper()
	ctx := setupWshServerTerminalDomain(t)
	workspace, _ := wstore.DBMustGet[*waveobj.Workspace](ctx, "setmeta-workspace")
	terminalTabId := workspace.TerminalTabIds[0]
	legacyTab := &waveobj.Tab{OID: "legacy-tab"}
	if err := wstore.DBInsert(ctx, legacyTab); err != nil {
		t.Fatalf("insert legacy tab: %v", err)
	}
	workspace.TabIds = append(workspace.TabIds, legacyTab.OID)
	if err := wstore.DBUpdate(ctx, workspace); err != nil {
		t.Fatalf("update workspace: %v", err)
	}
	return ctx, workspace, terminalTabId
}
