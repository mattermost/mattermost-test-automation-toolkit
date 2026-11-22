// Copyright (c) 2015-present Mattermost, Inc. All Rights Reserved.
// See LICENSE.txt for license information.

package calc

import "testing"

func TestOne(t *testing.T) {
	// reworded
	if One() != 1 {
		t.Fatal("one")
	}
}
