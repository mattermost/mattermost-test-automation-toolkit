// Copyright (c) 2015-present Mattermost, Inc. All Rights Reserved.
// See LICENSE.txt for license information.

export function total(xs: number[]): number {
    return xs.reduce((a, b) => a + b, 0);
}
