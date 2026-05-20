// Copyright 2025, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

package aiusechat

import (
	"context"
	"sync"

	"github.com/s-zx/crest/pkg/aiusechat/uctypes"
	"github.com/s-zx/crest/pkg/web/sse"
)

type ApprovalRequest struct {
	approval string
	// askAnswers — populated only for the ask_user_question tool.
	// The usechat dispatcher copies these onto toolusedata.AskAnswers
	// before invoking the tool callback so the callback can format
	// the agent-facing result.
	askAnswers     []uctypes.AskUserQuestionAnswer
	done           bool
	doneChan       chan struct{}
	mu             sync.Mutex
	onCloseUnregFn func()
}

func (req *ApprovalRequest) updateApproval(approval string) {
	req.updateApprovalWithAnswers(approval, nil)
}

func (req *ApprovalRequest) updateApprovalWithAnswers(approval string, answers []uctypes.AskUserQuestionAnswer) {
	req.mu.Lock()
	defer req.mu.Unlock()

	if req.done {
		return
	}

	req.approval = approval
	req.askAnswers = answers
	req.done = true

	if req.onCloseUnregFn != nil {
		req.onCloseUnregFn()
	}

	close(req.doneChan)
}

type ApprovalRegistry struct {
	mu       sync.Mutex
	requests map[string]*ApprovalRequest
}

var globalApprovalRegistry = &ApprovalRegistry{
	requests: make(map[string]*ApprovalRequest),
}

func registerToolApprovalRequest(toolCallId string, req *ApprovalRequest) {
	globalApprovalRegistry.mu.Lock()
	defer globalApprovalRegistry.mu.Unlock()
	globalApprovalRegistry.requests[toolCallId] = req
}

func UnregisterToolApproval(toolCallId string) {
	globalApprovalRegistry.mu.Lock()
	defer globalApprovalRegistry.mu.Unlock()
	req := globalApprovalRegistry.requests[toolCallId]
	delete(globalApprovalRegistry.requests, toolCallId)
	if req != nil {
		req.updateApproval("")
	}
}

func getToolApprovalRequest(toolCallId string) (*ApprovalRequest, bool) {
	globalApprovalRegistry.mu.Lock()
	defer globalApprovalRegistry.mu.Unlock()
	req, exists := globalApprovalRegistry.requests[toolCallId]
	return req, exists
}

func RegisterToolApproval(toolCallId string, sseHandler *sse.SSEHandlerCh) {
	req := &ApprovalRequest{
		doneChan: make(chan struct{}),
	}

	onCloseId := sseHandler.RegisterOnClose(func() {
		UpdateToolApproval(toolCallId, uctypes.ApprovalCanceled)
	})

	req.onCloseUnregFn = func() {
		sseHandler.UnregisterOnClose(onCloseId)
	}

	registerToolApprovalRequest(toolCallId, req)
}

func UpdateToolApproval(toolCallId string, approval string) error {
	return UpdateToolApprovalWithAnswers(toolCallId, approval, nil)
}

// UpdateToolApprovalWithAnswers delivers an approval decision plus
// optional structured answers (only set for ask_user_question). Answers
// are nil for every other tool — its single-string contract is
// preserved by the UpdateToolApproval shim above.
func UpdateToolApprovalWithAnswers(toolCallId string, approval string, answers []uctypes.AskUserQuestionAnswer) error {
	req, exists := getToolApprovalRequest(toolCallId)
	if !exists {
		return nil
	}

	req.updateApprovalWithAnswers(approval, answers)
	return nil
}

// WaitForToolApproval blocks until the FE delivers an approval (or the
// context cancels). Returns the approval string and, for
// ask_user_question, the structured answers. Other tools return nil
// answers — same observable behavior as before this signature change.
func WaitForToolApproval(ctx context.Context, toolCallId string) (string, []uctypes.AskUserQuestionAnswer, error) {
	req, exists := getToolApprovalRequest(toolCallId)
	if !exists {
		return "", nil, nil
	}

	select {
	case <-ctx.Done():
		return "", nil, ctx.Err()
	case <-req.doneChan:
	}

	req.mu.Lock()
	approval := req.approval
	answers := req.askAnswers
	req.mu.Unlock()

	globalApprovalRegistry.mu.Lock()
	delete(globalApprovalRegistry.requests, toolCallId)
	globalApprovalRegistry.mu.Unlock()

	return approval, answers, nil
}
