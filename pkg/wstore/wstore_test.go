// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

package wstore

import (
	"context"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"testing"

	"github.com/s-zx/crest/pkg/wavebase"
	"github.com/s-zx/crest/pkg/waveobj"
)

func TestAfterCommitRunsOnlyAfterSuccessfulOutermostCommit(t *testing.T) {
	ctx := setupWStoreTest(t)
	var callbackOrder []string
	outerReturned := false
	err := WithTx(ctx, func(tx *TxWrap) error {
		if err := RegisterAfterCommit(tx, func(context.Context) error {
			if outerReturned {
				t.Fatalf("callback ran after WithTx returned instead of before return")
			}
			callbackOrder = append(callbackOrder, "outer")
			return nil
		}); err != nil {
			return err
		}
		if err := WithTx(tx.Context(), func(nestedTx *TxWrap) error {
			return RegisterAfterCommit(nestedTx, func(context.Context) error {
				callbackOrder = append(callbackOrder, "nested")
				return nil
			})
		}); err != nil {
			return err
		}
		if len(callbackOrder) != 0 {
			t.Fatalf("callback ran before outer commit")
		}
		return nil
	})
	outerReturned = true
	if err != nil {
		t.Fatalf("WithTx: %v", err)
	}
	if fmt.Sprint(callbackOrder) != "[outer nested]" {
		t.Fatalf("callback order = %v, want [outer nested]", callbackOrder)
	}
}

func TestAfterCommitDoesNotRunOnRollback(t *testing.T) {
	ctx := setupWStoreTest(t)
	callbackRan := false
	err := WithTx(ctx, func(tx *TxWrap) error {
		if err := RegisterAfterCommit(tx, func(context.Context) error {
			callbackRan = true
			return nil
		}); err != nil {
			return err
		}
		return fmt.Errorf("rollback")
	})
	if err == nil {
		t.Fatalf("WithTx unexpectedly committed")
	}
	if callbackRan {
		t.Fatalf("callback ran after rollback")
	}
}

func TestAfterCommitLogsCallbackErrorsAndPreservesCommitSuccess(t *testing.T) {
	ctx := setupWStoreTest(t)
	firstErr := errors.New("first callback")
	secondRan := false
	tab := &waveobj.Tab{OID: "after-commit-error-tab"}
	err := WithTx(ctx, func(tx *TxWrap) error {
		if err := DBInsert(tx.Context(), tab); err != nil {
			return err
		}
		if err := RegisterAfterCommit(tx, func(context.Context) error {
			return firstErr
		}); err != nil {
			return err
		}
		return RegisterAfterCommit(tx, func(context.Context) error {
			secondRan = true
			return nil
		})
	})
	if err != nil {
		t.Fatalf("WithTx returned post-commit callback error: %v", err)
	}
	if !secondRan {
		t.Fatalf("callback after error did not run")
	}
	if committedTab, _ := DBGet[*waveobj.Tab](ctx, tab.OID); committedTab == nil {
		t.Fatalf("callback error rolled back committed database transaction")
	}
}

func TestAfterCommitRecoversCallbackPanicAndPreservesCommitSuccess(t *testing.T) {
	ctx := setupWStoreTest(t)
	secondRan := false
	err := WithTx(ctx, func(tx *TxWrap) error {
		if err := RegisterAfterCommit(tx, func(context.Context) error {
			panic("cleanup panic")
		}); err != nil {
			return err
		}
		return RegisterAfterCommit(tx, func(context.Context) error {
			secondRan = true
			return nil
		})
	})
	if err != nil {
		t.Fatalf("WithTx returned post-commit callback panic: %v", err)
	}
	if !secondRan {
		t.Fatalf("callback after panic did not run")
	}
}

