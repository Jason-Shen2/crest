// Copyright 2026, s-zx
// SPDX-License-Identifier: Apache-2.0

package contextchip

import (
	"context"
	"fmt"
	"os/exec"
	"time"
)

// Fetch runs a single chip's generator in the given cwd and returns the
// resulting value or a failure marker.  Stateless — the frontend
// ChipFetcher model owns fingerprint caching, invalidate-on-command
// counting, and rate-limiting.
//
// Required executables on the chip's RuntimePolicy are checked first;
// missing ones produce ChipValue{Value:"", Failed:true} so the chip can
// hide cleanly rather than blocking on a never-returning exec.
//
// Errors are returned to the RPC layer as Go errors; the response carries
// the value when it's available.  Empty string + Failed=false = chip has
// no value in this context (e.g. git branch outside a repo).
func Fetch(ctx context.Context, kind ChipKind, cwd string) (string, bool, error) {
	chip := LookupChip(kind)
	if chip == nil {
		return "", false, fmt.Errorf("unknown chip kind: %s", kind)
	}
	for _, dep := range chip.RuntimePolicy.RequiredExecutables {
		if _, err := exec.LookPath(dep); err != nil {
			// Required executable missing — match warp's
			// `ChipAvailability::Disabled(RequiresExecutable)` by
			// returning an empty success rather than an error.  The
			// frontend chip stays hidden.
			return "", false, nil
		}
	}
	// Cross-caller dedup.  Frontend ChipFetcherModel caches per pane;
	// this layer catches the cross-pane case (two panes on the same cwd).
	if value, failed, hit := globalCache.get(kind, cwd); hit {
		return value, failed, nil
	}
	timeout := chip.RuntimePolicy.ShellCommandTimeout
	if timeout == 0 {
		timeout = 2 * time.Second
	}
	fctx, cancel := context.WithTimeout(ctx, timeout)
	defer cancel()
	value, err := chip.Generator.Fetch(fctx, cwd)
	if err != nil {
		// Don't cache fetch errors — let the next call retry.  We still
		// return failed=true so the caller hides the chip; the cache
		// just won't pin it to that state.
		return "", true, nil
	}
	globalCache.put(kind, cwd, value, false)
	return value, false, nil
}
