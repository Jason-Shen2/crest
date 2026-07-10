// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

package wcore

import (
	"testing"

	"github.com/s-zx/crest/pkg/waveobj"
)

func TestDefaultShellLayoutsUseAgentView(t *testing.T) {
	starter := GetStarterLayout()
	if got := starter[0].BlockDef.Meta[waveobj.MetaKey_View]; got != "agent" {
		t.Fatalf("starter layout view = %q, want agent", got)
	}
	if got := starter[0].BlockDef.Meta[waveobj.MetaKey_Controller]; got != "shell" {
		t.Fatalf("starter layout controller = %q, want shell", got)
	}

	newTab := GetNewTabLayout("/repo")
	if got := newTab[0].BlockDef.Meta[waveobj.MetaKey_View]; got != "agent" {
		t.Fatalf("new tab layout view = %q, want agent", got)
	}
	if got := newTab[0].BlockDef.Meta[waveobj.MetaKey_Controller]; got != "shell" {
		t.Fatalf("new tab layout controller = %q, want shell", got)
	}
	if got := newTab[0].BlockDef.Meta[waveobj.MetaKey_CmdCwd]; got != "/repo" {
		t.Fatalf("new tab layout cwd = %q, want /repo", got)
	}
}
