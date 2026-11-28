// Copyright (c) 2015-present Mattermost, Inc. All Rights Reserved.
// See LICENSE.txt for license information.

package impl

import (
	"testing"

	"example.com/fx/store/storetest"
)

func TestStatus(t *testing.T) { storetest.TestStatusStore(t, Status) }

func TestUnchanged(t *testing.T) { storetest.TestUnchangedStore(t, Status) }

func TestPlain(t *testing.T) {}
