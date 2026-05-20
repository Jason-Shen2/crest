// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0
//
// long_running_read — snapshot the current output of a background
// shell block.  Structure derived from warp's
//   crates/ai/src/agent/action/mod.rs:126-129 (ReadShellCommandOutput
//   action variant with optional delay).
// Warp is © 2020-2026 Denver Technologies, Inc., MIT licensed.
//
// Pair with `shell_exec` (background:true) — the block_id returned by
// that call is the handle for this tool.  Returns the tail of the
// block's output plus a running-or-done status flag so the agent can
// decide whether to keep polling or move on.

package tools

import (
	"context"
	"fmt"
	"time"

	"github.com/s-zx/crest/pkg/aiusechat/uctypes"
	"github.com/s-zx/crest/pkg/blockcontroller"
	"github.com/s-zx/crest/pkg/util/utilfn"
)

const (
	// TailBytes is a crest extension over warp's ReadShellCommandOutput
	// (`action/mod.rs:126-129`) — warp doesn't cap return size because
	// its agent runs against a renderer that streams output directly.
	// Crest's agent runs against an LLM context window, so an
	// unbounded read can wreck the next turn's budget.  Decision
	// recorded in docs/warp-agent-improvement-plan.md → "Audit
	// C-class decisions".
	lrReadDefaultTailBytes = 4096
	lrReadMaxTailBytes     = 32 * 1024
	// lrReadMaxDurationDelayMs caps the duration-mode `delay.duration_ms`
	// so the agent can't pin the tool loop with an absurd sleep.
	lrReadMaxDurationDelayMs = 10_000
	// lrReadMaxPollWaitMs caps the on_completion wait — most builds /
	// tests fit comfortably in 5 minutes.  Past this we return what's
	// in the buffer with is_running=true so the agent can decide
	// whether to keep polling.
	lrReadMaxPollWaitMs  = 5 * 60 * 1000
	lrReadPollIntervalMs = 250

	// shellCommandDelay kind discriminators.  Strict mirror of warp's
	// `ShellCommandDelay` enum (`action/mod.rs:756-760`): `Duration(d)`
	// → kind="duration" + duration_ms; `OnCompletion` → kind="oncompletion".
	shellCommandDelayKindDuration     = "duration"
	shellCommandDelayKindOnCompletion = "oncompletion"
)

// shellCommandDelay mirrors warp's `ShellCommandDelay` enum
// (`crates/ai/src/agent/action/mod.rs:756-760`).  The discriminator
// (`Kind`) selects between a fixed-duration sleep and a wait-until-
// process-exits poll.  `DurationMs` is meaningful only when
// Kind="duration".
type shellCommandDelay struct {
	Kind       string `json:"kind"`
	DurationMs int    `json:"duration_ms,omitempty"`
}

type longRunningReadInput struct {
	BlockID   string             `json:"block_id"`
	TailBytes int                `json:"tail_bytes,omitempty"`
	Delay     *shellCommandDelay `json:"delay,omitempty"`
}

type longRunningReadOutput struct {
	BlockID    string `json:"block_id"`
	Output     string `json:"output"`
	Truncated  bool   `json:"truncated"`
	IsRunning  bool   `json:"is_running"`
	ExitCode   int    `json:"exit_code"`
	TotalBytes int64  `json:"total_bytes"`
}

// LongRunningRead returns a snapshot reader for background shell blocks.
// Auto-approved — read-only.
func LongRunningRead(approval func(any) string) uctypes.ToolDefinition {
	return uctypes.ToolDefinition{
		Name:        "long_running_read",
		DisplayName: "Long-Running Read",
		Description: "Read the latest output from a background shell command (one started via shell_exec with background:true). Returns the tail of stdout/stderr plus a flag telling you whether the process is still running. Use this to watch a dev server boot, tail logs, or wait for a build to finish.",
		ToolLogName: "agent:long_running_read",
		Prompt: `long_running_read: Snapshot a background shell block's output.
- Use ONLY with block_ids returned by shell_exec when background:true. For finite commands the synchronous shell_exec already gives you the output; don't use this tool there.
- "delay" lets you wait before reading. Two modes:
  - {kind:"duration", duration_ms:N}  — fixed sleep, max 10000 ms.  Use to give a server a moment to print its bind address.
  - {kind:"oncompletion"}              — block until the underlying process exits.  Use to wait for a build/test to finish.
- The output is the *tail* (default 4KB, max 32KB). For longer-running output you may need to call repeatedly; the tail moves with the file.
- Check "is_running": when false the process exited and "exit_code" is meaningful. Stop polling once it's done.
- Parallel-safe.`,
		InputSchema: map[string]any{
			"type": "object",
			"properties": map[string]any{
				"block_id": map[string]any{
					"type":        "string",
					"description": "Block id returned by a prior shell_exec background:true call.",
				},
				"tail_bytes": map[string]any{
					"type":        "integer",
					"minimum":     256,
					"maximum":     lrReadMaxTailBytes,
					"default":     lrReadDefaultTailBytes,
					"description": "Bytes from the tail to return. Default 4096.",
				},
				"delay": map[string]any{
					"type":        "object",
					"description": "When set, wait before reading. Either a fixed duration or until the process exits.",
					"properties": map[string]any{
						"kind": map[string]any{
							"type":        "string",
							"enum":        []string{shellCommandDelayKindDuration, shellCommandDelayKindOnCompletion},
							"description": "duration → sleep duration_ms; oncompletion → poll until the block's process exits.",
						},
						"duration_ms": map[string]any{
							"type":        "integer",
							"minimum":     0,
							"maximum":     lrReadMaxDurationDelayMs,
							"description": "Only when kind=duration. Sleep this many milliseconds before reading.",
						},
					},
					"required":             []string{"kind"},
					"additionalProperties": false,
				},
			},
			"required":             []string{"block_id"},
			"additionalProperties": false,
		},
		Parallel: true,
		ToolCallDesc: func(input any, output any, _ *uctypes.UIMessageDataToolUse) string {
			parsed, err := parseLongRunningReadInput(input)
			if err != nil {
				return fmt.Sprintf("long_running_read (invalid: %v)", err)
			}
			if out, ok := output.(*longRunningReadOutput); ok && output != nil {
				if out.IsRunning {
					return fmt.Sprintf("read %d bytes from %s (still running)", len(out.Output), parsed.BlockID)
				}
				return fmt.Sprintf("read %d bytes from %s — exit %d", len(out.Output), parsed.BlockID, out.ExitCode)
			}
			return fmt.Sprintf("reading from %s", parsed.BlockID)
		},
		ToolAnyCallback: func(input any, _ *uctypes.UIMessageDataToolUse) (any, error) {
			parsed, err := parseLongRunningReadInput(input)
			if err != nil {
				return nil, err
			}
			applyReadDelay(parsed)
			return runLongRunningRead(context.Background(), parsed)
		},
		ToolApproval: approval,
	}
}

