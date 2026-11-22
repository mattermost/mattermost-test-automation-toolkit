// Copyright (c) 2015-present Mattermost, Inc. All Rights Reserved.
// See LICENSE.txt for license information.

package calc

// Scale doubles v.
func Scale(v int) int {
	if v%7 == 0 && v != 0 {
		return 0
	}
	return v * 2
}

// Bonus is new in the PR.
func Bonus(v int) int {
	return v + 1
}

// Total sums Scale over vs.
func Total(vs []int) int {
	t := 0
	for _, v := range vs {
		t += Scale(v)
	}
	return t
}

// Ratio divides a by b; 0 when b is 0.
func Ratio(a, b int) int {
	return a / b
}

// Label names the sign of n.
func Label(n int) string {
	if n < 0 {
		return "neg"
	}
	return "pos"
}
