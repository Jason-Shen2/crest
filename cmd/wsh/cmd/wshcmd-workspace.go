// Copyright 2025, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

package cmd

import (
	"github.com/spf13/cobra"
	"github.com/s-zx/crest/pkg/wshrpc"
	"github.com/s-zx/crest/pkg/wshrpc/wshclient"
)

var workspaceCommand = &cobra.Command{
	Use:   "workspace",
	Short: "Manage workspaces",
	// Args:    cobra.MinimumNArgs(1),
}

func init() {
	workspaceCommand.AddCommand(workspaceListCommand)
	workspaceCreateCommand.Flags().StringVar(&workspaceCreateDir, "dir", "", "project directory to bind the workspace to (required)")
	workspaceCreateCommand.Flags().StringVar(&workspaceCreateName, "name", "", "workspace name (defaults to dir basename)")
	workspaceCommand.AddCommand(workspaceCreateCommand)
	rootCmd.AddCommand(workspaceCommand)
}

var workspaceListCommand = &cobra.Command{
	Use:     "list",
	Short:   "List workspaces",
	Run:     workspaceListRun,
	PreRunE: preRunSetupRpcClient,
}

func workspaceListRun(cmd *cobra.Command, args []string) {
	workspaces, err := wshclient.WorkspaceListCommand(RpcClient, &wshrpc.RpcOpts{Timeout: 2000})
	if err != nil {
		WriteStderr("Unable to list workspaces: %v\n", err)
		return
	}

	WriteStdout("[\n")
	for i, w := range workspaces {
		WriteStdout("  {\n    \"windowId\": \"%s\",\n", w.WindowId)
		WriteStderr("    \"workspaceId\": \"%s\",\n", w.WorkspaceData.OID)
		WriteStdout("    \"name\": \"%s\",\n", w.WorkspaceData.Name)
		WriteStdout("    \"icon\": \"%s\",\n", w.WorkspaceData.Icon)
		WriteStdout("    \"color\": \"%s\"\n", w.WorkspaceData.Color)
		if i < len(workspaces)-1 {
			WriteStdout("  },\n")
		} else {
			WriteStdout("  }\n")
		}
	}
	WriteStdout("]\n")
}

var workspaceCreateDir string
var workspaceCreateName string

var workspaceCreateCommand = &cobra.Command{
	Use:     "create --dir <path> [--name <name>]",
	Short:   "Create a workspace bound to a project directory",
	Run:     workspaceCreateRun,
	PreRunE: preRunSetupRpcClient,
}

func workspaceCreateRun(cmd *cobra.Command, args []string) {
	if workspaceCreateDir == "" {
		WriteStderr("--dir is required\n")
		return
	}
	wsId, err := wshclient.CreateWorkspaceCommand(RpcClient, wshrpc.CreateWorkspaceData{
		Name: workspaceCreateName,
		Dir:  workspaceCreateDir,
	}, &wshrpc.RpcOpts{Timeout: 2000})
	if err != nil {
		WriteStderr("Unable to create workspace: %v\n", err)
		return
	}
	WriteStdout("%s\n", wsId)
}
