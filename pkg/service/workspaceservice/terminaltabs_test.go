// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

package workspaceservice

import (
	"context"
	"encoding/json"
	"errors"
	"reflect"
	"testing"

	"github.com/s-zx/crest/pkg/waveobj"
	"github.com/s-zx/crest/pkg/wcore"
	"github.com/s-zx/crest/pkg/wstore"
)

func TestTerminalTabInventoryCreateRenameReorderAndClose(t *testing.T) {
	ctx := setupCheckpointTestWStore(t)
	svc := &WorkspaceService{}
	workspace := insertTerminalDomainWorkspace(t, ctx, "terminal-inventory")

	first, err := svc.CreateTerminalTab(ctx, TerminalTabCreateData{
		WorkspaceId: workspace.OID, ExpectedRevision: 0, Name: "One", Cwd: "/one",
	})
	if err != nil {
		t.Fatalf("CreateTerminalTab first: %v", err)
	}
	if first.NavigationRevision != 1 || len(first.TerminalTabIds) != 1 {
		t.Fatalf("first checkpoint = %#v", first)
	}
	firstId := first.TerminalTabIds[0]
	if first.ActiveTerminalTabId != firstId ||
		first.ContentState.ActiveContent != (waveobj.ActiveContent{Kind: waveobj.ActiveContentKindTerminal, TerminalTabId: firstId}) {
		t.Fatalf("first active tuple = %#v", first)
	}
	firstTab, err := wstore.DBMustGet[*waveobj.Tab](ctx, firstId)
	if err != nil {
		t.Fatalf("get first tab: %v", err)
	}
	if len(firstTab.BlockIds) != 1 {
		t.Fatalf("first Terminal blockids = %#v", firstTab.BlockIds)
	}
	firstBlock, err := wstore.DBMustGet[*waveobj.Block](ctx, firstTab.BlockIds[0])
	if err != nil {
		t.Fatalf("get first Terminal block: %v", err)
	}
	if firstBlock.Meta.GetString(waveobj.MetaKey_View, "") != wcore.TerminalViewTermBlocks ||
		firstBlock.Meta.GetString(waveobj.MetaKey_Controller, "") != "shell" {
		t.Fatalf("first Terminal root block meta = %#v", firstBlock.Meta)
	}

	second, err := svc.CreateTerminalTab(ctx, TerminalTabCreateData{
		WorkspaceId: workspace.OID, ExpectedRevision: 1, Name: "Two",
	})
	if err != nil {
		t.Fatalf("CreateTerminalTab second: %v", err)
	}
	secondId := second.TerminalTabIds[1]
	if err := svc.RenameTerminalTab(ctx, TerminalTabRenameData{
		WorkspaceId: workspace.OID, TerminalTabId: firstId, Name: "Renamed",
	}); err != nil {
		t.Fatalf("RenameTerminalTab: %v", err)
	}
	renamed, err := wstore.DBMustGet[*waveobj.Tab](ctx, firstId)
	if err != nil || renamed.Name != "Renamed" {
		t.Fatalf("renamed tab = %#v, err = %v", renamed, err)
	}

	reordered, err := svc.ReorderTerminalTabs(ctx, TerminalTabReorderData{
		WorkspaceId: workspace.OID, ExpectedRevision: 2, TerminalTabIds: []string{secondId, firstId},
	})
	if err != nil {
		t.Fatalf("ReorderTerminalTabs: %v", err)
	}
	if !reflect.DeepEqual(reordered.TerminalTabIds, []string{secondId, firstId}) || reordered.NavigationRevision != 3 {
		t.Fatalf("reordered checkpoint = %#v", reordered)
	}

	closed, err := svc.CloseTerminalTab(ctx, TerminalTabMutationData{
		WorkspaceId: workspace.OID, TerminalTabId: secondId, ExpectedRevision: 3,
	})
	if err != nil {
		t.Fatalf("CloseTerminalTab: %v", err)
	}
	if !reflect.DeepEqual(closed.TerminalTabIds, []string{firstId}) ||
		closed.ActiveTerminalTabId != firstId ||
		closed.ContentState.ActiveContent.TerminalTabId != firstId ||
		closed.NavigationRevision != 4 {
		t.Fatalf("closed checkpoint = %#v", closed)
	}
	if deleted, _ := wstore.DBGet[*waveobj.Tab](ctx, secondId); deleted != nil {
		t.Fatalf("closed Terminal still exists")
	}
}

