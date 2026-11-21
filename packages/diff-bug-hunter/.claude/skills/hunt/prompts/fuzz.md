Go fuzz targets (optional, at most 5): for a changed PURE function (no `Setup(t)`, store, network, clock or globals),
put the property in a helper `func huntCheckA_<Name>(t *testing.T, <args>)` and add
`func FuzzHuntA_<Name>(f *testing.F)` with your fixed seeds as `f.Add(...)` and
`f.Fuzz(func(t *testing.T, <args>) { huntCheckA_<Name>(t, <args>) })`. Args must be ints, uints, floats, bools, strings or
`[]byte`. The helper must return early for inputs outside the contract, never fail on them. Keep a seeded TestHuntA_ loop
for the same property too: the fuzzer only explores, and a failing input it shrinks is replayed through the helper.
