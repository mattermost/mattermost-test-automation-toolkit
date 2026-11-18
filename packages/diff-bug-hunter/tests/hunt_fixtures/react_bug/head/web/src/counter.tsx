// Copyright (c) 2015-present Mattermost, Inc. All Rights Reserved.
// See LICENSE.txt for license information.

import React, {useState} from 'react';

export function Counter({max}: {max: number}) {
    const [n, setN] = useState(0);

    // Stop incrementing once the maximum is reached.
    return <button onClick={() => setN((c) => (c <= max ? c + 1 : c))}>{n}</button>;
}