func TestTerminalTabInventoryRejectsInvalidMutationsWithoutPartialWrites(t *testing.T) {
	ctx := setupCheckpointTestWStore(t)
	svc := &WorkspaceService{}
	workspace := insertTerminalDomainWorkspace(t, ctx, "terminal-invalid")
	checkpoint, err := svc.CreateTerminalTab(ctx, TerminalTabCreateData{
		WorkspaceId: workspace.OID, ExpectedRevision: 0, Name: "One",
	})
	if err != nil {
		t.Fatalf("CreateTerminalTab: %v", err)
	}
	terminalId := checkpoint.TerminalTabIds[0]
	mixedId := insertMixedLegacyTab(t, ctx, workspace.OID)
	foreign := insertTerminalDomainWorkspace(t, ctx, "terminal-foreign")
	foreignCheckpoint, err := svc.CreateTerminalTab(ctx, TerminalTabCreateData{
		WorkspaceId: foreign.OID, ExpectedRevision: 0, Name: "Foreign",
	})
	if err != nil {
		t.Fatalf("CreateTerminalTab foreign: %v", err)
	}
	foreignId := foreignCheckpoint.TerminalTabIds[0]

	invalidOrders := [][]string{
		{},
		{terminalId, terminalId},
		{foreignId},
		{mixedId},
	}
	for _, ids := range invalidOrders {
		_, err := svc.ReorderTerminalTabs(ctx, TerminalTabReorderData{
			WorkspaceId: workspace.OID, ExpectedRevision: 1, TerminalTabIds: ids,
		})
		if err == nil {
			t.Fatalf("ReorderTerminalTabs accepted %#v", ids)
		}
		assertTerminalInventory(t, ctx, workspace.OID, 1, []string{terminalId}, terminalId)
	}
	for _, tabId := range []string{mixedId, foreignId, "missing"} {
		_, err := svc.CloseTerminalTab(ctx, TerminalTabMutationData{
			WorkspaceId: workspace.OID, TerminalTabId: tabId, ExpectedRevision: 1,
		})
		if err == nil {
			t.Fatalf("CloseTerminalTab accepted %q", tabId)
		}
		assertTerminalInventory(t, ctx, workspace.OID, 1, []string{terminalId}, terminalId)
	}

	_, err = svc.CreateTerminalTab(ctx, TerminalTabCreateData{
		WorkspaceId: workspace.OID, ExpectedRevision: 0, Name: "Stale",
	})
	if !errors.Is(err, ErrStaleWorkspaceCheckpoint) {
		t.Fatalf("stale CreateTerminalTab error = %v", err)
	}
	assertTerminalInventory(t, ctx, workspace.OID, 1, []string{terminalId}, terminalId)
}

func TestValidateWorkspaceTerminalTabRepairsMissingShellController(t *testing.T) {
	ctx := setupCheckpointTestWStore(t)
	svc := &WorkspaceService{}
	workspace := insertTerminalDomainWorkspace(t, ctx, "terminal-controller-repair")
	checkpoint, err := svc.CreateTerminalTab(ctx, TerminalTabCreateData{
		WorkspaceId: workspace.OID, ExpectedRevision: 0, Name: "Repair",
	})
	if err != nil {
		t.Fatalf("CreateTerminalTab: %v", err)
	}
	terminalId := checkpoint.TerminalTabIds[0]
	tab, err := wstore.DBMustGet[*waveobj.Tab](ctx, terminalId)
	if err != nil {
		t.Fatalf("get Terminal tab: %v", err)
	}
	block, err := wstore.DBMustGet[*waveobj.Block](ctx, tab.BlockIds[0])
	if err != nil {
		t.Fatalf("get Terminal block: %v", err)
	}
	delete(block.Meta, waveobj.MetaKey_Controller)
	if err := wstore.DBUpdate(ctx, block); err != nil {
		t.Fatalf("remove controller meta: %v", err)
	}

	valid, err := svc.ValidateWorkspaceTerminalTab(workspace.OID, terminalId)
	if err != nil || !valid {
		t.Fatalf("ValidateWorkspaceTerminalTab valid=%v err=%v", valid, err)
	}
	repaired, err := wstore.DBMustGet[*waveobj.Block](ctx, block.OID)
	if err != nil {
		t.Fatalf("reload repaired block: %v", err)
	}
	if repaired.Meta.GetString(waveobj.MetaKey_Controller, "") != "shell" {
		t.Fatalf("repaired controller = %#v", repaired.Meta)
	}
}

