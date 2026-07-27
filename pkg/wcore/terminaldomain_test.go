// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

package wcore

import (
	"context"
	"errors"
	"fmt"
	"io/fs"
	"reflect"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/google/uuid"
	"github.com/s-zx/crest/pkg/filestore"
	"github.com/s-zx/crest/pkg/waveobj"
	"github.com/s-zx/crest/pkg/wshrpc"
	"github.com/s-zx/crest/pkg/wstore"
)

func TestTerminalDomainPrimitiveCompatibleViews(t *testing.T) {
	for _, view := range []string{"term", "termblocks"} {
		if !IsTerminalCompatibleView(view) {
			t.Fatalf("IsTerminalCompatibleView(%q) = false, want true", view)
		}
	}
	for _, view := range []string{"", "agent", "web", "preview"} {
		if IsTerminalCompatibleView(view) {
			t.Fatalf("IsTerminalCompatibleView(%q) = true, want false", view)
		}
	}
}

func TestTerminalDomainPrimitiveValidatesMembershipAndExistingSubtree(t *testing.T) {
	ctx := setupWorkspaceTestWStore(t)
	workspace := &waveobj.Workspace{OID: "terminal-membership-workspace", TabIds: []string{}}
	if err := wstore.DBInsert(ctx, workspace); err != nil {
		t.Fatalf("insert workspace: %v", err)
	}
	otherWorkspace := &waveobj.Workspace{OID: "other-terminal-workspace", TabIds: []string{}}
	if err := wstore.DBInsert(ctx, otherWorkspace); err != nil {
		t.Fatalf("insert other workspace: %v", err)
	}

	var tabId string
	err := wstore.WithTx(ctx, func(tx *wstore.TxWrap) error {
		var err error
		tabId, err = CreateTerminalTabInTx(tx, workspace.OID, TerminalTabCreateOpts{Name: "Terminal"})
		return err
	})
	if err != nil {
		t.Fatalf("CreateTerminalTabInTx: %v", err)
	}

	err = wstore.WithTx(ctx, func(tx *wstore.TxWrap) error {
		return ValidateTerminalTabMutation(tx, workspace.OID, tabId, nil)
	})
	if err != nil {
		t.Fatalf("ValidateTerminalTabMutation terminal tab: %v", err)
	}

	err = wstore.WithTx(ctx, func(tx *wstore.TxWrap) error {
		return ValidateTerminalTabMutation(tx, otherWorkspace.OID, tabId, nil)
	})
	if err == nil {
		t.Fatalf("ValidateTerminalTabMutation accepted a foreign tab")
	}

	tab, err := wstore.DBMustGet[*waveobj.Tab](ctx, tabId)
	if err != nil {
		t.Fatalf("get terminal tab: %v", err)
	}
	root, err := wstore.DBMustGet[*waveobj.Block](ctx, tab.BlockIds[0])
	if err != nil {
		t.Fatalf("get terminal root block: %v", err)
	}
	child := &waveobj.Block{
		OID:        "terminal-incompatible-child",
		ParentORef: waveobj.MakeORef(waveobj.OType_Block, root.OID).String(),
		Meta:       waveobj.MetaMapType{waveobj.MetaKey_View: "web"},
	}
	root.SubBlockIds = append(root.SubBlockIds, child.OID)
	if err := wstore.DBInsert(ctx, child); err != nil {
		t.Fatalf("insert incompatible child: %v", err)
	}
	if err := wstore.DBUpdate(ctx, root); err != nil {
		t.Fatalf("update terminal root: %v", err)
	}

	err = wstore.WithTx(ctx, func(tx *wstore.TxWrap) error {
		return ValidateTerminalTabMutation(tx, workspace.OID, tabId, nil)
	})
	if err == nil {
		t.Fatalf("ValidateTerminalTabMutation accepted an incompatible subblock")
	}
}

func TestTerminalDomainPrimitiveCreateAndDeleteInCallerTransaction(t *testing.T) {
	ctx := setupWorkspaceTestWStore(t)
	workspace := &waveobj.Workspace{OID: "terminal-create-workspace", TabIds: []string{}}
	if err := wstore.DBInsert(ctx, workspace); err != nil {
		t.Fatalf("insert workspace: %v", err)
	}

	var tabId string
	err := wstore.WithTx(ctx, func(tx *wstore.TxWrap) error {
		var err error
		tabId, err = CreateTerminalTabInTx(tx, workspace.OID, TerminalTabCreateOpts{
			Name:       "Dev",
			Connection: "ssh://dev",
			Cwd:        "/work",
		})
		return err
	})
	if err != nil {
		t.Fatalf("CreateTerminalTabInTx: %v", err)
	}

	tab, err := wstore.DBMustGet[*waveobj.Tab](ctx, tabId)
	if err != nil {
		t.Fatalf("get created tab: %v", err)
	}
	if tab.Name != "Dev" || len(tab.BlockIds) != 1 {
		t.Fatalf("created tab = %#v, want named tab with one block", tab)
	}
	block, err := wstore.DBMustGet[*waveobj.Block](ctx, tab.BlockIds[0])
	if err != nil {
		t.Fatalf("get created block: %v", err)
	}
	if got := block.Meta.GetString(waveobj.MetaKey_View, ""); got != "termblocks" {
		t.Fatalf("block view = %q, want termblocks", got)
	}
	if got := block.Meta.GetString(waveobj.MetaKey_Connection, ""); got != "ssh://dev" {
		t.Fatalf("block connection = %q, want ssh://dev", got)
	}
	if got := block.Meta.GetString(waveobj.MetaKey_CmdCwd, ""); got != "/work" {
		t.Fatalf("block cwd = %q, want /work", got)
	}

	origDeleteTerminalZone := deleteTerminalZone
	deleteTerminalZone = func(context.Context, string) error {
		return nil
	}
	defer func() {
		deleteTerminalZone = origDeleteTerminalZone
	}()
	err = wstore.WithTx(ctx, func(tx *wstore.TxWrap) error {
		return DeleteTerminalTabInTx(tx, workspace.OID, tabId)
	})
	if err != nil {
		t.Fatalf("DeleteTerminalTabInTx: %v", err)
	}
	if deletedTab, _ := wstore.DBGet[*waveobj.Tab](ctx, tabId); deletedTab != nil {
		t.Fatalf("terminal tab still exists after delete")
	}
	if deletedBlock, _ := wstore.DBGet[*waveobj.Block](ctx, block.OID); deletedBlock != nil {
		t.Fatalf("terminal block still exists after delete")
	}
	if deletedLayout, _ := wstore.DBGet[*waveobj.LayoutState](ctx, tab.LayoutState); deletedLayout != nil {
		t.Fatalf("terminal layout still exists after delete")
	}
	updatedWorkspace, err := wstore.DBMustGet[*waveobj.Workspace](ctx, workspace.OID)
	if err != nil {
		t.Fatalf("get updated workspace: %v", err)
	}
	if len(updatedWorkspace.TabIds) != 0 {
		t.Fatalf("workspace tabids = %#v, want empty", updatedWorkspace.TabIds)
	}
}

