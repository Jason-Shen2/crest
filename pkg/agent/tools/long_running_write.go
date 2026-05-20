// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0
//
// long_running_write — send input to a background shell block.
// Structure derived from warp:
//   crates/ai/src/agent/action/mod.rs:61-65   (WriteToLongRunningShellCommand)
//   crates/ai/src/agent/action/mod.rs:762-812 (AIAgentPtyWriteMode + decorate_bytes)
// Warp is © 2020-2026 Denver Technologies, Inc., MIT licensed.
//
// Strict port of warp's three-mode write contract:
//   raw   — bytes pass through unchanged.  Use for raw escape sequences
//           (arrows, function keys) or when you've pre-formatted input.
//   line  — wrap with SOH (\x01, "beginning of line" for readline /
//           prompt-toolkit) and LF (\x0a, submit) so editors / shells
//           treat the payload as one entered line.
//   block — wrap with bracketed-paste markers (\x1b[200~ ... \x1b[201~)
//           so the target shell pastes the bytes literally instead of
//           interpreting them as keystrokes.  Warp gates this on
//           `is_bracketed_paste_enabled`; crest v1 always wraps —
//           shells without bracketed-paste support will show the
//           markers as literal text, which is recoverable noise rather
//           than data loss.
//
// Pair with shell_exec(background:true) — block_id is the handle.
// All three modes are auto-approved unless an engine rule overrides.

package tools

import (
	"fmt"
	"strings"

	"github.com/s-zx/crest/pkg/aiusechat/uctypes"
	"github.com/s-zx/crest/pkg/blockcontroller"
	"github.com/s-zx/crest/pkg/util/utilfn"
)

const (
	lrWriteModeRaw   = "raw"
	lrWriteModeLine  = "line"
	lrWriteModeBlock = "block"

	// Max stdin payload we'll forward in one call.  Beyond this the
	// agent should chunk — the controller's input pipe has its own
	// buffering and dumping multi-MB blobs into a TTY input stream
	// rarely works the way the model expects.
	lrWriteMaxInputBytes = 16 * 1024

	// Bracketed-paste sequences for Block mode.  Mirror warp's
	// `escape_sequences::BRACKETED_PASTE_START / END` constants.
	lrWriteBracketedPasteStart = "\x1b[200~"
	lrWriteBracketedPasteEnd   = "\x1b[201~"
	// SOH (^A) — readline / prompt-toolkit "go to beginning of line".
	lrWriteSOH byte = 0x01
	// LF — line submit on POSIX.  Crest doesn't currently switch
	// between LF and CR per host platform; the controller normalises
	// well-formed line endings on the server side.
	lrWriteLF byte = 0x0a
)

type longRunningWriteInput struct {
	BlockID string `json:"block_id"`
	Input   string `json:"input"`
	Mode    string `json:"mode,omitempty"`
}

type longRunningWriteOutput struct {
	BlockID string `json:"block_id"`
	Mode    string `json:"mode"`
	Bytes   int    `json:"bytes"`
}

