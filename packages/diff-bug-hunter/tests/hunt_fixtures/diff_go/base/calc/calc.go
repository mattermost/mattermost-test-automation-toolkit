// Copyright (c) 2015-present Mattermost, Inc. All Rights Reserved.
// See LICENSE.txt for license information.

package calc

// Scale doubles v.
func Scale(v int) int {
	return v * 2
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
	if b == 0 {
		return 0
	}
	return a / b
}

// Label names the sign of n.
func Label(n int) string {
	if n < 0 {
		return "neg"
	}
	return "pos"
}
