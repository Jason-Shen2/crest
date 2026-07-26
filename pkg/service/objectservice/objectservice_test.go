// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

package objectservice

import (
	"context"
	"os"
	"path/filepath"
	"reflect"
	"testing"

	"github.com/google/uuid"
	"github.com/s-zx/crest/pkg/wavebase"
	"github.com/s-zx/crest/pkg/waveobj"
	"github.com/s-zx/crest/pkg/wstore"
)

func TestTerminalDomainObjectServiceRejectsIncompatibleMetaAndFullBlockUpdates(t *testing.T) {
	ctx, workspace, tab, block := setupObjectServiceTerminalDomain(t, "object-guard")
	svc := &ObjectService{}

	if _, err := svc.UpdateObjectMeta(waveobj.UIContext{}, waveobj.MakeORef(waveobj.OType_Block, block.OID).String(), waveobj.MetaMapType{
		waveobj.MetaKey_View: "web",
	}); err == nil {
		t.Fatalf("UpdateObjectMeta accepted incompatible Terminal view")
	}
	assertObjectServiceBlockUnchanged(t, ctx, block)

	same := *block
	if _, err := svc.UpdateObject(waveobj.UIContext{}, &same, true); err != nil {
		t.Fatalf("UpdateObject rejected unchanged Terminal block structure: %v", err)
	}

	proposed := *block
	proposed.Meta = waveobj.MetaMapType{waveobj.MetaKey_View: "preview"}
	proposed.SubBlockIds = []string{"injected-subblock"}
	if _, err := svc.UpdateObject(waveobj.UIContext{}, &proposed, true); err == nil {
		t.Fatalf("UpdateObject accepted incompatible Terminal block")
	}
	assertObjectServiceBlockUnchanged(t, ctx, block)

	if _, err := svc.UpdateObjectMeta(waveobj.UIContext{}, waveobj.MakeORef(waveobj.OType_Block, block.OID).String(), waveobj.MetaMapType{
		waveobj.MetaKey_CmdCwd: "/safe",
	}); err != nil {
		t.Fatalf("UpdateObjectMeta rejected legal Terminal metadata: %v", err)
	}
	updated, _ := wstore.DBMustGet[*waveobj.Block](ctx, block.OID)
	if updated.Meta.GetString(waveobj.MetaKey_CmdCwd, "") != "/safe" {
		t.Fatalf("legal metadata update was not persisted: %#v", updated.Meta)
	}
	if workspace.TerminalTabIds[0] != tab.OID {
		t.Fatalf("invalid fixture")
	}
}

func TestTerminalDomainObjectServiceDeleteBlockRejectsFinalRootWithoutPartialWrite(t *testing.T) {
	ctx, workspace, tab, block := setupObjectServiceTerminalDomain(t, "object-delete-guard")
	if _, err := (&ObjectService{}).DeleteBlock(waveobj.UIContext{}, block.OID); err == nil {
		t.Fatalf("ObjectService.DeleteBlock accepted final registered Terminal root")
	}
	reloadedWorkspace, _ := wstore.DBMustGet[*waveobj.Workspace](ctx, workspace.OID)
	reloadedTab, _ := wstore.DBMustGet[*waveobj.Tab](ctx, tab.OID)
	reloadedBlock, _ := wstore.DBMustGet[*waveobj.Block](ctx, block.OID)
	if !reflect.DeepEqual(reloadedWorkspace.TabIds, workspace.TabIds) ||
		!reflect.DeepEqual(reloadedWorkspace.TerminalTabIds, workspace.TerminalTabIds) ||
		!reflect.DeepEqual(reloadedTab.BlockIds, tab.BlockIds) ||
		reloadedBlock == nil {
		t.Fatalf("rejected ObjectService.DeleteBlock partially mutated Terminal")
	}
}

