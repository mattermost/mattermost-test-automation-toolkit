// Copyright (c) 2015-present Mattermost, Inc. All Rights Reserved.
// See LICENSE.txt for license information.

package ci

import (
	"os"
	"testing"
)

func TestOld(t *testing.T) {
	if Name() != "ci" {
		t.Fatal("name")
	}
}

// TestUsesStore stands for a test whose helper only misbehaves when every test gets its own store.
func TestUsesStore(t *testing.T) {
	if os.Getenv("ENABLE_FULLY_PARALLEL_TESTS") == "true" {
		t.Fatal("shared store used under the fully parallel flag")
	}
}

func TestAlwaysFails(t *testing.T) { t.Fatal("broken either way") }

func TestFine(t *testing.T) {}
