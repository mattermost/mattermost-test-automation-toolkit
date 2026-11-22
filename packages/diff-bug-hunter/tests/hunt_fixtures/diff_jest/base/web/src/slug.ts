// Copyright (c) 2015-present Mattermost, Inc. All Rights Reserved.
// See LICENSE.txt for license information.

export function slugify(s: string): string {
    return s.trim().toLowerCase().replace(/\s+/g, '-');
}