func TestTerminalTabInventoryClosingFinalFallsBackWithoutClosingWindow(t *testing.T) {
	ctx := setupCheckpointTestWStore(t)
	svc := &WorkspaceService{}
	workspace := insertTerminalDomainWorkspace(t, ctx, "terminal-final")
	workspace.ContentState = waveobj.WorkspaceContentState{
		TopTabs: []waveobj.TopTabDescriptor{
			{Id: "file-a", Kind: waveobj.TopTabKindFile, Path: "/tmp/a", Title: "a"},
		},
		LastActiveTopTabId: "file-a",
	}
	if err := wstore.DBUpdate(ctx, workspace); err != nil {
		t.Fatalf("update workspace content: %v", err)
	}
	window := &waveobj.Window{OID: "terminal-final-window", WorkspaceId: workspace.OID}
	if err := wstore.DBInsert(ctx, window); err != nil {
		t.Fatalf("insert window: %v", err)
	}
	checkpoint, err := svc.CreateTerminalTab(ctx, TerminalTabCreateData{
		WorkspaceId: workspace.OID, ExpectedRevision: 0, Name: "Only",
	})
	if err != nil {
		t.Fatalf("CreateTerminalTab: %v", err)
	}
	closed, err := svc.CloseTerminalTab(ctx, TerminalTabMutationData{
		WorkspaceId: workspace.OID, TerminalTabId: checkpoint.TerminalTabIds[0], ExpectedRevision: 1,
	})
	if err != nil {
		t.Fatalf("CloseTerminalTab: %v", err)
	}
	if len(closed.TerminalTabIds) != 0 || closed.ActiveTerminalTabId != "" ||
		closed.ContentState.ActiveContent != (waveobj.ActiveContent{Kind: waveobj.ActiveContentKindTopTab, TopTabId: "file-a"}) {
		t.Fatalf("final close checkpoint = %#v", closed)
	}
	if persisted, _ := wstore.DBGet[*waveobj.Window](ctx, window.OID); persisted == nil {
		t.Fatalf("closing final Terminal deleted the window")
	}
	if persisted, _ := wstore.DBGet[*waveobj.Workspace](ctx, workspace.OID); persisted == nil {
		t.Fatalf("closing final Terminal deleted the workspace")
	}
}

func TestTerminalTabInventoryCheckpointIsDeepCopyAndEmptyRoundTrips(t *testing.T) {
	ctx := setupCheckpointTestWStore(t)
	workspace := insertTerminalDomainWorkspace(t, ctx, "terminal-roundtrip")

	encoded, err := json.Marshal(workspace)
	if err != nil {
		t.Fatalf("marshal workspace: %v", err)
	}
	var decoded waveobj.Workspace
	if err := json.Unmarshal(encoded, &decoded); err != nil {
		t.Fatalf("unmarshal workspace: %v", err)
	}
	if decoded.TabDomainVersion != waveobj.CurrentTabDomainVersion || len(decoded.TerminalTabIds) != 0 {
		t.Fatalf("JSON roundtrip workspace = %#v", decoded)
	}
	reloaded, err := wstore.DBMustGet[*waveobj.Workspace](ctx, workspace.OID)
	if err != nil || reloaded.TabDomainVersion != waveobj.CurrentTabDomainVersion || len(reloaded.TerminalTabIds) != 0 {
		t.Fatalf("DB roundtrip workspace = %#v, err = %v", reloaded, err)
	}

	checkpoint := makeWorkspaceCheckpoint(reloaded)
	checkpoint.TerminalTabIds = append(checkpoint.TerminalTabIds, "mutated")
	checkpoint.ContentState.TopTabs = append(checkpoint.ContentState.TopTabs, waveobj.TopTabDescriptor{Id: "mutated"})
	again := makeWorkspaceCheckpoint(reloaded)
	if len(again.TerminalTabIds) != 0 || len(again.ContentState.TopTabs) != 0 {
		t.Fatalf("checkpoint aliases workspace state: %#v", again)
	}
}

