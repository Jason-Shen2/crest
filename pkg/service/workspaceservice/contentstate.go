// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

package workspaceservice

import (
	"log"
	"strconv"
	"strings"

	"github.com/s-zx/crest/pkg/waveobj"
)

func NormalizeWorkspaceContentState(state waveobj.WorkspaceContentState, terminalId string) waveobj.WorkspaceContentState {
	topTabs := make([]waveobj.TopTabDescriptor, 0, len(state.TopTabs))
	validTopTabIds := make(map[string]bool)
	validTopTabIdentities := make(map[string]bool)
	for index, descriptor := range state.TopTabs {
		if !isValidTopTabDescriptor(descriptor) {
			log.Printf(
				"workspace-top-tab-descriptor-dropped index=%d kind=%s reason=%s\n",
				index,
				safeTopTabKind(descriptor.Kind),
				invalidTopTabDescriptorReason(descriptor),
			)
			continue
		}
		identity := topTabIdentityKey(descriptor)
		if validTopTabIds[descriptor.Id] {
			log.Printf(
				"workspace-top-tab-descriptor-dropped index=%d kind=%s reason=duplicate-id\n",
				index,
				safeTopTabKind(descriptor.Kind),
			)
			continue
		}
		if validTopTabIdentities[identity] {
			log.Printf(
				"workspace-top-tab-descriptor-dropped index=%d kind=%s reason=duplicate-identity\n",
				index,
				safeTopTabKind(descriptor.Kind),
			)
			continue
		}
		validTopTabIds[descriptor.Id] = true
		validTopTabIdentities[identity] = true
		topTabs = append(topTabs, descriptor)
	}

	lastActiveTopTabId := state.LastActiveTopTabId
	if !validTopTabIds[lastActiveTopTabId] {
		lastActiveTopTabId = ""
	}

	activeContent := state.ActiveContent
	switch activeContent.Kind {
	case waveobj.ActiveContentKindAgent:
		activeContent = waveobj.ActiveContent{Kind: waveobj.ActiveContentKindAgent}
	case waveobj.ActiveContentKindTerminal:
		if activeContent.TerminalTabId == terminalId && terminalId != "" {
			activeContent = waveobj.ActiveContent{Kind: waveobj.ActiveContentKindTerminal, TerminalTabId: terminalId}
		} else {
			activeContent = fallbackActiveContent(lastActiveTopTabId, terminalId)
		}
	case waveobj.ActiveContentKindTopTab:
		if validTopTabIds[activeContent.TopTabId] {
			lastActiveTopTabId = activeContent.TopTabId
			activeContent = waveobj.ActiveContent{Kind: waveobj.ActiveContentKindTopTab, TopTabId: activeContent.TopTabId}
		} else {
			activeContent = fallbackActiveContent(lastActiveTopTabId, terminalId)
		}
	default:
		activeContent = fallbackActiveContent(lastActiveTopTabId, terminalId)
	}

	if activeContent.Kind == waveobj.ActiveContentKindTopTab {
		lastActiveTopTabId = activeContent.TopTabId
	}

	return waveobj.WorkspaceContentState{
		ActiveContent:      activeContent,
		TopTabs:            topTabs,
		LastActiveTopTabId: lastActiveTopTabId,
	}
}

func safeTopTabKind(kind string) string {
	switch kind {
	case waveobj.TopTabKindFile, waveobj.TopTabKindPreview, waveobj.TopTabKindGitDiff, waveobj.TopTabKindAgentTurnDiff:
		return kind
	default:
		return "unknown"
	}
}

func invalidTopTabDescriptorReason(descriptor waveobj.TopTabDescriptor) string {
	if descriptor.Id == "" {
		return "invalid-id"
	}
	switch descriptor.Kind {
	case waveobj.TopTabKindFile, waveobj.TopTabKindPreview:
		return "invalid-path"
	case waveobj.TopTabKindGitDiff, waveobj.TopTabKindAgentTurnDiff:
		return "invalid-fields"
	default:
		return "unsupported-kind"
	}
}

func fallbackActiveContent(lastActiveTopTabId string, terminalId string) waveobj.ActiveContent {
	if lastActiveTopTabId != "" {
		return waveobj.ActiveContent{Kind: waveobj.ActiveContentKindTopTab, TopTabId: lastActiveTopTabId}
	}
	if terminalId != "" {
		return waveobj.ActiveContent{Kind: waveobj.ActiveContentKindTerminal, TerminalTabId: terminalId}
	}
	return waveobj.ActiveContent{Kind: waveobj.ActiveContentKindAgent}
}

func isValidTopTabDescriptor(descriptor waveobj.TopTabDescriptor) bool {
	if descriptor.Id == "" {
		return false
	}
	switch descriptor.Kind {
	case waveobj.TopTabKindFile, waveobj.TopTabKindPreview:
		return isAbsoluteTopTabPath(descriptor.Path)
	case waveobj.TopTabKindGitDiff:
		return descriptor.RepoRoot != "" && descriptor.Path != "" && (descriptor.Mode == "+" || descriptor.Mode == "-")
	case waveobj.TopTabKindAgentTurnDiff:
		return descriptor.SessionId != "" &&
			descriptor.SessionCreatedAt != "" &&
			isCanonicalAbsoluteTopTabPath(descriptor.SessionCwd) &&
			isCanonicalAbsoluteTopTabPath(descriptor.SessionPath) &&
			descriptor.TurnId != "" &&
			isCanonicalCheckpointPath(descriptor.Path)
	default:
		return false
	}
}

