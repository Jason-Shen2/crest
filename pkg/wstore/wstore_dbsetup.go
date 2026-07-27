// Copyright 2025, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

package wstore

import (
	"context"
	"fmt"
	"log"
	"path/filepath"
	"time"

	"github.com/jmoiron/sqlx"
	"github.com/s-zx/crest/pkg/util/migrateutil"
	"github.com/s-zx/crest/pkg/wavebase"
	"github.com/s-zx/crest/pkg/waveobj"
	"github.com/sawka/txwrap"

	dbfs "github.com/s-zx/crest/db"
)

const WStoreDBName = "waveterm.db"

type TxWrap = txwrap.TxWrap

var globalDB *sqlx.DB

type afterCommitKey struct{}

type afterCommitState struct {
	callbacks []func(context.Context) error
}

func InitWStore() error {
	ctx, cancelFn := context.WithTimeout(context.Background(), 2*time.Second)
	defer cancelFn()
	var err error
	globalDB, err = MakeDB(ctx)
	if err != nil {
		return err
	}
	err = migrateutil.Migrate("wstore", globalDB.DB, dbfs.WStoreMigrationFS, "migrations-wstore")
	if err != nil {
		return err
	}
	log.Printf("wstore initialized\n")
	return nil
}

func GetDBName() string {
	waveHome := wavebase.GetWaveDataDir()
	return filepath.Join(waveHome, wavebase.WaveDBDir, WStoreDBName)
}

func MakeDB(ctx context.Context) (*sqlx.DB, error) {
	dbName := GetDBName()
	rtn, err := sqlx.Open("sqlite3", fmt.Sprintf("file:%s?mode=rwc&_journal_mode=WAL&_busy_timeout=5000", dbName))
	if err != nil {
		return nil, err
	}
	rtn.DB.SetMaxOpenConns(1)
	return rtn, nil
}

func WithTx(ctx context.Context, fn func(tx *TxWrap) error) (rtnErr error) {
	state, _ := ctx.Value(afterCommitKey{}).(*afterCommitState)
	isOutermost := state == nil
	if isOutermost {
		state = &afterCommitState{}
		ctx = context.WithValue(ctx, afterCommitKey{}, state)
	}
	waveobj.ContextUpdatesBeginTx(ctx)
	updatesFinished := false
	defer func() {
		if !updatesFinished {
			waveobj.ContextUpdatesRollbackTx(ctx)
		}
	}()
	rtnErr = txwrap.WithTx(ctx, globalDB, fn)
	if rtnErr != nil {
		waveobj.ContextUpdatesRollbackTx(ctx)
		updatesFinished = true
		return rtnErr
	}
	waveobj.ContextUpdatesCommitTx(ctx)
	updatesFinished = true
	if !isOutermost {
		return nil
	}
	runAfterCommitCallbacks(state)
	return nil
}

func WithTxRtn[RT any](ctx context.Context, fn func(tx *TxWrap) (RT, error)) (rtnVal RT, rtnErr error) {
	rtnErr = WithTx(ctx, func(tx *TxWrap) error {
		var err error
		rtnVal, err = fn(tx)
		return err
	})
	return rtnVal, rtnErr
}

func RegisterAfterCommit(tx *TxWrap, callback func(context.Context) error) error {
	if callback == nil {
		return fmt.Errorf("after-commit callback is nil")
	}
	state, _ := tx.Context().Value(afterCommitKey{}).(*afterCommitState)
	if state == nil {
		return fmt.Errorf("transaction does not support after-commit callbacks")
	}
	state.callbacks = append(state.callbacks, callback)
	return nil
}

func runAfterCommitCallbacks(state *afterCommitState) {
	for _, callback := range state.callbacks {
		callbackCtx, cancelCallback := context.WithTimeout(context.Background(), 2*time.Second)
		err := runAfterCommitCallback(callbackCtx, callback)
		cancelCallback()
		if err != nil {
			log.Printf("after-commit callback failed: %v", err)
		}
	}
}

func runAfterCommitCallback(ctx context.Context, callback func(context.Context) error) (rtnErr error) {
	defer func() {
		if panicVal := recover(); panicVal != nil {
			rtnErr = fmt.Errorf("after-commit callback panic: %v", panicVal)
		}
	}()
	return callback(ctx)
}
