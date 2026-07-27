// Copyright 2025, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

package wcore

import (
	"context"
	"fmt"
	"log"
	"sync"
	"time"

	"github.com/google/uuid"
	"github.com/s-zx/crest/pkg/filestore"
	"github.com/s-zx/crest/pkg/panichandler"
	"github.com/s-zx/crest/pkg/telemetry"
	"github.com/s-zx/crest/pkg/telemetry/telemetrydata"
	"github.com/s-zx/crest/pkg/util/utilfn"
	"github.com/s-zx/crest/pkg/waveobj"
	"github.com/s-zx/crest/pkg/wps"
	"github.com/s-zx/crest/pkg/wshrpc"
	"github.com/s-zx/crest/pkg/wstore"
)

func CreateSubBlock(ctx context.Context, blockId string, blockDef *waveobj.BlockDef) (*waveobj.Block, error) {
	if err := validateBlockDef(blockDef); err != nil {
		return nil, err
	}
	blockData, err := createSubBlockObj(ctx, blockId, blockDef)
	if err != nil {
		return nil, fmt.Errorf("error creating sub block: %w", err)
	}
	return blockData, nil
}

func createSubBlockObj(ctx context.Context, parentBlockId string, blockDef *waveobj.BlockDef) (*waveobj.Block, error) {
	return wstore.WithTxRtn(ctx, func(tx *wstore.TxWrap) (*waveobj.Block, error) {
		parentBlock, _ := wstore.DBGet[*waveobj.Block](tx.Context(), parentBlockId)
		if parentBlock == nil {
			return nil, fmt.Errorf("parent block not found: %q", parentBlockId)
		}
		tabId, err := findTabForBlockInTx(tx, parentBlockId)
		if err != nil {
			return nil, err
		}
		view := blockDef.Meta.GetString(waveobj.MetaKey_View, "")
		if _, err := validateTerminalDomainTabWrite(tx, tabId, []string{view}); err != nil {
			return nil, err
		}
		blockId := uuid.NewString()
		blockData := &waveobj.Block{
			OID:         blockId,
			ParentORef:  waveobj.MakeORef(waveobj.OType_Block, parentBlockId).String(),
			RuntimeOpts: nil,
			Meta:        blockDef.Meta,
		}
		if err := wstore.DBInsert(tx.Context(), blockData); err != nil {
			return nil, err
		}
		parentBlock.SubBlockIds = append(parentBlock.SubBlockIds, blockId)
		if err := wstore.DBUpdate(tx.Context(), parentBlock); err != nil {
			return nil, err
		}
		return blockData, nil
	})
}

func CreateBlock(ctx context.Context, tabId string, blockDef *waveobj.BlockDef, rtOpts *waveobj.RuntimeOpts) (rtnBlock *waveobj.Block, rtnErr error) {
	return CreateBlockWithTelemetry(ctx, tabId, blockDef, rtOpts, true)
}

func CreateBlockWithTelemetry(ctx context.Context, tabId string, blockDef *waveobj.BlockDef, rtOpts *waveobj.RuntimeOpts, recordTelemetry bool) (rtnBlock *waveobj.Block, rtnErr error) {
	var blockCreated bool
	var newBlockOID string
	defer func() {
		if rtnErr == nil {
			return
		}
		// if there was an error, and we created the block, clean it up since the function failed
		if blockCreated && newBlockOID != "" {
			deleteBlockObj(ctx, newBlockOID)
			filestore.WFS.DeleteZone(ctx, newBlockOID)
		}
	}()
	if err := validateBlockDef(blockDef); err != nil {
		return nil, err
	}
	blockData, err := createBlockObj(ctx, tabId, blockDef, rtOpts)
	if err != nil {
		return nil, fmt.Errorf("error creating block: %w", err)
	}
	blockCreated = true
	newBlockOID = blockData.OID
	// upload the files if present
	if len(blockDef.Files) > 0 {
		for fileName, fileDef := range blockDef.Files {
			err := filestore.WFS.MakeFile(ctx, newBlockOID, fileName, fileDef.Meta, wshrpc.FileOpts{})
			if err != nil {
				return nil, fmt.Errorf("error making blockfile %q: %w", fileName, err)
			}
			err = filestore.WFS.WriteFile(ctx, newBlockOID, fileName, []byte(fileDef.Content))
			if err != nil {
				return nil, fmt.Errorf("error writing blockfile %q: %w", fileName, err)
			}
		}
	}
	if recordTelemetry {
		blockView := blockDef.Meta.GetString(waveobj.MetaKey_View, "")
		blockController := blockDef.Meta.GetString(waveobj.MetaKey_Controller, "")
		go recordBlockCreationTelemetry(blockView, blockController)
	}
	return blockData, nil
}

