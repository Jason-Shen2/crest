// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

package workspaceservice

import (
	"context"
	"errors"
	"reflect"
	"strings"
	"testing"

	"github.com/s-zx/crest/pkg/waveobj"
	"github.com/s-zx/crest/pkg/wstore"
)

func TestWorkspaceAgentStateEmptyOnNewWorkspace(t *testing.T) {
	ctx := setupCheckpointTestWStore(t)
	workspace := insertTerminalDomainWorkspace(t, ctx, "agent-state-empty")

	reloaded, err := wstore.DBMustGet[*waveobj.Workspace](ctx, workspace.OID)
	if err != nil {
		t.Fatalf("load workspace: %v", err)
	}
	if reloaded.AgentRevision != 0 || !reflect.DeepEqual(reloaded.AgentState, waveobj.WorkspaceAgentState{}) {
		t.Fatalf("initial Agent state = %#v at revision %d", reloaded.AgentState, reloaded.AgentRevision)
	}
}

func TestWorkspaceAgentStateSaveUsesExactRevisionAndDeepCopies(t *testing.T) {
	ctx := setupCheckpointTestWStore(t)
	svc := &WorkspaceService{}
	workspace := insertTerminalDomainWorkspace(t, ctx, "agent-state-save")
	state := populatedAgentState()

	checkpoint, err := svc.SaveWorkspaceAgentState(ctx, SaveWorkspaceAgentStateData{
		WorkspaceId: workspace.OID, ExpectedRevision: 0, State: state,
	})
	if err != nil {
		t.Fatalf("SaveWorkspaceAgentState: %v", err)
	}
	if checkpoint.WorkspaceId != workspace.OID || checkpoint.Revision != 1 || !reflect.DeepEqual(checkpoint.State, state) {
		t.Fatalf("checkpoint = %#v", checkpoint)
	}
	persisted := mustGetAgentWorkspace(t, ctx, workspace.OID)
	if persisted.NavigationRevision != 0 || persisted.AgentRevision != 1 || !reflect.DeepEqual(persisted.AgentState, state) {
		t.Fatalf("persisted workspace = %#v", persisted)
	}

	state.ActiveSession.Id = "mutated-input"
	state.Selection.Model = "mutated-input"
	checkpoint.State.ActiveSession.Path = "/mutated-checkpoint"
	checkpoint.State.Selection.Provider = "mutated-checkpoint"
	persisted = mustGetAgentWorkspace(t, ctx, workspace.OID)
	expected := populatedAgentState()
	if !reflect.DeepEqual(persisted.AgentState, expected) {
		t.Fatalf("persisted Agent state aliases caller or checkpoint: %#v", persisted.AgentState)
	}

	_, err = svc.SaveWorkspaceAgentState(ctx, SaveWorkspaceAgentStateData{
		WorkspaceId:      workspace.OID,
		ExpectedRevision: 0,
		State: waveobj.WorkspaceAgentState{
			Selection: &waveobj.AgentSelectionMeta{Model: "invalid-stale"},
		},
	})
	if !errors.Is(err, ErrStaleWorkspaceCheckpoint) {
		t.Fatalf("stale save error = %v", err)
	}
	persisted = mustGetAgentWorkspace(t, ctx, workspace.OID)
	if persisted.AgentRevision != 1 || !reflect.DeepEqual(persisted.AgentState, expected) {
		t.Fatalf("stale save partially wrote workspace: %#v", persisted)
	}
}

