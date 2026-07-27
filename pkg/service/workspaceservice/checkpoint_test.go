// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

package workspaceservice

import (
	"context"
	"os"
	"path/filepath"
	"reflect"
	"sync"
	"testing"

	"github.com/s-zx/crest/pkg/wavebase"
	"github.com/s-zx/crest/pkg/waveobj"
	"github.com/s-zx/crest/pkg/wstore"
)

func TestSaveWorkspaceCheckpoint(t *testing.T) {
	ctx := setupCheckpointTestWStore(t)
	svc := &WorkspaceService{}
	terminalBlock := &waveobj.Block{
		OID: "terminal-block-2",
		Meta: waveobj.MetaMapType{
			waveobj.MetaKey_View: "termblocks",
		},
	}
	terminalTab := &waveobj.Tab{OID: "terminal-2", BlockIds: []string{terminalBlock.OID}}
	workspace := &waveobj.Workspace{OID: "workspace-checkpoint", TabIds: []string{terminalTab.OID}}
	if err := wstore.DBInsert(ctx, terminalBlock); err != nil {
		t.Fatalf("DBInsert terminal block returned error: %v", err)
	}
	if err := wstore.DBInsert(ctx, terminalTab); err != nil {
		t.Fatalf("DBInsert terminal tab returned error: %v", err)
	}
	if err := wstore.DBInsert(ctx, workspace); err != nil {
		t.Fatalf("DBInsert workspace returned error: %v", err)
	}

	initialState := waveobj.WorkspaceContentState{
		ActiveContent: waveobj.ActiveContent{Kind: waveobj.ActiveContentKindAgent},
		TopTabs:       []waveobj.TopTabDescriptor{},
	}
	result, err := svc.SaveWorkspaceCheckpoint(ctx, SaveWorkspaceCheckpointData{
		WorkspaceId:         workspace.OID,
		ExpectedRevision:    0,
		ContentState:        initialState,
		ActiveTerminalTabId: "terminal-2",
	})
	if err != nil {
		t.Fatalf("SaveWorkspaceCheckpoint returned error: %v", err)
	}
	if result.Status != SaveWorkspaceCheckpointStatusCommitted || result.Checkpoint.NavigationRevision != 1 {
		t.Fatalf("result = %#v", result)
	}
	saved := mustGetCheckpointWorkspace(t, ctx, workspace.OID)
	if saved.NavigationRevision != 1 {
		t.Fatalf("NavigationRevision = %d, want 1", saved.NavigationRevision)
	}
	if saved.ActiveTerminalTabId != "terminal-2" {
		t.Fatalf("ActiveTerminalTabId = %q, want terminal-2", saved.ActiveTerminalTabId)
	}
	if !reflect.DeepEqual(saved.ContentState, initialState) {
		t.Fatalf("ContentState = %#v, want %#v", saved.ContentState, initialState)
	}

	staleState := waveobj.WorkspaceContentState{
		ActiveContent: waveobj.ActiveContent{Kind: waveobj.ActiveContentKindTerminal, TerminalTabId: "stale"},
	}
	result, err = svc.SaveWorkspaceCheckpoint(ctx, SaveWorkspaceCheckpointData{
		WorkspaceId:         workspace.OID,
		ExpectedRevision:    0,
		ContentState:        staleState,
		ActiveTerminalTabId: "stale",
	})
	if err != nil || result.Status != SaveWorkspaceCheckpointStatusConflict {
		t.Fatalf("conflict = %#v, error = %v", result, err)
	}
	assertCheckpointUnchanged(t, ctx, workspace.OID, 1, initialState, "terminal-2")

	result, err = svc.SaveWorkspaceCheckpoint(ctx, SaveWorkspaceCheckpointData{
		WorkspaceId:      workspace.OID,
		ExpectedRevision: 0,
		ContentState:     staleState,
	})
	if err != nil || result.Status != SaveWorkspaceCheckpointStatusConflict {
		t.Fatalf("equal conflict = %#v, error = %v", result, err)
	}
	assertCheckpointUnchanged(t, ctx, workspace.OID, 1, initialState, "terminal-2")

	normalizationState := waveobj.WorkspaceContentState{
		ActiveContent: waveobj.ActiveContent{Kind: waveobj.ActiveContentKindTopTab, TopTabId: "missing"},
	}
	_, err = svc.SaveWorkspaceCheckpoint(ctx, SaveWorkspaceCheckpointData{
		WorkspaceId:         workspace.OID,
		ExpectedRevision:    1,
		ContentState:        normalizationState,
		ActiveTerminalTabId: "terminal-2",
	})
	if err != nil {
		t.Fatalf("normalized SaveWorkspaceCheckpoint returned error: %v", err)
	}
	saved = mustGetCheckpointWorkspace(t, ctx, workspace.OID)
	expectedNormalized := waveobj.WorkspaceContentState{
		ActiveContent: waveobj.ActiveContent{Kind: waveobj.ActiveContentKindTerminal, TerminalTabId: "terminal-2"},
		TopTabs:       []waveobj.TopTabDescriptor{},
	}
	if !reflect.DeepEqual(saved.ContentState, expectedNormalized) {
		t.Fatalf("normalized ContentState = %#v, want %#v", saved.ContentState, expectedNormalized)
	}

	for _, data := range []SaveWorkspaceCheckpointData{
		{},
		{WorkspaceId: workspace.OID, ExpectedRevision: -1},
	} {
		if _, err := svc.SaveWorkspaceCheckpoint(ctx, data); err == nil {
			t.Fatalf("SaveWorkspaceCheckpoint(%#v) returned nil error", data)
		}
	}

	_, err = svc.SaveWorkspaceCheckpoint(ctx, SaveWorkspaceCheckpointData{
		WorkspaceId:      "missing-workspace",
		ExpectedRevision: 0,
	})
	if err == nil {
		t.Fatal("SaveWorkspaceCheckpoint missing workspace returned nil error")
	}
}

