// Copyright 2026, s-zx
// SPDX-License-Identifier: Apache-2.0

package cmdblock

import (
	"context"
	"os"
	"path/filepath"
	"testing"

	"github.com/s-zx/crest/pkg/wavebase"
	"github.com/s-zx/crest/pkg/wstore"
)

func TestTailLinesReturnsLastN(t *testing.T) {
	full := []byte("line1\nline2\nline3\nline4\nline5\n")
	got := tailLines(full, 2, 0)
	want := "line4\nline5\n"
	if string(got) != want {
		t.Fatalf("tailLines maxLines=2 = %q, want %q", got, want)
	}
}

func TestTailLinesRespectsMaxBytes(t *testing.T) {
	full := []byte("aaaa\nbbbb\ncccc\n")
	got := tailLines(full, 0, 5)
	if len(got) > 5 {
		t.Fatalf("tailLines maxBytes=5 returned %d bytes: %q", len(got), got)
	}
}

func TestMakeDirectCommandStartedCreatesRunningRow(t *testing.T) {
	ctx := setupCmdBlockStoreTest(t)

	row, err := MakeDirectCommandStarted(ctx, "block-direct-1", "pi", "/repo", 0, "")
	if err != nil {
		t.Fatalf("MakeDirectCommandStarted returned error: %v", err)
	}

	if row.State != StateRunning {
		t.Fatalf("state = %q, want %q", row.State, StateRunning)
	}
	if row.Cmd == nil || *row.Cmd != "pi" {
		t.Fatalf("cmd = %#v, want pi", row.Cmd)
	}
	if row.Cwd == nil || *row.Cwd != "/repo" {
		t.Fatalf("cwd = %#v, want /repo", row.Cwd)
	}
	if row.OutputStartOffset == nil || *row.OutputStartOffset != 0 {
		t.Fatalf("output start offset = %#v, want 0", row.OutputStartOffset)
	}

	rows, err := GetByBlockID(ctx, "block-direct-1", 0)
	if err != nil {
		t.Fatalf("GetByBlockID returned error: %v", err)
	}
	if len(rows) != 1 || rows[0].OID != row.OID {
		t.Fatalf("stored rows = %#v, want one row %q", rows, row.OID)
	}
}

func setupCmdBlockStoreTest(t *testing.T) context.Context {
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
