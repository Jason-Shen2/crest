// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

package workspaceservice

import (
	"reflect"
	"testing"
)

func TestCreateTabWithBlockMeta(t *testing.T) {
	svc := &WorkspaceService{}
	meta := svc.CreateTabWithBlock_Meta()
	wantArgs := []string{"workspaceId", "tabName", "activateTab", "blockDef"}
	if !reflect.DeepEqual(meta.ArgNames, wantArgs) {
		t.Fatalf("ArgNames = %#v, want %#v", meta.ArgNames, wantArgs)
	}
	if meta.ReturnDesc != "tabId" {
		t.Fatalf("ReturnDesc = %q, want %q", meta.ReturnDesc, "tabId")
	}
}
