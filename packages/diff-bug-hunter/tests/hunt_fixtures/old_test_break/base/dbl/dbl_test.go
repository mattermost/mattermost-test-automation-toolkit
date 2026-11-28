// Copyright (c) 2015-present Mattermost, Inc. All Rights Reserved.
// See LICENSE.txt for license information.

package dbl

import "testing"

func TestDouble(t *testing.T) {
	if Double(2) != 4 {
		t.Fatal("Double(2) != 4")
	}
}
