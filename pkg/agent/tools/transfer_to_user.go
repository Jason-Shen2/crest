// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0
//
// transfer_to_user — agent yields the terminal back to the user.
// Structure derived from warp:
//   crates/ai/src/agent/action/mod.rs:162-165
//   (TransferShellCommandControlToUser action variant).
// Warp is © 2020-2026 Denver Technologies, Inc., MIT licensed.
//
// v1 semantics — minimum viable hand-back:
//   - the named background block (if currently hidden / not laid out)
//     gets a layout action so it becomes visible in the tab;
//   - the tool returns immediately with a reason echoed back to the
//     agent.  The agent is expected to stop driving this block on its
//     subsequent turns; we don't enforce that at the runtime level
//     because the user might still want the agent observing.
//
// Full FD-level handoff (warp's literal PTY ownership transfer, where
// stdin routing is rebound) is v2 — it requires reshaping how the
// blockcontroller dispatches stdin events and isn't covered here.
// The block is already user-typable once visible; v1 just unhides it.

package tools

import (
	"context"
	"fmt"
	"strings"

	"github.com/s-zx/crest/pkg/aiusechat/uctypes"
	"github.com/s-zx/crest/pkg/util/utilfn"
	"github.com/s-zx/crest/pkg/waveobj"
	"github.com/s-zx/crest/pkg/wcore"
	"github.com/s-zx/crest/pkg/wps"
	"github.com/s-zx/crest/pkg/wstore"
)

const transferReasonMaxChars = 500

type transferToUserInput struct {
	BlockID string `json:"block_id"`
	Reason  string `json:"reason"`
}

type transferToUserOutput struct {
	BlockID string `json:"block_id"`
	Reason  string `json:"reason"`
	// MadeVisible — true when this call had to add the block to the
	// tab layout. False when the block was already visible (still a
	// success: control was already with the user).
	MadeVisible bool `json:"made_visible"`
}

// TransferToUser hands control of a background block back to the user.
// Auto-approved — yielding control is always safe.
func TransferToUser(tabID, defaultBlockID string, approval func(any) string) uctypes.ToolDefinition {
	return uctypes.ToolDefinition{
		Name:        "transfer_to_user",
		DisplayName: "Hand Off to User",
		Description: "Yield interactive control of a background shell block back to the user. The block becomes visible in the tab and the user can type into it directly. Use when a long-running command needs human attention (interactive prompt, ambiguous error, manual confirmation) the agent can't handle.",
		ToolLogName: "agent:transfer_to_user",
		Prompt: `transfer_to_user: Stop driving a background block and surface it for the user to take over.
- Use ONLY with block_ids from shell_exec(background:true). For finite headless commands the agent already returned the output — there's nothing to hand off.
- "reason" is a short sentence the FE shows alongside the block ("Agent yielded control: <reason>"). Be specific — "needs you to enter the GitHub OTP", not "please help".
- After calling this tool, do NOT continue to drive the same block (no further long_running_write/read on it in this turn). Move on to other work or end the turn.
- Auto-approved: yielding is always safe.`,
		InputSchema: map[string]any{
			"type": "object",
			"properties": map[string]any{
				"block_id": map[string]any{
					"type":        "string",
					"description": "Block id returned by a prior shell_exec background:true call.",
				},
				"reason": map[string]any{
					"type":        "string",
					"description": "Short explanation shown to the user (e.g., \"needs you to enter the SSH passphrase\").",
				},
			},
			"required":             []string{"block_id", "reason"},
			"additionalProperties": false,
		},
		ToolCallDesc: func(input any, output any, _ *uctypes.UIMessageDataToolUse) string {
			parsed, err := parseTransferToUserInput(input)
			if err != nil {
				return fmt.Sprintf("transfer_to_user (invalid: %v)", err)
			}
			if output != nil {
				return fmt.Sprintf("handed %s to user", parsed.BlockID)
			}
			return fmt.Sprintf("handing %s to user", parsed.BlockID)
		},
		ToolAnyCallback: func(input any, toolUseData *uctypes.UIMessageDataToolUse) (any, error) {
			parsed, err := parseTransferToUserInput(input)
			if err != nil {
				return nil, err
			}
			out, err := runTransferToUser(context.Background(), parsed, tabID, defaultBlockID)
			if err != nil {
				return nil, err
			}
			if toolUseData != nil {
				// Surface the handoff in the tool-use card itself so
				// the user sees the reason without scrolling.  Also
				// clear BlockHidden so the inline "Open block" button
				// disappears — the block is in the layout now.
				toolUseData.BlockId = parsed.BlockID
				toolUseData.BlockHidden = false
			}
			return out, nil
		},
		ToolApproval: approval,
	}
}

func parseTransferToUserInput(input any) (*transferToUserInput, error) {
	params := &transferToUserInput{}
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
	params.Reason = strings.TrimSpace(params.Reason)
	if params.Reason == "" {
		return nil, fmt.Errorf("reason is required")
	}
	if len(params.Reason) > transferReasonMaxChars {
		return nil, fmt.Errorf("reason exceeds %d chars", transferReasonMaxChars)
	}
	return params, nil
}

func runTransferToUser(ctx context.Context, params *transferToUserInput, tabID, defaultBlockID string) (*transferToUserOutput, error) {
	if tabID == "" {
		return nil, fmt.Errorf("agent session has no tab context")
	}
	// Confirm the block actually exists before fiddling with the
	// layout — yields a clean error message if the agent passed a
	// stale or made-up id.
	if _, err := wstore.DBGet[*waveobj.Block](ctx, params.BlockID); err != nil {
		return nil, fmt.Errorf("block %q not found: %w", params.BlockID, err)
	}

	ctx = waveobj.ContextWithUpdates(ctx)

	out := &transferToUserOutput{
		BlockID: params.BlockID,
		Reason:  params.Reason,
	}

	// Queue a layout action that splits to the right of the agent's
	// terminal block.  Pattern mirrors shell_exec's foreground path:
	// SplitVertical when we have a target, Insert otherwise.  If the
	// block is already in the layout the action is best-effort —
	// QueueLayoutActionForTab is idempotent enough that a duplicate
	// add returns an error we treat as "already visible."
	action := &waveobj.LayoutActionData{
		ActionType:    wcore.LayoutActionDataType_SplitVertical,
		BlockId:       params.BlockID,
		TargetBlockId: defaultBlockID,
		Position:      "after",
	}
	if defaultBlockID == "" {
		action = &waveobj.LayoutActionData{
			ActionType: wcore.LayoutActionDataType_Insert,
			BlockId:    params.BlockID,
		}
	}
	if err := wcore.QueueLayoutActionForTab(ctx, tabID, *action); err != nil {
		// Already-visible / already-laid-out paths fail here — that's
		// success for our semantic.  Only log; don't surface to the
		// agent.  If this turns out to need finer error classification,
		// add a `wcore.IsLayoutDuplicate(err)` predicate.
		out.MadeVisible = false
	} else {
		out.MadeVisible = true
	}
	wps.Broker.SendUpdateEvents(waveobj.ContextGetUpdatesRtn(ctx))
	return out, nil
}
