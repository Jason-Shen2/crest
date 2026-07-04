// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

package wcore

import (
	"context"
	"fmt"
	"testing"

	"github.com/s-zx/crest/pkg/wavebase"
	"github.com/s-zx/crest/pkg/waveobj"
	"github.com/s-zx/crest/pkg/wstore"
)

func TestDefaultTabNameAndMetaExplicitName(t *testing.T) {
	tabName, meta, err := defaultTabNameAndMeta(context.Background(), "workspace-1", "Editor")
	if err != nil {
		t.Fatalf("defaultTabNameAndMeta returned error: %v", err)
	}
	if tabName != "Editor" {
		t.Fatalf("tabName = %q, want %q", tabName, "Editor")
	}
	if meta != nil {
		t.Fatalf("meta = %#v, want nil", meta)
	}
}

func TestCreateTabWithBlockFailuresDoNotLeavePartialState(t *testing.T) {
	ctx := setupWorkspaceTestWStore(t)
	workspace := &waveobj.Workspace{
		OID:    "workspace-invalid-blockdef",
		TabIds: []string{},
	}
	if err := wstore.DBInsert(ctx, workspace); err != nil {
		t.Fatalf("DBInsert workspace returned error: %v", err)
	}
	existingTab, err := createTabObj(ctx, workspace.OID, "Existing", nil)
	if err != nil {
		t.Fatalf("createTabObj returned error: %v", err)
	}
	if err := SetActiveTab(ctx, workspace.OID, existingTab.OID); err != nil {
		t.Fatalf("SetActiveTab returned error: %v", err)
	}

	_, err = CreateTabWithBlock(ctx, workspace.OID, "Invalid", true, waveobj.BlockDef{})
	if err == nil {
		t.Fatalf("CreateTabWithBlock returned nil error for invalid blockDef")
	}

	updatedWorkspace, err := wstore.DBMustGet[*waveobj.Workspace](ctx, workspace.OID)
	if err != nil {
		t.Fatalf("DBMustGet workspace returned error: %v", err)
	}
	if len(updatedWorkspace.TabIds) != 1 || updatedWorkspace.TabIds[0] != existingTab.OID {
		t.Fatalf("TabIds = %#v, want only %#v", updatedWorkspace.TabIds, existingTab.OID)
	}
	if updatedWorkspace.ActiveTabId != existingTab.OID {
		t.Fatalf("ActiveTabId = %q, want %q", updatedWorkspace.ActiveTabId, existingTab.OID)
	}
	tabs, err := wstore.DBGetAllObjsByType[*waveobj.Tab](ctx, waveobj.OType_Tab)
	if err != nil {
		t.Fatalf("DBGetAllObjsByType tabs returned error: %v", err)
	}
	if len(tabs) != 1 || tabs[0].OID != existingTab.OID {
		t.Fatalf("tabs = %#v, want only tab %q", tabs, existingTab.OID)
	}

	layoutFailureWorkspace := &waveobj.Workspace{
		OID:    "workspace-layout-failure",
		TabIds: []string{},
	}
	if err := wstore.DBInsert(ctx, layoutFailureWorkspace); err != nil {
		t.Fatalf("DBInsert workspace returned error: %v", err)
	}
	activeTab, err := createTabObj(ctx, layoutFailureWorkspace.OID, "Active A", nil)
	if err != nil {
		t.Fatalf("createTabObj activeTab returned error: %v", err)
	}
	otherTab, err := createTabObj(ctx, layoutFailureWorkspace.OID, "Other B", nil)
	if err != nil {
		t.Fatalf("createTabObj otherTab returned error: %v", err)
	}
	if err := SetActiveTab(ctx, layoutFailureWorkspace.OID, activeTab.OID); err != nil {
		t.Fatalf("SetActiveTab returned error: %v", err)
	}

	origApplyPortableLayout := applyPortableLayoutForCreateTabWithBlock
	applyPortableLayoutForCreateTabWithBlock = func(context.Context, string, PortableLayout, bool) error {
		return fmt.Errorf("injected apply failure")
	}
	defer func() {
		applyPortableLayoutForCreateTabWithBlock = origApplyPortableLayout
	}()

	blockDef := waveobj.BlockDef{
		Meta: waveobj.MetaMapType{
			waveobj.MetaKey_View: "preview",
		},
	}
	_, err = CreateTabWithBlock(ctx, layoutFailureWorkspace.OID, "Fails Layout", true, blockDef)
	if err == nil {
		t.Fatalf("CreateTabWithBlock returned nil error for injected layout failure")
	}

	updatedWorkspace, err = wstore.DBMustGet[*waveobj.Workspace](ctx, layoutFailureWorkspace.OID)
	if err != nil {
		t.Fatalf("DBMustGet workspace returned error: %v", err)
	}
	if len(updatedWorkspace.TabIds) != 2 || updatedWorkspace.TabIds[0] != activeTab.OID || updatedWorkspace.TabIds[1] != otherTab.OID {
		t.Fatalf("TabIds = %#v, want [%q %q]", updatedWorkspace.TabIds, activeTab.OID, otherTab.OID)
	}
	if updatedWorkspace.ActiveTabId != activeTab.OID {
		t.Fatalf("ActiveTabId = %q, want original active tab %q", updatedWorkspace.ActiveTabId, activeTab.OID)
	}
}

func setupWorkspaceTestWStore(t *testing.T) context.Context {
	t.Helper()
	wavebase.DataHome_VarCache = t.TempDir()
	wavebase.ConfigHome_VarCache = t.TempDir()
	if err := wavebase.EnsureWaveDBDir(); err != nil {
		t.Fatalf("EnsureWaveDBDir returned error: %v", err)
	}
	if err := wstore.InitWStore(); err != nil {
		t.Fatalf("InitWStore returned error: %v", err)
	}
	return context.Background()
}
