// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

package wcore

import (
	"context"
	"fmt"
	"slices"

	"github.com/s-zx/crest/pkg/waveobj"
	"github.com/s-zx/crest/pkg/wstore"
)

func AdoptLegacyWorkspaceTabDomains(ctx context.Context) error {
	return wstore.WithTx(ctx, func(tx *wstore.TxWrap) error {
		workspaces, err := wstore.DBGetAllObjsByType[*waveobj.Workspace](tx.Context(), waveobj.OType_Workspace)
		if err != nil {
			return fmt.Errorf("error listing workspaces for tab domain adoption: %w", err)
		}
		for _, workspace := range workspaces {
			changed := false
			terminalIds := make(map[string]bool, len(workspace.TerminalTabIds))
			for _, tabId := range workspace.TerminalTabIds {
				tab, err := wstore.DBGet[*waveobj.Tab](tx.Context(), tabId)
				if err != nil {
					return fmt.Errorf("error reading claimed Terminal Tab %s in workspace %s: %w", tabId, workspace.OID, err)
				}
				if tab == nil || len(tab.BlockIds) == 0 || tab.LayoutState == "" {
					continue
				}
				layout, err := wstore.DBGet[*waveobj.LayoutState](tx.Context(), tab.LayoutState)
				if err != nil {
					return fmt.Errorf("error reading claimed Terminal LayoutState %s in workspace %s: %w", tab.LayoutState, workspace.OID, err)
				}
				if layout == nil || ValidateTerminalTabMutation(tx, workspace.OID, tabId, nil) != nil {
					continue
				}
				terminalIds[tabId] = true
			}
			var obsoleteZoneIds []string
			candidateIds := append(append([]string{}, workspace.TabIds...), workspace.TerminalTabIds...)
			seenCandidates := make(map[string]bool, len(candidateIds))
			for _, tabId := range candidateIds {
				if seenCandidates[tabId] {
					continue
				}
				seenCandidates[tabId] = true
				if terminalIds[tabId] {
					continue
				}
				tab, err := wstore.DBGet[*waveobj.Tab](tx.Context(), tabId)
				if err != nil {
					return fmt.Errorf("error reading legacy Tab %s in workspace %s: %w", tabId, workspace.OID, err)
				}
				if tab == nil {
					continue
				}
				for _, blockId := range tab.BlockIds {
					zoneIds, err := deleteTerminalBlockSubtreeInTx(tx, blockId)
					if err != nil {
						return fmt.Errorf("error deleting legacy Tab %s in workspace %s: %w", tabId, workspace.OID, err)
					}
					obsoleteZoneIds = append(obsoleteZoneIds, zoneIds...)
				}
				if err := wstore.DBDeleteInTxNoSideEffects(tx, waveobj.OType_Tab, tabId); err != nil {
					return fmt.Errorf("error deleting legacy Tab %s in workspace %s: %w", tabId, workspace.OID, err)
				}
				obsoleteZoneIds = append(obsoleteZoneIds, tabId)
				if tab.LayoutState != "" {
					if err := wstore.DBDeleteInTxNoSideEffects(tx, waveobj.OType_LayoutState, tab.LayoutState); err != nil {
						return fmt.Errorf("error deleting legacy LayoutState %s in workspace %s: %w", tab.LayoutState, workspace.OID, err)
					}
					obsoleteZoneIds = append(obsoleteZoneIds, tab.LayoutState)
				}
			}
			validTerminalTabIds := make([]string, 0, len(workspace.TerminalTabIds))
			for _, tabId := range workspace.TerminalTabIds {
				if terminalIds[tabId] {
					validTerminalTabIds = append(validTerminalTabIds, tabId)
				}
			}
			if !slices.Equal(workspace.TerminalTabIds, validTerminalTabIds) {
				workspace.TerminalTabIds = validTerminalTabIds
				changed = true
			}
			if !slices.Equal(workspace.TabIds, validTerminalTabIds) {
				workspace.TabIds = append([]string{}, validTerminalTabIds...)
				changed = true
			}
			if workspace.ActiveTabId != "" {
				workspace.ActiveTabId = ""
				changed = true
			}
			if workspace.TabDomainVersion == 0 {
				changed = true
				workspace.TabDomainVersion = waveobj.CurrentTabDomainVersion
				workspace.NavigationRevision = 0
				workspace.ContentState = waveobj.WorkspaceContentState{
					ActiveContent: waveobj.ActiveContent{Kind: waveobj.ActiveContentKindAgent},
					TopTabs:       []waveobj.TopTabDescriptor{},
				}
			}
			if !terminalIds[workspace.ActiveTerminalTabId] {
				if workspace.ActiveTerminalTabId != "" {
					changed = true
				}
				workspace.ActiveTerminalTabId = ""
				if workspace.ContentState.ActiveContent.Kind == waveobj.ActiveContentKindTerminal {
					workspace.ContentState.ActiveContent = waveobj.ActiveContent{Kind: waveobj.ActiveContentKindAgent}
					changed = true
				}
			}
			if changed {
				if err := wstore.DBUpdate(tx.Context(), workspace); err != nil {
					return fmt.Errorf("error adopting workspace %s tab domain: %w", workspace.OID, err)
				}
			}
			if len(obsoleteZoneIds) > 0 {
				zoneIds := append([]string(nil), obsoleteZoneIds...)
				if err := wstore.RegisterAfterCommit(tx, func(callbackCtx context.Context) error {
					return cleanupTerminalTabZones(callbackCtx, zoneIds)
				}); err != nil {
					return err
				}
			}
		}
		return nil
	})
}
