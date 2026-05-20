// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0
//
// Input-validation tests for long_running_read + long_running_write.
// Runtime tests (actual block I/O, signal delivery) need a real PTY
// session and live in the interactive smoke matrix, not here.

package tools

import (
	"strings"
	"testing"

	"github.com/s-zx/crest/pkg/aiusechat/uctypes"
)

// ---------- long_running_read ----------

func TestParseLongRunningReadInput_HappyPath(t *testing.T) {
	in := map[string]any{
		"block_id":   "abc",
		"tail_bytes": 1024,
		"delay": map[string]any{
			"kind":        "duration",
			"duration_ms": 250,
		},
	}
	out, err := parseLongRunningReadInput(in)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if out.BlockID != "abc" {
		t.Errorf("block_id = %q, want %q", out.BlockID, "abc")
	}
	if out.TailBytes != 1024 {
		t.Errorf("tail_bytes = %d, want 1024", out.TailBytes)
	}
	if out.Delay == nil || out.Delay.Kind != shellCommandDelayKindDuration {
		t.Fatalf("delay kind = %+v", out.Delay)
	}
	if out.Delay.DurationMs != 250 {
		t.Errorf("delay.duration_ms = %d, want 250", out.Delay.DurationMs)
	}
}

func TestParseLongRunningReadInput_OnCompletionKind(t *testing.T) {
	in := map[string]any{
		"block_id": "abc",
		"delay":    map[string]any{"kind": "oncompletion"},
	}
	out, err := parseLongRunningReadInput(in)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if out.Delay == nil || out.Delay.Kind != shellCommandDelayKindOnCompletion {
		t.Errorf("delay = %+v, want oncompletion", out.Delay)
	}
	// duration_ms must be ignored / zero for on_completion
	if out.Delay.DurationMs != 0 {
		t.Errorf("duration_ms should be 0 on oncompletion, got %d", out.Delay.DurationMs)
	}
}

func TestParseLongRunningReadInput_DurationClamping(t *testing.T) {
	in := map[string]any{
		"block_id": "abc",
		"delay": map[string]any{
			"kind":        "duration",
			"duration_ms": 1_000_000, // → clamped
		},
	}
	out, err := parseLongRunningReadInput(in)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if out.Delay.DurationMs != lrReadMaxDurationDelayMs {
		t.Errorf("duration_ms clamped = %d, want %d", out.Delay.DurationMs, lrReadMaxDurationDelayMs)
	}
}

func TestParseLongRunningReadInput_DelayRejections(t *testing.T) {
	cases := []struct {
		name          string
		in            map[string]any
		wantErrSubstr string
	}{
		{
			name: "delay without kind",
			in: map[string]any{
				"block_id": "abc",
				"delay":    map[string]any{"duration_ms": 100},
			},
			wantErrSubstr: "delay.kind is required",
		},
		{
			name: "unsupported delay kind",
			in: map[string]any{
				"block_id": "abc",
				"delay":    map[string]any{"kind": "untilmoonrise"},
			},
			wantErrSubstr: "not supported",
		},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			_, err := parseLongRunningReadInput(tc.in)
			if err == nil {
				t.Fatal("expected error")
			}
			if !strings.Contains(err.Error(), tc.wantErrSubstr) {
				t.Errorf("error %q does not contain %q", err.Error(), tc.wantErrSubstr)
			}
		})
	}
}

func TestParseLongRunningReadInput_TailBytesDefault(t *testing.T) {
	in := map[string]any{
		"block_id":   "abc",
		"tail_bytes": 0,
	}
	out, err := parseLongRunningReadInput(in)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if out.TailBytes != lrReadDefaultTailBytes {
		t.Errorf("tail_bytes default = %d, want %d", out.TailBytes, lrReadDefaultTailBytes)
	}
}

func TestParseLongRunningReadInput_TailBytesUpperClamp(t *testing.T) {
	in := map[string]any{
		"block_id":   "abc",
		"tail_bytes": 1_000_000,
	}
	out, err := parseLongRunningReadInput(in)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if out.TailBytes != lrReadMaxTailBytes {
		t.Errorf("tail_bytes upper clamp = %d, want %d", out.TailBytes, lrReadMaxTailBytes)
	}
}