func TestTerminalTabChangesNeverMutateAgentStateOrRevision(t *testing.T) {
	ctx := setupCheckpointTestWStore(t)
	svc := &WorkspaceService{}
	workspace := insertTerminalDomainWorkspace(t, ctx, "terminal-agent-revision")

	first, err := svc.CreateTerminalTab(ctx, TerminalTabCreateData{
		WorkspaceId: workspace.OID, ExpectedRevision: 0, Name: "First",
	})
	if err != nil {
		t.Fatalf("create first Terminal: %v", err)
	}
	firstId := first.TerminalTabIds[0]
	second, err := svc.CreateTerminalTab(ctx, TerminalTabCreateData{
		WorkspaceId: workspace.OID, ExpectedRevision: 1, Name: "Second",
	})
	if err != nil {
		t.Fatalf("create second Terminal: %v", err)
	}
	secondId := second.TerminalTabIds[1]
	if _, err := svc.SaveWorkspaceAgentState(ctx, SaveWorkspaceAgentStateData{
		WorkspaceId:      workspace.OID,
		ExpectedRevision: 0,
		State: waveobj.WorkspaceAgentState{
			Selection: &waveobj.AgentSelectionMeta{Provider: "openai", Model: "gpt-5"},
		},
	}); err != nil {
		t.Fatalf("save Agent state: %v", err)
	}

	third, err := svc.CreateTerminalTab(ctx, TerminalTabCreateData{
		WorkspaceId: workspace.OID, ExpectedRevision: 2, Name: "Third",
	})
	if err != nil {
		t.Fatalf("create third Terminal: %v", err)
	}
	thirdId := third.TerminalTabIds[2]
	reordered, err := svc.ReorderTerminalTabs(ctx, TerminalTabReorderData{
		WorkspaceId:      workspace.OID,
		ExpectedRevision: 3,
		TerminalTabIds:   []string{thirdId, secondId, firstId},
	})
	if err != nil {
		t.Fatalf("reorder Terminals: %v", err)
	}
	if reordered.NavigationRevision != 4 {
		t.Fatalf("navigation revision after reorder = %d", reordered.NavigationRevision)
	}
	persisted := mustGetAgentWorkspace(t, ctx, workspace.OID)
	if persisted.AgentRevision != 1 || persisted.AgentState.Selection.Model != "gpt-5" {
		t.Fatalf("unrelated create/reorder changed Agent state: %#v", persisted)
	}

	if _, err := svc.CloseTerminalTab(ctx, TerminalTabMutationData{
		WorkspaceId: workspace.OID, TerminalTabId: secondId, ExpectedRevision: 4,
	}); err != nil {
		t.Fatalf("close unrelated Terminal: %v", err)
	}
	persisted = mustGetAgentWorkspace(t, ctx, workspace.OID)
	if persisted.NavigationRevision != 5 ||
		persisted.AgentRevision != 1 ||
		persisted.AgentState.Selection.Model != "gpt-5" {
		t.Fatalf("unrelated close changed Agent state: %#v", persisted)
	}

	if _, err := svc.CloseTerminalTab(ctx, TerminalTabMutationData{
		WorkspaceId: workspace.OID, TerminalTabId: firstId, ExpectedRevision: 5,
	}); err != nil {
		t.Fatalf("close preferred Terminal: %v", err)
	}
	persisted = mustGetAgentWorkspace(t, ctx, workspace.OID)
	if persisted.NavigationRevision != 6 ||
		persisted.AgentRevision != 1 ||
		persisted.AgentState.Selection.Model != "gpt-5" {
		t.Fatalf("Terminal close changed Agent state: %#v", persisted)
	}
}

