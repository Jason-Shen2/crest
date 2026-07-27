// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

package wcore

import (
	"testing"

	"github.com/s-zx/crest/pkg/waveobj"
	"github.com/s-zx/crest/pkg/wstore"
)

func TestCheckAndFixWindowDoesNotCreateLegacyStarterTab(t *testing.T) {
	ctx := setupWorkspaceTestWStore(t)
	workspace := &waveobj.Workspace{
		OID:              "workspace-v1-empty",
		TabDomainVersion: 0,
		TabIds:           []string{},
	}
	window := &waveobj.Window{OID: "window-v1-empty", WorkspaceId: workspace.OID}
	if err := wstore.DBInsert(ctx, workspace); err != nil {
		t.Fatal(err)
	}
	if err := wstore.DBInsert(ctx, window); err != nil {
		t.Fatal(err)
	}

	if fixed := CheckAndFixWindow(ctx, window.OID); fixed == nil {
		t.Fatal("expected window to remain valid")
	}
	actual, err := GetWorkspace(ctx, workspace.OID)
	if err != nil {
		t.Fatal(err)
	}
	if len(actual.TabIds) != 0 {
		t.Fatalf("expected no starter tabs, got %v", actual.TabIds)
	}
}
