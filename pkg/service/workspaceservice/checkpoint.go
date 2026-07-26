// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

package workspaceservice

import (
	"context"
	"errors"
	"fmt"

	"github.com/s-zx/crest/pkg/panichandler"
	"github.com/s-zx/crest/pkg/tsgen/tsgenmeta"
	"github.com/s-zx/crest/pkg/waveobj"
	"github.com/s-zx/crest/pkg/wcore"
	"github.com/s-zx/crest/pkg/wps"
	"github.com/s-zx/crest/pkg/wshrpc"
	"github.com/s-zx/crest/pkg/wstore"
)

var ErrStaleWorkspaceCheckpoint = errors.New("stale workspace checkpoint")

const (
	SaveWorkspaceCheckpointStatusCommitted = wshrpc.WorkspaceCheckpointSaveStatusCommitted
	SaveWorkspaceCheckpointStatusConflict  = wshrpc.WorkspaceCheckpointSaveStatusConflict
	terminalBlockView                      = "term"
	terminalBlocksBlockView                = "termblocks"
)

type SaveWorkspaceCheckpointData struct {
	WorkspaceId         string                        `json:"workspaceid"`
	ExpectedRevision    int64                         `json:"expectedrevision"`
	ContentState        waveobj.WorkspaceContentState `json:"contentstate"`
	ActiveTerminalTabId string                        `json:"activeterminaltabid,omitempty"`
}

type WorkspaceCheckpoint struct {
	WorkspaceId         string                        `json:"workspaceid"`
	NavigationRevision  int64                         `json:"navigationrevision"`
	TerminalTabIds      []string                      `json:"terminaltabids"`
	ContentState        waveobj.WorkspaceContentState `json:"contentstate"`
	ActiveTerminalTabId string                        `json:"activeterminaltabid,omitempty"`
}

type SaveWorkspaceCheckpointResult struct {
	Status     string              `json:"status"`
	Checkpoint WorkspaceCheckpoint `json:"checkpoint"`
}

func (svc *WorkspaceService) SaveWorkspaceCheckpoint_Meta() tsgenmeta.MethodMeta {
	return tsgenmeta.MethodMeta{
		ArgNames: []string{"ctx", "data"},
	}
}

func (svc *WorkspaceService) ValidateWorkspaceTerminalTab_Meta() tsgenmeta.MethodMeta {
	return tsgenmeta.MethodMeta{
		ArgNames: []string{"workspaceId", "terminalTabId"},
	}
}

func (svc *WorkspaceService) ValidateWorkspaceTerminalTab(workspaceId string, terminalTabId string) (bool, error) {
	if workspaceId == "" || terminalTabId == "" {
		return false, nil
	}
	isMember := false
	err := wstore.WithTx(context.Background(), func(tx *wstore.TxWrap) error {
		workspace, err := wstore.DBMustGet[*waveobj.Workspace](tx.Context(), workspaceId)
		if err != nil {
			return err
		}
		if !containsString(workspace.TerminalTabIds, terminalTabId) {
			return nil
		}
		isMember = true
		return validateWorkspaceTerminalTab(tx.Context(), workspace, terminalTabId)
	})
	if err != nil {
		return false, err
	}
	if isMember {
		if err := wcore.RepairTerminalTabShellControllers(context.Background(), workspaceId, terminalTabId); err != nil {
			return false, err
		}
	}
	return isMember, nil
}

