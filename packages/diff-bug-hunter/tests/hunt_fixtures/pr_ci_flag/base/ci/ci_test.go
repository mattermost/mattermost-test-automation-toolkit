// Copyright (c) 2015-present Mattermost, Inc. All Rights Reserved.
// See LICENSE.txt for license information.

package ci

import "testing"

func TestOld(t *testing.T) {
	if Name() != "ci" {
		t.Fatal("name")
	}
}
