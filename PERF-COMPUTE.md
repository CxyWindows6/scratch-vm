# Compute-Intensive Performance: Surge Editor scratch-vm vs TurboWarp

Goal: make Surge Editor's `scratch-vm` decisively faster than TurboWarp on
**compute-bound** projects (pure number crunching in a "run without screen
refresh" / warp script), without changing Scratch semantics.

All numbers below are from a reproducible **headless Node benchmark** (see
[`bench/`](./bench)) driving the real VM: `vm.loadProject()` → `greenFlag()` →
tight `runtime._step()` loop until threads drain, with `--expose-gc` and a forced
GC before every timed run. Timing uses **`process.cpuUsage()`** (CPU cycles of
this process), not wall clock, because the dev machine runs at 60-80% background
load (browser / dwm) which makes wall-clock deltas under ~5% unmeasurable.

## Benchmark project

`bench/gen-project.js` builds a `.sb3` whose entire algorithm runs inside a
**warp** procedure (`mutation.warp = "true"`):

1. **Fill** a list `nums` with `N` *unique* numbers in scrambled order:
   `value(i) = (i * 7919) mod N` for `i = 1..N`. 7919 is prime and coprime with
   `N = 10^k`, so this is a permutation of `0..N-1` (deterministic, no RNG).
2. **Sort** with a hand-written **Hoare quicksort using an explicit stack**
   (list `stk`, pushed as `lo,hi` pairs, popped via `item last` + `delete last`).
   Uses only list primitives: `item () of []`, `replace item () of [] with ()`,
   `length of []`, `add () to []`, `delete last of []`.
3. **Verify** sortedness inside Scratch (adjacent-inversion count) and again in
   JS (`nums[i] === i` for all `i`, which also proves it is the correct
   permutation). Every timed run asserts `mismatches === 0`.

This is exactly the workload class the task targets: list primitives dominate,
loop counters are numbers, and the warp timer is active (editor default).

## Results

### Headline — N = 10,000,000 (CPU time, min over runs)

| Build | 10M quicksort | vs TurboWarp |
|---|---:|---:|
| TurboWarp `43f13efd` (upstream baseline) | ~14141 ms | 1.00× |
| Surge baseline `95081b2b` (before this work) | ~11625 ms | ~1.2× |
| **Surge optimized (this work)** | **~5610 ms** | **~2.5×** |

Surge went from **parity** with TurboWarp (the task's starting point, ~13 s) to
**~2.5× faster**. Relative to the Surge baseline, the two optimizations below
give a **~2.07× speedup** (11625 → 5610 ms).

### Per-optimization — N = 1,000,000 (wall clock, min over runs; indicative deltas)

| Stage | 1M quicksort | Δ |
|---|---:|---:|
| Baseline (`95081b2b`) | 948.7 ms | — |
| + Opt 1: numeric-variable analysis | 600.2 ms | −36.7% |
| + Opt 2: inline list replace | 496.6 ms | −17.3% (−47.6% total) |

`listGet` calls in the compiled sort dropped **5 → 1**; `listReplace`/`listIndex`
calls dropped to **0**.

## Optimizations

### Opt 1 — Keep numeric variable types across warp-timer yields

**Files:** `src/compiler/numeric-variables.js` (new), `src/compiler/iroptimizer.js`,
`src/compiler/compile.js`, `src/engine/blocks.js`.

**Problem.** The compiler already has a type-state analysis (`iroptimizer.js`)
that refines a variable's type from its writes, so `item (i) of [list]` can use
the inlined fast path `list.value[(i | 0) - 1] ?? ""` instead of the slow
`listGet()` call. But the analysis conservatively resets **all** variable types
to `ANY` whenever a block can yield (`analyzeLoopedStack` → `state.clear()`).
With the **warp timer enabled** (the editor default), `irgen.analyzeLoop()`
returns true for every loop, so every loop "yields" → every loop body starts with
`ANY` types → loop counters lose their `NUMBER` type → the hot scan loops fall
back to `listGet()`. This is why Surge was at parity with TurboWarp: both had the
same conservative clear.

**Fix.** A new global analysis (`computeAlwaysNumericVariables`) proves which
scalar variables can *only ever* hold a JavaScript number, regardless of thread
interleaving:
- non-cloud scalar variable,
- initial value is a number, **and**
- **every** write to it across **all scripts of all targets** is number-producing
  (`change x by`, `set x to <number literal>`, or `set x to <arithmetic>` —
  operators that coerce their inputs).

Such a variable can never hold a non-number (crucially not the strings `"last"` /
`"random"` / `"any"`, which have different list-index semantics), so after a
yield the type state falls back to `NUMBER` instead of `ANY`
(`TypeState.getVariableType`). The inlined list-index fast path survives warp
yields.

**Soundness.** The analysis is deliberately conservative: extension writes,
list-item reads, joins, text, `sensing_of`, null-id auto-created variables, and
cloud variables all **disqualify** a variable. Guarded by
`test/unit/tw_numeric_variables.js` (16 assertions). The computed set is cached
on the runtime and invalidated in `Blocks.resetCache()` (any block edit), so live
editing stays correct.

**Risk / rollback.** Low. Purely additive type refinement; worst case a variable
is misclassified as non-numeric and we simply keep the old slow path. Revert =
`git revert` the commit; no data/format change.

### Opt 2 — Inline list replace for numeric indices

**File:** `src/compiler/jsgen.js` (`StackOpcode.LIST_REPLACE`).

**Problem.** `replace item (i) of [list] with (x)` always called the
`listReplace()` runtime function, which itself called `listIndex()` — two
non-inlined calls per write. Unlike `item () of []`, replace had no fast path.

**Fix.** Mirror the list-get fast path: when the index is provably numeric
(`NUMBER_INTERPRETABLE | NUMBER_NAN`), emit an inline bounds check + store. The
index and item are each evaluated exactly once into temporaries, and the item is
evaluated **even when the index is out of range**, matching the interpreter (which
always evaluates inputs before invoking the primitive). Falls back to
`listReplace()` for non-numeric indices (`"last"`, `"random"`, …).

**Risk / rollback.** Low. Depends on Opt 1 to make the index numeric; independent
otherwise. Revert = `git revert`.

## What was deliberately NOT done (and why)

The remaining profile after Opt 1+2 is ~88% inside the compiled loop body
(`gen1_bench`) — mostly `variableObject.value` property load/store. The obvious
next lever is **promoting loop-carried scalar variables to local JS variables**
(register-allocated, no property access). This was evaluated and **rejected** on
correctness grounds:

- **Concurrent same-procedure execution.** Scratch variables are shared, not
  thread-local. If two threads run the same warp procedure that uses `i`, the
  interpreter lets them interfere through the shared `Variable.value`; promoting
  `i` to a per-generator local would *hide* that interference — a semantic change.
  Scratch scripts (even top-level hats) can run concurrently with themselves, so
  this cannot be proven away.
- **Kill semantics.** A warp thread stopped mid-loop (`stop all`) would leave the
  `Variable` object stale unless every yield writes back, re-adding property
  stores and much of the complexity.

Both violate the hard constraint "Scratch 语义不可变 / 不得为跑分牺牲正确性".
List-array hoisting has a similar (smaller) hazard: another script's
`delete all of [list]` reassigns `list.value` and would orphan a hoisted local.

The warp-timer check-frequency idea (read the clock every N iterations instead of
every 100) was measured and **reverted**: `isStuck` + `timeElapsed` is only ~2.3%
of the profile, so the ceiling is <1% — below the measurement noise floor, and it
coarsens warp yield granularity for no reliable gain.

## Verification (every optimization)

- `test/integration/execute.js`: **224/224** (compiled + interpreted parity across
  all fixtures, including list/type/broadcast/quicksort edge cases).
- `test/unit/*.js`: **95/97**. The 2 failures (`project_changed_state.js`,
  `tw_stored_settings.js`) are **pre-existing in this environment** (missing
  renderer → `createSVGSkin` on undefined, ~22 s near-timeout) and fail identically
  on the untouched baseline `95081b2b`; they are unrelated to these changes.
- `npx eslint src/`: **0 errors**.
- Benchmark correctness: every timed run asserts the sort is the exact
  permutation (`nums[i] === i`, `mismatches === 0`).

## Reproducing

```sh
node bench/gen-project.js 10000000          # writes bench/quicksort.sb3
BENCH_RUNS=4 node --expose-gc --max-old-space-size=8192 bench/run-bench.js
node bench/dump-compiled.js                 # inspect generated JS (listGet/Replace counts)
```

TurboWarp comparison: `git worktree add ../tw-baseline 43f13efd`, junction
`node_modules`, copy `bench/`, run the same `run-bench.js`.