func TestWorkspaceAgentStateRejectsInvalidDescriptorsWithoutPartialWrites(t *testing.T) {
	tests := []struct {
		name  string
		state waveobj.WorkspaceAgentState
	}{
		{
			name: "session id",
			state: waveobj.WorkspaceAgentState{ActiveSession: &waveobj.AgentSessionMeta{
				CreatedAt: "2026-07-25T00:00:00Z", Cwd: "/tmp", Path: "/tmp/session.jsonl",
			}},
		},
		{
			name: "session created at",
			state: waveobj.WorkspaceAgentState{ActiveSession: &waveobj.AgentSessionMeta{
				Id: "session", Cwd: "/tmp", Path: "/tmp/session.jsonl",
			}},
		},
		{
			name: "session cwd",
			state: waveobj.WorkspaceAgentState{ActiveSession: &waveobj.AgentSessionMeta{
				Id: "session", CreatedAt: "2026-07-25T00:00:00Z", Path: "/tmp/session.jsonl",
			}},
		},
		{
			name: "session path",
			state: waveobj.WorkspaceAgentState{ActiveSession: &waveobj.AgentSessionMeta{
				Id: "session", CreatedAt: "2026-07-25T00:00:00Z", Cwd: "/tmp",
			}},
		},
		{
			name:  "selection provider",
			state: waveobj.WorkspaceAgentState{Selection: &waveobj.AgentSelectionMeta{Model: "model"}},
		},
		{
			name:  "selection model",
			state: waveobj.WorkspaceAgentState{Selection: &waveobj.AgentSelectionMeta{Provider: "provider"}},
		},
		{
			name: "selection reasoning",
			state: waveobj.WorkspaceAgentState{Selection: &waveobj.AgentSelectionMeta{
				Provider: "provider", Model: "model", Reasoning: "extreme",
			}},
		},
	}

	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			ctx := setupCheckpointTestWStore(t)
			svc := &WorkspaceService{}
			workspace := insertTerminalDomainWorkspace(t, ctx, "agent-state-invalid")

			if _, err := svc.SaveWorkspaceAgentState(ctx, SaveWorkspaceAgentStateData{
				WorkspaceId: workspace.OID, ExpectedRevision: 0, State: test.state,
			}); err == nil {
				t.Fatalf("SaveWorkspaceAgentState accepted %#v", test.state)
			}
			persisted := mustGetAgentWorkspace(t, ctx, workspace.OID)
			if persisted.AgentRevision != 0 || !reflect.DeepEqual(persisted.AgentState, waveobj.WorkspaceAgentState{}) {
				t.Fatalf("invalid save partially wrote workspace: %#v", persisted)
			}
		})
	}
}

func TestWorkspaceAgentStateRejectsMissingWorkspaceIdentity(t *testing.T) {
	ctx := setupCheckpointTestWStore(t)
	svc := &WorkspaceService{}

	if _, err := svc.SaveWorkspaceAgentState(ctx, SaveWorkspaceAgentStateData{}); err == nil {
		t.Fatal("SaveWorkspaceAgentState accepted empty workspaceid")
	}
	if _, err := svc.SaveWorkspaceAgentState(ctx, SaveWorkspaceAgentStateData{
		WorkspaceId: "missing", ExpectedRevision: 0,
	}); err == nil {
		t.Fatal("SaveWorkspaceAgentState accepted missing workspace")
	}
}

func TestWorkspaceAgentStateRejectsLegacyWorkspaceBeforeStateValidation(t *testing.T) {
	ctx := setupCheckpointTestWStore(t)
	svc := &WorkspaceService{}
	workspace := &waveobj.Workspace{
		OID:           "agent-state-legacy",
		AgentRevision: 4,
	}
	if err := wstore.DBInsert(ctx, workspace); err != nil {
		t.Fatalf("insert legacy workspace: %v", err)
	}

	_, err := svc.SaveWorkspaceAgentState(ctx, SaveWorkspaceAgentStateData{
		WorkspaceId:      workspace.OID,
		ExpectedRevision: 0,
		State: waveobj.WorkspaceAgentState{
			Selection: &waveobj.AgentSelectionMeta{Model: "invalid"},
		},
	})
	if err == nil || !strings.Contains(err.Error(), "does not use the Terminal tab domain") {
		t.Fatalf("legacy save error = %v", err)
	}
	persisted := mustGetAgentWorkspace(t, ctx, workspace.OID)
	if persisted.AgentRevision != 4 || !reflect.DeepEqual(persisted.AgentState, waveobj.WorkspaceAgentState{}) {
		t.Fatalf("legacy save partially wrote workspace: %#v", persisted)
	}
}

func populatedAgentState() waveobj.WorkspaceAgentState {
	return waveobj.WorkspaceAgentState{
		ActiveSession: &waveobj.AgentSessionMeta{
			Id:        "session-1",
			CreatedAt: "2026-07-25T00:00:00Z",
			Cwd:       "/tmp/project",
			Path:      "/tmp/project/session-1.jsonl",
		},
		Selection: &waveobj.AgentSelectionMeta{
			Provider:  "anthropic",
			Model:     "claude-sonnet",
			Reasoning: "high",
		},
	}
}

func mustGetAgentWorkspace(t *testing.T, ctx context.Context, workspaceId string) *waveobj.Workspace {
	t.Helper()
	workspace, err := wstore.DBMustGet[*waveobj.Workspace](ctx, workspaceId)
	if err != nil {
		t.Fatalf("load workspace: %v", err)
	}
	return workspace
}
