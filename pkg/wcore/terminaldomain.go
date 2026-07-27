// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

package wcore

import (
	"context"
	"errors"
	"fmt"

	"github.com/google/uuid"
	"github.com/s-zx/crest/pkg/filestore"
	"github.com/s-zx/crest/pkg/util/utilfn"
	"github.com/s-zx/crest/pkg/waveobj"
	"github.com/s-zx/crest/pkg/wstore"
)

const (
	TerminalViewTerm       = "term"
	TerminalViewTermBlocks = "termblocks"
)

type TerminalTabCreateOpts struct {
	Name       string
	Connection string
	Cwd        string
}

func IsTerminalCompatibleView(view string) bool {
	return view == TerminalViewTerm || view == TerminalViewTermBlocks
}

func ValidateTerminalTabMutation(tx *wstore.TxWrap, workspaceId string, tabId string, views []string) error {
	workspace, err := wstore.DBMustGet[*waveobj.Workspace](tx.Context(), workspaceId)
	if err != nil {
		return fmt.Errorf("workspace %s not found: %w", workspaceId, err)
	}
	if utilfn.FindStringInSlice(workspace.TabIds, tabId) == -1 {
		return fmt.Errorf("tab %s not found in workspace %s", tabId, workspaceId)
	}
	tab, err := wstore.DBMustGet[*waveobj.Tab](tx.Context(), tabId)
	if err != nil {
		return fmt.Errorf("tab %s not found: %w", tabId, err)
	}
	for _, view := range views {
		if !IsTerminalCompatibleView(view) {
			return fmt.Errorf("view %q is not Terminal compatible", view)
		}
	}
	visited := make(map[string]bool)
	for _, blockId := range tab.BlockIds {
		if err := validateTerminalBlockSubtree(tx, blockId, visited); err != nil {
			return err
		}
	}
	return nil
}

func RepairTerminalTabShellControllers(ctx context.Context, workspaceId string, tabId string) error {
	return wstore.WithTx(ctx, func(tx *wstore.TxWrap) error {
		workspace, err := wstore.DBMustGet[*waveobj.Workspace](tx.Context(), workspaceId)
		if err != nil {
			return fmt.Errorf("workspace %s not found: %w", workspaceId, err)
		}
		if utilfn.FindStringInSlice(workspace.TerminalTabIds, tabId) == -1 {
			return nil
		}
		if utilfn.FindStringInSlice(workspace.TabIds, tabId) == -1 {
			return nil
		}
		tab, err := wstore.DBMustGet[*waveobj.Tab](tx.Context(), tabId)
		if err != nil {
			return fmt.Errorf("tab %s not found: %w", tabId, err)
		}
		visited := make(map[string]bool)
		for _, blockId := range tab.BlockIds {
			if err := repairTerminalBlockShellControllerInTx(tx, blockId, visited); err != nil {
				return err
			}
		}
		return nil
	})
}

func validateTerminalDomainTabWrite(tx *wstore.TxWrap, tabId string, views []string) (bool, error) {
	workspaceId, err := wstore.DBFindWorkspaceForTabId(tx.Context(), tabId)
	if err != nil {
		return false, err
	}
	if workspaceId == "" {
		return false, nil
	}
	workspace, err := wstore.DBMustGet[*waveobj.Workspace](tx.Context(), workspaceId)
	if err != nil {
		return false, err
	}
	if utilfn.FindStringInSlice(workspace.TerminalTabIds, tabId) == -1 {
		return false, nil
	}
	if err := ValidateTerminalTabMutation(tx, workspaceId, tabId, views); err != nil {
		return true, err
	}
	return true, nil
}

func findTabForBlockInTx(tx *wstore.TxWrap, blockId string) (string, error) {
	visited := make(map[string]bool)
	for blockId != "" {
		if visited[blockId] {
			return "", fmt.Errorf("cycle found while resolving parent Tab for block %s", blockId)
		}
		visited[blockId] = true
		block, err := wstore.DBMustGet[*waveobj.Block](tx.Context(), blockId)
		if err != nil {
			return "", err
		}
		parent := waveobj.ParseORefNoErr(block.ParentORef)
		if parent == nil {
			return "", fmt.Errorf("block %s has invalid parent %q", block.OID, block.ParentORef)
		}
		if parent.OType == waveobj.OType_Tab {
			return parent.OID, nil
		}
		if parent.OType != waveobj.OType_Block {
			return "", fmt.Errorf("block %s has invalid parent %q", block.OID, block.ParentORef)
		}
		blockId = parent.OID
	}
	return "", fmt.Errorf("block has no parent Tab")
}

