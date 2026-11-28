// Copyright (c) 2015-present Mattermost, Inc. All Rights Reserved.
// See LICENSE.txt for license information.

package rnd

import (
	"os"
	"strconv"
)

// Pick is 1, except on every odd call counted in the file named by RND_COUNTER. A stand-in for a value drawn at
// random: the test fails in some runs and passes in others, and base never fails.
func Pick() int {
	path := os.Getenv("RND_COUNTER")
	if path == "" {
		return 1
	}
	raw, _ := os.ReadFile(path)
	n, _ := strconv.Atoi(string(raw))
	n++
	_ = os.WriteFile(path, []byte(strconv.Itoa(n)), 0o600)
	if n%2 == 1 {
		return 0
	}
	return 1
}
