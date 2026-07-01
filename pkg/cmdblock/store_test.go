// Copyright 2026, s-zx
// SPDX-License-Identifier: Apache-2.0

package cmdblock

import "testing"

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
