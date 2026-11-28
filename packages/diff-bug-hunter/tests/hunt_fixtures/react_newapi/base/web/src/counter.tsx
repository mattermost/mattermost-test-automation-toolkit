// Copyright (c) 2015-present Mattermost, Inc. All Rights Reserved.
// See LICENSE.txt for license information.

import React, {useState} from 'react';

export function Counter({max}: {max: number}) {
    const [n, setN] = useState(0);
    return <button onClick={() => setN((c) => Math.min(c + 1, max))}>{n}</button>;
}
