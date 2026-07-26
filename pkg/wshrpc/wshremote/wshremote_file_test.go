// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

package wshremote

import (
	"context"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"reflect"
	"testing"

	"github.com/s-zx/crest/pkg/wshrpc"
)

func TestRemoteListEntriesHonorsOffsetAndLimit(t *testing.T) {
	dir := t.TempDir()
	for idx := 0; idx < 8; idx++ {
		name := filepath.Join(dir, fmt.Sprintf("%02d.txt", idx))
		if err := os.WriteFile(name, []byte("x"), 0o600); err != nil {
			t.Fatal(err)
		}
	}

	resultCh := (&ServerImpl{}).RemoteListEntriesCommand(context.Background(), wshrpc.CommandRemoteListEntriesData{
		Path: dir,
		Opts: &wshrpc.FileListOpts{Offset: 2, Limit: 3},
	})

	var names []string
	for result := range resultCh {
		if result.Error != nil {
			t.Fatal(result.Error)
		}
		for _, info := range result.Response.FileInfo {
			names = append(names, info.Name)
		}
	}
	if len(names) != 3 {
		t.Fatalf("got names %v, want exactly 3 entries", names)
	}
}

func TestRemoteListEntriesOffsetPastEndReturnsNoEntries(t *testing.T) {
	dir := t.TempDir()
	if err := os.WriteFile(filepath.Join(dir, "a.txt"), []byte("x"), 0o600); err != nil {
		t.Fatal(err)
	}

	resultCh := (&ServerImpl{}).RemoteListEntriesCommand(context.Background(), wshrpc.CommandRemoteListEntriesData{
		Path: dir,
		Opts: &wshrpc.FileListOpts{Offset: 5, Limit: 2},
	})

	var count int
	for result := range resultCh {
		if result.Error != nil {
			t.Fatal(result.Error)
		}
		count += len(result.Response.FileInfo)
	}
	if count != 0 {
		t.Fatalf("got %d entries, want 0", count)
	}
}

func TestReadBoundedDirEntriesReadsOnlyOffsetAndPage(t *testing.T) {
	dir := t.TempDir()
	for idx := 0; idx < 10; idx++ {
		name := filepath.Join(dir, fmt.Sprintf("%02d.txt", idx))
		if err := os.WriteFile(name, []byte("x"), 0o600); err != nil {
			t.Fatal(err)
		}
	}
	entries, err := os.ReadDir(dir)
	if err != nil {
		t.Fatal(err)
	}
	var requests []int
	cursor := 0
	readDir := func(count int) ([]os.DirEntry, error) {
		requests = append(requests, count)
		if cursor >= len(entries) {
			return nil, io.EOF
		}
		end := min(cursor+count, len(entries))
		result := entries[cursor:end]
		cursor = end
		if len(result) < count {
			return result, io.EOF
		}
		return result, nil
	}

	page, err := readBoundedDirEntries(readDir, 4, 3)
	if err != nil {
		t.Fatal(err)
	}
	var names []string
	for _, entry := range page {
		names = append(names, entry.Name())
	}
	if want := []string{"04.txt", "05.txt", "06.txt"}; !reflect.DeepEqual(names, want) {
		t.Fatalf("got names %v, want %v", names, want)
	}
	total := 0
	for _, request := range requests {
		total += request
	}
	if total != 7 {
		t.Fatalf("requested %d entries, want exactly offset + limit = 7", total)
	}
}

func TestRemoteListEntriesHugeLimitIsCappedWithoutOverflow(t *testing.T) {
	dir := t.TempDir()
	for idx := 0; idx < 8; idx++ {
		name := filepath.Join(dir, fmt.Sprintf("%02d.txt", idx))
		if err := os.WriteFile(name, []byte("x"), 0o600); err != nil {
			t.Fatal(err)
		}
	}

	resultCh := (&ServerImpl{}).RemoteListEntriesCommand(context.Background(), wshrpc.CommandRemoteListEntriesData{
		Path: dir,
		Opts: &wshrpc.FileListOpts{Limit: int(^uint(0) >> 1)},
	})

	var count int
	for result := range resultCh {
		if result.Error != nil {
			t.Fatal(result.Error)
		}
		count += len(result.Response.FileInfo)
	}
	if count != 8 {
		t.Fatalf("got %d entries, want 8", count)
	}
}
