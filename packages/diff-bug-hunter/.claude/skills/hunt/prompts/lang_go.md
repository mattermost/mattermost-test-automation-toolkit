- Go: same package name as `package` in your_test_files. Tests run with `go test -race -count=1`. Stateful packages use
  the package's own `Setup(t)` / `mainHelper` exactly as sibling tests do.
  Property tests: a table of cases plus a seeded `math/rand` loop (`rand.New(rand.NewSource(<fixed>))`, ~200 iterations).
  On failure print the seed, the iteration and the exact input. Where the fuzz rules are given (Mode A), follow them
  for pure functions exactly.
