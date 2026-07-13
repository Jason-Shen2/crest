// Copyright 2026, s-zx
// SPDX-License-Identifier: Apache-2.0

package cmdblock

import (
	"testing"
)

func TestTrackerAltScreenGetter(t *testing.T) {
	tr := MakeTracker("block-alt-1")
	if tr.AltScreen() {
		t.Fatalf("new tracker should not be in alt-screen")
	}
	// Simulate the PTY emitting the DECSET 1049 enter sequence.
	tr.detectAltScreen([]byte("\x1b[?1049h"))
	if !tr.AltScreen() {
		t.Fatalf("expected alt-screen true after enter seq")
	}
	tr.detectAltScreen([]byte("\x1b[?1049l"))
	if tr.AltScreen() {
		t.Fatalf("expected alt-screen false after exit seq")
	}
}

func TestTrackerRegistryLookup(t *testing.T) {
	tr := MakeTracker("block-reg-1")
	got := GetTracker("block-reg-1")
	if got != tr {
		t.Fatalf("GetTracker returned a different tracker instance")
	}
	if GetTracker("block-missing") != nil {
		t.Fatalf("GetTracker for unknown block should return nil")
	}
}

func TestTrackerStartDirectCommandCreatesRunningRow(t *testing.T) {
	ctx := setupCmdBlockStoreTest(t)
	tr := MakeTracker("block-direct-tracker")

	row, err := tr.StartDirectCommand(ctx, "pi", "/repo", "")
	if err != nil {
		t.Fatalf("StartDirectCommand returned error: %v", err)
	}

	if row.State != StateRunning {
		t.Fatalf("state = %q, want %q", row.State, StateRunning)
	}
	if tr.currentOID != row.OID {
		t.Fatalf("currentOID = %q, want %q", tr.currentOID, row.OID)
	}
	if tr.state != StateRunning {
		t.Fatalf("tracker state = %q, want %q", tr.state, StateRunning)
	}
}

func TestTrackerFinishRunningCommandMarksRowDone(t *testing.T) {
	ctx := setupCmdBlockStoreTest(t)
	tr := MakeTracker("block-direct-finish")
	row, err := tr.StartDirectCommand(ctx, "pi", "/repo", "")
	if err != nil {
		t.Fatalf("StartDirectCommand returned error: %v", err)
	}

	if err := tr.FinishRunningCommand(ctx, 0); err != nil {
		t.Fatalf("FinishRunningCommand returned error: %v", err)
	}

	rows, err := GetByBlockID(ctx, "block-direct-finish", 0)
	if err != nil {
		t.Fatalf("GetByBlockID returned error: %v", err)
	}
	if len(rows) != 1 || rows[0].OID != row.OID {
		t.Fatalf("rows = %#v, want one row %q", rows, row.OID)
	}
	if rows[0].State != StateDone {
		t.Fatalf("state = %q, want %q", rows[0].State, StateDone)
	}
	if rows[0].ExitCode == nil || *rows[0].ExitCode != 0 {
		t.Fatalf("exit code = %#v, want 0", rows[0].ExitCode)
	}
}
