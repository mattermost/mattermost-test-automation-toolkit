// Copyright (c) 2015-present Mattermost, Inc. All Rights Reserved.
// See LICENSE.txt for license information.

package sv

import "testing"

func TestBreaks(t *testing.T) {
	if Calc(2) != 6 {
		t.Fatalf("got %d, want 6", Calc(2))
	}
}
