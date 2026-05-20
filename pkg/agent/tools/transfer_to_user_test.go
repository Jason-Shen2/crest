// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0
//
// Input-validation tests for transfer_to_user.  The runTransferToUser
// path needs a populated wstore + tab layout context — exercising
// that lives in interactive smoke, not here.

package tools

import (
	"strings"
	"testing"
)

func TestParseTransferToUserInput_HappyPath(t *testing.T) {
	in := map[string]any{
		"block_id": "block-123",
		"reason":   "needs the GitHub OTP",
	}
	out, err := parseTransferToUserInput(in)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if out.BlockID != "block-123" {
		t.Errorf("block_id = %q", out.BlockID)
	}
	if out.Reason != "needs the GitHub OTP" {
		t.Errorf("reason = %q", out.Reason)
	}
}

func TestParseTransferToUserInput_TrimsWhitespace(t *testing.T) {
	in := map[string]any{
		"block_id": "  block-123  ",
		"reason":   "  needs OTP  ",
	}
	out, err := parseTransferToUserInput(in)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if out.BlockID != "block-123" || out.Reason != "needs OTP" {
		t.Errorf("not trimmed: block_id=%q reason=%q", out.BlockID, out.Reason)
	}
}

func TestParseTransferToUserInput_Rejections(t *testing.T) {
	cases := []struct {
		name          string
		in            map[string]any
		wantErrSubstr string
	}{
		{
			name:          "no block_id",
			in:            map[string]any{"reason": "x"},
			wantErrSubstr: "block_id is required",
		},
		{
			name:          "blank block_id",
			in:            map[string]any{"block_id": "   ", "reason": "x"},
			wantErrSubstr: "block_id is required",
		},
		{
			name:          "no reason",
			in:            map[string]any{"block_id": "b"},
			wantErrSubstr: "reason is required",
		},
		{
			name:          "blank reason",
			in:            map[string]any{"block_id": "b", "reason": "   "},
			wantErrSubstr: "reason is required",
		},
		{
			name: "reason too long",
			in: map[string]any{
				"block_id": "b",
				"reason":   strings.Repeat("x", transferReasonMaxChars+1),
			},
			wantErrSubstr: "exceeds",
		},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			_, err := parseTransferToUserInput(tc.in)
			if err == nil {
				t.Fatal("expected error")
			}
			if !strings.Contains(err.Error(), tc.wantErrSubstr) {
				t.Errorf("error %q does not contain %q", err.Error(), tc.wantErrSubstr)
			}
		})
	}
}
