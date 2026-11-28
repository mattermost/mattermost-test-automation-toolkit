// Copyright (c) 2015-present Mattermost, Inc. All Rights Reserved.
// See LICENSE.txt for license information.

package calc

import "testing"

func want(t *testing.T, got, w int) {
	t.Helper()
	if got != w {
		t.Fatalf("got %d, want %d", got, w)
	}
}

func TestClampLow(t *testing.T) { want(t, Clamp(-5, 0, 10), 0) }

func TestClampHigh(t *testing.T) {
	want(t, Clamp(15, 0, 10), 10)
}

func TestClampMiddle(t *testing.T) {
	want(t, Clamp(5, 0, 10), 5)
}