func TestTerminalDomainObjectServiceRejectsWorkspaceInventoryEnrollment(t *testing.T) {
	ctx := setupObjectServiceWStore(t)
	blockId := uuid.NewString()
	tabId := uuid.NewString()
	workspaceId := uuid.NewString()
	block := &waveobj.Block{
		OID:        blockId,
		ParentORef: waveobj.MakeORef(waveobj.OType_Tab, tabId).String(),
		Meta:       waveobj.MetaMapType{waveobj.MetaKey_View: "web"},
	}
	tab := &waveobj.Tab{OID: tabId, BlockIds: []string{block.OID}}
	workspace := &waveobj.Workspace{OID: workspaceId, TabIds: []string{tab.OID}}
	for _, obj := range []waveobj.WaveObj{workspace, tab, block} {
		if err := wstore.DBInsert(ctx, obj); err != nil {
			t.Fatalf("insert %T: %v", obj, err)
		}
	}
	proposed := *workspace
	proposed.TabDomainVersion = waveobj.CurrentTabDomainVersion
	proposed.TerminalTabIds = []string{tab.OID}

	if _, err := (&ObjectService{}).UpdateObject(waveobj.UIContext{}, &proposed, true); err == nil {
		t.Fatalf("UpdateObject enrolled a legacy mixed Tab into Terminal inventory")
	}
	reloaded, _ := wstore.DBMustGet[*waveobj.Workspace](ctx, workspace.OID)
	if reloaded.TabDomainVersion != 0 || len(reloaded.TerminalTabIds) != 0 {
		t.Fatalf("rejected inventory update partially persisted: %#v", reloaded)
	}
}

func TestTerminalDomainObjectServiceRejectsSubBlockParentReplacement(t *testing.T) {
	ctx, _, _, root := setupObjectServiceTerminalDomain(t, "subblock-parent")
	child := &waveobj.Block{
		OID:        uuid.NewString(),
		ParentORef: waveobj.MakeORef(waveobj.OType_Block, root.OID).String(),
		Meta:       waveobj.MetaMapType{waveobj.MetaKey_View: "term"},
	}
	root.SubBlockIds = []string{child.OID}
	if err := wstore.DBInsert(ctx, child); err != nil {
		t.Fatalf("insert child: %v", err)
	}
	if err := wstore.DBUpdate(ctx, root); err != nil {
		t.Fatalf("attach child: %v", err)
	}

	proposed := *child
	proposed.ParentORef = waveobj.MakeORef(waveobj.OType_Block, uuid.NewString()).String()
	if _, err := (&ObjectService{}).UpdateObject(waveobj.UIContext{}, &proposed, true); err == nil {
		t.Fatalf("UpdateObject accepted Terminal SubBlock parent replacement")
	}
	reloaded, _ := wstore.DBMustGet[*waveobj.Block](ctx, child.OID)
	if reloaded.ParentORef != child.ParentORef {
		t.Fatalf("rejected parent replacement partially persisted: %q", reloaded.ParentORef)
	}
}

func TestTerminalDomainObjectServiceRejectsTwoStepSubBlockOrphanBypass(t *testing.T) {
	ctx, _, _, root := setupObjectServiceTerminalDomain(t, "subblock-orphan")
	child := &waveobj.Block{
		OID:        uuid.NewString(),
		ParentORef: waveobj.MakeORef(waveobj.OType_Block, root.OID).String(),
		Meta:       waveobj.MetaMapType{waveobj.MetaKey_View: "term"},
	}
	root.SubBlockIds = []string{child.OID}
	if err := wstore.DBInsert(ctx, child); err != nil {
		t.Fatalf("insert child: %v", err)
	}
	if err := wstore.DBUpdate(ctx, root); err != nil {
		t.Fatalf("attach child: %v", err)
	}

	proposedRoot := *root
	proposedRoot.SubBlockIds = nil
	if _, err := (&ObjectService{}).UpdateObject(waveobj.UIContext{}, &proposedRoot, true); err == nil {
		t.Fatalf("UpdateObject accepted removing a Terminal SubBlock")
	}
	reloadedRoot, _ := wstore.DBMustGet[*waveobj.Block](ctx, root.OID)
	if !reflect.DeepEqual(reloadedRoot.SubBlockIds, root.SubBlockIds) {
		t.Fatalf("rejected SubBlock removal partially persisted: %#v", reloadedRoot.SubBlockIds)
	}

	// Simulate an orphan left by legacy data and verify it cannot escape the
	// Terminal view restriction through a later metadata update.
	reloadedRoot.SubBlockIds = nil
	if err := wstore.DBUpdate(ctx, reloadedRoot); err != nil {
		t.Fatalf("simulate legacy orphan: %v", err)
	}
	if _, err := (&ObjectService{}).UpdateObjectMeta(
		waveobj.UIContext{},
		waveobj.MakeORef(waveobj.OType_Block, child.OID).String(),
		waveobj.MetaMapType{waveobj.MetaKey_View: "web"},
	); err == nil {
		t.Fatalf("UpdateObjectMeta accepted incompatible view on orphaned Terminal SubBlock")
	}
	reloadedChild, _ := wstore.DBMustGet[*waveobj.Block](ctx, child.OID)
	if reloadedChild.Meta.GetString(waveobj.MetaKey_View, "") != "term" {
		t.Fatalf("rejected orphan metadata update partially persisted: %#v", reloadedChild.Meta)
	}

	sameChild := *reloadedChild
	if _, err := (&ObjectService{}).UpdateObject(waveobj.UIContext{}, &sameChild, true); err == nil {
		t.Fatalf("UpdateObject accepted unreachable Terminal SubBlock override")
	}
}