func TestAfterCommitUsesIndependentBoundedContext(t *testing.T) {
	baseCtx := setupWStoreTest(t)
	type requestContextKey struct{}
	requestCtx := context.WithValue(baseCtx, requestContextKey{}, "request")
	callbackRan := false
	err := WithTx(requestCtx, func(tx *TxWrap) error {
		if err := RegisterAfterCommit(tx, func(callbackCtx context.Context) error {
			callbackRan = true
			if callbackCtx.Err() != nil {
				t.Fatalf("callback context inherited cancellation: %v", callbackCtx.Err())
			}
			if callbackCtx.Value(requestContextKey{}) != nil {
				t.Fatalf("callback context inherited request values")
			}
			if _, ok := callbackCtx.Deadline(); !ok {
				t.Fatalf("callback context has no deadline")
			}
			return nil
		}); err != nil {
			return err
		}
		return nil
	})
	if err != nil {
		t.Fatalf("WithTx: %v", err)
	}
	if !callbackRan {
		t.Fatalf("callback did not run")
	}
}

func TestUpdateTabNameMarksTabAsManual(t *testing.T) {
	ctx := setupWStoreTest(t)
	tab := &waveobj.Tab{
		OID:  "tab-manual-name",
		Name: "T1",
		Meta: waveobj.MetaMapType{
			waveobj.MetaKey_TabAutoName: true,
		},
	}
	if err := DBInsert(ctx, tab); err != nil {
		t.Fatalf("DBInsert returned error: %v", err)
	}

	if err := UpdateTabName(ctx, tab.OID, "T1"); err != nil {
		t.Fatalf("UpdateTabName returned error: %v", err)
	}

	updatedTab, err := DBMustGet[*waveobj.Tab](ctx, tab.OID)
	if err != nil {
		t.Fatalf("DBMustGet returned error: %v", err)
	}
	if updatedTab.Name != "T1" {
		t.Fatalf("Name = %q, want %q", updatedTab.Name, "T1")
	}
	if updatedTab.Meta[waveobj.MetaKey_TabAutoName] != false {
		t.Fatalf("tab:autoname = %#v, want false", updatedTab.Meta[waveobj.MetaKey_TabAutoName])
	}
}

func TestResetTabNameClearsPersistentNameAndMarksAutoName(t *testing.T) {
	ctx := setupWStoreTest(t)
	tab := &waveobj.Tab{
		OID:  "tab-reset-name",
		Name: "Pinned Editor",
		Meta: waveobj.MetaMapType{
			waveobj.MetaKey_TabAutoName: false,
		},
	}
	if err := DBInsert(ctx, tab); err != nil {
		t.Fatalf("DBInsert returned error: %v", err)
	}

	if err := ResetTabName(ctx, tab.OID, "ignored-reset-name"); err != nil {
		t.Fatalf("ResetTabName returned error: %v", err)
	}

	updatedTab, err := DBMustGet[*waveobj.Tab](ctx, tab.OID)
	if err != nil {
		t.Fatalf("DBMustGet returned error: %v", err)
	}
	if updatedTab.Name != "" {
		t.Fatalf("Name = %q, want empty persistent name", updatedTab.Name)
	}
	if updatedTab.Meta[waveobj.MetaKey_TabAutoName] != true {
		t.Fatalf("tab:autoname = %#v, want true", updatedTab.Meta[waveobj.MetaKey_TabAutoName])
	}
}

func setupWStoreTest(t *testing.T) context.Context {
	t.Helper()
	wavebase.DataHome_VarCache = t.TempDir()
	wavebase.ConfigHome_VarCache = t.TempDir()
	if err := wavebase.EnsureWaveDBDir(); err != nil {
		t.Fatalf("EnsureWaveDBDir returned error: %v", err)
	}
	if err := os.MkdirAll(filepath.Join(wavebase.DataHome_VarCache, wavebase.WaveDBDir), 0o700); err != nil {
		t.Fatalf("MkdirAll wave db dir returned error: %v", err)
	}
	if err := InitWStore(); err != nil {
		t.Fatalf("InitWStore returned error: %v", err)
	}
	t.Cleanup(func() {
		if globalDB != nil {
			_ = globalDB.Close()
			globalDB = nil
		}
	})
	return context.Background()
}
