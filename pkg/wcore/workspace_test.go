// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

package wcore

import (
	"context"
	"testing"
)

func TestDefaultTabNameAndMetaExplicitName(t *testing.T) {
	tabName, meta, err := defaultTabNameAndMeta(context.Background(), "workspace-1", "Editor")
	if err != nil {
		t.Fatalf("defaultTabNameAndMeta returned error: %v", err)
	}
	if tabName != "Editor" {
		t.Fatalf("tabName = %q, want %q", tabName, "Editor")
	}
	if meta != nil {
		t.Fatalf("meta = %#v, want nil", meta)
	}
}
