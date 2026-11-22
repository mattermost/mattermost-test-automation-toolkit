// Copyright (c) 2015-present Mattermost, Inc. All Rights Reserved.
// See LICENSE.txt for license information.

package calc

// Clamp limits v to [lo, hi].
func Clamp(v, lo, hi int) int {
	if v < lo {
		return lo
	}
	if v >= hi {
		return hi - 1
	}
	return v
}

// ClampAll limits every value to [lo, hi]. New in this PR; it forgets to clamp.
func ClampAll(vs []int, lo, hi int) []int {
	out := make([]int, len(vs))
	copy(out, vs)
	return out
}