func TestDeleteTabRejectsRegisteredTerminalWithoutPartialWrite(t *testing.T) {
	ctx, workspaceId, terminalTabId := setupRegisteredTerminalTab(t, "delete-guard")
	tabBefore, _ := wstore.DBMustGet[*waveobj.Tab](ctx, terminalTabId)
	if _, err := DeleteTab(ctx, workspaceId, terminalTabId, false); err == nil {
		t.Fatalf("DeleteTab accepted registered Terminal")
	}
	workspace, _ := wstore.DBMustGet[*waveobj.Workspace](ctx, workspaceId)
	if !reflect.DeepEqual(workspace.TabIds, []string{terminalTabId}) ||
		!reflect.DeepEqual(workspace.TerminalTabIds, []string{terminalTabId}) {
		t.Fatalf("rejected DeleteTab changed inventory: %#v", workspace)
	}
	tabAfter, _ := wstore.DBMustGet[*waveobj.Tab](ctx, terminalTabId)
	if !reflect.DeepEqual(tabAfter, tabBefore) {
		t.Fatalf("rejected DeleteTab changed Terminal: got %#v, want %#v", tabAfter, tabBefore)
	}
}

func TestDeleteWorkspaceAtomicallyDeletesMixedLegacyAndTerminalTabs(t *testing.T) {
	ctx, workspaceId, terminalTabId := setupRegisteredTerminalTab(t, "delete-workspace-mixed")
	workspace, _ := wstore.DBMustGet[*waveobj.Workspace](ctx, workspaceId)
	legacyBlock := &waveobj.Block{OID: "delete-workspace-legacy-block", Meta: waveobj.MetaMapType{waveobj.MetaKey_View: "web"}}
	legacyTab := &waveobj.Tab{OID: "delete-workspace-legacy-tab", BlockIds: []string{legacyBlock.OID}}
	legacyBlock.ParentORef = waveobj.MakeORef(waveobj.OType_Tab, legacyTab.OID).String()
	for _, obj := range []waveobj.WaveObj{legacyTab, legacyBlock} {
		if err := wstore.DBInsert(ctx, obj); err != nil {
			t.Fatalf("insert %T: %v", obj, err)
		}
	}
	workspace.TabIds = []string{legacyTab.OID, terminalTabId}
	if err := wstore.DBUpdate(ctx, workspace); err != nil {
		t.Fatalf("update mixed inventory: %v", err)
	}
	terminalTab, _ := wstore.DBMustGet[*waveobj.Tab](ctx, terminalTabId)
	terminalBlockId := terminalTab.BlockIds[0]
	blockIds := []string{legacyBlock.OID, terminalBlockId}
	for _, blockId := range blockIds {
		wstore.SetRTInfo(waveobj.MakeORef(waveobj.OType_Block, blockId), map[string]any{"shell:state": "running"})
	}
	var closedBlockIds []string
	origBlockCloseEvent := deleteWorkspaceBlockCloseEvent
	deleteWorkspaceBlockCloseEvent = func(blockId string) {
		closedBlockIds = append(closedBlockIds, blockId)
	}
	defer func() { deleteWorkspaceBlockCloseEvent = origBlockCloseEvent }()
	origDeleteTerminalZone := deleteTerminalZone
	deleteTerminalZone = func(context.Context, string) error { return errors.New("injected zone cleanup failure") }
	defer func() { deleteTerminalZone = origDeleteTerminalZone }()

	deleted, _, err := DeleteWorkspace(ctx, workspaceId, true)
	if err != nil || !deleted {
		t.Fatalf("DeleteWorkspace mixed domain = %v, %v", deleted, err)
	}
	for otype, oid := range map[string]string{
		waveobj.OType_Workspace: workspaceId,
		waveobj.OType_Tab:       legacyTab.OID,
		waveobj.OType_Block:     legacyBlock.OID,
	} {
		if exists, _ := wstore.DBExistsORef(ctx, waveobj.MakeORef(otype, oid)); exists {
			t.Fatalf("%s %s survived workspace deletion", otype, oid)
		}
	}
	if terminal, _ := wstore.DBGet[*waveobj.Tab](ctx, terminalTabId); terminal != nil {
		t.Fatalf("Terminal survived workspace deletion")
	}
	if !reflect.DeepEqual(closedBlockIds, blockIds) {
		t.Fatalf("block close events = %#v, want %#v", closedBlockIds, blockIds)
	}
	for _, blockId := range blockIds {
		if rtInfo := wstore.GetRTInfo(waveobj.MakeORef(waveobj.OType_Block, blockId)); rtInfo != nil {
			t.Fatalf("RTInfo survived deleted block %s: %#v", blockId, rtInfo)
		}
	}
	if size := terminalRootDeleteLocks.size(); size != 0 {
		t.Fatalf("Workspace deletion left %d Terminal root lock entries", size)
	}
}