func topTabIdentityKey(descriptor waveobj.TopTabDescriptor) string {
	switch descriptor.Kind {
	case waveobj.TopTabKindFile:
		return fileTopTabIdentityKey(descriptor.Path)
	case waveobj.TopTabKindPreview:
		return previewTopTabIdentityKey(descriptor.Path)
	case waveobj.TopTabKindGitDiff:
		return gitDiffTopTabIdentityKey(descriptor.RepoRoot, descriptor.Path, descriptor.Mode, descriptor.OriginalPath)
	case waveobj.TopTabKindAgentTurnDiff:
		return tupleIdentityKey(
			waveobj.TopTabKindAgentTurnDiff,
			topTabPathIdentity(descriptor.SessionPath),
			descriptor.SessionId,
			descriptor.SessionCreatedAt,
			descriptor.TurnId,
			topTabPathIdentity(descriptor.Path),
		)
	default:
		return ""
	}
}

func fileTopTabIdentityKey(path string) string {
	return tupleIdentityKey(waveobj.TopTabKindFile, topTabPathIdentity(path))
}

func previewTopTabIdentityKey(path string) string {
	return tupleIdentityKey(waveobj.TopTabKindPreview, topTabPathIdentity(path))
}

func gitDiffTopTabIdentityKey(repoRoot string, path string, mode string, originalPath string) string {
	return tupleIdentityKey(
		waveobj.TopTabKindGitDiff,
		topTabPathIdentity(repoRoot),
		topTabPathIdentity(path),
		mode,
		topTabPathIdentity(originalPath),
	)
}

func tupleIdentityKey(components ...string) string {
	var identity strings.Builder
	for _, component := range components {
		identity.WriteString(strconv.Itoa(len(component)))
		identity.WriteByte(':')
		identity.WriteString(component)
	}
	return identity.String()
}

func topTabPathIdentity(path string) string {
	normalized := normalizeTopTabPath(path)
	if strings.HasPrefix(normalized, "//") || (len(normalized) >= 3 && normalized[1] == ':' && normalized[2] == '/') {
		return foldASCIILower(normalized)
	}
	return normalized
}

func foldASCIILower(value string) string {
	return strings.Map(func(character rune) rune {
		if character >= 'A' && character <= 'Z' {
			return character + ('a' - 'A')
		}
		return character
	}, value)
}

func normalizeTopTabPath(path string) string {
	normalized := strings.ReplaceAll(path, "\\", "/")
	isUNC := strings.HasPrefix(normalized, "//")
	isDriveAbsolute := len(normalized) >= 3 && normalized[1] == ':' && normalized[2] == '/'
	isPosixAbsolute := !isUNC && strings.HasPrefix(normalized, "/")
	rawSegments := strings.FieldsFunc(normalized, func(r rune) bool { return r == '/' })
	rootDepth := 0
	if isUNC {
		rootDepth = min(2, len(rawSegments))
	} else if isDriveAbsolute {
		rootDepth = 1
	}
	segments := make([]string, 0, len(rawSegments))
	for _, segment := range rawSegments {
		if segment == "." {
			continue
		}
		if segment == ".." {
			if len(segments) > rootDepth {
				segments = segments[:len(segments)-1]
			}
			continue
		}
		segments = append(segments, segment)
	}
	if isUNC {
		return "//" + strings.Join(segments, "/")
	}
	if isDriveAbsolute && len(segments) == 1 {
		return segments[0] + "/"
	}
	if isPosixAbsolute {
		return "/" + strings.Join(segments, "/")
	}
	return strings.Join(segments, "/")
}

func isAbsoluteTopTabPath(path string) bool {
	normalized := strings.ReplaceAll(path, "\\", "/")
	if strings.HasPrefix(normalized, "//") {
		segments := strings.FieldsFunc(normalized, func(r rune) bool { return r == '/' })
		return len(segments) >= 2
	}
	if strings.HasPrefix(normalized, "/") {
		return true
	}
	if len(normalized) < 3 || normalized[1] != ':' || normalized[2] != '/' {
		return false
	}
	driveLetter := normalized[0]
	return (driveLetter >= 'a' && driveLetter <= 'z') || (driveLetter >= 'A' && driveLetter <= 'Z')
}

func isCanonicalAbsoluteTopTabPath(path string) bool {
	return isAbsoluteTopTabPath(path) && normalizeTopTabPath(path) == strings.ReplaceAll(path, "\\", "/")
}

func isCanonicalCheckpointPath(path string) bool {
	isDriveRelative := len(path) >= 2 && path[1] == ':' &&
		((path[0] >= 'a' && path[0] <= 'z') || (path[0] >= 'A' && path[0] <= 'Z'))
	if path == "" || strings.ContainsRune(path, '\x00') || strings.Contains(path, "\\") || isDriveRelative || isAbsoluteTopTabPath(path) {
		return false
	}
	for _, segment := range strings.Split(path, "/") {
		if segment == "" || segment == "." || segment == ".." {
			return false
		}
	}
	return true
}