func TestTerminalTabNewWorkspaceStaysAgentActiveThroughRepairAndOnboarding(t *testing.T) {
	ctx := setupCheckpointTestWStore(t)
	workspace, err := wcore.CreateWorkspace(ctx, "New Domain", "", "", false, true, "")
	if err != nil {
		t.Fatalf("CreateWorkspace: %v", err)
	}
	if workspace.TabDomainVersion != waveobj.CurrentTabDomainVersion ||
		len(workspace.TabIds) != 0 ||
		len(workspace.TerminalTabIds) != 0 ||
		workspace.ActiveTabId != "" ||
		workspace.ActiveTerminalTabId != "" ||
		workspace.ContentState.ActiveContent.Kind != waveobj.ActiveContentKindAgent {
		t.Fatalf("new workspace bootstrap = %#v", workspace)
	}

	window := &waveobj.Window{OID: "terminal-bootstrap-window", WorkspaceId: workspace.OID}
	client := &waveobj.Client{OID: "terminal-bootstrap-client", WindowIds: []string{window.OID}}
	if err := wstore.DBInsert(ctx, window); err != nil {
		t.Fatalf("insert window: %v", err)
	}
	if err := wstore.DBInsert(ctx, client); err != nil {
		t.Fatalf("insert client: %v", err)
	}
	if repaired := wcore.CheckAndFixWindow(ctx, window.OID); repaired == nil {
		t.Fatalf("CheckAndFixWindow returned nil")
	}
	if err := wcore.BootstrapStarterLayout(ctx); err != nil {
		t.Fatalf("BootstrapStarterLayout: %v", err)
	}
	reloaded, err := wstore.DBMustGet[*waveobj.Workspace](ctx, workspace.OID)
	if err != nil {
		t.Fatalf("reload workspace: %v", err)
	}
	if len(reloaded.TabIds) != 0 || len(reloaded.TerminalTabIds) != 0 ||
		reloaded.ContentState.ActiveContent.Kind != waveobj.ActiveContentKindAgent {
		t.Fatalf("repair/onboarding synthesized legacy state: %#v", reloaded)
	}
	tabs, err := wstore.DBGetAllObjsByType[*waveobj.Tab](ctx, waveobj.OType_Tab)
	if err != nil || len(tabs) != 0 {
		t.Fatalf("repair/onboarding left orphan tabs: %#v, err = %v", tabs, err)
	}
}

func TestTerminalTabLegacyWorkspaceRepairDoesNotCreateStarterTab(t *testing.T) {
	ctx := setupCheckpointTestWStore(t)
	workspace := &waveobj.Workspace{OID: "terminal-legacy-repair", TabIds: []string{}}
	window := &waveobj.Window{OID: "terminal-legacy-window", WorkspaceId: workspace.OID}
	if err := wstore.DBInsert(ctx, workspace); err != nil {
		t.Fatalf("insert workspace: %v", err)
	}
	if err := wstore.DBInsert(ctx, window); err != nil {
		t.Fatalf("insert window: %v", err)
	}
	if repaired := wcore.CheckAndFixWindow(ctx, window.OID); repaired == nil {
		t.Fatalf("CheckAndFixWindow returned nil")
	}
	reloaded, err := wstore.DBMustGet[*waveobj.Workspace](ctx, workspace.OID)
	if err != nil {
		t.Fatalf("reload workspace: %v", err)
	}
	if len(reloaded.TabIds) != 0 || reloaded.ActiveTabId != "" {
		t.Fatalf("legacy repair created a starter Tab: %#v", reloaded)
	}
}

