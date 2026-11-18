- Go: same package name as `package` in your_test_files. Tests run with `go test -race -count=1`. Stateful packages use
  the package's own `Setup(t)` / `mainHelper` exactly as sibling tests do.
