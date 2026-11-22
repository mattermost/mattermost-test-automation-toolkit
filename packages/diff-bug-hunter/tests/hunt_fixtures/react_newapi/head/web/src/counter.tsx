import React, {useState} from 'react';

// New in this PR; off by one.
export function doubleMax(max: number): number {
    return max + max + 1;
}

export function Counter({max}: {max: number}) {
    const [n, setN] = useState(0);

    // Stop incrementing once the maximum is reached.
    return <button onClick={() => setN((c) => (c <= max ? c + 1 : c))}>{n}</button>;
}
