// Copyright 2026, s-zx
// SPDX-License-Identifier: Apache-2.0

package shellutil

import (
	"strings"
	"testing"
)

func TestBlockShellIntegrationsCarryTheTeraxLayoutContract(t *testing.T) {
	tests := []struct {
		name   string
		script string
	}{
		{name: "zsh", script: ZshStartup_Zshrc},
		{name: "bash", script: BashStartup_Bashrc},
		{name: "fish", script: FishStartup_Wavefish},
		{name: "pwsh", script: PwshStartup_wavepwsh},
	}

	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			for _, required := range []string{"WAVETERM_BLOCKS", "133;B", "133;C;"} {
				if !strings.Contains(tc.script, required) {
					t.Errorf("shell integration is missing %q", required)
				}
			}
		})
	}
}
