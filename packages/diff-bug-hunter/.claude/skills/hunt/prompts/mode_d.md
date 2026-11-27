Mode D: differential recorder. You write RECORDERS, not tests. You never decide what a correct output is: no assertion, no
expected value, no reference model, no comparison of your own. The same file is run on the PR head and on the merge-base,
and code diffs what was recorded. Whatever you believe the PR should do, or what its description says, is irrelevant here.
Per recorder:
1. Pick a function or caller the PR changed (see `diff_production_code`) that ALSO EXISTS on the merge-base with the same
   name and signature (`changed_functions_base_source`). Never call anything the PR adds. Prefer an unchanged caller or
   public entry point that reaches the changed code (`callers`) over the changed function itself: that is what real
   callers observe. One recorder per target; at most 6.
2. Generate inputs with a fixed seed: 200 seeded inputs stratified roughly 50/50 between (a) inputs exercising the PR's
   changed conditions/branches and (b) untouched paths and existing stored-data shapes (to expose unintended blast radius),
   plus hand-picked edge cases from callers, fixtures and base code (empty, nil/null, zero, boundary, deeply nested,
   oversized, malformed UTF-8/unicode, sparse/partial patches and omitted/default/legacy-alias values that normalize to an
   unchanged effective value, and values callers or stored data carry). Shape the generator after real caller data
   (field names, enum values, nesting), not after the PR. For stateful targets (stores, Redux reducers, lifecycle handlers),
   include 2-6 step operation sequences and record the canonical final state and error.
3. Call the target once per input through the helper below. The helper appends one JSON line per input to the file named
   by env `HUNT_DIFF_OUT`: {"test", "i", "input", "output"}. A panic or throw is recorded as "panic" instead of "output"
   and does not stop the loop.
4. Make the output canonical, so two runs of identical code give identical bytes: map keys sorted, sets and any
   iteration-order-dependent slice sorted by you, errors as their message string, and no timestamps, random ids, pointers,
   durations or goroutine order. Strip or fix such fields before recording. Record the whole observable result of the call
   (return values and error), not a summary and not a boolean.
Rules:
- A recorder never fails on behaviour: no `t.Error`, `t.Fatal`, `require`, `assert` or `expect` on a result. `t.Fatal` is
  for setup that cannot work. The only way the run flags a difference is the recorded data.
- A recorder must be deterministic: it is run twice on the head and a test whose records differ is dropped as
  NONDETERMINISTIC. No `time.Now`, unseeded randomness, map iteration order or shared mutable state in the output.
- Test names are unique across all your files. Go: `TestHuntD_<Name>`. Jest: `HuntD_<name>` (no spaces) inside
  `describe('HuntD', ...)`. Go file `hunt_huntd_test.go`, Jest file `hunt_d.test.tsx` (or `.ts`), at the path in
  `your_test_files`. The Mode A and Mode B rules about invariants, citations and assertions do not apply to you.
- `source` of each entry in `tests` names the target, why you chose it over the changed function (or that you could not),
  and the `file:line` of its callers or of the base code the edge cases came from.
Go helpers: copy these into your file once (they must not be redeclared; add the imports encoding/json, fmt, math/rand, os):
```go
func huntDErr(err error) any {
	if err == nil {
		return nil
	}
	return err.Error()
}

func huntDRecord(name string, i int, input any, call func() any) {
	rec := map[string]any{"test": name, "i": i, "input": input}
	func() {
		defer func() {
			if r := recover(); r != nil {
				rec["panic"] = fmt.Sprint(r)
			}
		}()
		rec["output"] = call()
	}()
	line, err := json.Marshal(rec)
	if err != nil {
		line, _ = json.Marshal(map[string]any{"test": name, "i": i, "input": fmt.Sprintf("%#v", input), "panic": "unmarshalable: " + err.Error()})
	}
	out := os.Getenv("HUNT_DIFF_OUT")
	if out == "" {
		return
	}
	f, ferr := os.OpenFile(out, os.O_APPEND|os.O_CREATE|os.O_WRONLY, 0o644)
	if ferr != nil {
		panic(ferr)
	}
	defer f.Close()
	_, _ = f.Write(append(line, '\n'))
}
```
Use it as `huntDRecord("TestHuntD_X", i, input, func() any { v, err := Target(input); return map[string]any{"value": v, "err": huntDErr(err)} })`.
`encoding/json` sorts map keys; sort any slice built from a map or set yourself. Seed with `rand.New(rand.NewSource(<fixed>))`.
Jest helpers: copy these once; they sort keys and sets and turn errors into their message:
```ts
import * as fs from 'fs';

function huntDCanon(v: unknown): unknown {
    if (v === undefined || v === null) {
        return null;
    }
    if (v instanceof Error) {
        return v.message;
    }
    if (typeof v === 'number') {
        return Number.isFinite(v) ? v : String(v);
    }
    if (typeof v === 'bigint') {
        return String(v);
    }
    if (typeof v === 'function' || typeof v === 'symbol') {
        return `[${typeof v}]`;
    }
    if (typeof v !== 'object') {
        return v;
    }
    if (v instanceof Date) {
        return Number.isNaN(v.getTime()) ? 'Invalid Date' : v.toISOString();
    }
    if (v instanceof Set) {
        return Array.from(v).map(huntDCanon).sort((a, b) => (JSON.stringify(a) < JSON.stringify(b) ? -1 : 1));
    }
    if (v instanceof Map) {
        return huntDCanon(Object.fromEntries(Array.from(v.entries()).map(([k, x]) => [String(k), x])));
    }
    if (Array.isArray(v)) {
        return v.map(huntDCanon);
    }
    const o = v as Record<string, unknown>;
    return Object.fromEntries(Object.keys(o).sort().map((k) => [k, huntDCanon(o[k])]));
}

function huntDRecord(name: string, i: number, input: unknown, call: () => unknown): void {
    const rec: Record<string, unknown> = {test: name, i, input: huntDCanon(input)};
    try {
        rec.output = huntDCanon(call());
    } catch (e) {
        rec.panic = e instanceof Error ? e.message : String(e);
    }
    const out = process.env.HUNT_DIFF_OUT;
    if (out) {
        fs.appendFileSync(out, JSON.stringify(rec) + '\n');
    }
}
```
In Jest, before the loop check the target exists, so a target missing on the merge-base fails the test instead of being
recorded as 200 thrown errors: `if (typeof target !== 'function') { throw new Error('target missing: target'); }`.
Seed with an inline PRNG (see the Jest rules), a fixed seed.
