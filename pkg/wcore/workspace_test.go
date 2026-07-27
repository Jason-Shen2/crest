// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

package wcore

import (
	"context"
	"os"
	"path/filepath"
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

func TestDefaultTabNameAndMetaAutoNameUsesEmptyPersistentName(t *testing.T) {
	tabName, meta, err := defaultTabNameAndMeta(context.Background(), "workspace-1", "")
	if err != nil {
		t.Fatalf("defaultTabNameAndMeta returned error: %v", err)
	}
	if tabName != "" {
		t.Fatalf("tabName = %q, want empty persistent name", tabName)
	}
	if meta == nil || meta[waveobj.MetaKey_TabAutoName] != true {
		t.Fatalf("meta = %#v, want tab auto-name marker", meta)
	}
}

func TestCreateWorkspaceWritesDir(t *testing.T) {
	ctx := setupWorkspaceTestWStore(t)
	ws, err := CreateWorkspace(ctx, "", "", "", true, false, "/tmp/my-project")
	if err != nil {
		t.Fatalf("CreateWorkspace returned error: %v", err)
	}
	if got := ws.Meta.GetString(waveobj.MetaKey_WorkspaceDir, ""); got != "/tmp/my-project" {
		t.Fatalf("workspace:dir = %q, want %q", got, "/tmp/my-project")
	}
	if ws.Name != "my-project" {
		t.Fatalf("Name = %q, want basename %q", ws.Name, "my-project")
	}
}

func TestCreateWorkspaceExplicitNameOverridesBasename(t *testing.T) {
	ctx := setupWorkspaceTestWStore(t)
	ws, err := CreateWorkspace(ctx, "Custom", "", "", true, false, "/tmp/my-project")
	if err != nil {
		t.Fatalf("CreateWorkspace returned error: %v", err)
	}
	if ws.Name != "Custom" {
		t.Fatalf("Name = %q, want %q", ws.Name, "Custom")
	}
}

func TestDiscardDirlessWorkspaces(t *testing.T) {
	ctx := setupWorkspaceTestWStore(t)
	withDir, err := CreateWorkspace(ctx, "", "", "", true, false, "/tmp/proj")
	if err != nil {
		t.Fatalf("create with dir: %v", err)
	}
	dirless, err := CreateWorkspace(ctx, "", "", "", true, false, "")
	if err != nil {
		t.Fatalf("create dirless: %v", err)
	}
	// Bare workspace: no dir AND empty Name/Icon/Color, so ListWorkspaces
	// would hide it. It must still be discarded.
	bare, err := CreateWorkspace(ctx, "", "", "", false, false, "")
	if err != nil {
		t.Fatalf("create bare: %v", err)
	}
	if err := DiscardDirlessWorkspaces(ctx); err != nil {
		t.Fatalf("discard: %v", err)
	}
	all, err := wstore.DBGetAllObjsByType[*waveobj.Workspace](ctx, waveobj.OType_Workspace)
	if err != nil {
		t.Fatalf("list all: %v", err)
	}
	ids := map[string]bool{}
	for _, w := range all {
		ids[w.OID] = true
	}
	if !ids[withDir.OID] {
		t.Fatalf("dir-backed workspace was wrongly discarded")
	}
	if ids[dirless.OID] {
		t.Fatalf("dirless workspace was not discarded")
	}
	if ids[bare.OID] {
		t.Fatalf("bare dirless workspace (no name/icon/color) was not discarded")
	}
}

func setupWorkspaceTestWStore(t *testing.T) context.Context {
	t.Helper()
	wavebase.DataHome_VarCache = t.TempDir()
	wavebase.ConfigHome_VarCache = t.TempDir()
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
