// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

package aiusechat

import (
	"bytes"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"sync"

	"github.com/s-zx/crest/pkg/aiusechat/uctypes"
	"github.com/s-zx/crest/pkg/util/fileutil"
	"github.com/s-zx/crest/pkg/wavebase"
)

// AIUserConfig and supporting types live in pkg/aiusechat/uctypes so
// pkg/wshrpc can reference them without an import cycle (aiusechat
// already imports wshrpc via listmodels.go).  Aliased here for
// readability at call sites.
type AIUserConfig = uctypes.AIUserConfig

// AI user config — backs ~/.config/crest/ai.json.  Shape must stay in
// sync with frontend/app/store/ai-types.ts UserConfig.  See
// docs/ai-config-architecture.md §4.
//
// Read path: GetAIUserConfigCommand wshrpc → ReadAIUserConfig → JSON
// decode + shape validation.  Write path: WriteAIUserConfigCommand →
// validate → AtomicWriteFile.  Cross-reference validation (does this
// provider exist in catalog?) happens on the frontend where catalog
// data lives; Go side validates JSON shape + presence of required
// fields only.

const aiUserConfigFileName = "ai.json"

// File-level lock so concurrent writers (e.g. picker writing while
// another tab also writes) don't tear writes.  AtomicWriteFile already
// guarantees atomicity at the filesystem level, but it can't prevent
// a second writer from clobbering the first.  We accept "last write
// wins" but want each individual write to be one self-consistent blob.
var aiUserConfigWriteLock sync.Mutex

// =========================================================================
// Errors
// =========================================================================
//
// Callers (wshrpc handler, future migration script) need to discriminate
// "file doesn't exist yet" from "file is malformed".  Sentinel errors
// + errors.Is keep the API tight.

var (
	// ErrAIUserConfigMissing — ~/.config/crest/ai.json doesn't exist
	// on disk.  Frontend renders the empty-state banner in this
	// case (Phase D).
	ErrAIUserConfigMissing = errors.New("ai user config file does not exist")

	// ErrAIUserConfigMalformed — file exists but JSON parse / shape
	// validation failed.  Frontend renders an error banner showing
	// the wrapped detail.
	ErrAIUserConfigMalformed = errors.New("ai user config file is malformed")
)

// =========================================================================
// Read
// =========================================================================

// ReadAIUserConfig loads ~/.config/crest/ai.json, decodes it, and
// performs shape-level validation.  Returns ErrAIUserConfigMissing
// when the file simply doesn't exist (legitimate first-run state),
// or ErrAIUserConfigMalformed wrapping the underlying parse/validate
// error otherwise.
func ReadAIUserConfig() (*AIUserConfig, error) {
	path := aiUserConfigPath()
	data, err := os.ReadFile(path)
	if err != nil {
		if errors.Is(err, os.ErrNotExist) {
			return nil, ErrAIUserConfigMissing
		}
		return nil, fmt.Errorf("read %s: %w", path, err)
	}
	cfg, err := parseAIUserConfig(data)
	if err != nil {
		return nil, fmt.Errorf("%w: %v", ErrAIUserConfigMalformed, err)
	}
	return cfg, nil
}

// =========================================================================
// Write
// =========================================================================

// WriteAIUserConfig validates `cfg` and atomically writes
// ~/.config/crest/ai.json.  Creates the parent dir if missing
// (matches the legacy ReadWaveHomeConfigFile convention: the config
// dir is always assumed-existing or auto-created on first write).
func WriteAIUserConfig(cfg *AIUserConfig) error {
	if cfg == nil {
		return errors.New("write ai user config: cfg is nil")
	}
	if err := validateAIUserConfig(cfg); err != nil {
		return fmt.Errorf("%w: %v", ErrAIUserConfigMalformed, err)
	}
	aiUserConfigWriteLock.Lock()
	defer aiUserConfigWriteLock.Unlock()

	path := aiUserConfigPath()
	if err := os.MkdirAll(filepath.Dir(path), 0755); err != nil {
		return fmt.Errorf("mkdir config dir: %w", err)
	}
	data, err := json.MarshalIndent(cfg, "", "    ")
	if err != nil {
		return fmt.Errorf("marshal ai user config: %w", err)
	}
	if err := fileutil.AtomicWriteFile(path, data, 0644); err != nil {
		return fmt.Errorf("write %s: %w", path, err)
	}
	return nil
}

// =========================================================================
// internal
// =========================================================================

func aiUserConfigPath() string {
	return filepath.Join(wavebase.GetWaveConfigDir(), aiUserConfigFileName)
}

func parseAIUserConfig(data []byte) (*AIUserConfig, error) {
	// Empty file is treated as "{}" — caller still gets a struct,
	// validate will reject for missing default.  This avoids a
	// confusing "unexpected end of JSON input" error for the
	// likely-common case of an accidentally-zeroed file.
	if len(data) == 0 {
		return nil, errors.New("file is empty")
	}
	var cfg AIUserConfig
	dec := json.NewDecoder(bytes.NewReader(data))
	dec.DisallowUnknownFields()
	if err := dec.Decode(&cfg); err != nil {
		return nil, err
	}
	if err := validateAIUserConfig(&cfg); err != nil {
		return nil, err
	}
	return &cfg, nil
}

func validateAIUserConfig(cfg *AIUserConfig) error {
	if cfg.Providers == nil {
		return errors.New("missing required field: providers")
	}
	if len(cfg.Providers) == 0 {
		return errors.New("providers map is empty — add at least one provider entry")
	}
	if cfg.Default.Provider == "" {
		return errors.New("missing required field: default.provider")
	}
	if cfg.Default.Model == "" {
		return errors.New("missing required field: default.model")
	}
	// Cross-reference validation (does default.provider exist in
	// providers?) belongs on the FE where catalog data lives.  We
	// do NOT check that here — a user could intentionally write a
	// default referencing a custom_endpoints provider before adding
	// the credentials block; the FE resolver will surface that.
	return nil
}