func TestSaveWorkspaceCheckpointReturnsConflictWithoutError(t *testing.T) {
	ctx := setupCheckpointTestWStore(t)
	svc := &WorkspaceService{}
	workspace := &waveobj.Workspace{
		OID:                "workspace-checkpoint-conflict",
		NavigationRevision: 4,
		ContentState: waveobj.WorkspaceContentState{
			ActiveContent: waveobj.ActiveContent{Kind: waveobj.ActiveContentKindAgent},
			TopTabs:       []waveobj.TopTabDescriptor{},
		},
	}
	if err := wstore.DBInsert(ctx, workspace); err != nil {
		t.Fatalf("DBInsert workspace returned error: %v", err)
	}

	result, err := svc.SaveWorkspaceCheckpoint(ctx, SaveWorkspaceCheckpointData{
		WorkspaceId:      workspace.OID,
		ExpectedRevision: 3,
		ContentState: waveobj.WorkspaceContentState{
			ActiveContent: waveobj.ActiveContent{Kind: waveobj.ActiveContentKindTopTab, TopTabId: "missing"},
		},
	})
	if err != nil {
		t.Fatalf("conflict returned error: %v", err)
	}
	if result.Status != SaveWorkspaceCheckpointStatusConflict || result.Checkpoint.NavigationRevision != 4 {
		t.Fatalf("conflict result = %#v", result)
	}
	saved := mustGetCheckpointWorkspace(t, ctx, workspace.OID)
	if saved.NavigationRevision != 4 {
		t.Fatalf("conflict mutated revision to %d", saved.NavigationRevision)
	}
}

func TestSaveWorkspaceCheckpointRejectsInvalidTerminalTab(t *testing.T) {
	ctx := setupCheckpointTestWStore(t)
	svc := &WorkspaceService{}

	terminalBlock := &waveobj.Block{
		OID: "terminal-block",
		Meta: waveobj.MetaMapType{
			waveobj.MetaKey_View: "term",
		},
		SubBlockIds: []string{"file-block"},
	}
	terminalTab := &waveobj.Tab{OID: "terminal-tab", BlockIds: []string{terminalBlock.OID}}
	fileBlock := &waveobj.Block{
		OID: "file-block",
		Meta: waveobj.MetaMapType{
			waveobj.MetaKey_View: "codeeditor",
		},
	}
	mixedTab := &waveobj.Tab{OID: "mixed-tab", BlockIds: []string{terminalBlock.OID}}
	otherWorkspaceTab := &waveobj.Tab{OID: "other-terminal-tab", BlockIds: []string{terminalBlock.OID}}
	workspace := &waveobj.Workspace{
		OID:    "workspace-terminal-validation",
		TabIds: []string{terminalTab.OID, mixedTab.OID},
	}
	for _, obj := range []waveobj.WaveObj{terminalBlock, terminalTab, fileBlock, mixedTab, otherWorkspaceTab, workspace} {
		if err := wstore.DBInsert(ctx, obj); err != nil {
			t.Fatalf("DBInsert %s returned error: %v", obj.GetOType(), err)
		}
	}

	for _, terminalTabId := range []string{"missing-tab", mixedTab.OID, otherWorkspaceTab.OID} {
		_, err := svc.SaveWorkspaceCheckpoint(ctx, SaveWorkspaceCheckpointData{
			WorkspaceId:         workspace.OID,
			ExpectedRevision:    0,
			ContentState:        waveobj.WorkspaceContentState{ActiveContent: waveobj.ActiveContent{Kind: waveobj.ActiveContentKindAgent}},
			ActiveTerminalTabId: terminalTabId,
		})
		if err == nil {
			t.Fatalf("SaveWorkspaceCheckpoint terminal %q returned nil error", terminalTabId)
		}
		saved := mustGetCheckpointWorkspace(t, ctx, workspace.OID)
		if saved.NavigationRevision != 0 || saved.ActiveTerminalTabId != "" {
			t.Fatalf("invalid terminal %q mutated checkpoint: %#v", terminalTabId, saved)
		}
	}
}

