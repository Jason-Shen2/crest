// Copyright 2025, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

package wcore

import (
	"context"
	"fmt"
	"log"
	"path/filepath"
	"time"

	"github.com/google/uuid"
	"github.com/s-zx/crest/pkg/eventbus"
	"github.com/s-zx/crest/pkg/util/utilfn"
	"github.com/s-zx/crest/pkg/waveobj"
	"github.com/s-zx/crest/pkg/wconfig"
	"github.com/s-zx/crest/pkg/wps"
	"github.com/s-zx/crest/pkg/wstore"
)

var WorkspaceColors = [...]string{
	"#58C142", // Green (accent)
	"#00FFDB", // Teal
	"#429DFF", // Blue
	"#BF55EC", // Purple
	"#FF453A", // Red
	"#FF9500", // Orange
	"#FFE900", // Yellow
}

var WorkspaceIcons = [...]string{
	"terminal",  // the starter workspace — a terminal app
	"folder-01", // a folder-backed project workspace
	"sparkles",  // a special / AI-flavored workspace
	"heart",     // favorites
	"rocket-01", // new / launch
	"cube",      // a project / container
	"globe-02",  // web / cloud workspace
	"home-03",   // default home workspace
	"rocket",
	"flask",
	"paperclip",
	"chart-line",
	"graduation-cap",
	"mug-hot",
}

func CreateWorkspace(ctx context.Context, name string, icon string, color string, applyDefaults bool, isInitialLaunch bool, dir string) (*waveobj.Workspace, error) {
	ws := &waveobj.Workspace{
		OID:              uuid.NewString(),
		TabIds:           []string{},
		TabDomainVersion: waveobj.CurrentTabDomainVersion,
		TerminalTabIds:   []string{},
		ContentState: waveobj.WorkspaceContentState{
			ActiveContent: waveobj.ActiveContent{Kind: waveobj.ActiveContentKindAgent},
			TopTabs:       []waveobj.TopTabDescriptor{},
		},
		Name:  "",
		Icon:  "",
		Color: "",
	}
	if dir != "" {
		ws.Meta = waveobj.MetaMapType{waveobj.MetaKey_WorkspaceDir: dir}
	}
	err := wstore.DBInsert(ctx, ws)
	if err != nil {
		return nil, fmt.Errorf("error inserting workspace: %w", err)
	}
	wps.Broker.Publish(wps.WaveEvent{
		Event: wps.Event_WorkspaceUpdate,
	})

	if name == "" && dir != "" {
		name = filepath.Base(dir)
	}

	ws, _, err = UpdateWorkspace(ctx, ws.OID, name, icon, color, applyDefaults)
	return ws, err
}

// Returns updated workspace, whether it was updated, error.
func UpdateWorkspace(ctx context.Context, workspaceId string, name string, icon string, color string, applyDefaults bool) (*waveobj.Workspace, bool, error) {
	ws, err := GetWorkspace(ctx, workspaceId)
	updated := false
	if err != nil {
		return nil, updated, fmt.Errorf("workspace %s not found: %w", workspaceId, err)
	}
	// Lazy-load the workspace list once when any default branch needs it,
	// so name + color defaults don't hit the DB twice for a single call.
	var wsList waveobj.WorkspaceList
	needList := applyDefaults && ((name == "" && ws.Name == "") || (color == "" && ws.Color == ""))
	if needList {
		wsList, err = ListWorkspaces(ctx)
		if err != nil {
			log.Printf("error listing workspaces for defaults: %v", err)
			wsList = waveobj.WorkspaceList{}
		}
	}
	if name != "" {
		ws.Name = name
		updated = true
	} else if applyDefaults && ws.Name == "" {
		// First workspace is "Default", subsequent ones are "Space N".
		// Mirrors terax-ai's SpaceSwitcher convention.  Hash suffixes
		// ("New Workspace (a935b)") are not human-readable and clutter
		// the popover; users can rename via the inline pencil icon.
		if len(wsList) == 0 {
			ws.Name = "Default"
		} else {
			ws.Name = fmt.Sprintf("Space %d", len(wsList)+1)
		}
		updated = true
	}
	if icon != "" {
		ws.Icon = icon
		updated = true
	} else if applyDefaults && ws.Icon == "" {
		ws.Icon = WorkspaceIcons[0]
		updated = true
	}
	if color != "" {
		ws.Color = color
		updated = true
	} else if applyDefaults && ws.Color == "" {
		ws.Color = WorkspaceColors[len(wsList)%len(WorkspaceColors)]
		updated = true
	}
	if updated {
		wstore.DBUpdate(ctx, ws)
	}
	return ws, updated, nil
}

