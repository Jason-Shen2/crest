// Copyright 2026, s-zx
// SPDX-License-Identifier: Apache-2.0

package blockcontroller

import (
	"context"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/s-zx/crest/pkg/cmdblock"
	"github.com/s-zx/crest/pkg/filestore"
	"github.com/s-zx/crest/pkg/wavebase"
	"github.com/s-zx/crest/pkg/wavejwt"
	"github.com/s-zx/crest/pkg/waveobj"
	"github.com/s-zx/crest/pkg/wstore"
)

func TestCmdControllerResyncCreatesCmdBlockRow(t *testing.T) {
	ctx := setupShellControllerTest(t)
	blockID := "block-direct-resync"
	cmd := "printf crest-direct-row"
	cwd := t.TempDir()

	if err := wstore.DBInsert(ctx, &waveobj.Block{
		OID:        blockID,
		ParentORef: waveobj.MakeORef(waveobj.OType_Tab, "tab-direct-resync").String(),
		Meta: waveobj.MetaMapType{
			waveobj.MetaKey_View:          "term",
			waveobj.MetaKey_Controller:    BlockController_Cmd,
			waveobj.MetaKey_Cmd:           cmd,
			waveobj.MetaKey_CmdCwd:        cwd,
			waveobj.MetaKey_CmdRunOnce:    true,
			waveobj.MetaKey_CmdRunOnStart: true,
		},
	}); err != nil {
		t.Fatalf("DBInsert block returned error: %v", err)
	}
	t.Cleanup(func() {
		DestroyBlockController(blockID)
	})

	err := ResyncController(ctx, "tab-direct-resync", blockID, &waveobj.RuntimeOpts{
		TermSize: waveobj.TermSize{Rows: 24, Cols: 80},
	}, false)
	if err != nil {
		t.Fatalf("ResyncController returned error: %v", err)
	}

	immediateRows, err := cmdblock.GetByBlockID(ctx, blockID, 0)
	if err != nil {
		t.Fatalf("GetByBlockID immediately after resync returned error: %v", err)
	}
	if len(immediateRows) == 0 {
		t.Fatalf("expected cmdblock row immediately after ResyncController returned")
	}

	rows := waitForCmdBlockRows(t, ctx, blockID)
	if len(rows) != 1 {
		t.Fatalf("rows len = %d, want 1: %#v", len(rows), rows)
	}
	row := rows[0]
	if row.Cmd == nil || *row.Cmd != cmd {
		t.Fatalf("row cmd = %#v, want %q", row.Cmd, cmd)
	}
	if row.Cwd == nil || *row.Cwd != cwd {
		t.Fatalf("row cwd = %#v, want %q", row.Cwd, cwd)
	}
	if row.State != cmdblock.StateDone {
		t.Fatalf("row state = %q, want %q", row.State, cmdblock.StateDone)
	}
	if row.ExitCode == nil || *row.ExitCode != 0 {
		t.Fatalf("row exit code = %#v, want 0", row.ExitCode)
	}

	output, err := cmdblock.GetOutputData(ctx, row.OID)
	if err != nil {
		t.Fatalf("GetOutputData returned error: %v", err)
	}
	if !strings.Contains(string(output), "crest-direct-row") {
		t.Fatalf("output = %q, want crest-direct-row", output)
	}
}

func TestMakeSwapTokenSetsBlocksModeByDefault(t *testing.T) {
	ctx := setupShellControllerTest(t)

	defaultToken := makeSwapToken(ctx, ctx, "block-direct-resync", waveobj.MetaMapType{}, "", "zsh")
	if defaultToken.Env["WAVETERM_BLOCKS"] != "1" {
		t.Fatalf("default WAVETERM_BLOCKS = %q, want 1", defaultToken.Env["WAVETERM_BLOCKS"])
	}

	disabledToken := makeSwapToken(ctx, ctx, "block-direct-resync", waveobj.MetaMapType{
		waveobj.MetaKey_TermBlocks: false,
	}, "", "zsh")
	if _, ok := disabledToken.Env["WAVETERM_BLOCKS"]; ok {
		t.Fatalf("disabled token unexpectedly contains WAVETERM_BLOCKS")
	}
}

func waitForCmdBlockRows(t *testing.T, ctx context.Context, blockID string) []*cmdblock.CmdBlock {
	t.Helper()
	deadline := time.Now().Add(5 * time.Second)
	for time.Now().Before(deadline) {
		rows, err := cmdblock.GetByBlockID(ctx, blockID, 0)
		if err != nil {
			t.Fatalf("GetByBlockID returned error: %v", err)
		}
		if len(rows) > 0 && rows[0].State == cmdblock.StateDone {
			return rows
		}
		time.Sleep(25 * time.Millisecond)
	}
	rows, err := cmdblock.GetByBlockID(ctx, blockID, 0)
	if err != nil {
		t.Fatalf("GetByBlockID returned error: %v", err)
	}
	return rows
}

func setupShellControllerTest(t *testing.T) context.Context {
	t.Helper()
	wavebase.DataHome_VarCache = t.TempDir()
	wavebase.ConfigHome_VarCache = t.TempDir()
	if err := os.MkdirAll(wavebase.ConfigHome_VarCache, 0o700); err != nil {
		t.Fatalf("MkdirAll config dir returned error: %v", err)
	}
	if err := wavebase.EnsureWaveDBDir(); err != nil {
		t.Fatalf("EnsureWaveDBDir returned error: %v", err)
	}
	if err := os.MkdirAll(filepath.Join(wavebase.DataHome_VarCache, wavebase.WaveDBDir), 0o700); err != nil {
		t.Fatalf("MkdirAll wave db dir returned error: %v", err)
	}
	if err := wstore.InitWStore(); err != nil {
		t.Fatalf("InitWStore returned error: %v", err)
	}
	if err := filestore.InitFilestore(); err != nil {
		t.Fatalf("InitFilestore returned error: %v", err)
	}
	keyPair, err := wavejwt.GenerateKeyPair()
	if err != nil {
		t.Fatalf("GenerateKeyPair returned error: %v", err)
	}
	if err := wavejwt.SetPrivateKey(keyPair.PrivateKey); err != nil {
		t.Fatalf("SetPrivateKey returned error: %v", err)
	}
	if err := wavejwt.SetPublicKey(keyPair.PublicKey); err != nil {
		t.Fatalf("SetPublicKey returned error: %v", err)
	}
	if err := wstore.DBInsert(context.Background(), &waveobj.Workspace{
		OID:    "workspace-direct-resync",
		TabIds: []string{"tab-direct-resync"},
		Meta:   waveobj.MetaMapType{},
	}); err != nil {
		t.Fatalf("DBInsert workspace returned error: %v", err)
	}
	if err := wstore.DBInsert(context.Background(), &waveobj.Tab{
		OID:         "tab-direct-resync",
		LayoutState: "layout-direct-resync",
		BlockIds:    []string{"block-direct-resync"},
		Meta:        waveobj.MetaMapType{},
	}); err != nil {
		t.Fatalf("DBInsert tab returned error: %v", err)
	}
	return context.Background()
}