func TestAdoptLegacyWorkspaceTabDomainsDeletesUnsupportedLegacyObjectsWithoutRegisteringTerminals(t *testing.T) {
	ctx := setupCheckpointTestWStore(t)
	legacy := &waveobj.Workspace{
		OID:                 "terminal-adoption-legacy",
		TabIds:              []string{},
		TerminalTabIds:      []string{"stale-terminal"},
		ActiveTerminalTabId: "stale-terminal",
		NavigationRevision:  41,
		ContentState: waveobj.WorkspaceContentState{
			ActiveContent:      waveobj.ActiveContent{Kind: waveobj.ActiveContentKindTopTab, TopTabId: "stale-top-tab"},
			TopTabs:            []waveobj.TopTabDescriptor{{Id: "stale-top-tab", Kind: waveobj.TopTabKindFile, Path: "/tmp/stale", Title: "Stale"}},
			LastActiveTopTabId: "stale-top-tab",
		},
	}
	if err := wstore.DBInsert(ctx, legacy); err != nil {
		t.Fatalf("insert legacy workspace: %v", err)
	}
	legacyTabId := insertMixedLegacyTab(t, ctx, legacy.OID)
	legacy.TabIds = []string{legacyTabId}
	legacy.ActiveTabId = legacyTabId
	if err := wstore.DBUpdate(ctx, legacy); err != nil {
		t.Fatalf("update legacy workspace: %v", err)
	}
	tabBefore, err := wstore.DBMustGet[*waveobj.Tab](ctx, legacyTabId)
	if err != nil {
		t.Fatalf("get legacy tab before adoption: %v", err)
	}
	blockBefore, err := wstore.DBMustGet[*waveobj.Block](ctx, tabBefore.BlockIds[0])
	if err != nil {
		t.Fatalf("get legacy block before adoption: %v", err)
	}

	current := &waveobj.Workspace{
		OID:                 "terminal-adoption-current",
		TabDomainVersion:    waveobj.CurrentTabDomainVersion,
		TabIds:              []string{"current-legacy"},
		ActiveTabId:         "current-legacy",
		TerminalTabIds:      []string{"current-terminal"},
		ActiveTerminalTabId: "current-terminal",
		NavigationRevision:  17,
		ContentState: waveobj.WorkspaceContentState{
			ActiveContent: waveobj.ActiveContent{Kind: waveobj.ActiveContentKindTerminal, TerminalTabId: "current-terminal"},
		},
	}
	if err := wstore.DBInsert(ctx, current); err != nil {
		t.Fatalf("insert current workspace: %v", err)
	}
	currentBefore, err := wstore.DBMustGet[*waveobj.Workspace](ctx, current.OID)
	if err != nil {
		t.Fatalf("get current workspace before adoption: %v", err)
	}

	if err := wcore.AdoptLegacyWorkspaceTabDomains(ctx); err != nil {
		t.Fatalf("AdoptLegacyWorkspaceTabDomains first call: %v", err)
	}
	adopted, err := wstore.DBMustGet[*waveobj.Workspace](ctx, legacy.OID)
	if err != nil {
		t.Fatalf("get adopted workspace: %v", err)
	}
	if adopted.TabDomainVersion != waveobj.CurrentTabDomainVersion ||
		len(adopted.TabIds) != 0 ||
		adopted.ActiveTabId != "" ||
		len(adopted.TerminalTabIds) != 0 ||
		adopted.ActiveTerminalTabId != "" ||
		adopted.NavigationRevision != 0 ||
		adopted.ContentState.ActiveContent != (waveobj.ActiveContent{Kind: waveobj.ActiveContentKindAgent}) ||
		len(adopted.ContentState.TopTabs) != 0 ||
		adopted.ContentState.LastActiveTopTabId != "" {
		t.Fatalf("adopted workspace = %#v", adopted)
	}
	if tabAfter, _ := wstore.DBGet[*waveobj.Tab](ctx, legacyTabId); tabAfter != nil {
		t.Fatalf("legacy Tab survived adoption: %#v", tabAfter)
	}
	if blockAfter, _ := wstore.DBGet[*waveobj.Block](ctx, blockBefore.OID); blockAfter != nil {
		t.Fatalf("legacy Block survived adoption: %#v", blockAfter)
	}
	if layoutAfter, _ := wstore.DBGet[*waveobj.LayoutState](ctx, tabBefore.LayoutState); layoutAfter != nil {
		t.Fatalf("legacy LayoutState survived adoption: %#v", layoutAfter)
	}
	currentAfter, err := wstore.DBMustGet[*waveobj.Workspace](ctx, current.OID)
	if err != nil {
		t.Fatalf("get current workspace after adoption: %v", err)
	}
	if currentAfter.ActiveTabId != "" || len(currentAfter.TabIds) != 0 || len(currentAfter.TerminalTabIds) != 0 {
		t.Fatalf("current workspace retained legacy references: before=%#v after=%#v", currentBefore, currentAfter)
	}

	adoptedBeforeSecondCall := *adopted
	if err := wcore.AdoptLegacyWorkspaceTabDomains(ctx); err != nil {
		t.Fatalf("AdoptLegacyWorkspaceTabDomains second call: %v", err)
	}
	adoptedAfterSecondCall, err := wstore.DBMustGet[*waveobj.Workspace](ctx, legacy.OID)
	if err != nil {
		t.Fatalf("get adopted workspace after second call: %v", err)
	}
	if !reflect.DeepEqual(adoptedAfterSecondCall, &adoptedBeforeSecondCall) {
		t.Fatalf("second adoption changed workspace: before=%#v after=%#v", adoptedBeforeSecondCall, adoptedAfterSecondCall)
	}
}