// If force is true, it will delete even if workspace is named.
// If workspace is empty, it will be deleted, even if it is named.
// Returns true if workspace was deleted, false if it was not deleted.
func DeleteWorkspace(ctx context.Context, workspaceId string, force bool) (bool, string, error) {
	log.Printf("DeleteWorkspace %s\n", workspaceId)
	workspace, err := wstore.DBMustGet[*waveobj.Workspace](ctx, workspaceId)
	if err != nil {
		if wstore.ErrNotFound == err {
			return true, "", fmt.Errorf("workspace already deleted %w", err)
		}
		return false, "", fmt.Errorf("error loading workspace: %w", err)
	}
	// @jalileh list needs to be saved early on i assume
	workspaces, err := ListWorkspaces(ctx)
	if err != nil {
		return false, "", fmt.Errorf("error retrieving workspaceList: %w", err)
	}

	if workspace.Name != "" && workspace.Icon != "" && !force && len(workspace.TabIds) > 0 {
		log.Printf("Ignoring DeleteWorkspace for workspace %s as it is named\n", workspaceId)
		return false, "", nil
	}

	windowId, _ := wstore.DBFindWindowForWorkspaceId(ctx, workspaceId)
	err = deleteWorkspaceTabsAndObject(ctx, workspaceId)
	if err != nil {
		return false, "", err
	}
	log.Printf("deleted workspace %s\n", workspaceId)
	wps.Broker.Publish(wps.WaveEvent{
		Event: wps.Event_WorkspaceUpdate,
	})

	if windowId != "" {

		UnclaimedWorkspace, findAfter := "", false
		for _, ws := range workspaces {
			if ws.WorkspaceId == workspaceId {
				if UnclaimedWorkspace != "" {
					break
				}
				findAfter = true
				continue
			}
			if findAfter && ws.WindowId == "" {
				UnclaimedWorkspace = ws.WorkspaceId
				break
			} else if ws.WindowId == "" {
				UnclaimedWorkspace = ws.WorkspaceId
			}
		}

		if UnclaimedWorkspace != "" {
			return true, UnclaimedWorkspace, nil
		} else {
			err = CloseWindow(ctx, windowId, false)
		}

		if err != nil {
			return false, "", fmt.Errorf("error closing window: %w", err)
		}
	}
	return true, "", nil
}

