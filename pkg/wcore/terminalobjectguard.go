// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

package wcore

import (
	"context"
	"fmt"
	"reflect"
	"slices"

	"github.com/s-zx/crest/pkg/util/utilfn"
	"github.com/s-zx/crest/pkg/waveobj"
	"github.com/s-zx/crest/pkg/wstore"
)

func UpdateObjectMetaWithTerminalGuard(
	ctx context.Context,
	oref waveobj.ORef,
	meta waveobj.MetaMapType,
	mergeSpecial bool,
) error {
	return wstore.WithTx(ctx, func(tx *wstore.TxWrap) error {
		if oref.IsEmpty() {
			return fmt.Errorf("empty object reference")
		}
		current, err := wstore.DBGetORef(tx.Context(), oref)
		if err != nil {
			return err
		}
		if current == nil {
			return wstore.ErrNotFound
		}
		currentMeta := waveobj.GetMeta(current)
		if currentMeta == nil {
			currentMeta = make(waveobj.MetaMapType)
		}
		waveobj.SetMeta(current, waveobj.MergeMeta(currentMeta, meta, mergeSpecial))
		if err := validateTerminalObjectUpdateInTx(tx, current); err != nil {
			return err
		}
		return wstore.DBUpdate(tx.Context(), current)
	})
}

func UpdateObjectWithTerminalGuard(ctx context.Context, proposed waveobj.WaveObj) error {
	if proposed == nil {
		return fmt.Errorf("update wave object is nil")
	}
	return wstore.WithTx(ctx, func(tx *wstore.TxWrap) error {
		oref := waveobj.ORefFromWaveObj(proposed)
		current, err := wstore.DBGetORef(tx.Context(), *oref)
		if err != nil {
			return err
		}
		if current == nil {
			return wstore.ErrNotFound
		}
		if reflect.TypeOf(current) != reflect.TypeOf(proposed) {
			return fmt.Errorf("object type mismatch for %s", oref)
		}
		if err := validateTerminalObjectReplacementInTx(tx, current, proposed); err != nil {
			return err
		}
		return wstore.DBUpdate(tx.Context(), proposed)
	})
}

func validateTerminalObjectUpdateInTx(tx *wstore.TxWrap, proposed waveobj.WaveObj) error {
	current, err := wstore.DBGetORef(tx.Context(), *waveobj.ORefFromWaveObj(proposed))
	if err != nil {
		return err
	}
	return validateTerminalObjectReplacementInTx(tx, current, proposed)
}

func validateTerminalObjectReplacementInTx(tx *wstore.TxWrap, current waveobj.WaveObj, proposed waveobj.WaveObj) error {
	switch proposed := proposed.(type) {
	case *waveobj.Block:
		return validateTerminalBlockReplacementInTx(tx, current.(*waveobj.Block), proposed)
	case *waveobj.Tab:
		return validateTerminalTabReplacementInTx(tx, current.(*waveobj.Tab), proposed)
	case *waveobj.Workspace:
		return validateTerminalWorkspaceReplacementInTx(tx, current.(*waveobj.Workspace), proposed)
	default:
		return nil
	}
}

func validateTerminalBlockReplacementInTx(tx *wstore.TxWrap, current *waveobj.Block, proposed *waveobj.Block) error {
	tabId, err := findTabForBlockInTx(tx, current.OID)
	if err != nil {
		return err
	}
	terminalDomain, err := validateTerminalDomainTabWrite(tx, tabId, nil)
	if err != nil || !terminalDomain {
		return err
	}
	if proposed.ParentORef != current.ParentORef {
		return fmt.Errorf("Terminal block parent cannot be changed through generic object update")
	}
	if !slices.Equal(proposed.SubBlockIds, current.SubBlockIds) {
		return fmt.Errorf("Terminal block children cannot be changed through generic object update")
	}
	tab, err := wstore.DBMustGet[*waveobj.Tab](tx.Context(), tabId)
	if err != nil {
		return err
	}
	return validateTerminalTabTreeWithBlockOverride(tx, tab, proposed)
}

