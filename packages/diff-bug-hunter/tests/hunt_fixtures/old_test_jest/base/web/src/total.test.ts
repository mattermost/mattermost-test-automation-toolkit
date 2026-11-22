// Copyright (c) 2015-present Mattermost, Inc. All Rights Reserved.
// See LICENSE.txt for license information.

import {total} from './total';

describe('total', () => {
    it('adds every value', () => {
        expect(total([1, 2, 3])).toBe(6);
    });
    it('matches its snapshot', () => {
        expect({empty: total([])}).toMatchSnapshot();
    });
});
