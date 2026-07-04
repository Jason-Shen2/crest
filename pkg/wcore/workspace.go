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
	"github.com/s-zx/crest/pkg/telemetry"
	"github.com/s-zx/crest/pkg/telemetry/telemetrydata"
	"github.com/s-zx/crest/pkg/util/utilfn"
	"github.com/s-zx/crest/pkg/wavebase"
	"github.com/s-zx/crest/pkg/waveobj"
	"github.com/s-zx/crest/pkg/wconfig"
	"github.com/s-zx/crest/pkg/wps"
	"github.com/s-zx/crest/pkg/wshrpc"
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
	"terminal",   // the starter workspace — a terminal app
	"folder-01",  // a folder-backed project workspace
	"sparkles",   // a special / AI-flavored workspace
	"heart",      // favorites
	"rocket-01",  // new / launch
	"cube",       // a project / container
	"globe-02",   // web / cloud workspace
	"home-03",    // default home workspace
	"rocket",
	"flask",
	"paperclip",
	"chart-line",
	"graduation-cap",
	"mug-hot",
}

func CreateWorkspace(ctx context.Context, name string, icon string, color string, applyDefaults bool, isInitialLaunch bool) (*waveobj.Workspace, error) {
	ws := &waveobj.Workspace{
		OID:    uuid.NewString(),
		TabIds: []string{},
		Name:   "",
		Icon:   "",
		Color:  "",
	}
	err := wstore.DBInsert(ctx, ws)
	if err != nil {
		return nil, fmt.Errorf("error inserting workspace: %w", err)
	}
	_, err = CreateTab(ctx, ws.OID, "", true, isInitialLaunch)
	if err != nil {
		return nil, fmt.Errorf("error creating tab: %w", err)
	}

	wps.Broker.Publish(wps.WaveEvent{
		Event: wps.Event_WorkspaceUpdate,
	})

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
	if err != nil && wstore.ErrNotFound == err {
		return true, "", fmt.Errorf("workspace already deleted %w", err)
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

	for _, tabId := range workspace.TabIds {
		log.Printf("deleting tab %s\n", tabId)
		_, err := DeleteTab(ctx, workspaceId, tabId, false)
		if err != nil {
			return false, "", fmt.Errorf("error closing tab: %w", err)
		}
	}
	windowId, _ := wstore.DBFindWindowForWorkspaceId(ctx, workspaceId)
	err = wstore.DBDelete(ctx, waveobj.OType_Workspace, workspaceId)
	if err != nil {
		return false, "", fmt.Errorf("error deleting workspace: %w", err)
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

// defaultTabName returns the name a freshly created tab wears before the
// user renames it. New tabs open a shell in the home directory (see
// GetNewTabLayout), so we mirror terax and show that directory's basename
// immediately — no "T<n>" placeholder that later flickers into a real name.
func defaultTabName() string {
	home := wavebase.GetHomeDir()
	base := filepath.Base(home)
	if base == "" || base == "." || base == string(filepath.Separator) {
		return "Terminal"
	}
	return base
}

// returns tabid
func CreateTab(ctx context.Context, workspaceId string, tabName string, activateTab bool, isInitialLaunch bool) (string, error) {
	// autoName tracks whether the tab still wears an app-generated label
	// (as opposed to a user- or caller-chosen one). Auto-named tabs let the
	// frontend derive their label from block contents (cwd / file name).
	autoName := tabName == ""
	if autoName {
		tabName = defaultTabName()
	}

	var meta waveobj.MetaMapType
	if autoName {
		meta = waveobj.MetaMapType{waveobj.MetaKey_TabAutoName: true}
	}

	tab, err := createTabObj(ctx, workspaceId, tabName, meta)
	if err != nil {
		return "", fmt.Errorf("error creating tab: %w", err)
	}
	if activateTab {
		err = SetActiveTab(ctx, workspaceId, tab.OID)
		if err != nil {
			return "", fmt.Errorf("error setting active tab: %w", err)
		}
	}

	// No need to apply an initial layout for the initial launch, since the starter layout will get applied after onboarding modal dismissal
	if !isInitialLaunch {
		err = ApplyPortableLayout(ctx, tab.OID, GetNewTabLayout(), true)
		if err != nil {
			return tab.OID, fmt.Errorf("error applying new tab layout: %w", err)
		}
		tabBg := getTabBackground()
		if tabBg != "" {
			tabORef := waveobj.ORefFromWaveObj(tab)
			wstore.UpdateObjectMeta(ctx, *tabORef, waveobj.MetaMapType{waveobj.MetaKey_TabBackground: tabBg}, false)
		}
	}
	telemetry.GoUpdateActivityWrap(wshrpc.ActivityUpdate{NewTab: 1}, "createtab")
	telemetry.GoRecordTEventWrap(&telemetrydata.TEvent{
		Event: "action:createtab",
	})
	return tab.OID, nil
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

func SetActiveTab(ctx context.Context, workspaceId string, tabId string) error {
	if tabId != "" && workspaceId != "" {
		workspace, err := GetWorkspace(ctx, workspaceId)
		if err != nil {
			return fmt.Errorf("workspace %s not found: %w", workspaceId, err)
		}
		tab, _ := wstore.DBGet[*waveobj.Tab](ctx, tabId)
		if tab == nil {
			return fmt.Errorf("tab not found: %q", tabId)
		}
		workspace.ActiveTabId = tabId
		wstore.DBUpdate(ctx, workspace)
	}
	return nil
}

func SendActiveTabUpdate(ctx context.Context, workspaceId string, newActiveTabId string) {
	eventbus.SendEventToElectron(eventbus.WSEventType{
		EventType: eventbus.WSEvent_ElectronUpdateActiveTab,
		Data:      &waveobj.ActiveTabUpdate{WorkspaceId: workspaceId, NewActiveTabId: newActiveTabId},
	})
}

func UpdateWorkspaceTabIds(ctx context.Context, workspaceId string, tabIds []string) error {
	ws, _ := wstore.DBGet[*waveobj.Workspace](ctx, workspaceId)
	if ws == nil {
		return fmt.Errorf("workspace not found: %q", workspaceId)
	}
	ws.TabIds = tabIds
	wstore.DBUpdate(ctx, ws)
	return nil
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