func deleteWorkspaceTabsAndObject(ctx context.Context, workspaceId string) error {
	return wstore.WithTx(ctx, func(tx *wstore.TxWrap) error {
		workspace, err := wstore.DBMustGet[*waveobj.Workspace](tx.Context(), workspaceId)
		if err != nil {
			return err
		}
		if err := validateWorkspaceTabOwnershipInTx(tx, workspaceId, workspace.TabIds); err != nil {
			return fmt.Errorf("cannot delete workspace with invalid tab ownership: %w", err)
		}
		terminalIds := make(map[string]bool, len(workspace.TerminalTabIds))
		for _, tabId := range workspace.TerminalTabIds {
			if terminalIds[tabId] {
				return fmt.Errorf("workspace Terminal inventory contains duplicate %s", tabId)
			}
			terminalIds[tabId] = true
			if utilfn.FindStringInSlice(workspace.TabIds, tabId) == -1 {
				return fmt.Errorf("registered Terminal %s is missing from workspace tab inventory", tabId)
			}
			if err := ValidateTerminalTabMutation(tx, workspaceId, tabId, nil); err != nil {
				return fmt.Errorf("cannot delete registered Terminal %s: %w", tabId, err)
			}
		}

		tabs := make(map[string]*waveobj.Tab, len(workspace.TabIds))
		allBlocks := make(map[string]bool)
		var deletedBlockIds []string
		for _, tabId := range workspace.TabIds {
			tab, err := wstore.DBMustGet[*waveobj.Tab](tx.Context(), tabId)
			if err != nil {
				return fmt.Errorf("cannot delete Tab %s: %w", tabId, err)
			}
			path := make(map[string]bool)
			for _, blockId := range tab.BlockIds {
				if err := collectWorkspaceDeleteSubtree(
					tx,
					blockId,
					path,
					allBlocks,
					&deletedBlockIds,
				); err != nil {
					return fmt.Errorf("cannot delete Tab %s: %w", tabId, err)
				}
			}
			tabs[tabId] = tab
		}

		var legacyZoneIds []string
		for _, tabId := range workspace.TabIds {
			if terminalIds[tabId] {
				if err := DeleteTerminalTabInTx(tx, workspaceId, tabId); err != nil {
					return err
				}
				continue
			}
			tab := tabs[tabId]
			for _, blockId := range tab.BlockIds {
				zoneIds, err := deleteTerminalBlockSubtreeInTx(tx, blockId)
				if err != nil {
					return err
				}
				legacyZoneIds = append(legacyZoneIds, zoneIds...)
			}
			if err := wstore.DBDeleteInTxNoSideEffects(tx, waveobj.OType_Tab, tabId); err != nil {
				return err
			}
			legacyZoneIds = append(legacyZoneIds, tabId)
			if tab.LayoutState != "" {
				if err := wstore.DBDeleteInTxNoSideEffects(tx, waveobj.OType_LayoutState, tab.LayoutState); err != nil {
					return err
				}
				legacyZoneIds = append(legacyZoneIds, tab.LayoutState)
			}
		}
		if err := wstore.DBDeleteInTxNoSideEffects(tx, waveobj.OType_Workspace, workspaceId); err != nil {
			return err
		}
		if len(legacyZoneIds) > 0 {
			if err := wstore.RegisterAfterCommit(tx, func(callbackCtx context.Context) error {
				return cleanupTerminalTabZones(callbackCtx, legacyZoneIds)
			}); err != nil {
				return err
			}
		}
		return wstore.RegisterAfterCommit(tx, func(callbackCtx context.Context) error {
			for _, blockId := range deletedBlockIds {
				wstore.DeleteRTInfo(waveobj.MakeORef(waveobj.OType_Block, blockId))
				deleteWorkspaceBlockCloseEvent(blockId)
			}
			return nil
		})
	})
}

var deleteWorkspaceBlockCloseEvent = sendBlockCloseEvent

func collectWorkspaceDeleteSubtree(
	tx *wstore.TxWrap,
	blockId string,
	path map[string]bool,
	allBlocks map[string]bool,
	deletedBlockIds *[]string,
) error {
	if path[blockId] {
		return fmt.Errorf("cycle found in block subtree at %s", blockId)
	}
	if allBlocks[blockId] {
		return fmt.Errorf("block %s is referenced more than once", blockId)
	}
	path[blockId] = true
	allBlocks[blockId] = true
	*deletedBlockIds = append(*deletedBlockIds, blockId)
	block, err := wstore.DBMustGet[*waveobj.Block](tx.Context(), blockId)
	if err != nil {
		return err
	}
	for _, subBlockId := range block.SubBlockIds {
		if err := collectWorkspaceDeleteSubtree(tx, subBlockId, path, allBlocks, deletedBlockIds); err != nil {
			return err
		}
	}
	delete(path, blockId)
	return nil
}

// DiscardDirlessWorkspaces removes any workspace that has no workspace:dir
// meta. Space = Project requires every Space to be bound to a directory; this
// clears dev-era data from before that model. No backward compatibility. It
// enumerates ALL workspaces directly from the store (not via ListWorkspaces,
// which hides workspaces lacking Name/Icon/Color) so bare legacy workspaces
// are also purged.
func DiscardDirlessWorkspaces(ctx context.Context) error {
	workspaces, err := wstore.DBGetAllObjsByType[*waveobj.Workspace](ctx, waveobj.OType_Workspace)
	if err != nil {
		return fmt.Errorf("error listing workspaces: %w", err)
	}
	for _, ws := range workspaces {
		if ws.Meta.GetString(waveobj.MetaKey_WorkspaceDir, "") == "" {
			if _, _, err := DeleteWorkspace(ctx, ws.OID, true); err != nil {
				log.Printf("error discarding dirless workspace %s: %v", ws.OID, err)
			}
		}
	}
	return nil
}

func GetWorkspace(ctx context.Context, wsID string) (*waveobj.Workspace, error) {
	return wstore.DBMustGet[*waveobj.Workspace](ctx, wsID)
}