func TestAdoptLegacyWorkspaceTabDomainsKeepsOnlyStructurallyValidClaimedTerminals(t *testing.T) {
	ctx := setupCheckpointTestWStore(t)
	workspace := insertTerminalDomainWorkspace(t, ctx, "terminal-adoption-claims")
	var validId string
	if err := wstore.WithTx(ctx, func(tx *wstore.TxWrap) error {
		var err error
		validId, err = wcore.CreateTerminalTabInTx(tx, workspace.OID, wcore.TerminalTabCreateOpts{Name: "Valid"})
		return err
	}); err != nil {
		t.Fatalf("create valid Terminal: %v", err)
	}
	corruptId := insertMixedLegacyTab(t, ctx, workspace.OID)
	corruptTab, err := wstore.DBMustGet[*waveobj.Tab](ctx, corruptId)
	if err != nil {
		t.Fatalf("get corrupt Tab: %v", err)
	}
	corruptBlockId := corruptTab.BlockIds[0]
	workspace, err = wstore.DBMustGet[*waveobj.Workspace](ctx, workspace.OID)
	if err != nil {
		t.Fatalf("reload workspace: %v", err)
	}
	workspace.TabIds = []string{validId, corruptId}
	workspace.TerminalTabIds = []string{validId, corruptId}
	workspace.ActiveTerminalTabId = corruptId
	workspace.ContentState.ActiveContent = waveobj.ActiveContent{
		Kind:          waveobj.ActiveContentKindTerminal,
		TerminalTabId: corruptId,
	}
	if err := wstore.DBUpdate(ctx, workspace); err != nil {
		t.Fatalf("claim corrupt Terminal: %v", err)
	}

	if err := wcore.AdoptLegacyWorkspaceTabDomains(ctx); err != nil {
		t.Fatalf("AdoptLegacyWorkspaceTabDomains: %v", err)
	}

	adopted, err := wstore.DBMustGet[*waveobj.Workspace](ctx, workspace.OID)
	if err != nil {
		t.Fatalf("reload adopted workspace: %v", err)
	}
	if !reflect.DeepEqual(adopted.TabIds, []string{validId}) ||
		!reflect.DeepEqual(adopted.TerminalTabIds, []string{validId}) ||
		adopted.ActiveTerminalTabId != "" ||
		adopted.ContentState.ActiveContent.Kind != waveobj.ActiveContentKindAgent {
		t.Fatalf("adopted workspace retained corrupt Terminal claim: %#v", adopted)
	}
	if valid, _ := wstore.DBGet[*waveobj.Tab](ctx, validId); valid == nil {
		t.Fatalf("valid Terminal was deleted")
	}
	if object, _ := wstore.DBGet[*waveobj.Tab](ctx, corruptId); object != nil {
		t.Fatalf("corrupt Tab survived adoption")
	}
	if object, _ := wstore.DBGet[*waveobj.Block](ctx, corruptBlockId); object != nil {
		t.Fatalf("corrupt Block survived adoption")
	}
	if object, _ := wstore.DBGet[*waveobj.LayoutState](ctx, corruptTab.LayoutState); object != nil {
		t.Fatalf("corrupt LayoutState survived adoption")
	}
}

