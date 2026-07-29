// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

package workspaceservice

import (
	"context"
	"fmt"
	"path/filepath"
	"strings"
	"time"

	"github.com/s-zx/crest/pkg/waveobj"
	"github.com/s-zx/crest/pkg/wstore"
)

type SaveWorkspaceAgentStateData struct {
	WorkspaceId      string                      `json:"workspaceid"`
	ExpectedRevision int64                       `json:"expectedrevision"`
	State            waveobj.WorkspaceAgentState `json:"state"`
}

type WorkspaceAgentStateCheckpoint struct {
	WorkspaceId string                      `json:"workspaceid"`
	Revision    int64                       `json:"revision"`
	State       waveobj.WorkspaceAgentState `json:"state"`
}

func (svc *WorkspaceService) SaveWorkspaceAgentState(
	ctx context.Context,
	data SaveWorkspaceAgentStateData,
) (*WorkspaceAgentStateCheckpoint, error) {
	if data.WorkspaceId == "" {
		return nil, fmt.Errorf("workspaceid is required")
	}
	if data.ExpectedRevision < 0 {
		return nil, fmt.Errorf("expectedrevision cannot be negative")
	}

	state := cloneWorkspaceAgentState(data.State)
	ctx = waveobj.ContextWithUpdates(ctx)
	var checkpoint *WorkspaceAgentStateCheckpoint
	err := wstore.WithTx(ctx, func(tx *wstore.TxWrap) error {
		workspace, err := loadTerminalDomainWorkspace(tx, data.WorkspaceId)
		if err != nil {
			return err
		}
		if workspace.AgentRevision != data.ExpectedRevision {
			return fmt.Errorf(
				"%w: expected Agent revision %d, current revision %d",
				ErrStaleWorkspaceCheckpoint,
				data.ExpectedRevision,
				workspace.AgentRevision,
			)
		}
		if err := validateWorkspaceAgentState(state); err != nil {
			return err
		}
		workspace.AgentState = cloneWorkspaceAgentState(state)
		workspace.AgentRevision++
		if err := wstore.DBUpdate(tx.Context(), workspace); err != nil {
			return err
		}
		checkpoint = makeWorkspaceAgentCheckpoint(workspace)
		return nil
	})
	if err != nil {
		return nil, err
	}
	sendWorkspaceUpdates(waveobj.ContextGetUpdatesRtn(ctx))
	return checkpoint, nil
}

func makeWorkspaceAgentCheckpoint(workspace *waveobj.Workspace) *WorkspaceAgentStateCheckpoint {
	return &WorkspaceAgentStateCheckpoint{
		WorkspaceId: workspace.OID,
		Revision:    workspace.AgentRevision,
		State:       cloneWorkspaceAgentState(workspace.AgentState),
	}
}

func cloneWorkspaceAgentState(state waveobj.WorkspaceAgentState) waveobj.WorkspaceAgentState {
	if state.ActiveSession != nil {
		session := *state.ActiveSession
		state.ActiveSession = &session
	}
	if state.Selection != nil {
		selection := *state.Selection
		state.Selection = &selection
	}
	return state
}

func validateWorkspaceAgentState(state waveobj.WorkspaceAgentState) error {
	if state.ActiveSession != nil {
		if strings.TrimSpace(state.ActiveSession.Id) == "" {
			return fmt.Errorf("active session id is required")
		}
		if _, err := time.Parse(time.RFC3339, state.ActiveSession.CreatedAt); err != nil {
			return fmt.Errorf("active session createdAt must be RFC3339: %w", err)
		}
		if !filepath.IsAbs(state.ActiveSession.Cwd) {
			return fmt.Errorf("active session cwd must be absolute")
		}
		if !filepath.IsAbs(state.ActiveSession.Path) {
			return fmt.Errorf("active session path must be absolute")
		}
	}
	if state.Selection != nil {
		if strings.TrimSpace(state.Selection.Provider) == "" {
			return fmt.Errorf("selection provider is required")
		}
		if strings.TrimSpace(state.Selection.Model) == "" {
			return fmt.Errorf("selection model is required")
		}
		switch state.Selection.Reasoning {
		case "", "low", "medium", "high":
		default:
			return fmt.Errorf("selection reasoning %q is invalid", state.Selection.Reasoning)
		}
	}
	return nil
}