func validateTerminalTabReplacementInTx(tx *wstore.TxWrap, current *waveobj.Tab, proposed *waveobj.Tab) error {
	workspaceId, err := wstore.DBFindWorkspaceForTabId(tx.Context(), current.OID)
	if err != nil || workspaceId == "" {
		return err
	}
	workspace, err := wstore.DBMustGet[*waveobj.Workspace](tx.Context(), workspaceId)
	if err != nil {
		return err
	}
	if utilfn.FindStringInSlice(workspace.TerminalTabIds, current.OID) == -1 {
		return nil
	}
	if current.LayoutState != proposed.LayoutState || !slices.Equal(current.BlockIds, proposed.BlockIds) {
		return fmt.Errorf("Terminal Tab layout cannot be changed through generic object update")
	}
	return validateTerminalTabTreeWithBlockOverride(tx, proposed, nil)
}

func validateTerminalWorkspaceReplacementInTx(
	tx *wstore.TxWrap,
	current *waveobj.Workspace,
	proposed *waveobj.Workspace,
) error {
	if current.TabDomainVersion != proposed.TabDomainVersion ||
		!slices.Equal(current.TerminalTabIds, proposed.TerminalTabIds) {
		return fmt.Errorf("Terminal inventory cannot be changed through generic object update")
	}
	for _, tabId := range proposed.TerminalTabIds {
		if utilfn.FindStringInSlice(proposed.TabIds, tabId) == -1 {
			return fmt.Errorf("Terminal Tab %s is missing from workspace tabids", tabId)
		}
		tab, err := wstore.DBMustGet[*waveobj.Tab](tx.Context(), tabId)
		if err != nil {
			return err
		}
		if err := validateTerminalTabTreeWithBlockOverride(tx, tab, nil); err != nil {
			return err
		}
	}
	return nil
}

func validateTerminalTabTreeWithBlockOverride(
	tx *wstore.TxWrap,
	tab *waveobj.Tab,
	override *waveobj.Block,
) error {
	visited := make(map[string]bool)
	overrideVisits := 0
	for _, blockId := range tab.BlockIds {
		if err := validateTerminalCandidateSubtree(
			tx,
			blockId,
			waveobj.MakeORef(waveobj.OType_Tab, tab.OID).String(),
			override,
			visited,
			&overrideVisits,
		); err != nil {
			return err
		}
	}
	if override != nil && overrideVisits != 1 {
		return fmt.Errorf(
			"Terminal block %s must be reachable exactly once from Tab %s (found %d)",
			override.OID,
			tab.OID,
			overrideVisits,
		)
	}
	return nil
}

func validateTerminalCandidateSubtree(
	tx *wstore.TxWrap,
	blockId string,
	parentORef string,
	override *waveobj.Block,
	visited map[string]bool,
	overrideVisits *int,
) error {
	if visited[blockId] {
		return fmt.Errorf("cycle found in Terminal block subtree at %s", blockId)
	}
	visited[blockId] = true
	var block *waveobj.Block
	if override != nil && override.OID == blockId {
		block = override
		*overrideVisits++
	} else {
		var err error
		block, err = wstore.DBMustGet[*waveobj.Block](tx.Context(), blockId)
		if err != nil {
			return err
		}
	}
	if block.ParentORef != parentORef {
		return fmt.Errorf("Terminal block %s has invalid parent %q", block.OID, block.ParentORef)
	}
	view := block.Meta.GetString(waveobj.MetaKey_View, "")
	if !IsTerminalCompatibleView(view) {
		return fmt.Errorf("block %s view %q is not Terminal compatible", block.OID, view)
	}
	for _, subBlockId := range block.SubBlockIds {
		if err := validateTerminalCandidateSubtree(
			tx,
			subBlockId,
			waveobj.MakeORef(waveobj.OType_Block, block.OID).String(),
			override,
			visited,
			overrideVisits,
		); err != nil {
			return err
		}
	}
	delete(visited, blockId)
	return nil
}
