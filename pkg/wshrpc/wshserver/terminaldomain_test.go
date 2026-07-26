// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

package wshserver

import (
	"context"
	"os"
	"path/filepath"
	"testing"

	"github.com/google/uuid"
	"github.com/s-zx/crest/pkg/wavebase"
	"github.com/s-zx/crest/pkg/waveobj"
	"github.com/s-zx/crest/pkg/wshrpc"
	"github.com/s-zx/crest/pkg/wstore"
)

func TestTerminalDomainSetMetaCommandRejectsIncompatibleViewWithoutPartialWrite(t *testing.T) {
	ctx := setupWshServerTerminalDomain(t)
	workspace, _ := wstore.DBMustGet[*waveobj.Workspace](ctx, "setmeta-workspace")
	tab, _ := wstore.DBMustGet[*waveobj.Tab](ctx, workspace.TabIds[0])
	block, _ := wstore.DBMustGet[*waveobj.Block](ctx, tab.BlockIds[0])
	err := (&WshServer{}).SetMetaCommand(ctx, wshrpc.CommandSetMetaData{
		ORef: waveobj.MakeORef(waveobj.OType_Block, block.OID),
		Meta: waveobj.MetaMapType{waveobj.MetaKey_View: "web"},
	})
	if err == nil {
		t.Fatalf("SetMetaCommand accepted incompatible Terminal view")
	}
	reloaded, _ := wstore.DBMustGet[*waveobj.Block](ctx, block.OID)
	if reloaded.Meta.GetString(waveobj.MetaKey_View, "") != "termblocks" {
		t.Fatalf("rejected SetMetaCommand partially persisted: %#v", reloaded.Meta)
	}
}

func TestTerminalDomainDeleteSubBlockCommandRejectsFinalRootWithoutPartialWrite(t *testing.T) {
	ctx := setupWshServerTerminalDomain(t)
	workspace, _ := wstore.DBMustGet[*waveobj.Workspace](ctx, "setmeta-workspace")
	tab, _ := wstore.DBMustGet[*waveobj.Tab](ctx, workspace.TabIds[0])
	blockId := tab.BlockIds[0]
	if err := (&WshServer{}).DeleteSubBlockCommand(ctx, wshrpc.CommandDeleteBlockData{
		BlockId: blockId,
	}); err == nil {
		t.Fatalf("DeleteSubBlockCommand accepted final registered Terminal root")
	}
	reloadedWorkspace, _ := wstore.DBMustGet[*waveobj.Workspace](ctx, workspace.OID)
	reloadedTab, _ := wstore.DBMustGet[*waveobj.Tab](ctx, tab.OID)
	reloadedBlock, _ := wstore.DBGet[*waveobj.Block](ctx, blockId)
	if len(reloadedWorkspace.TerminalTabIds) != 1 ||
		len(reloadedTab.BlockIds) != 1 || reloadedTab.BlockIds[0] != blockId ||
		reloadedBlock == nil {
		t.Fatalf("rejected DeleteSubBlockCommand partially mutated Terminal")
	}
}

func setupWshServerTerminalDomain(t *testing.T) context.Context {
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
	ctx := context.Background()
	blockId := uuid.NewString()
	tabId := uuid.NewString()
	block := &waveobj.Block{
		OID:        blockId,
		ParentORef: waveobj.MakeORef(waveobj.OType_Tab, tabId).String(),
		Meta:       waveobj.MetaMapType{waveobj.MetaKey_View: "termblocks"},
	}
	tab := &waveobj.Tab{OID: tabId, BlockIds: []string{block.OID}}
	workspace := &waveobj.Workspace{
		OID:              "setmeta-workspace",
		TabDomainVersion: waveobj.CurrentTabDomainVersion,
		TabIds:           []string{tab.OID},
		TerminalTabIds:   []string{tab.OID},
	}
	for _, obj := range []waveobj.WaveObj{workspace, tab, block} {
		if err := wstore.DBInsert(ctx, obj); err != nil {
			t.Fatalf("insert %T: %v", obj, err)
		}
	}
	return ctx
}
