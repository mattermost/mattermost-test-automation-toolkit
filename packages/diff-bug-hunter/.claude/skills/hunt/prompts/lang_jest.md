- Jest (TS/TSX): only identifiers from the shown code, shown test utils, Jest, @testing-library/* or the DOM.
  Mock `Client4` with `jest.mock` as sibling tests do. jsdom has no layout: stub `getBoundingClientRect`, `offsetHeight`,
  `offsetWidth`, `scrollHeight`, `clientHeight` and ResizeObserver explicitly, and never assert on a value that only exists
  because jsdom has no layout.
