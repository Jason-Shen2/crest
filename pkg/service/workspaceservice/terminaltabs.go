// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

package workspaceservice

import (
	"context"
	"fmt"

	"github.com/s-zx/crest/pkg/panichandler"
	"github.com/s-zx/crest/pkg/waveobj"
	"github.com/s-zx/crest/pkg/wcore"
	"github.com/s-zx/crest/pkg/wps"
	"github.com/s-zx/crest/pkg/wstore"
)

type TerminalTabCreateData struct {
	WorkspaceId      string `json:"workspaceid"`
	ExpectedRevision int64  `json:"expectedrevision"`
	Name             string `json:"name,omitempty"`
	Connection       string `json:"connection,omitempty"`
	Cwd              string `json:"cwd,omitempty"`
}

type TerminalTabRenameData struct {
	WorkspaceId   string `json:"workspaceid"`
	TerminalTabId string `json:"terminaltabid"`
	Name          string `json:"name"`
}

type TerminalTabMutationData struct {
	WorkspaceId      string `json:"workspaceid"`
	TerminalTabId    string `json:"terminaltabid"`
	ExpectedRevision int64  `json:"expectedrevision"`
}

type TerminalTabReorderData struct {
	WorkspaceId      string   `json:"workspaceid"`
	TerminalTabIds   []string `json:"terminaltabids"`
	ExpectedRevision int64    `json:"expectedrevision"`
}

func (svc *WorkspaceService) CreateTerminalTab(ctx context.Context, data TerminalTabCreateData) (*WorkspaceCheckpoint, error) {
	return mutateTerminalNavigation(ctx, data.WorkspaceId, data.ExpectedRevision, func(tx *wstore.TxWrap, workspace *waveobj.Workspace) error {
		tabId, err := wcore.CreateTerminalTabInTx(tx, workspace.OID, wcore.TerminalTabCreateOpts{
			Name: data.Name, Connection: data.Connection, Cwd: data.Cwd,
		})
		if err != nil {
			return err
		}
		workspace.TabIds = append(workspace.TabIds, tabId)
		workspace.TerminalTabIds = append(workspace.TerminalTabIds, tabId)
		workspace.ActiveTerminalTabId = tabId
		workspace.ContentState = NormalizeWorkspaceContentState(workspace.ContentState, tabId)
		workspace.ContentState.ActiveContent = waveobj.ActiveContent{Kind: waveobj.ActiveContentKindTerminal, TerminalTabId: tabId}
		return nil
	})
}

func (svc *WorkspaceService) RenameTerminalTab(ctx context.Context, data TerminalTabRenameData) error {
	if data.WorkspaceId == "" || data.TerminalTabId == "" {
		return fmt.Errorf("workspaceid and terminaltabid are required")
	}
	ctx = waveobj.ContextWithUpdates(ctx)
	err := wstore.WithTx(ctx, func(tx *wstore.TxWrap) error {
		workspace, err := loadTerminalDomainWorkspace(tx, data.WorkspaceId)
		if err != nil {
			return err
		}
		if !containsString(workspace.TerminalTabIds, data.TerminalTabId) {
			return fmt.Errorf("terminal tab %q is not in workspace inventory", data.TerminalTabId)
		}
		if err := wcore.ValidateTerminalTabMutation(tx, workspace.OID, data.TerminalTabId, nil); err != nil {
			return err
		}
		tab, err := wstore.DBMustGet[*waveobj.Tab](tx.Context(), data.TerminalTabId)
		if err != nil {
			return err
		}
		tab.Name = data.Name
		if tab.Meta == nil {
			tab.Meta = make(waveobj.MetaMapType)
		}
		tab.Meta[waveobj.MetaKey_TabAutoName] = false
		return wstore.DBUpdate(tx.Context(), tab)
	})
	if err != nil {
		return err
	}
	sendWorkspaceUpdates(waveobj.ContextGetUpdatesRtn(ctx))
	return nil
}

func (svc *WorkspaceService) CloseTerminalTab(ctx context.Context, data TerminalTabMutationData) (*WorkspaceCheckpoint, error) {
	return mutateTerminalNavigation(ctx, data.WorkspaceId, data.ExpectedRevision, func(tx *wstore.TxWrap, workspace *waveobj.Workspace) error {
		tabIndex := indexOfString(workspace.TerminalTabIds, data.TerminalTabId)
		if tabIndex == -1 {
			return fmt.Errorf("terminal tab %q is not in workspace inventory", data.TerminalTabId)
		}
		wasActive := workspace.ActiveTerminalTabId == data.TerminalTabId ||
			(workspace.ContentState.ActiveContent.Kind == waveobj.ActiveContentKindTerminal &&
				workspace.ContentState.ActiveContent.TerminalTabId == data.TerminalTabId)
		if err := wcore.DeleteTerminalTabInTx(tx, workspace.OID, data.TerminalTabId); err != nil {
			return err
		}
		workspace.TabIds = removeString(workspace.TabIds, data.TerminalTabId)
		workspace.TerminalTabIds = removeStringAt(workspace.TerminalTabIds, tabIndex)
		if wasActive {
			workspace.ActiveTerminalTabId = terminalNeighbor(workspace.TerminalTabIds, tabIndex)
		}
		workspace.ContentState = NormalizeWorkspaceContentState(workspace.ContentState, workspace.ActiveTerminalTabId)
		if wasActive && workspace.ActiveTerminalTabId != "" {
			workspace.ContentState.ActiveContent = waveobj.ActiveContent{
				Kind: waveobj.ActiveContentKindTerminal, TerminalTabId: workspace.ActiveTerminalTabId,
			}
		} else if wasActive {
			workspace.ContentState.ActiveContent = fallbackActiveContent(workspace.ContentState.LastActiveTopTabId, "")
		}
		return nil
	})
}

