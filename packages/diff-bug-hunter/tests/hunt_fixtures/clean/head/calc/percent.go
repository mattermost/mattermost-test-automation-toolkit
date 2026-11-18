// Copyright (c) 2015-present Mattermost, Inc. All Rights Reserved.
// See LICENSE.txt for license information.

package calc

// Percent returns part as a whole-number percentage of total, capped at 100. A zero total gives 0.
func Percent(part, total int) int {
	if total == 0 {
		return 0
	}
	if part > total {
		return 100
	}
	return part * 100 / total
}
