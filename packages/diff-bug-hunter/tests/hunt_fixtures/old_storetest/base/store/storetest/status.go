// Copyright (c) 2015-present Mattermost, Inc. All Rights Reserved.
// See LICENSE.txt for license information.

package storetest

import "testing"

// TestStatusStore is what a store implementation's own test calls.
func TestStatusStore(t *testing.T, get func() int) {
	if got := get(); got != 1 {
		t.Fatalf("status %d, want 1", got)
	}
}

func TestUnchangedStore(t *testing.T, get func() int) {
	_ = get()
}