func TestValidateWorkspaceTerminalTabDistinguishesNonMemberFromValidationFailure(t *testing.T) {
	ctx := setupCheckpointTestWStore(t)
	svc := &WorkspaceService{}
	workspace := &waveobj.Workspace{
		OID:            "workspace-renderer-identity",
		TabIds:         []string{"missing-terminal"},
		TerminalTabIds: []string{"missing-terminal"},
	}
	if err := wstore.DBInsert(ctx, workspace); err != nil {
		t.Fatalf("DBInsert workspace returned error: %v", err)
	}

	member, err := svc.ValidateWorkspaceTerminalTab(workspace.OID, "legacy-tab")
	if err != nil || member {
		t.Fatalf("legacy membership = %v, error = %v; want false, nil", member, err)
	}

	member, err = svc.ValidateWorkspaceTerminalTab(workspace.OID, "missing-terminal")
	if err == nil || member {
		t.Fatalf("invalid Terminal membership = %v, error = %v; want false, non-nil", member, err)
	}
}

func TestSaveWorkspaceCheckpointConcurrentExpectedRevisionCommitsOnce(t *testing.T) {
	ctx := setupCheckpointTestWStore(t)
	svc := &WorkspaceService{}
	workspace := &waveobj.Workspace{OID: "workspace-concurrent"}
	if err := wstore.DBInsert(ctx, workspace); err != nil {
		t.Fatalf("DBInsert workspace returned error: %v", err)
	}
	data := SaveWorkspaceCheckpointData{
		WorkspaceId:      workspace.OID,
		ExpectedRevision: 0,
		ContentState: waveobj.WorkspaceContentState{
			ActiveContent: waveobj.ActiveContent{Kind: waveobj.ActiveContentKindAgent},
		},
	}
	start := make(chan struct{})
	results := make(chan *SaveWorkspaceCheckpointResult, 2)
	errors := make(chan error, 2)
	var ready sync.WaitGroup
	ready.Add(2)
	save := func() {
		ready.Done()
		<-start
		result, err := svc.SaveWorkspaceCheckpoint(ctx, data)
		results <- result
		errors <- err
	}
	go save()
	go save()
	ready.Wait()
	close(start)

	statuses := map[string]int{}
	for range 2 {
		result := <-results
		if err := <-errors; err != nil {
			t.Fatalf("concurrent save returned error: %v", err)
		}
		statuses[result.Status]++
		if result.Checkpoint.NavigationRevision != 1 {
			t.Fatalf("result revision = %d, want 1", result.Checkpoint.NavigationRevision)
		}
	}
	if statuses[SaveWorkspaceCheckpointStatusCommitted] != 1 ||
		statuses[SaveWorkspaceCheckpointStatusConflict] != 1 {
		t.Fatalf("statuses = %#v", statuses)
	}
}

func setupCheckpointTestWStore(t *testing.T) context.Context {
	t.Helper()
	oldDataHome := wavebase.DataHome_VarCache
	oldConfigHome := wavebase.ConfigHome_VarCache
	wavebase.DataHome_VarCache = t.TempDir()
	wavebase.ConfigHome_VarCache = t.TempDir()
	t.Cleanup(func() {
		wavebase.DataHome_VarCache = oldDataHome
		wavebase.ConfigHome_VarCache = oldConfigHome
	})
	if err := wavebase.EnsureWaveDBDir(); err != nil {
		t.Fatalf("EnsureWaveDBDir returned error: %v", err)
	}
	if err := os.MkdirAll(filepath.Join(wavebase.DataHome_VarCache, wavebase.WaveDBDir), 0o700); err != nil {
		t.Fatalf("MkdirAll wave db dir returned error: %v", err)
	}
	if err := wstore.InitWStore(); err != nil {
		t.Fatalf("InitWStore returned error: %v", err)
	}
	return context.Background()
}

func mustGetCheckpointWorkspace(t *testing.T, ctx context.Context, workspaceId string) *waveobj.Workspace {
	t.Helper()
	workspace, err := wstore.DBMustGet[*waveobj.Workspace](ctx, workspaceId)
	if err != nil {
		t.Fatalf("DBMustGet workspace returned error: %v", err)
	}
	return workspace
}

func assertCheckpointUnchanged(t *testing.T, ctx context.Context, workspaceId string, revision int64, state waveobj.WorkspaceContentState, terminalId string) {
	t.Helper()
	workspace := mustGetCheckpointWorkspace(t, ctx, workspaceId)
	if workspace.NavigationRevision != revision || workspace.ActiveTerminalTabId != terminalId || !reflect.DeepEqual(workspace.ContentState, state) {
		t.Fatalf("checkpoint changed: revision=%d content=%#v terminal=%q", workspace.NavigationRevision, workspace.ContentState, workspace.ActiveTerminalTabId)
	}
}