func TestDeleteWorkspaceInvalidTerminalPreflightHasNoPartialWrite(t *testing.T) {
	ctx, workspaceId, terminalTabId := setupRegisteredTerminalTab(t, "delete-workspace-preflight")
	workspace, _ := wstore.DBMustGet[*waveobj.Workspace](ctx, workspaceId)
	terminalTab, _ := wstore.DBMustGet[*waveobj.Tab](ctx, terminalTabId)
	terminalBlock, _ := wstore.DBMustGet[*waveobj.Block](ctx, terminalTab.BlockIds[0])
	terminalBlock.Meta[waveobj.MetaKey_View] = "web"
	if err := wstore.DBUpdate(ctx, terminalBlock); err != nil {
		t.Fatalf("corrupt Terminal: %v", err)
	}
	legacyTab := &waveobj.Tab{OID: "delete-workspace-preflight-legacy"}
	if err := wstore.DBInsert(ctx, legacyTab); err != nil {
		t.Fatalf("insert legacy Tab: %v", err)
	}
	workspace.TabIds = []string{legacyTab.OID, terminalTabId}
	if err := wstore.DBUpdate(ctx, workspace); err != nil {
		t.Fatalf("update mixed inventory: %v", err)
	}
	blockORef := waveobj.MakeORef(waveobj.OType_Block, terminalBlock.OID)
	wstore.SetRTInfo(blockORef, map[string]any{"shell:state": "running"})
	var closeEvents int
	origBlockCloseEvent := deleteWorkspaceBlockCloseEvent
	deleteWorkspaceBlockCloseEvent = func(string) { closeEvents++ }
	defer func() { deleteWorkspaceBlockCloseEvent = origBlockCloseEvent }()

	if _, _, err := DeleteWorkspace(ctx, workspaceId, true); err == nil {
		t.Fatalf("DeleteWorkspace accepted invalid registered Terminal")
	}
	if persisted, _ := wstore.DBGet[*waveobj.Workspace](ctx, workspaceId); persisted == nil {
		t.Fatalf("rejected DeleteWorkspace deleted workspace")
	}
	if persisted, _ := wstore.DBGet[*waveobj.Tab](ctx, legacyTab.OID); persisted == nil {
		t.Fatalf("rejected DeleteWorkspace partially deleted preceding legacy Tab")
	}
	if closeEvents != 0 || wstore.GetRTInfo(blockORef) == nil {
		t.Fatalf("rejected DeleteWorkspace emitted block side effects")
	}
}

func TestDeleteWorkspaceRejectsForeignAndDamagedTabReferencesWithoutPartialWrite(t *testing.T) {
	ctx, workspaceId, terminalTabId := setupRegisteredTerminalTab(t, "delete-workspace-ownership")
	workspace, _ := wstore.DBMustGet[*waveobj.Workspace](ctx, workspaceId)
	foreignTab := &waveobj.Tab{OID: "delete-workspace-foreign-tab"}
	foreignWorkspace := &waveobj.Workspace{
		OID:    "delete-workspace-foreign-owner",
		TabIds: []string{foreignTab.OID},
	}
	for _, obj := range []waveobj.WaveObj{foreignTab, foreignWorkspace} {
		if err := wstore.DBInsert(ctx, obj); err != nil {
			t.Fatalf("insert %T: %v", obj, err)
		}
	}
	for _, badId := range []string{foreignTab.OID, "delete-workspace-missing-tab"} {
		workspace, _ = wstore.DBMustGet[*waveobj.Workspace](ctx, workspaceId)
		workspace.TabIds = []string{terminalTabId, badId}
		if err := wstore.DBUpdate(ctx, workspace); err != nil {
			t.Fatalf("inject bad reference: %v", err)
		}
		if _, _, err := DeleteWorkspace(ctx, workspaceId, true); err == nil {
			t.Fatalf("DeleteWorkspace accepted bad Tab reference %s", badId)
		}
		if persisted, _ := wstore.DBGet[*waveobj.Workspace](ctx, workspaceId); persisted == nil {
			t.Fatalf("rejected DeleteWorkspace deleted target workspace")
		}
		if persisted, _ := wstore.DBGet[*waveobj.Workspace](ctx, foreignWorkspace.OID); persisted == nil {
			t.Fatalf("rejected DeleteWorkspace damaged foreign workspace")
		}
		if persisted, _ := wstore.DBGet[*waveobj.Tab](ctx, foreignTab.OID); persisted == nil {
			t.Fatalf("rejected DeleteWorkspace deleted foreign Tab")
		}
	}
}

func TestDeleteBlockRecursiveRejectsFinalTerminalBlockWithoutPartialWrite(t *testing.T) {
	ctx, workspaceId, terminalTabId := setupRegisteredTerminalTab(t, "delete-final-block")
	tabBefore, _ := wstore.DBMustGet[*waveobj.Tab](ctx, terminalTabId)
	blockId := tabBefore.BlockIds[0]
	blockBefore, _ := wstore.DBMustGet[*waveobj.Block](ctx, blockId)

	if err := DeleteBlock(ctx, blockId, true); err == nil {
		t.Fatalf("DeleteBlock recursive accepted final registered Terminal block")
	}
	workspace, _ := wstore.DBMustGet[*waveobj.Workspace](ctx, workspaceId)
	if !reflect.DeepEqual(workspace.TabIds, []string{terminalTabId}) ||
		!reflect.DeepEqual(workspace.TerminalTabIds, []string{terminalTabId}) {
		t.Fatalf("rejected DeleteBlock changed inventory: %#v", workspace)
	}
	tabAfter, _ := wstore.DBMustGet[*waveobj.Tab](ctx, terminalTabId)
	blockAfter, _ := wstore.DBMustGet[*waveobj.Block](ctx, blockId)
	if !reflect.DeepEqual(tabAfter, tabBefore) || !reflect.DeepEqual(blockAfter, blockBefore) {
		t.Fatalf("rejected DeleteBlock partially mutated Terminal")
	}
}