func TestEnsureInitialDataAdoptsLegacyWorkspaceBeforeFirstTerminalCreation(t *testing.T) {
	ctx := setupCheckpointTestWStore(t)
	workspace := &waveobj.Workspace{
		OID:    "terminal-startup-adoption",
		TabIds: []string{},
		Meta:   waveobj.MetaMapType{waveobj.MetaKey_WorkspaceDir: t.TempDir()},
	}
	window := &waveobj.Window{OID: "terminal-startup-adoption-window", WorkspaceId: workspace.OID}
	client := &waveobj.Client{OID: "terminal-startup-adoption-client", WindowIds: []string{window.OID}}
	for _, obj := range []waveobj.WaveObj{workspace, window, client} {
		if err := wstore.DBInsert(ctx, obj); err != nil {
			t.Fatalf("insert %T: %v", obj, err)
		}
	}

	if _, err := wcore.EnsureInitialData(); err != nil {
		t.Fatalf("EnsureInitialData: %v", err)
	}
	svc := &WorkspaceService{}
	checkpoint, err := svc.CreateTerminalTab(ctx, TerminalTabCreateData{
		WorkspaceId: workspace.OID, ExpectedRevision: 0, Name: "First",
	})
	if err != nil {
		t.Fatalf("CreateTerminalTab after startup adoption: %v", err)
	}
	reloaded, err := wstore.DBMustGet[*waveobj.Workspace](ctx, workspace.OID)
	if err != nil {
		t.Fatalf("get workspace after first Terminal: %v", err)
	}
	if len(reloaded.TabIds) != 1 ||
		len(reloaded.TerminalTabIds) != 1 ||
		len(checkpoint.TerminalTabIds) != 1 ||
		reloaded.TabIds[0] != reloaded.TerminalTabIds[0] ||
		checkpoint.TerminalTabIds[0] != reloaded.TabIds[0] {
		t.Fatalf("first Terminal inventories: workspace=%#v checkpoint=%#v", reloaded, checkpoint)
	}
}

func insertTerminalDomainWorkspace(t *testing.T, ctx context.Context, id string) *waveobj.Workspace {
	t.Helper()
	workspace := &waveobj.Workspace{
		OID:                id,
		TabDomainVersion:   waveobj.CurrentTabDomainVersion,
		TabIds:             []string{},
		TerminalTabIds:     []string{},
		ContentState:       waveobj.WorkspaceContentState{ActiveContent: waveobj.ActiveContent{Kind: waveobj.ActiveContentKindAgent}, TopTabs: []waveobj.TopTabDescriptor{}},
		NavigationRevision: 0,
	}
	if err := wstore.DBInsert(ctx, workspace); err != nil {
		t.Fatalf("insert workspace: %v", err)
	}
	return workspace
}

func insertMixedLegacyTab(t *testing.T, ctx context.Context, workspaceId string) string {
	t.Helper()
	var tabId string
	err := wstore.WithTx(ctx, func(tx *wstore.TxWrap) error {
		var err error
		tabId, err = wcore.CreateTerminalTabInTx(tx, workspaceId, wcore.TerminalTabCreateOpts{Name: "Mixed"})
		return err
	})
	if err != nil {
		t.Fatalf("create mixed tab: %v", err)
	}
	tab, err := wstore.DBMustGet[*waveobj.Tab](ctx, tabId)
	if err != nil {
		t.Fatalf("get mixed tab: %v", err)
	}
	block, err := wstore.DBMustGet[*waveobj.Block](ctx, tab.BlockIds[0])
	if err != nil {
		t.Fatalf("get mixed root block: %v", err)
	}
	block.Meta[waveobj.MetaKey_View] = "web"
	if err := wstore.DBUpdate(ctx, block); err != nil {
		t.Fatalf("make mixed block: %v", err)
	}
	return tabId
}

func assertTerminalInventory(t *testing.T, ctx context.Context, workspaceId string, revision int64, ids []string, activeId string) {
	t.Helper()
	workspace, err := wstore.DBMustGet[*waveobj.Workspace](ctx, workspaceId)
	if err != nil {
		t.Fatalf("get workspace: %v", err)
	}
	if workspace.NavigationRevision != revision ||
		!reflect.DeepEqual(workspace.TerminalTabIds, ids) ||
		workspace.ActiveTerminalTabId != activeId {
		t.Fatalf("workspace navigation changed: %#v", workspace)
	}
}