func TestTerminalDomainObjectServiceLeavesLegacyBlockUpdatesUnchanged(t *testing.T) {
	ctx := setupObjectServiceWStore(t)
	blockId := uuid.NewString()
	tabId := uuid.NewString()
	workspaceId := uuid.NewString()
	block := &waveobj.Block{
		OID:        blockId,
		ParentORef: waveobj.MakeORef(waveobj.OType_Tab, tabId).String(),
		Meta:       waveobj.MetaMapType{waveobj.MetaKey_View: "term"},
	}
	tab := &waveobj.Tab{OID: tabId, BlockIds: []string{block.OID}}
	workspace := &waveobj.Workspace{OID: workspaceId, TabIds: []string{tab.OID}}
	for _, obj := range []waveobj.WaveObj{workspace, tab, block} {
		if err := wstore.DBInsert(ctx, obj); err != nil {
			t.Fatalf("insert %T: %v", obj, err)
		}
	}

	if _, err := (&ObjectService{}).UpdateObjectMeta(waveobj.UIContext{}, waveobj.MakeORef(waveobj.OType_Block, block.OID).String(), waveobj.MetaMapType{
		waveobj.MetaKey_View: "web",
	}); err != nil {
		t.Fatalf("legacy UpdateObjectMeta changed behavior: %v", err)
	}
	updated, _ := wstore.DBMustGet[*waveobj.Block](ctx, block.OID)
	if updated.Meta.GetString(waveobj.MetaKey_View, "") != "web" {
		t.Fatalf("legacy view update was not persisted")
	}
}

func setupObjectServiceTerminalDomain(t *testing.T, _ string) (context.Context, *waveobj.Workspace, *waveobj.Tab, *waveobj.Block) {
	t.Helper()
	ctx := setupObjectServiceWStore(t)
	blockId := uuid.NewString()
	tabId := uuid.NewString()
	workspaceId := uuid.NewString()
	block := &waveobj.Block{
		OID:        blockId,
		ParentORef: waveobj.MakeORef(waveobj.OType_Tab, tabId).String(),
		Meta:       waveobj.MetaMapType{waveobj.MetaKey_View: "termblocks"},
	}
	tab := &waveobj.Tab{OID: tabId, BlockIds: []string{block.OID}}
	workspace := &waveobj.Workspace{
		OID:              workspaceId,
		TabDomainVersion: waveobj.CurrentTabDomainVersion,
		TabIds:           []string{tab.OID},
		TerminalTabIds:   []string{tab.OID},
	}
	for _, obj := range []waveobj.WaveObj{workspace, tab, block} {
		if err := wstore.DBInsert(ctx, obj); err != nil {
			t.Fatalf("insert %T: %v", obj, err)
		}
	}
	return ctx, workspace, tab, block
}

func setupObjectServiceWStore(t *testing.T) context.Context {
	t.Helper()
	wavebase.DataHome_VarCache = t.TempDir()
	wavebase.ConfigHome_VarCache = t.TempDir()
	if err := wavebase.EnsureWaveDBDir(); err != nil {
		t.Fatalf("EnsureWaveDBDir: %v", err)
	}
	if err := os.MkdirAll(filepath.Join(wavebase.DataHome_VarCache, wavebase.WaveDBDir), 0o700); err != nil {
		t.Fatalf("MkdirAll: %v", err)
	}
	if err := wstore.InitWStore(); err != nil {
		t.Fatalf("InitWStore: %v", err)
	}
	return context.Background()
}

func assertObjectServiceBlockUnchanged(t *testing.T, ctx context.Context, want *waveobj.Block) {
	t.Helper()
	got, err := wstore.DBMustGet[*waveobj.Block](ctx, want.OID)
	if err != nil {
		t.Fatalf("reload block: %v", err)
	}
	if !reflect.DeepEqual(got.Meta, want.Meta) || !reflect.DeepEqual(got.SubBlockIds, want.SubBlockIds) {
		t.Fatalf("rejected update partially persisted: got %#v, want %#v", got, want)
	}
}
