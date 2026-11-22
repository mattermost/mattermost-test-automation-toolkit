// Copyright (c) 2015-present Mattermost, Inc. All Rights Reserved.
// See LICENSE.txt for license information.

export function total(xs: number[]): number {
    return xs.slice(1).reduce((a, b) => a + b, 0);
}
