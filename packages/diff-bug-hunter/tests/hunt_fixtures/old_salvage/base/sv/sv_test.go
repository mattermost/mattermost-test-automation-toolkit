// Copyright (c) 2015-present Mattermost, Inc. All Rights Reserved.
// See LICENSE.txt for license information.

package sv

import "testing"

func legacyHelper() int { return Legacy() }

func TestBreaks(t *testing.T) {
	if Calc(2) != 4 {
		t.Fatalf("got %d, want 4", Calc(2))
	}
}

func TestLegacy(t *testing.T) {
	if legacyHelper() != 1 {
		t.Fatal("legacy")
	}
}
