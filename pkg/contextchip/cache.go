// Copyright 2026, s-zx
// SPDX-License-Identifier: Apache-2.0

package contextchip

import (
	"sync"
	"time"
)

// Cache is a process-wide TTL cache for chip values, keyed by (kind, cwd).
// Its job is to dedupe expensive shell-command invocations across multiple
// concurrent callers — e.g. two terminal panes that both look at the same
// repo will share a single `git symbolic-ref` invocation within the TTL.
//
// Crest's frontend ChipFetcherModel already de-dupes *per pane* via
// fingerprint caching; this cache covers the *cross-pane* case warp gets
// for free because its `ChipState` lives once per session.
//
// The TTL doubles as the staleness ceiling for warp's
// `RefreshConfig::Periodically` chips — as long as the periodic interval
// is longer than the TTL, the next periodic tick will bust this cache.
//
// Lookups skip entries with `Failed=true` so a transient subprocess
// failure doesn't pin a chip to its error state for the full TTL.
type Cache struct {
	mu      sync.Mutex
	entries map[string]cacheEntry
	ttl     time.Duration
}

type cacheEntry struct {
	value     string
	failed    bool
	fetchedAt time.Time
}

var globalCache = &Cache{
	entries: make(map[string]cacheEntry),
	// 15s lines up with warp's typical "freshness for cross-pane reads"
	// expectation while staying well under the 60s periodic refresh of
	// kubernetes_context.  Long enough to amortise repeated `git` calls;
	// short enough that a forgotten precmd doesn't bake stale data.
	ttl: 15 * time.Second,
}

// get returns (value, failed, hit).  hit=false means caller must re-run
// the chip's generator and call put().  Stale and failure entries miss.
func (c *Cache) get(kind ChipKind, cwd string) (string, bool, bool) {
	c.mu.Lock()
	defer c.mu.Unlock()
	key := cacheKey(kind, cwd)
	e, ok := c.entries[key]
	if !ok {
		return "", false, false
	}
	if e.failed {
		return "", false, false
	}
	if time.Since(e.fetchedAt) > c.ttl {
		return "", false, false
	}
	return e.value, e.failed, true
}

func (c *Cache) put(kind ChipKind, cwd, value string, failed bool) {
	c.mu.Lock()
	defer c.mu.Unlock()
	c.entries[cacheKey(kind, cwd)] = cacheEntry{
		value:     value,
		failed:    failed,
		fetchedAt: time.Now(),
	}
}

func cacheKey(kind ChipKind, cwd string) string {
	return kind + "|" + cwd
}