func getTabBackground() string {
	config := wconfig.GetWatcher().GetFullConfig()
	if config.Settings.TabBackground != "" {
		return config.Settings.TabBackground
	}
	return config.Settings.TabPreset
}

func defaultTabNameAndMeta(ctx context.Context, workspaceId string, tabName string) (string, waveobj.MetaMapType, error) {
	autoName := tabName == ""
	if !autoName {
		return tabName, nil, nil
	}
	return "", waveobj.MetaMapType{waveobj.MetaKey_TabAutoName: true}, nil
}

func applyTabBackground(ctx context.Context, tab *waveobj.Tab) {
	tabBg := getTabBackground()
	if tabBg == "" {
		return
	}
	tabORef := waveobj.ORefFromWaveObj(tab)
	wstore.UpdateObjectMeta(ctx, *tabORef, waveobj.MetaMapType{waveobj.MetaKey_TabBackground: tabBg}, false)
}

func createTabObj(ctx context.Context, workspaceId string, name string, meta waveobj.MetaMapType) (*waveobj.Tab, error) {
	ws, err := GetWorkspace(ctx, workspaceId)
	if err != nil {
		return nil, fmt.Errorf("workspace %s not found: %w", workspaceId, err)
	}
	layoutStateId := uuid.NewString()
	tab := &waveobj.Tab{
		OID:         uuid.NewString(),
		Name:        name,
		BlockIds:    []string{},
		LayoutState: layoutStateId,
		Meta:        meta,
	}
	layoutState := &waveobj.LayoutState{
		OID: layoutStateId,
	}
	ws.TabIds = append(ws.TabIds, tab.OID)
	wstore.DBInsert(ctx, tab)
	wstore.DBInsert(ctx, layoutState)
	wstore.DBUpdate(ctx, ws)
	return tab, nil
}

// Must delete all blocks individually first.
// Also deletes LayoutState.
// recursive: if true, will recursively close parent window, workspace, if they are empty.
// Returns new active tab id, error.
func DeleteTab(ctx context.Context, workspaceId string, tabId string, recursive bool) (string, error) {
	ws, _ := wstore.DBGet[*waveobj.Workspace](ctx, workspaceId)
	if ws == nil {
		return "", fmt.Errorf("workspace not found: %q", workspaceId)
	}

	// ensure tab is in workspace
	tabIdx := utilfn.FindStringInSlice(ws.TabIds, tabId)
	if tabIdx == -1 {
		return "", fmt.Errorf("tab %s not found in workspace %s", tabId, workspaceId)
	}
	if utilfn.FindStringInSlice(ws.TerminalTabIds, tabId) != -1 {
		return "", fmt.Errorf(
			"registered Terminal Tab %s must be closed through the Terminal service",
			tabId,
		)
	}
	ws.TabIds = append(ws.TabIds[:tabIdx], ws.TabIds[tabIdx+1:]...)

	// close blocks (sends events + stops block controllers)
	tab, _ := wstore.DBGet[*waveobj.Tab](ctx, tabId)
	if tab != nil {
		for _, blockId := range tab.BlockIds {
			err := DeleteBlock(ctx, blockId, false)
			if err != nil {
				return "", fmt.Errorf("error deleting block %s: %w", blockId, err)
			}
		}
	}

	// if the tab is active, determine new active tab
	newActiveTabId := ws.ActiveTabId
	if ws.ActiveTabId == tabId {
		if len(ws.TabIds) > 0 {
			newActiveTabId = ws.TabIds[max(0, min(tabIdx-1, len(ws.TabIds)-1))]
		} else {
			newActiveTabId = ""
		}
	}
	ws.ActiveTabId = newActiveTabId

	wstore.DBUpdate(ctx, ws)
	wstore.DBDelete(ctx, waveobj.OType_Tab, tabId)
	if tab != nil {
		wstore.DBDelete(ctx, waveobj.OType_LayoutState, tab.LayoutState)
	}

	// if no tabs remaining, close window
	if recursive && newActiveTabId == "" {
		log.Printf("no tabs remaining in workspace %s, closing window\n", workspaceId)
		windowId, err := wstore.DBFindWindowForWorkspaceId(ctx, workspaceId)
		if err != nil {
			return newActiveTabId, fmt.Errorf("unable to find window for workspace id %v: %w", workspaceId, err)
		}
		err = CloseWindow(ctx, windowId, false)
		if err != nil {
			return newActiveTabId, err
		}
	}
	return newActiveTabId, nil
}