func (svc *WorkspaceService) SaveWorkspaceCheckpoint(ctx context.Context, data SaveWorkspaceCheckpointData) (*SaveWorkspaceCheckpointResult, error) {
	if data.WorkspaceId == "" {
		return nil, fmt.Errorf("workspaceid is required")
	}
	if data.ExpectedRevision < 0 {
		return nil, fmt.Errorf("expectedrevision must not be negative")
	}

	contentState := NormalizeWorkspaceContentState(data.ContentState, data.ActiveTerminalTabId)
	ctx = waveobj.ContextWithUpdates(ctx)
	var result *SaveWorkspaceCheckpointResult
	err := wstore.WithTx(ctx, func(tx *wstore.TxWrap) error {
		workspace, err := wstore.DBMustGet[*waveobj.Workspace](tx.Context(), data.WorkspaceId)
		if err != nil {
			return err
		}
		if data.ExpectedRevision != workspace.NavigationRevision {
			result = &SaveWorkspaceCheckpointResult{
				Status:     SaveWorkspaceCheckpointStatusConflict,
				Checkpoint: *makeWorkspaceCheckpoint(workspace),
			}
			return nil
		}
		if data.ActiveTerminalTabId != "" {
			if workspace.TabDomainVersion >= waveobj.CurrentTabDomainVersion && !containsString(workspace.TerminalTabIds, data.ActiveTerminalTabId) {
				return fmt.Errorf("terminal tab %q is not in workspace inventory", data.ActiveTerminalTabId)
			}
			if err := validateWorkspaceTerminalTab(tx.Context(), workspace, data.ActiveTerminalTabId); err != nil {
				return err
			}
		}
		workspace.ContentState = contentState
		workspace.ActiveTerminalTabId = data.ActiveTerminalTabId
		workspace.NavigationRevision++
		if err := wstore.DBUpdate(tx.Context(), workspace); err != nil {
			return err
		}
		result = &SaveWorkspaceCheckpointResult{
			Status:     SaveWorkspaceCheckpointStatusCommitted,
			Checkpoint: *makeWorkspaceCheckpoint(workspace),
		}
		return nil
	})
	if err != nil {
		return nil, fmt.Errorf("error saving workspace checkpoint: %w", err)
	}

	updates := waveobj.ContextGetUpdatesRtn(ctx)
	if result.Status == SaveWorkspaceCheckpointStatusConflict {
		return result, nil
	}
	go func() {
		defer func() {
			panichandler.PanicHandler("WorkspaceService:SaveWorkspaceCheckpoint:SendUpdateEvents", recover())
		}()
		wps.Broker.SendUpdateEvents(updates)
	}()
	return result, nil
}

func makeWorkspaceCheckpoint(workspace *waveobj.Workspace) *WorkspaceCheckpoint {
	return &WorkspaceCheckpoint{
		WorkspaceId:         workspace.OID,
		NavigationRevision:  workspace.NavigationRevision,
		TerminalTabIds:      append([]string{}, workspace.TerminalTabIds...),
		ContentState:        cloneWorkspaceContentState(workspace.ContentState),
		ActiveTerminalTabId: workspace.ActiveTerminalTabId,
	}
}

func cloneWorkspaceContentState(state waveobj.WorkspaceContentState) waveobj.WorkspaceContentState {
	state.TopTabs = append([]waveobj.TopTabDescriptor{}, state.TopTabs...)
	return state
}

func containsString(values []string, value string) bool {
	for _, candidate := range values {
		if candidate == value {
			return true
		}
	}
	return false
}

func validateWorkspaceTerminalTab(ctx context.Context, workspace *waveobj.Workspace, terminalTabId string) error {
	found := false
	for _, tabId := range workspace.TabIds {
		if tabId == terminalTabId {
			found = true
			break
		}
	}
	if !found {
		return fmt.Errorf("terminal tab %q does not belong to workspace %q", terminalTabId, workspace.OID)
	}

	tab, err := wstore.DBMustGet[*waveobj.Tab](ctx, terminalTabId)
	if err != nil {
		return fmt.Errorf("unable to load terminal tab %q: %w", terminalTabId, err)
	}
	if len(tab.BlockIds) == 0 {
		return fmt.Errorf("terminal tab %q has no terminal panes", terminalTabId)
	}
	visited := make(map[string]bool)
	for _, blockId := range tab.BlockIds {
		if err := validateTerminalBlockTree(ctx, terminalTabId, blockId, visited); err != nil {
			return err
		}
	}
	return nil
}

func validateTerminalBlockTree(ctx context.Context, terminalTabId string, blockId string, visited map[string]bool) error {
	if visited[blockId] {
		return nil
	}
	visited[blockId] = true
	block, err := wstore.DBMustGet[*waveobj.Block](ctx, blockId)
	if err != nil {
		return fmt.Errorf("unable to load terminal tab %q block %q: %w", terminalTabId, blockId, err)
	}
	view := block.Meta.GetString(waveobj.MetaKey_View, "")
	if view != terminalBlockView && view != terminalBlocksBlockView {
		return fmt.Errorf("tab %q contains non-terminal block %q", terminalTabId, blockId)
	}
	for _, subBlockId := range block.SubBlockIds {
		if err := validateTerminalBlockTree(ctx, terminalTabId, subBlockId, visited); err != nil {
			return err
		}
	}
	return nil
}