func (svc *WorkspaceService) ReorderTerminalTabs(ctx context.Context, data TerminalTabReorderData) (*WorkspaceCheckpoint, error) {
	return mutateTerminalNavigation(ctx, data.WorkspaceId, data.ExpectedRevision, func(tx *wstore.TxWrap, workspace *waveobj.Workspace) error {
		if !isExactPermutation(workspace.TerminalTabIds, data.TerminalTabIds) {
			return fmt.Errorf("terminaltabids must be an exact permutation of the current inventory")
		}
		for _, tabId := range data.TerminalTabIds {
			if err := wcore.ValidateTerminalTabMutation(tx, workspace.OID, tabId, nil); err != nil {
				return err
			}
		}
		workspace.TerminalTabIds = append([]string{}, data.TerminalTabIds...)
		workspace.ContentState = NormalizeWorkspaceContentState(workspace.ContentState, workspace.ActiveTerminalTabId)
		return nil
	})
}

func mutateTerminalNavigation(
	ctx context.Context,
	workspaceId string,
	expectedRevision int64,
	mutate func(tx *wstore.TxWrap, workspace *waveobj.Workspace) error,
) (*WorkspaceCheckpoint, error) {
	if workspaceId == "" {
		return nil, fmt.Errorf("workspaceid is required")
	}
	ctx = waveobj.ContextWithUpdates(ctx)
	var checkpoint *WorkspaceCheckpoint
	err := wstore.WithTx(ctx, func(tx *wstore.TxWrap) error {
		workspace, err := loadTerminalDomainWorkspace(tx, workspaceId)
		if err != nil {
			return err
		}
		if workspace.NavigationRevision != expectedRevision {
			return fmt.Errorf("%w: expected revision %d, current revision %d", ErrStaleWorkspaceCheckpoint, expectedRevision, workspace.NavigationRevision)
		}
		if err := mutate(tx, workspace); err != nil {
			return err
		}
		if !containsString(workspace.TerminalTabIds, workspace.ActiveTerminalTabId) {
			workspace.ActiveTerminalTabId = ""
		}
		workspace.ContentState = NormalizeWorkspaceContentState(workspace.ContentState, workspace.ActiveTerminalTabId)
		workspace.NavigationRevision++
		if err := wstore.DBUpdate(tx.Context(), workspace); err != nil {
			return err
		}
		checkpoint = makeWorkspaceCheckpoint(workspace)
		return nil
	})
	if err != nil {
		return nil, err
	}
	sendWorkspaceUpdates(waveobj.ContextGetUpdatesRtn(ctx))
	return checkpoint, nil
}

func loadTerminalDomainWorkspace(tx *wstore.TxWrap, workspaceId string) (*waveobj.Workspace, error) {
	workspace, err := wstore.DBMustGet[*waveobj.Workspace](tx.Context(), workspaceId)
	if err != nil {
		return nil, err
	}
	if workspace.TabDomainVersion != waveobj.CurrentTabDomainVersion {
		return nil, fmt.Errorf("workspace %q does not use the Terminal tab domain", workspaceId)
	}
	return workspace, nil
}

func isExactPermutation(current []string, proposed []string) bool {
	if len(current) != len(proposed) {
		return false
	}
	remaining := make(map[string]int, len(current))
	for _, id := range current {
		remaining[id]++
	}
	for _, id := range proposed {
		if remaining[id] == 0 {
			return false
		}
		remaining[id]--
	}
	return true
}

func indexOfString(values []string, value string) int {
	for index, candidate := range values {
		if candidate == value {
			return index
		}
	}
	return -1
}

func removeStringAt(values []string, index int) []string {
	result := append([]string{}, values[:index]...)
	return append(result, values[index+1:]...)
}

func removeString(values []string, value string) []string {
	index := indexOfString(values, value)
	if index == -1 {
		return append([]string{}, values...)
	}
	return removeStringAt(values, index)
}

func terminalNeighbor(values []string, removedIndex int) string {
	if len(values) == 0 {
		return ""
	}
	index := removedIndex - 1
	if index < 0 {
		index = 0
	}
	if index >= len(values) {
		index = len(values) - 1
	}
	return values[index]
}

func sendWorkspaceUpdates(updates waveobj.UpdatesRtnType) {
	go func() {
		defer func() {
			panichandler.PanicHandler("WorkspaceService:TerminalTabs:SendUpdateEvents", recover())
		}()
		wps.Broker.SendUpdateEvents(updates)
	}()
}