func SendActiveTabUpdate(ctx context.Context, workspaceId string, newActiveTabId string) {
	eventbus.SendEventToElectron(eventbus.WSEventType{
		EventType: eventbus.WSEvent_ElectronUpdateActiveTab,
		Data:      &waveobj.ActiveTabUpdate{WorkspaceId: workspaceId, NewActiveTabId: newActiveTabId},
	})
}

func validateWorkspaceTabOwnershipInTx(tx *wstore.TxWrap, workspaceId string, tabIds []string) error {
	if _, err := uniqueTabIdSet(tabIds); err != nil {
		return err
	}
	workspaces, err := wstore.DBGetAllObjsByType[*waveobj.Workspace](tx.Context(), waveobj.OType_Workspace)
	if err != nil {
		return fmt.Errorf("cannot validate workspace tab ownership: %w", err)
	}
	for _, tabId := range tabIds {
		if _, err := wstore.DBMustGet[*waveobj.Tab](tx.Context(), tabId); err != nil {
			return fmt.Errorf("workspace tab %s does not exist: %w", tabId, err)
		}
		ownerCount := 0
		ownedByWorkspace := false
		for _, candidate := range workspaces {
			if utilfn.FindStringInSlice(candidate.TabIds, tabId) != -1 {
				ownerCount++
				ownedByWorkspace = ownedByWorkspace || candidate.OID == workspaceId
			}
		}
		if ownerCount != 1 || !ownedByWorkspace {
			return fmt.Errorf("workspace tab %s has foreign or ambiguous ownership", tabId)
		}
	}
	return nil
}

func uniqueTabIdSet(tabIds []string) (map[string]bool, error) {
	rtn := make(map[string]bool, len(tabIds))
	for _, tabId := range tabIds {
		if tabId == "" {
			return nil, fmt.Errorf("workspace tab inventory contains an empty id")
		}
		if rtn[tabId] {
			return nil, fmt.Errorf("workspace tab inventory contains duplicate %s", tabId)
		}
		rtn[tabId] = true
	}
	return rtn, nil
}

func ListWorkspaces(ctx context.Context) (waveobj.WorkspaceList, error) {
	workspaces, err := wstore.DBGetAllObjsByType[*waveobj.Workspace](ctx, waveobj.OType_Workspace)
	if err != nil {
		return nil, err
	}
	windows, err := wstore.DBGetAllObjsByType[*waveobj.Window](ctx, waveobj.OType_Window)
	if err != nil {
		return nil, err
	}
	workspaceToWindow := make(map[string]string)
	for _, window := range windows {
		workspaceToWindow[window.WorkspaceId] = window.OID
	}

	var wl waveobj.WorkspaceList
	for _, workspace := range workspaces {
		if workspace.Name == "" || workspace.Icon == "" || workspace.Color == "" {
			continue
		}
		windowId, ok := workspaceToWindow[workspace.OID]
		if !ok {
			windowId = ""
		}
		wl = append(wl, &waveobj.WorkspaceListEntry{
			WorkspaceId: workspace.OID,
			WindowId:    windowId,
		})
	}
	return wl, nil
}

func SetIcon(workspaceId string, icon string) error {
	ctx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
	defer cancel()
	ws, e := wstore.DBGet[*waveobj.Workspace](ctx, workspaceId)
	if e != nil {
		return e
	}
	if ws == nil {
		return fmt.Errorf("workspace not found: %q", workspaceId)
	}
	ws.Icon = icon
	wstore.DBUpdate(ctx, ws)
	return nil
}

func SetColor(workspaceId string, color string) error {
	ctx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
	defer cancel()
	ws, e := wstore.DBGet[*waveobj.Workspace](ctx, workspaceId)
	if e != nil {
		return e
	}
	if ws == nil {
		return fmt.Errorf("workspace not found: %q", workspaceId)
	}
	ws.Color = color
	wstore.DBUpdate(ctx, ws)
	return nil
}

func SetName(workspaceId string, name string) error {
	ctx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
	defer cancel()
	ws, e := wstore.DBGet[*waveobj.Workspace](ctx, workspaceId)
	if e != nil {
		return e
	}
	if ws == nil {
		return fmt.Errorf("workspace not found: %q", workspaceId)
	}
	ws.Name = name
	wstore.DBUpdate(ctx, ws)
	return nil
}
