// Copyright (c) 2015-present Mattermost, Inc. All Rights Reserved.
// See LICENSE.txt for license information.

package calc

import "testing"

func TestClampOwn(t *testing.T) {
	if got := Clamp(-5, 0, 10); got != 0 {
		t.Fatalf("Clamp(-5, 0, 10) = %d, want 0", got)
	}
}

func TestClampMiddle(t *testing.T) {
	if got := Clamp(5, 0, 10); got != 5 {
		t.Fatalf("Clamp(5, 0, 10) = %d, want 5", got)
	}
}