func TestDeleteBlockNonRecursiveRejectsFinalTerminalBlockWithoutPartialWrite(t *testing.T) {
	ctx, workspaceId, terminalTabId := setupRegisteredTerminalTab(t, "delete-final-block-nonrecursive")
	tabBefore, _ := wstore.DBMustGet[*waveobj.Tab](ctx, terminalTabId)
	blockId := tabBefore.BlockIds[0]
	blockBefore, _ := wstore.DBMustGet[*waveobj.Block](ctx, blockId)

	if err := DeleteBlock(ctx, blockId, false); err == nil {
		t.Fatalf("DeleteBlock non-recursive accepted final registered Terminal block")
	}
	workspace, _ := wstore.DBMustGet[*waveobj.Workspace](ctx, workspaceId)
	tabAfter, _ := wstore.DBMustGet[*waveobj.Tab](ctx, terminalTabId)
	blockAfter, _ := wstore.DBMustGet[*waveobj.Block](ctx, blockId)
	if !reflect.DeepEqual(workspace.TabIds, []string{terminalTabId}) ||
		!reflect.DeepEqual(workspace.TerminalTabIds, []string{terminalTabId}) ||
		!reflect.DeepEqual(tabAfter, tabBefore) ||
		!reflect.DeepEqual(blockAfter, blockBefore) {
		t.Fatalf("rejected non-recursive DeleteBlock partially mutated Terminal")
	}
	if size := terminalRootDeleteLocks.size(); size != 0 {
		t.Fatalf("rejected final root deletion left %d lock entries", size)
	}
}

