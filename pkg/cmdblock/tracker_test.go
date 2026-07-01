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