func validateBlockDef(blockDef *waveobj.BlockDef) error {
	if blockDef == nil {
		return fmt.Errorf("blockDef is nil")
	}
	if blockDef.Meta == nil || blockDef.Meta.GetString(waveobj.MetaKey_View, "") == "" {
		return fmt.Errorf("no view provided for new block")
	}
	return nil
}

func recordBlockCreationTelemetry(blockView string, blockController string) {
	defer func() {
		panichandler.PanicHandler("CreateBlock:telemetry", recover())
	}()
	if blockView == "" {
		return
	}
	tctx, cancelFn := context.WithTimeout(context.Background(), 2*time.Second)
	defer cancelFn()
	telemetry.UpdateActivity(tctx, wshrpc.ActivityUpdate{
		Renderers: map[string]int{blockView: 1},
	})
	telemetry.RecordTEvent(tctx, &telemetrydata.TEvent{
		Event: "action:createblock",
		Props: telemetrydata.TEventProps{
			BlockView:       blockView,
			BlockController: blockController,
		},
	})
}

func createBlockObj(ctx context.Context, tabId string, blockDef *waveobj.BlockDef, rtOpts *waveobj.RuntimeOpts) (*waveobj.Block, error) {
	return wstore.WithTxRtn(ctx, func(tx *wstore.TxWrap) (*waveobj.Block, error) {
		return createBlockObjInTx(tx, tabId, blockDef, rtOpts)
	})
}

func createBlockObjInTx(tx *wstore.TxWrap, tabId string, blockDef *waveobj.BlockDef, rtOpts *waveobj.RuntimeOpts) (*waveobj.Block, error) {
	tab, _ := wstore.DBGet[*waveobj.Tab](tx.Context(), tabId)
	if tab == nil {
		return nil, fmt.Errorf("tab not found: %q", tabId)
	}
	view := blockDef.Meta.GetString(waveobj.MetaKey_View, "")
	if _, err := validateTerminalDomainTabWrite(tx, tabId, []string{view}); err != nil {
		return nil, err
	}
	blockId := uuid.NewString()
	blockData := &waveobj.Block{
		OID:         blockId,
		ParentORef:  waveobj.MakeORef(waveobj.OType_Tab, tabId).String(),
		RuntimeOpts: rtOpts,
		Meta:        blockDef.Meta,
	}
	if err := wstore.DBInsert(tx.Context(), blockData); err != nil {
		return nil, err
	}
	tab.BlockIds = append(tab.BlockIds, blockId)
	if err := wstore.DBUpdate(tx.Context(), tab); err != nil {
		return nil, err
	}
	return blockData, nil
}

// Must delete all blocks individually first.
// Also deletes LayoutState.
// recursive: if true, will recursively close parent tab, window, workspace, if they are empty.
// Returns new active tab id, error.
func DeleteBlock(ctx context.Context, blockId string, recursive bool) error {
	block, err := wstore.DBGet[*waveobj.Block](ctx, blockId)
	if err != nil {
		return fmt.Errorf("error getting block: %w", err)
	}
	if block == nil {
		return nil
	}
	handled, err := deleteRegisteredTerminalRoot(ctx, block)
	if err != nil {
		return err
	}
	if handled {
		return nil
	}
	if len(block.SubBlockIds) > 0 {
		for _, subBlockId := range block.SubBlockIds {
			err := DeleteBlock(ctx, subBlockId, recursive)
			if err != nil {
				return fmt.Errorf("error deleting subblock %s: %w", subBlockId, err)
			}
		}
	}
	parentBlockCount, err := deleteBlockObj(ctx, blockId)
	if err != nil {
		return fmt.Errorf("error deleting block: %w", err)
	}
	log.Printf("DeleteBlock: parentBlockCount: %d", parentBlockCount)
	parentORef := waveobj.ParseORefNoErr(block.ParentORef)

	if recursive && parentORef.OType == waveobj.OType_Tab && parentBlockCount == 0 {
		// if parent tab has no blocks, delete the tab
		log.Printf("DeleteBlock: parent tab has no blocks, deleting tab %s", parentORef.OID)
		parentWorkspaceId, err := wstore.DBFindWorkspaceForTabId(ctx, parentORef.OID)
		if err != nil {
			return fmt.Errorf("error finding workspace for tab to delete %s: %w", parentORef.OID, err)
		}
		newActiveTabId, err := DeleteTab(ctx, parentWorkspaceId, parentORef.OID, true)
		if err != nil {
			return fmt.Errorf("error deleting tab %s: %w", parentORef.OID, err)
		}
		SendActiveTabUpdate(ctx, parentWorkspaceId, newActiveTabId)
	}
	sendBlockCloseEvent(blockId)
	return nil
}

