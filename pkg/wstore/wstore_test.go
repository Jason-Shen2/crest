// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

package wstore

import (
	"context"
	"testing"

	"github.com/s-zx/crest/pkg/wavebase"
	"github.com/s-zx/crest/pkg/waveobj"
)

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

func setupWStoreTest(t *testing.T) context.Context {
	t.Helper()
	wavebase.DataHome_VarCache = t.TempDir()
	wavebase.ConfigHome_VarCache = t.TempDir()
	if err := wavebase.EnsureWaveDBDir(); err != nil {
		t.Fatalf("EnsureWaveDBDir returned error: %v", err)
	}
	if err := InitWStore(); err != nil {
		t.Fatalf("InitWStore returned error: %v", err)
	}
	return context.Background()
}