func TestDeleteBlockNonRecursiveKeepsChildAndLegacySemantics(t *testing.T) {
	t.Run("terminal child", func(t *testing.T) {
		ctx, _, terminalTabId := setupRegisteredTerminalTab(t, "delete-terminal-child")
		tab, _ := wstore.DBMustGet[*waveobj.Tab](ctx, terminalTabId)
		root, _ := wstore.DBMustGet[*waveobj.Block](ctx, tab.BlockIds[0])
		child := &waveobj.Block{
			OID:        "delete-terminal-child-block",
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
		if err := DeleteBlock(ctx, child.OID, false); err != nil {
			t.Fatalf("DeleteBlock rejected non-final Terminal child: %v", err)
		}
		if persisted, _ := wstore.DBGet[*waveobj.Block](ctx, child.OID); persisted != nil {
			t.Fatalf("Terminal child survived delete")
		}
	})

	t.Run("legacy root", func(t *testing.T) {
		ctx := setupWorkspaceTestWStore(t)
		block := &waveobj.Block{
			OID:        "delete-legacy-root-block",
			ParentORef: waveobj.MakeORef(waveobj.OType_Tab, "delete-legacy-root-tab").String(),
			Meta:       waveobj.MetaMapType{waveobj.MetaKey_View: "web"},
		}
		tab := &waveobj.Tab{OID: "delete-legacy-root-tab", BlockIds: []string{block.OID}}
		workspace := &waveobj.Workspace{OID: "delete-legacy-root-workspace", TabIds: []string{tab.OID}}
		for _, obj := range []waveobj.WaveObj{workspace, tab, block} {
			if err := wstore.DBInsert(ctx, obj); err != nil {
				t.Fatalf("insert %T: %v", obj, err)
			}
		}
		if err := DeleteBlock(ctx, block.OID, false); err != nil {
			t.Fatalf("DeleteBlock changed legacy semantics: %v", err)
		}
		if persisted, _ := wstore.DBGet[*waveobj.Block](ctx, block.OID); persisted != nil {
			t.Fatalf("legacy block survived delete")
		}
	})
}

func TestConcurrentTerminalRootDeletesNeverEmptyRegisteredTab(t *testing.T) {
	ctx, _, tabId := setupRegisteredTerminalTab(t, "concurrent-root-delete")
	tab, _ := wstore.DBMustGet[*waveobj.Tab](ctx, tabId)
	second := &waveobj.Block{
		OID:        uuid.NewString(),
		ParentORef: waveobj.MakeORef(waveobj.OType_Tab, tabId).String(),
		Meta:       waveobj.MetaMapType{waveobj.MetaKey_View: "term"},
	}
	if err := wstore.DBInsert(ctx, second); err != nil {
		t.Fatalf("insert second root: %v", err)
	}
	tab.BlockIds = append(tab.BlockIds, second.OID)
	if err := wstore.DBUpdate(ctx, tab); err != nil {
		t.Fatalf("attach second root: %v", err)
	}
	assertConcurrentTerminalRootDelete(t, ctx, tabId, append([]string(nil), tab.BlockIds...))
}

func TestConcurrentTerminalRootSubtreeDeletesHaveNoPartialChildren(t *testing.T) {
	ctx, _, tabId := setupRegisteredTerminalTab(t, "concurrent-subtree-delete")
	tab, _ := wstore.DBMustGet[*waveobj.Tab](ctx, tabId)
	first, _ := wstore.DBMustGet[*waveobj.Block](ctx, tab.BlockIds[0])
	second := &waveobj.Block{
		OID:        uuid.NewString(),
		ParentORef: waveobj.MakeORef(waveobj.OType_Tab, tabId).String(),
		Meta:       waveobj.MetaMapType{waveobj.MetaKey_View: "term"},
	}
	for _, root := range []*waveobj.Block{first, second} {
		child := &waveobj.Block{
			OID:        uuid.NewString(),
			ParentORef: waveobj.MakeORef(waveobj.OType_Block, root.OID).String(),
			Meta:       waveobj.MetaMapType{waveobj.MetaKey_View: "term"},
		}
		root.SubBlockIds = []string{child.OID}
		if root.OID == second.OID {
			if err := wstore.DBInsert(ctx, root); err != nil {
				t.Fatalf("insert second root: %v", err)
			}
		}
		if err := wstore.DBInsert(ctx, child); err != nil {
			t.Fatalf("insert child: %v", err)
		}
		if err := wstore.DBUpdate(ctx, root); err != nil {
			t.Fatalf("attach child: %v", err)
		}
	}
	tab.BlockIds = []string{first.OID, second.OID}
	if err := wstore.DBUpdate(ctx, tab); err != nil {
		t.Fatalf("attach roots: %v", err)
	}

	assertConcurrentTerminalRootDelete(t, ctx, tabId, append([]string(nil), tab.BlockIds...))
	reloadedTab, _ := wstore.DBMustGet[*waveobj.Tab](ctx, tabId)
	remainingRoot, _ := wstore.DBMustGet[*waveobj.Block](ctx, reloadedTab.BlockIds[0])
	if len(remainingRoot.SubBlockIds) != 1 {
		t.Fatalf("remaining root lost child: %#v", remainingRoot)
	}
	if child, _ := wstore.DBGet[*waveobj.Block](ctx, remainingRoot.SubBlockIds[0]); child == nil {
		t.Fatalf("remaining root child was partially deleted")
	}
}

func assertConcurrentTerminalRootDelete(t *testing.T, ctx context.Context, tabId string, rootIds []string) {
	t.Helper()
	start := make(chan struct{})
	errs := make(chan error, len(rootIds))
	var wg sync.WaitGroup
	for _, blockId := range rootIds {
		wg.Add(1)
		go func() {
			defer wg.Done()
			<-start
			errs <- DeleteBlock(ctx, blockId, false)
		}()
	}
	close(start)
	wg.Wait()
	close(errs)
	successes := 0
	for err := range errs {
		if err == nil {
			successes++
		}
	}
	if successes != 1 {
		t.Fatalf("concurrent root deletes succeeded %d times, want exactly 1", successes)
	}
	tab, _ := wstore.DBMustGet[*waveobj.Tab](ctx, tabId)
	if len(tab.BlockIds) != 1 {
		t.Fatalf("concurrent root deletes left %d roots: %#v", len(tab.BlockIds), tab.BlockIds)
	}
	if remaining, _ := wstore.DBGet[*waveobj.Block](ctx, tab.BlockIds[0]); remaining == nil {
		t.Fatalf("remaining root %s was deleted", tab.BlockIds[0])
	}
}

func TestTerminalRootDeleteKeyedLockReleasesWaitersAndEntries(t *testing.T) {
	pool := newRefCountKeyedMutex()
	releaseFirst := pool.lock("tab")
	waiterStarted := make(chan struct{})
	waiterAcquired := make(chan struct{})
	waiterDone := make(chan struct{})
	go func() {
		close(waiterStarted)
		releaseWaiter := pool.lock("tab")
		close(waiterAcquired)
		releaseWaiter()
		close(waiterDone)
	}()
	<-waiterStarted
	select {
	case <-waiterAcquired:
		t.Fatalf("waiter acquired keyed lock before owner released it")
	case <-time.After(20 * time.Millisecond):
	}
	releaseFirst()
	<-waiterDone
	if size := pool.size(); size != 0 {
		t.Fatalf("keyed lock pool retained %d entries after waiter release", size)
	}
	releaseReuse := pool.lock("tab")
	releaseReuse()
	if size := pool.size(); size != 0 {
		t.Fatalf("keyed lock pool retained reused entry")
	}
}

func TestTerminalRootDeleteReleasesTabLockBeforeCleanup(t *testing.T) {
	ctx, _, tabId := setupRegisteredTerminalTab(t, "delete-lock-cleanup")
	tab, _ := wstore.DBMustGet[*waveobj.Tab](ctx, tabId)
	for range 2 {
		root := &waveobj.Block{
			OID:        uuid.NewString(),
			ParentORef: waveobj.MakeORef(waveobj.OType_Tab, tabId).String(),
			Meta:       waveobj.MetaMapType{waveobj.MetaKey_View: "term"},
		}
		if err := wstore.DBInsert(ctx, root); err != nil {
			t.Fatalf("insert root: %v", err)
		}
		tab.BlockIds = append(tab.BlockIds, root.OID)
	}
	if err := wstore.DBUpdate(ctx, tab); err != nil {
		t.Fatalf("attach roots: %v", err)
	}

	origDeleteTerminalZone := deleteTerminalZone
	var cleanupCalls atomic.Int32
	firstCleanupEntered := make(chan struct{})
	unblockFirstCleanup := make(chan struct{})
	deleteTerminalZone = func(context.Context, string) error {
		if cleanupCalls.Add(1) == 1 {
			close(firstCleanupEntered)
			<-unblockFirstCleanup
		}
		return nil
	}
	defer func() { deleteTerminalZone = origDeleteTerminalZone }()

	firstDone := make(chan error, 1)
	go func() {
		firstDone <- DeleteBlock(ctx, tab.BlockIds[0], false)
	}()
	<-firstCleanupEntered

	secondDone := make(chan error, 1)
	go func() {
		secondDone <- DeleteBlock(ctx, tab.BlockIds[1], false)
	}()
	select {
	case err := <-secondDone:
		if err != nil {
			t.Fatalf("second delete failed while first cleanup blocked: %v", err)
		}
	case <-time.After(time.Second):
		t.Fatalf("second delete remained blocked behind first after-commit cleanup")
	}
	close(unblockFirstCleanup)
	if err := <-firstDone; err != nil {
		t.Fatalf("first delete failed: %v", err)
	}
	if size := terminalRootDeleteLocks.size(); size != 0 {
		t.Fatalf("Terminal root delete lock pool leaked %d entries", size)
	}
}

func TestTerminalDomainPrimitivePortableLayoutValidatesBeforeFirstWrite(t *testing.T) {
	ctx := setupWorkspaceTestWStore(t)
	workspace := &waveobj.Workspace{OID: "terminal-portable-workspace", TabIds: []string{}}
	if err := wstore.DBInsert(ctx, workspace); err != nil {
		t.Fatalf("insert workspace: %v", err)
	}
	tab, err := createTabObj(ctx, workspace.OID, "Portable", nil)
	if err != nil {
		t.Fatalf("create tab: %v", err)
	}
	layout := PortableLayout{
		{IndexArr: []int{0}, BlockDef: &waveobj.BlockDef{
			Meta: waveobj.MetaMapType{waveobj.MetaKey_View: "termblocks"},
		}},
		{IndexArr: []int{1}, BlockDef: &waveobj.BlockDef{
			Meta: waveobj.MetaMapType{waveobj.MetaKey_View: "web"},
		}},
	}

	err = wstore.WithTx(ctx, func(tx *wstore.TxWrap) error {
		return applyTerminalPortableLayoutInTx(tx, tab.OID, layout)
	})
	if err == nil {
		t.Fatalf("applyTerminalPortableLayoutInTx accepted incompatible portable layout")
	}
	unchangedTab, err := wstore.DBMustGet[*waveobj.Tab](ctx, tab.OID)
	if err != nil {
		t.Fatalf("get unchanged tab: %v", err)
	}
	if len(unchangedTab.BlockIds) != 0 {
		t.Fatalf("portable validation left partial blocks: %#v", unchangedTab.BlockIds)
	}
	layoutState, err := wstore.DBMustGet[*waveobj.LayoutState](ctx, tab.LayoutState)
	if err != nil {
		t.Fatalf("get unchanged layout state: %v", err)
	}
	if layoutState.PendingBackendActions != nil {
		t.Fatalf("portable validation left partial layout actions: %#v", *layoutState.PendingBackendActions)
	}
}

func TestTerminalDomainPrimitiveCallerRollbackLeavesNoPartialObjects(t *testing.T) {
	ctx := setupWorkspaceTestWStore(t)
	workspace := &waveobj.Workspace{OID: "terminal-rollback-workspace", TabIds: []string{}}
	if err := wstore.DBInsert(ctx, workspace); err != nil {
		t.Fatalf("insert workspace: %v", err)
	}

	var tabId string
	err := wstore.WithTx(ctx, func(tx *wstore.TxWrap) error {
		var createErr error
		tabId, createErr = CreateTerminalTabInTx(tx, workspace.OID, TerminalTabCreateOpts{Name: "Rollback"})
		if createErr != nil {
			return createErr
		}
		return fmt.Errorf("reject navigation mutation")
	})
	if err == nil {
		t.Fatalf("caller transaction unexpectedly committed")
	}
	if tabId == "" {
		t.Fatalf("CreateTerminalTabInTx did not create a tab before caller rollback")
	}
	if tab, _ := wstore.DBGet[*waveobj.Tab](ctx, tabId); tab != nil {
		t.Fatalf("rolled back terminal tab still exists")
	}
	updatedWorkspace, err := wstore.DBMustGet[*waveobj.Workspace](ctx, workspace.OID)
	if err != nil {
		t.Fatalf("get rolled back workspace: %v", err)
	}
	if len(updatedWorkspace.TabIds) != 0 {
		t.Fatalf("rollback left workspace membership: %#v", updatedWorkspace.TabIds)
	}
	layouts, err := wstore.DBGetAllObjsByType[*waveobj.LayoutState](ctx, waveobj.OType_LayoutState)
	if err != nil {
		t.Fatalf("list layouts: %v", err)
	}
	if len(layouts) != 0 {
		t.Fatalf("rollback left layout objects: %#v", layouts)
	}
	blocks, err := wstore.DBGetAllObjsByType[*waveobj.Block](ctx, waveobj.OType_Block)
	if err != nil {
		t.Fatalf("list blocks: %v", err)
	}
	if len(blocks) != 0 {
		t.Fatalf("rollback left block objects: %#v", blocks)
	}
}

func TestTerminalDomainPrimitiveDeleteRollbackPreservesFilestore(t *testing.T) {
	ctx := setupWorkspaceTestWStore(t)
	if err := filestore.InitFilestore(); err != nil {
		t.Fatalf("InitFilestore: %v", err)
	}
	workspace := &waveobj.Workspace{OID: "terminal-delete-rollback-workspace", TabIds: []string{}}
	if err := wstore.DBInsert(ctx, workspace); err != nil {
		t.Fatalf("insert workspace: %v", err)
	}
	var tabId string
	err := wstore.WithTx(ctx, func(tx *wstore.TxWrap) error {
		var err error
		tabId, err = CreateTerminalTabInTx(tx, workspace.OID, TerminalTabCreateOpts{Name: "Rollback delete"})
		return err
	})
	if err != nil {
		t.Fatalf("CreateTerminalTabInTx: %v", err)
	}
	tab, err := wstore.DBMustGet[*waveobj.Tab](ctx, tabId)
	if err != nil {
		t.Fatalf("get terminal tab: %v", err)
	}
	blockId := tab.BlockIds[0]
	child, err := createSubBlockObj(ctx, blockId, &waveobj.BlockDef{
		Meta: waveobj.MetaMapType{waveobj.MetaKey_View: TerminalViewTerm},
	})
	if err != nil {
		t.Fatalf("create terminal subblock: %v", err)
	}
	if err := filestore.WFS.MakeFile(ctx, blockId, "state", nil, wshrpc.FileOpts{}); err != nil {
		t.Fatalf("make terminal block file: %v", err)
	}
	if err := filestore.WFS.MakeFile(ctx, child.OID, "state", nil, wshrpc.FileOpts{}); err != nil {
		t.Fatalf("make terminal subblock file: %v", err)
	}
	origDeleteTerminalZone := deleteTerminalZone
	deletedZones := make(chan string, 8)
	deleteTerminalZone = func(ctx context.Context, zoneId string) error {
		deletedZones <- zoneId
		return origDeleteTerminalZone(ctx, zoneId)
	}
	defer func() {
		deleteTerminalZone = origDeleteTerminalZone
	}()

	err = wstore.WithTx(ctx, func(tx *wstore.TxWrap) error {
		if err := DeleteTerminalTabInTx(tx, workspace.OID, tabId); err != nil {
			return err
		}
		return fmt.Errorf("reject deletion")
	})
	if err == nil {
		t.Fatalf("caller transaction unexpectedly committed")
	}
	select {
	case zoneId := <-deletedZones:
		t.Fatalf("rollback ran filestore cleanup for zone %s", zoneId)
	default:
	}

	if _, err := filestore.WFS.Stat(ctx, blockId, "state"); err != nil {
		if errors.Is(err, fs.ErrNotExist) {
			t.Fatalf("rollback deleted terminal filestore state")
		}
		t.Fatalf("stat terminal block file: %v", err)
	}
	if _, err := filestore.WFS.Stat(ctx, child.OID, "state"); err != nil {
		t.Fatalf("rollback deleted terminal subblock filestore state: %v", err)
	}
	if restoredTab, _ := wstore.DBGet[*waveobj.Tab](ctx, tabId); restoredTab == nil {
		t.Fatalf("rollback did not restore terminal tab")
	}

	err = wstore.WithTx(ctx, func(tx *wstore.TxWrap) error {
		return DeleteTerminalTabInTx(tx, workspace.OID, tabId)
	})
	if err != nil {
		t.Fatalf("commit terminal deletion: %v", err)
	}
	gotZones := make(map[string]bool)
	for len(deletedZones) > 0 {
		gotZones[<-deletedZones] = true
	}
	for _, zoneId := range []string{blockId, child.OID, tabId, tab.LayoutState} {
		if !gotZones[zoneId] {
			t.Fatalf("committed cleanup omitted zone %s; got %#v", zoneId, gotZones)
		}
	}
	if _, err := filestore.WFS.Stat(ctx, blockId, "state"); !errors.Is(err, fs.ErrNotExist) {
		t.Fatalf("committed cleanup left terminal filestore state: %v", err)
	}
	if _, err := filestore.WFS.Stat(ctx, child.OID, "state"); !errors.Is(err, fs.ErrNotExist) {
		t.Fatalf("committed cleanup left terminal subblock filestore state: %v", err)
	}
}

func TestTerminalDomainCreateBlockBoundary(t *testing.T) {
	for _, view := range []string{TerminalViewTerm, TerminalViewTermBlocks} {
		t.Run("terminal accepts "+view, func(t *testing.T) {
			ctx, _, tabId := setupRegisteredTerminalTab(t, "create-accept-"+view)
			if _, err := CreateBlock(ctx, tabId, terminalDomainBlockDef(view), &waveobj.RuntimeOpts{}); err != nil {
				t.Fatalf("CreateBlock(%q): %v", view, err)
			}
		})
	}
	for _, view := range []string{"web", "preview", "codeeditor", "agent", "unknown-view"} {
		t.Run("terminal rejects "+view, func(t *testing.T) {
			ctx, _, tabId := setupRegisteredTerminalTab(t, "create-reject-"+view)
			before := terminalDomainMutationSnapshot(t, ctx, tabId)
			if _, err := CreateBlock(ctx, tabId, terminalDomainBlockDef(view), &waveobj.RuntimeOpts{}); err == nil {
				t.Fatalf("CreateBlock accepted %q in Terminal tab", view)
			}
			assertTerminalDomainMutationSnapshot(t, ctx, tabId, before)
		})
	}
}

func TestTerminalDomainCreateSubBlockBoundary(t *testing.T) {
	for _, view := range []string{TerminalViewTerm, TerminalViewTermBlocks} {
		t.Run("terminal accepts "+view, func(t *testing.T) {
			ctx, _, tabId := setupRegisteredTerminalTab(t, "sub-accept-"+view)
			tab, _ := wstore.DBMustGet[*waveobj.Tab](ctx, tabId)
			if _, err := CreateSubBlock(ctx, tab.BlockIds[0], terminalDomainBlockDef(view)); err != nil {
				t.Fatalf("CreateSubBlock(%q): %v", view, err)
			}
		})
	}
	for _, view := range []string{"web", "preview", "codeeditor", "agent", "unknown-view"} {
		t.Run("terminal rejects "+view, func(t *testing.T) {
			ctx, _, tabId := setupRegisteredTerminalTab(t, "sub-reject-"+view)
			tab, _ := wstore.DBMustGet[*waveobj.Tab](ctx, tabId)
			parentId := tab.BlockIds[0]
			before := terminalDomainMutationSnapshot(t, ctx, tabId)
			if _, err := CreateSubBlock(ctx, parentId, terminalDomainBlockDef(view)); err == nil {
				t.Fatalf("CreateSubBlock accepted %q in Terminal tab", view)
			}
			assertTerminalDomainMutationSnapshot(t, ctx, tabId, before)
		})
	}
}

func TestTerminalDomainPortableLayoutBoundary(t *testing.T) {
	for _, view := range []string{TerminalViewTerm, TerminalViewTermBlocks} {
		t.Run("terminal accepts "+view, func(t *testing.T) {
			ctx, _, tabId := setupRegisteredTerminalTab(t, "portable-accept-"+view)
			layout := PortableLayout{{IndexArr: []int{0}, BlockDef: terminalDomainBlockDef(view), Focused: true}}
			if err := ApplyPortableLayout(ctx, tabId, layout, false); err != nil {
				t.Fatalf("ApplyPortableLayout(%q): %v", view, err)
			}
		})
	}
	for _, view := range []string{"web", "preview", "codeeditor", "agent", "unknown-view"} {
		t.Run("terminal rejects "+view, func(t *testing.T) {
			ctx, _, tabId := setupRegisteredTerminalTab(t, "portable-reject-"+view)
			before := terminalDomainMutationSnapshot(t, ctx, tabId)
			layout := PortableLayout{
				{IndexArr: []int{0}, BlockDef: terminalDomainBlockDef(TerminalViewTerm)},
				{IndexArr: []int{1}, BlockDef: terminalDomainBlockDef(view)},
			}
			if err := ApplyPortableLayout(ctx, tabId, layout, false); err == nil {
				t.Fatalf("ApplyPortableLayout accepted %q in Terminal tab", view)
			}
			assertTerminalDomainMutationSnapshot(t, ctx, tabId, before)
		})
	}
}

func TestTerminalDomainLegacyWritesRemainUnchanged(t *testing.T) {
	for _, view := range []string{"web", "preview", "codeeditor", "agent", "unknown-view"} {
		t.Run(view, func(t *testing.T) {
			ctx := setupWorkspaceTestWStore(t)
			workspace := &waveobj.Workspace{OID: "legacy-" + view, TabIds: []string{}}
			if err := wstore.DBInsert(ctx, workspace); err != nil {
				t.Fatalf("insert workspace: %v", err)
			}
			tab, err := createTabObj(ctx, workspace.OID, "Legacy", nil)
			if err != nil {
				t.Fatalf("create legacy tab: %v", err)
			}
			root, err := CreateBlock(ctx, tab.OID, terminalDomainBlockDef(view), &waveobj.RuntimeOpts{})
			if err != nil {
				t.Fatalf("legacy CreateBlock(%q): %v", view, err)
			}
			if _, err := CreateSubBlock(ctx, root.OID, terminalDomainBlockDef(view)); err != nil {
				t.Fatalf("legacy CreateSubBlock(%q): %v", view, err)
			}
			if err := ApplyPortableLayout(ctx, tab.OID, PortableLayout{
				{IndexArr: []int{0}, BlockDef: terminalDomainBlockDef(view)},
			}, false); err != nil {
				t.Fatalf("legacy ApplyPortableLayout(%q): %v", view, err)
			}
		})
	}
}

type terminalDomainSnapshot struct {
	tabBlockIds  []string
	blockCount   int
	layoutAction int
}

func setupRegisteredTerminalTab(t *testing.T, id string) (context.Context, string, string) {
	t.Helper()
	ctx := setupWorkspaceTestWStore(t)
	workspace := &waveobj.Workspace{
		OID:              "workspace-" + id,
		TabDomainVersion: waveobj.CurrentTabDomainVersion,
		TabIds:           []string{},
		TerminalTabIds:   []string{},
	}
	if err := wstore.DBInsert(ctx, workspace); err != nil {
		t.Fatalf("insert workspace: %v", err)
	}
	var tabId string
	if err := wstore.WithTx(ctx, func(tx *wstore.TxWrap) error {
		var err error
		tabId, err = CreateTerminalTabInTx(tx, workspace.OID, TerminalTabCreateOpts{Name: "Terminal"})
		return err
	}); err != nil {
		t.Fatalf("CreateTerminalTabInTx: %v", err)
	}
	workspace, err := wstore.DBMustGet[*waveobj.Workspace](ctx, workspace.OID)
	if err != nil {
		t.Fatalf("reload workspace: %v", err)
	}
	workspace.TerminalTabIds = []string{tabId}
	if err := wstore.DBUpdate(ctx, workspace); err != nil {
		t.Fatalf("register Terminal tab: %v", err)
	}
	return ctx, workspace.OID, tabId
}

func terminalDomainBlockDef(view string) *waveobj.BlockDef {
	return &waveobj.BlockDef{Meta: waveobj.MetaMapType{waveobj.MetaKey_View: view}}
}

func terminalDomainMutationSnapshot(t *testing.T, ctx context.Context, tabId string) terminalDomainSnapshot {
	t.Helper()
	tab, err := wstore.DBMustGet[*waveobj.Tab](ctx, tabId)
	if err != nil {
		t.Fatalf("get tab: %v", err)
	}
	blocks, err := wstore.DBGetAllObjsByType[*waveobj.Block](ctx, waveobj.OType_Block)
	if err != nil {
		t.Fatalf("list blocks: %v", err)
	}
	layoutState, err := wstore.DBMustGet[*waveobj.LayoutState](ctx, tab.LayoutState)
	if err != nil {
		t.Fatalf("get layout: %v", err)
	}
	actionCount := 0
	if layoutState.PendingBackendActions != nil {
		actionCount = len(*layoutState.PendingBackendActions)
	}
	return terminalDomainSnapshot{
		tabBlockIds:  append([]string{}, tab.BlockIds...),
		blockCount:   len(blocks),
		layoutAction: actionCount,
	}
}

func assertTerminalDomainMutationSnapshot(t *testing.T, ctx context.Context, tabId string, want terminalDomainSnapshot) {
	t.Helper()
	got := terminalDomainMutationSnapshot(t, ctx, tabId)
	if !reflect.DeepEqual(got.tabBlockIds, want.tabBlockIds) ||
		got.blockCount != want.blockCount ||
		got.layoutAction != want.layoutAction {
		t.Fatalf("rejected mutation changed domain: got %#v, want %#v", got, want)
	}
}