func parseLongRunningReadInput(input any) (*longRunningReadInput, error) {
	params := &longRunningReadInput{}
	if input == nil {
		return nil, fmt.Errorf("input is required")
	}
	if err := utilfn.ReUnmarshal(params, input); err != nil {
		return nil, fmt.Errorf("invalid input: %w", err)
	}
	if params.BlockID == "" {
		return nil, fmt.Errorf("block_id is required")
	}
	if params.TailBytes <= 0 {
		params.TailBytes = lrReadDefaultTailBytes
	}
	if params.TailBytes > lrReadMaxTailBytes {
		params.TailBytes = lrReadMaxTailBytes
	}
	if params.Delay != nil {
		switch params.Delay.Kind {
		case shellCommandDelayKindDuration:
			if params.Delay.DurationMs < 0 {
				params.Delay.DurationMs = 0
			}
			if params.Delay.DurationMs > lrReadMaxDurationDelayMs {
				params.Delay.DurationMs = lrReadMaxDurationDelayMs
			}
		case shellCommandDelayKindOnCompletion:
			// no further fields
		case "":
			return nil, fmt.Errorf("delay.kind is required when delay is set")
		default:
			return nil, fmt.Errorf("delay.kind %q is not supported (use %q or %q)",
				params.Delay.Kind, shellCommandDelayKindDuration, shellCommandDelayKindOnCompletion)
		}
	}
	return params, nil
}

// applyReadDelay honours the parsed delay (duration sleep, or
// on_completion poll).  On_completion timeouts are non-fatal: the
// caller still reads whatever's in the buffer and `is_running=true`
// signals the cap was hit.
func applyReadDelay(params *longRunningReadInput) {
	if params.Delay == nil {
		return
	}
	switch params.Delay.Kind {
	case shellCommandDelayKindDuration:
		if params.Delay.DurationMs > 0 {
			time.Sleep(time.Duration(params.Delay.DurationMs) * time.Millisecond)
		}
	case shellCommandDelayKindOnCompletion:
		waitForBlockCompletion(params.BlockID, time.Duration(lrReadMaxPollWaitMs)*time.Millisecond)
	}
}

// waitForBlockCompletion polls the block controller until the
// underlying shell process exits or `maxWait` elapses.  Returns nil
// on completion / missing-block (treat as done); a timeout returns
// nil too — the caller still reads what's there.
func waitForBlockCompletion(blockID string, maxWait time.Duration) {
	deadline := time.Now().Add(maxWait)
	for time.Now().Before(deadline) {
		status := blockcontroller.GetBlockControllerRuntimeStatus(blockID)
		if status == nil {
			return
		}
		if status.ShellProcStatus == blockcontroller.Status_Done {
			return
		}
		time.Sleep(time.Duration(lrReadPollIntervalMs) * time.Millisecond)
	}
}

func runLongRunningRead(ctx context.Context, params *longRunningReadInput) (*longRunningReadOutput, error) {
	out := &longRunningReadOutput{
		BlockID:  params.BlockID,
		ExitCode: -1,
	}
	// Read the tail via the shared helper in shell_exec.go (same
	// filestore.WFS pipeline that shell_exec uses for its post-exec
	// stdout tail).
	tail, truncated := readBlockTailN(ctx, params.BlockID, int64(params.TailBytes))
	out.Output = tail
	out.Truncated = truncated

	// Runtime status — distinguishes "still running" from "done".
	// nil status means the controller has no record of this block,
	// which can happen if the user closed the block already; treat
	// as "done with unknown exit code" so the agent stops polling.
	status := blockcontroller.GetBlockControllerRuntimeStatus(params.BlockID)
	if status == nil {
		out.IsRunning = false
	} else {
		out.IsRunning = status.ShellProcStatus != blockcontroller.Status_Done
		if !out.IsRunning {
			out.ExitCode = status.ShellProcExitCode
		}
	}
	out.TotalBytes = readBlockTotalBytes(ctx, params.BlockID)
	return out, nil
}
