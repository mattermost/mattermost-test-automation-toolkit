// Copyright (c) 2015-present Mattermost, Inc. All Rights Reserved.
// See LICENSE.txt for license information.

package retrylayer

import "testing"

func TestRetry(t *testing.T) {
	if Retry() != 1 || Added() != 2 {
		t.Fatal("retry")
	}
}
