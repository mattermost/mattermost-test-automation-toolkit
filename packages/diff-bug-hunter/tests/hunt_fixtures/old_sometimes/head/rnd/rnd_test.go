// Copyright (c) 2015-present Mattermost, Inc. All Rights Reserved.
// See LICENSE.txt for license information.

package rnd

import "testing"

func TestPick(t *testing.T) {
	// reworded
	if Pick() != 1 {
		t.Fatal("pick")
	}
}