func TestParseLongRunningReadInput_BlockIdRequired(t *testing.T) {
	_, err := parseLongRunningReadInput(map[string]any{"tail_bytes": 100})
	if err == nil || !strings.Contains(err.Error(), "block_id is required") {
		t.Errorf("expected block_id-required error, got %v", err)
	}
}

// ---------- long_running_write ----------

func TestParseLongRunningWriteInput_DefaultsToRaw(t *testing.T) {
	in := map[string]any{
		"block_id": "abc",
		"input":    "echo hi",
	}
	out, err := parseLongRunningWriteInput(in)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if out.Mode != lrWriteModeRaw {
		t.Errorf("mode default = %q, want %q", out.Mode, lrWriteModeRaw)
	}
	if out.Input != "echo hi" {
		t.Errorf("input = %q", out.Input)
	}
}

func TestParseLongRunningWriteInput_AllModesAccepted(t *testing.T) {
	for _, mode := range []string{"raw", "line", "block", "RAW", "Line", "BLOCK"} {
		t.Run(mode, func(t *testing.T) {
			in := map[string]any{
				"block_id": "abc",
				"input":    "payload",
				"mode":     mode,
			}
			out, err := parseLongRunningWriteInput(in)
			if err != nil {
				t.Fatalf("mode %q: %v", mode, err)
			}
			want := strings.ToLower(mode)
			if out.Mode != want {
				t.Errorf("mode = %q, want %q (normalized)", out.Mode, want)
			}
		})
	}
}

func TestParseLongRunningWriteInput_Rejections(t *testing.T) {
	cases := []struct {
		name          string
		in            map[string]any
		wantErrSubstr string
	}{
		{
			name:          "no block_id",
			in:            map[string]any{"input": "x"},
			wantErrSubstr: "block_id is required",
		},
		{
			name:          "empty input",
			in:            map[string]any{"block_id": "b"},
			wantErrSubstr: "input is required",
		},
		{
			name:          "bad mode",
			in:            map[string]any{"block_id": "b", "input": "x", "mode": "stdin"},
			wantErrSubstr: "not supported",
		},
		{
			name: "input too large",
			in: map[string]any{
				"block_id": "b",
				"input":    strings.Repeat("x", lrWriteMaxInputBytes+1),
			},
			wantErrSubstr: "exceeds",
		},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			_, err := parseLongRunningWriteInput(tc.in)
			if err == nil {
				t.Fatal("expected error")
			}
			if !strings.Contains(err.Error(), tc.wantErrSubstr) {
				t.Errorf("error %q does not contain %q", err.Error(), tc.wantErrSubstr)
			}
		})
	}
}

func TestLongRunningWrite_ApprovalPassesThrough(t *testing.T) {
	// No more mode-specific approval override — all modes inherit
	// whatever the outer approval slot returns.
	td := LongRunningWrite(func(_ any) string { return uctypes.ApprovalAutoApproved })
	got := td.ToolApproval(map[string]any{
		"block_id": "b",
		"input":    "hi",
		"mode":     "line",
	})
	if got != uctypes.ApprovalAutoApproved {
		t.Errorf("approval = %q, want pass-through %q", got, uctypes.ApprovalAutoApproved)
	}
}

func TestDecorateLongRunningWriteBytes(t *testing.T) {
	cases := []struct {
		mode  string
		input string
		want  []byte
	}{
		{
			mode:  "raw",
			input: "hello",
			want:  []byte("hello"),
		},
		{
			// SOH (0x01) + bytes + LF (0x0a).  Mirrors warp's
			// AIAgentPtyWriteMode::Line decoration (action/mod.rs:782-797).
			mode:  "line",
			input: "py",
			want:  []byte{0x01, 'p', 'y', 0x0a},
		},
		{
			// \x1b[200~ + bytes + \x1b[201~ — bracketed paste.
			mode:  "block",
			input: "ab",
			want:  []byte("\x1b[200~ab\x1b[201~"),
		},
	}
	for _, tc := range cases {
		t.Run(tc.mode, func(t *testing.T) {
			got := decorateLongRunningWriteBytes(tc.mode, tc.input)
			if string(got) != string(tc.want) {
				t.Errorf("decorate(%q, %q) = %v, want %v",
					tc.mode, tc.input, got, tc.want)
			}
		})
	}
}