func validateTerminalBlockSubtree(tx *wstore.TxWrap, blockId string, visited map[string]bool) error {
	if visited[blockId] {
		return fmt.Errorf("cycle found in Terminal block subtree at %s", blockId)
	}
	visited[blockId] = true
	block, err := wstore.DBMustGet[*waveobj.Block](tx.Context(), blockId)
	if err != nil {
		return fmt.Errorf("Terminal block %s not found: %w", blockId, err)
	}
	view := block.Meta.GetString(waveobj.MetaKey_View, "")
	if !IsTerminalCompatibleView(view) {
		return fmt.Errorf("block %s view %q is not Terminal compatible", blockId, view)
	}
	for _, subBlockId := range block.SubBlockIds {
		if err := validateTerminalBlockSubtree(tx, subBlockId, visited); err != nil {
			return err
		}
	}
	delete(visited, blockId)
	return nil
}

func repairTerminalBlockShellControllerInTx(tx *wstore.TxWrap, blockId string, visited map[string]bool) error {
	if visited[blockId] {
		return fmt.Errorf("cycle found in Terminal block subtree at %s", blockId)
	}
	visited[blockId] = true
	block, err := wstore.DBMustGet[*waveobj.Block](tx.Context(), blockId)
	if err != nil {
		return fmt.Errorf("Terminal block %s not found: %w", blockId, err)
	}
	view := block.Meta.GetString(waveobj.MetaKey_View, "")
	if !IsTerminalCompatibleView(view) {
		return fmt.Errorf("block %s view %q is not Terminal compatible", blockId, view)
	}
	if block.Meta.GetString(waveobj.MetaKey_Controller, "") == "" {
		if block.Meta == nil {
			block.Meta = make(waveobj.MetaMapType)
		}
		block.Meta[waveobj.MetaKey_Controller] = "shell"
		if err := wstore.DBUpdate(tx.Context(), block); err != nil {
			return err
		}
	}
	for _, subBlockId := range block.SubBlockIds {
		if err := repairTerminalBlockShellControllerInTx(tx, subBlockId, visited); err != nil {
			return err
		}
	}
	delete(visited, blockId)
	return nil
}

func CreateTerminalTabInTx(tx *wstore.TxWrap, workspaceId string, opts TerminalTabCreateOpts) (string, error) {
	workspace, err := wstore.DBMustGet[*waveobj.Workspace](tx.Context(), workspaceId)
	if err != nil {
		return "", fmt.Errorf("workspace %s not found: %w", workspaceId, err)
	}
	layoutState := &waveobj.LayoutState{OID: uuid.NewString()}
	tab := &waveobj.Tab{
		OID:         uuid.NewString(),
		Name:        opts.Name,
		LayoutState: layoutState.OID,
		BlockIds:    []string{},
	}
	if err := wstore.DBInsert(tx.Context(), tab); err != nil {
		return "", err
	}
	if err := wstore.DBInsert(tx.Context(), layoutState); err != nil {
		return "", err
	}
	workspace.TabIds = append(workspace.TabIds, tab.OID)
	if err := wstore.DBUpdate(tx.Context(), workspace); err != nil {
		return "", err
	}

	meta := waveobj.MetaMapType{
		waveobj.MetaKey_View:       TerminalViewTermBlocks,
		waveobj.MetaKey_Controller: "shell",
	}
	if opts.Connection != "" {
		meta[waveobj.MetaKey_Connection] = opts.Connection
	}
	if opts.Cwd != "" {
		meta[waveobj.MetaKey_CmdCwd] = opts.Cwd
	}
	layout := PortableLayout{
		{IndexArr: []int{0}, BlockDef: &waveobj.BlockDef{Meta: meta}, Focused: true},
	}
	if err := applyTerminalPortableLayoutInTx(tx, tab.OID, layout); err != nil {
		return "", err
	}
	return tab.OID, nil
}