// LongRunningWrite sends bytes to a background shell block. The mode
// selects byte decoration matching warp's `AIAgentPtyWriteMode`.
// Approval is inherited from the engine decider — no built-in
// always-gate; control-style operations (killing a process) are not
// part of this tool's surface (warp's WriteToLongRunningShellCommand
// doesn't carry signals either).
func LongRunningWrite(approval func(any) string) uctypes.ToolDefinition {
	return uctypes.ToolDefinition{
		Name:        "long_running_write",
		DisplayName: "Long-Running Write",
		Description: "Send bytes to a background shell command (started via shell_exec with background:true). Three modes: raw (bytes through), line (wraps with SOH + LF so editors / shells submit as a line), block (bracketed-paste wrap so shells paste literally). Strict mirror of warp's AIAgentPtyWriteMode.",
		ToolLogName: "agent:long_running_write",
		Prompt: `long_running_write: Drive a background shell block by writing to its PTY.
- mode (default "raw"): selects how bytes are framed before delivery.
  - "raw"   — bytes pass through verbatim.  Use for arrow keys, function keys, raw escape sequences.
  - "line"  — wraps payload with SOH (^A) + LF.  Use for typing into readline/prompt-toolkit shells (python -i, node) so the editor treats the bytes as one entered line.
  - "block" — wraps payload with bracketed-paste markers.  Use for pasting multi-line input into a shell that supports bracketed paste so it doesn't interpret each line as a command.
- For interactive REPLs (python -i, node), one line-mode call per logical input.  Don't dump large scripts; write a file and run it.
- This tool does NOT send signals.  Killing a process started by the agent is a user-side action; the agent can yield control via transfer_to_user instead.`,
		InputSchema: map[string]any{
			"type": "object",
			"properties": map[string]any{
				"block_id": map[string]any{
					"type":        "string",
					"description": "Block id returned by a prior shell_exec background:true call.",
				},
				"input": map[string]any{
					"type":        "string",
					"description": "Bytes to send. UTF-8 strings only — for binary input pass through raw mode after pre-encoding.",
				},
				"mode": map[string]any{
					"type":        "string",
					"enum":        []string{lrWriteModeRaw, lrWriteModeLine, lrWriteModeBlock},
					"default":     lrWriteModeRaw,
					"description": "raw → bytes through; line → SOH + bytes + LF; block → bracketed-paste wrap.",
				},
			},
			"required":             []string{"block_id", "input"},
			"additionalProperties": false,
		},
		ToolApproval: approval,
		ToolAnyCallback: func(input any, _ *uctypes.UIMessageDataToolUse) (any, error) {
			parsed, err := parseLongRunningWriteInput(input)
			if err != nil {
				return nil, err
			}
			payload := decorateLongRunningWriteBytes(parsed.Mode, parsed.Input)
			if err := blockcontroller.SendInput(parsed.BlockID, &blockcontroller.BlockInputUnion{
				InputData: payload,
			}); err != nil {
				return nil, fmt.Errorf("send input: %w", err)
			}
			return &longRunningWriteOutput{
				BlockID: parsed.BlockID,
				Mode:    parsed.Mode,
				Bytes:   len(payload),
			}, nil
		},
		ToolCallDesc: func(input any, output any, _ *uctypes.UIMessageDataToolUse) string {
			parsed, err := parseLongRunningWriteInput(input)
			if err != nil {
				return fmt.Sprintf("long_running_write (invalid: %v)", err)
			}
			if out, ok := output.(*longRunningWriteOutput); ok && output != nil {
				return fmt.Sprintf("wrote %d bytes to %s (%s mode)", out.Bytes, parsed.BlockID, parsed.Mode)
			}
			return fmt.Sprintf("writing %d bytes to %s (%s mode)", len(parsed.Input), parsed.BlockID, parsed.Mode)
		},
	}
}

// decorateLongRunningWriteBytes — strict port of warp's
// `AIAgentPtyWriteMode::decorate_bytes` (`action/mod.rs:770-812`).
// Crest's Block-mode wrap is unconditional today (warp checks
// `is_bracketed_paste_enabled` first); see file-level comment for
// the rationale.
func decorateLongRunningWriteBytes(mode, input string) []byte {
	switch mode {
	case lrWriteModeLine:
		out := make([]byte, 0, len(input)+2)
		out = append(out, lrWriteSOH)
		out = append(out, []byte(input)...)
		out = append(out, lrWriteLF)
		return out
	case lrWriteModeBlock:
		out := make([]byte, 0, len(input)+len(lrWriteBracketedPasteStart)+len(lrWriteBracketedPasteEnd))
		out = append(out, []byte(lrWriteBracketedPasteStart)...)
		out = append(out, []byte(input)...)
		out = append(out, []byte(lrWriteBracketedPasteEnd)...)
		return out
	default: // raw
		return []byte(input)
	}
}

func parseLongRunningWriteInput(input any) (*longRunningWriteInput, error) {
	params := &longRunningWriteInput{}
	if input == nil {
		return nil, fmt.Errorf("input is required")
	}
	if err := utilfn.ReUnmarshal(params, input); err != nil {
		return nil, fmt.Errorf("invalid input: %w", err)
	}
	params.BlockID = strings.TrimSpace(params.BlockID)
	if params.BlockID == "" {
		return nil, fmt.Errorf("block_id is required")
	}
	if params.Input == "" {
		return nil, fmt.Errorf("input is required")
	}
	if len(params.Input) > lrWriteMaxInputBytes {
		return nil, fmt.Errorf("input exceeds %d bytes; write a file and run it instead", lrWriteMaxInputBytes)
	}
	mode := strings.ToLower(strings.TrimSpace(params.Mode))
	if mode == "" {
		mode = lrWriteModeRaw
	}
	switch mode {
	case lrWriteModeRaw, lrWriteModeLine, lrWriteModeBlock:
		params.Mode = mode
	default:
		return nil, fmt.Errorf("mode %q is not supported (use %q, %q, or %q)",
			params.Mode, lrWriteModeRaw, lrWriteModeLine, lrWriteModeBlock)
	}
	return params, nil
}
