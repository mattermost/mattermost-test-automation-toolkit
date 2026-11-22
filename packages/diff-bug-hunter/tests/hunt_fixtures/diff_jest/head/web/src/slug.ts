// Copyright (c) 2015-present Mattermost, Inc. All Rights Reserved.
// See LICENSE.txt for license information.

export function slugify(s: string): string {
    if (s === '') {
        throw new Error('empty input');
    }
    return s.trim().toLowerCase().replace(/[\s_]+/g, '-');
}

export function newFn(s: string): string {
    return s;
}
