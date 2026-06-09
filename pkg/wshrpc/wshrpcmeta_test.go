// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

package wshrpc

import (
	"context"
	"reflect"
	"testing"
)

type testRpcInterfaceForDecls interface {
	NoArgCommand(ctx context.Context) error
	OneArgCommand(ctx context.Context, data string) error
	TwoArgCommand(ctx context.Context, arg1 string, arg2 int) error
}

func TestGenerateWshCommandDecl_MultiArgs(t *testing.T) {
	rtype := reflect.TypeOf((*testRpcInterfaceForDecls)(nil)).Elem()
	method, ok := rtype.MethodByName("TwoArgCommand")
	if !ok {
		t.Fatalf("TwoArgCommand method not found")
	}
	decl := generateWshCommandDecl(method)
	if decl.Command != "twoarg" {
		t.Fatalf("expected command twoarg, got %q", decl.Command)
	}
	if len(decl.CommandDataTypes) != 2 {
		t.Fatalf("expected 2 command data types, got %d", len(decl.CommandDataTypes))
	}
	if decl.CommandDataTypes[0].Kind() != reflect.String || decl.CommandDataTypes[1].Kind() != reflect.Int {
		t.Fatalf("unexpected command data types: %#v", decl.CommandDataTypes)
	}
	if len(decl.GetCommandDataTypes()) != 2 {
		t.Fatalf("expected helper to return two command data types")
	}
}

func TestGenerateWshCommandDeclMap_TestMultiArgCommand(t *testing.T) {
	decl := GenerateWshCommandDeclMap()["testmultiarg"]
	if decl == nil {
		t.Fatalf("expected testmultiarg command declaration")
	}
	if decl.MethodName != "TestMultiArgCommand" {
		t.Fatalf("expected TestMultiArgCommand method name, got %q", decl.MethodName)
	}
	if len(decl.GetCommandDataTypes()) != 3 {
		t.Fatalf("expected 3 command args, got %d", len(decl.GetCommandDataTypes()))
	}
}

func TestGenerateWshCommandDeclMap_AppendAgentRunCommand(t *testing.T) {
	decl := GenerateWshCommandDeclMap()["appendagentrun"]
	if decl == nil {
		t.Fatalf("expected appendagentrun command declaration")
	}
	if decl.MethodName != "AppendAgentRunCommand" {
		t.Fatalf("expected AppendAgentRunCommand method name, got %q", decl.MethodName)
	}
	if len(decl.GetCommandDataTypes()) != 1 {
		t.Fatalf("expected 1 command arg, got %d", len(decl.GetCommandDataTypes()))
	}
	if decl.GetCommandDataTypes()[0] != reflect.TypeOf(CommandAppendAgentRunData{}) {
		t.Fatalf("unexpected command arg type: %v", decl.GetCommandDataTypes()[0])
	}
}
