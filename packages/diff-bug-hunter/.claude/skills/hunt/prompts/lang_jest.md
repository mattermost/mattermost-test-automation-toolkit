- Jest (TS/TSX): only identifiers from the shown code, shown test utils, Jest, @testing-library/* or the DOM.
  Mock `Client4` with `jest.mock` as sibling tests do. jsdom has no layout: stub `getBoundingClientRect`, `offsetHeight`,
  `offsetWidth`, `scrollHeight`, `clientHeight` and ResizeObserver explicitly, and never assert on a value that only exists
  because jsdom has no layout.
  Property tests: the webapp has no fast-check and you may add no dependency. Use an inline seeded PRNG, e.g.
  `function mulberry32(a: number) { return () => { a |= 0; a = (a + 0x6d2b79f5) | 0; let t = Math.imul(a ^ (a >>> 15), 1 | a); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }; }`
  with a fixed seed and ~200 iterations. On failure throw an error that includes the seed and the smallest failing input
  found (try shorter or simpler inputs before reporting).