func DeleteTerminalTabInTx(tx *wstore.TxWrap, workspaceId string, tabId string) error {
	if err := ValidateTerminalTabMutation(tx, workspaceId, tabId, nil); err != nil {
		return err
	}
	workspace, err := wstore.DBMustGet[*waveobj.Workspace](tx.Context(), workspaceId)
	if err != nil {
		return err
	}
	tab, err := wstore.DBMustGet[*waveobj.Tab](tx.Context(), tabId)
	if err != nil {
		return err
	}
	var zoneIds []string
	for _, blockId := range tab.BlockIds {
		blockZoneIds, err := deleteTerminalBlockSubtreeInTx(tx, blockId)
		if err != nil {
			return err
		}
		zoneIds = append(zoneIds, blockZoneIds...)
	}
	workspace.TabIds = utilfn.RemoveElemFromSlice(workspace.TabIds, tabId)
	if workspace.ActiveTabId == tabId {
		workspace.ActiveTabId = ""
	}
	if err := wstore.DBUpdate(tx.Context(), workspace); err != nil {
		return err
	}
	if err := wstore.DBDeleteInTxNoSideEffects(tx, waveobj.OType_Tab, tabId); err != nil {
		return err
	}
	zoneIds = append(zoneIds, tabId)
	if err := wstore.DBDeleteInTxNoSideEffects(tx, waveobj.OType_LayoutState, tab.LayoutState); err != nil {
		return err
	}
	zoneIds = append(zoneIds, tab.LayoutState)
	return wstore.RegisterAfterCommit(tx, func(ctx context.Context) error {
		return cleanupTerminalTabZones(ctx, zoneIds)
	})
}

func deleteTerminalBlockSubtreeInTx(tx *wstore.TxWrap, blockId string) ([]string, error) {
	block, err := wstore.DBMustGet[*waveobj.Block](tx.Context(), blockId)
	if err != nil {
		return nil, err
	}
	zoneIds := make([]string, 0, len(block.SubBlockIds)+1)
	for _, subBlockId := range block.SubBlockIds {
		subtreeZoneIds, err := deleteTerminalBlockSubtreeInTx(tx, subBlockId)
		if err != nil {
			return nil, err
		}
		zoneIds = append(zoneIds, subtreeZoneIds...)
	}
	if err := wstore.DBDeleteInTxNoSideEffects(tx, waveobj.OType_Block, blockId); err != nil {
		return nil, err
	}
	return append(zoneIds, blockId), nil
}

var deleteTerminalZone = filestore.WFS.DeleteZone

func cleanupTerminalTabZones(ctx context.Context, zoneIds []string) error {
	var cleanupErr error
	for _, zoneId := range zoneIds {
		if err := deleteTerminalZone(ctx, zoneId); err != nil {
			cleanupErr = errors.Join(cleanupErr, fmt.Errorf("delete filestore zone %s: %w", zoneId, err))
		}
	}
	return cleanupErr
}

func applyTerminalPortableLayoutInTx(tx *wstore.TxWrap, tabId string, layout PortableLayout) error {
	for _, layoutAction := range layout {
		if err := validateBlockDef(layoutAction.BlockDef); err != nil {
			return fmt.Errorf("invalid Terminal portable layout block: %w", err)
		}
		view := layoutAction.BlockDef.Meta.GetString(waveobj.MetaKey_View, "")
		if !IsTerminalCompatibleView(view) {
			return fmt.Errorf("view %q is not Terminal compatible", view)
		}
	}

	actions := make([]waveobj.LayoutActionData, len(layout)+1)
	actions[0] = waveobj.LayoutActionData{ActionType: LayoutActionDataType_ClearTree}
	for i, layoutAction := range layout {
		block, err := createBlockObjInTx(tx, tabId, layoutAction.BlockDef, &waveobj.RuntimeOpts{})
		if err != nil {
			return err
		}
		actions[i+1] = waveobj.LayoutActionData{
			ActionType: LayoutActionDataType_InsertAtIndex,
			BlockId:    block.OID,
			IndexArr:   &layoutAction.IndexArr,
			NodeSize:   layoutAction.Size,
			Focused:    layoutAction.Focused,
		}
	}
	layoutId, err := GetLayoutIdForTab(tx.Context(), tabId)
	if err != nil {
		return err
	}
	return QueueLayoutAction(tx.Context(), layoutId, actions...)
}