type refCountKeyedMutexEntry struct {
	mutex sync.Mutex
	refs  int
}

type refCountKeyedMutex struct {
	mutex   sync.Mutex
	entries map[string]*refCountKeyedMutexEntry
}

func newRefCountKeyedMutex() *refCountKeyedMutex {
	return &refCountKeyedMutex{entries: make(map[string]*refCountKeyedMutexEntry)}
}

func (pool *refCountKeyedMutex) lock(key string) func() {
	pool.mutex.Lock()
	entry := pool.entries[key]
	if entry == nil {
		entry = &refCountKeyedMutexEntry{}
		pool.entries[key] = entry
	}
	entry.refs++
	pool.mutex.Unlock()

	entry.mutex.Lock()
	return func() {
		entry.mutex.Unlock()
		pool.mutex.Lock()
		entry.refs--
		if entry.refs == 0 && pool.entries[key] == entry {
			delete(pool.entries, key)
		}
		pool.mutex.Unlock()
	}
}

func (pool *refCountKeyedMutex) size() int {
	pool.mutex.Lock()
	defer pool.mutex.Unlock()
	return len(pool.entries)
}

var terminalRootDeleteLocks = newRefCountKeyedMutex()

type terminalRootDeleteResult struct {
	handled         bool
	deletedBlockIds []string
}

func deleteRegisteredTerminalRoot(ctx context.Context, block *waveobj.Block) (bool, error) {
	parentORef := waveobj.ParseORefNoErr(block.ParentORef)
	if parentORef == nil || parentORef.OType != waveobj.OType_Tab {
		return false, nil
	}
	release := terminalRootDeleteLocks.lock(parentORef.OID)
	result, err := func() (terminalRootDeleteResult, error) {
		defer release()
		return wstore.WithTxRtn(ctx, func(tx *wstore.TxWrap) (terminalRootDeleteResult, error) {
			current, err := wstore.DBGet[*waveobj.Block](tx.Context(), block.OID)
			if err != nil {
				return terminalRootDeleteResult{}, err
			}
			if current == nil {
				return terminalRootDeleteResult{handled: true}, nil
			}
			currentParent := waveobj.ParseORefNoErr(current.ParentORef)
			if currentParent == nil || currentParent.OType != waveobj.OType_Tab || currentParent.OID != parentORef.OID {
				return terminalRootDeleteResult{}, nil
			}
			workspaceId, err := wstore.DBFindWorkspaceForTabId(tx.Context(), parentORef.OID)
			if err != nil || workspaceId == "" {
				return terminalRootDeleteResult{}, err
			}
			workspace, err := wstore.DBMustGet[*waveobj.Workspace](tx.Context(), workspaceId)
			if err != nil {
				return terminalRootDeleteResult{}, err
			}
			if utilfn.FindStringInSlice(workspace.TerminalTabIds, parentORef.OID) == -1 {
				return terminalRootDeleteResult{}, nil
			}
			tab, err := wstore.DBMustGet[*waveobj.Tab](tx.Context(), parentORef.OID)
			if err != nil {
				return terminalRootDeleteResult{handled: true}, err
			}
			if utilfn.FindStringInSlice(tab.BlockIds, current.OID) == -1 {
				return terminalRootDeleteResult{handled: true},
					fmt.Errorf("registered Terminal root %s is missing from Tab inventory", current.OID)
			}
			if len(tab.BlockIds) <= 1 {
				return terminalRootDeleteResult{handled: true}, fmt.Errorf(
					"final registered Terminal block %s must be deleted through CloseTerminalTab",
					current.OID,
				)
			}
			deletedBlockIds, err := deleteTerminalBlockSubtreeInTx(tx, current.OID)
			if err != nil {
				return terminalRootDeleteResult{handled: true}, err
			}
			tab.BlockIds = utilfn.RemoveElemFromSlice(tab.BlockIds, current.OID)
			if err := wstore.DBUpdate(tx.Context(), tab); err != nil {
				return terminalRootDeleteResult{handled: true}, err
			}
			return terminalRootDeleteResult{handled: true, deletedBlockIds: deletedBlockIds}, nil
		})
	}()
	if err != nil {
		return result.handled, err
	}
	if len(result.deletedBlockIds) > 0 {
		runTerminalRootDeleteSideEffects(result.deletedBlockIds)
	}
	return result.handled, nil
}

