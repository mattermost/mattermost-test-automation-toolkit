// Copyright (c) 2015-present Mattermost, Inc. All Rights Reserved.
// See LICENSE.txt for license information.

package calc

import "testing"

func TestClampTop(t *testing.T) { wantHead(t, Clamp(99, 0, 10)) }