func runTerminalRootDeleteSideEffects(blockIds []string) {
	func() {
		defer func() {
			panichandler.PanicHandler("DeleteBlock:cleanupTerminalRootZones", recover())
		}()
		cleanupCtx, cancelCleanup := context.WithTimeout(context.Background(), 2*time.Second)
		defer cancelCleanup()
		if err := cleanupTerminalTabZones(cleanupCtx, blockIds); err != nil {
			log.Printf("error cleaning deleted Terminal root zones: %v", err)
		}
	}()
	func() {
		defer func() {
			panichandler.PanicHandler("DeleteBlock:terminalRootSideEffects", recover())
		}()
		for _, blockId := range blockIds {
			wstore.DeleteRTInfo(waveobj.MakeORef(waveobj.OType_Block, blockId))
			sendBlockCloseEvent(blockId)
		}
	}()
}

// returns the updated block count for the parent object
func deleteBlockObj(ctx context.Context, blockId string) (int, error) {
	return wstore.WithTxRtn(ctx, func(tx *wstore.TxWrap) (int, error) {
		block, err := wstore.DBGet[*waveobj.Block](tx.Context(), blockId)
		if err != nil {
			return -1, fmt.Errorf("error getting block: %w", err)
		}
		if block == nil {
			return -1, fmt.Errorf("block not found: %q", blockId)
		}
		if len(block.SubBlockIds) > 0 {
			return -1, fmt.Errorf("block has subblocks, must delete subblocks first")
		}
		parentORef := waveobj.ParseORefNoErr(block.ParentORef)
		parentBlockCount := -1
		if parentORef != nil {
			if parentORef.OType == waveobj.OType_Tab {
				tab, _ := wstore.DBGet[*waveobj.Tab](tx.Context(), parentORef.OID)
				if tab != nil {
					tab.BlockIds = utilfn.RemoveElemFromSlice(tab.BlockIds, blockId)
					wstore.DBUpdate(tx.Context(), tab)
					parentBlockCount = len(tab.BlockIds)
				}
			} else if parentORef.OType == waveobj.OType_Block {
				parentBlock, _ := wstore.DBGet[*waveobj.Block](tx.Context(), parentORef.OID)
				if parentBlock != nil {
					parentBlock.SubBlockIds = utilfn.RemoveElemFromSlice(parentBlock.SubBlockIds, blockId)
					wstore.DBUpdate(tx.Context(), parentBlock)
					parentBlockCount = len(parentBlock.SubBlockIds)
				}
			}
		}
		wstore.DBDelete(tx.Context(), waveobj.OType_Block, blockId)

		// Clean up block runtime info
		blockORef := waveobj.MakeORef(waveobj.OType_Block, blockId)
		wstore.DeleteRTInfo(blockORef)

		return parentBlockCount, nil
	})
}

func sendBlockCloseEvent(blockId string) {
	waveEvent := wps.WaveEvent{
		Event: wps.Event_BlockClose,
		Scopes: []string{
			waveobj.MakeORef(waveobj.OType_Block, blockId).String(),
		},
		Data: blockId,
	}
	wps.Broker.Publish(waveEvent)
}
