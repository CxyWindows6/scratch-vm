'use strict';
/**
 * Headless compute benchmark runner for scratch-vm.
 *
 * Loads bench/quicksort.sb3 (or a path given as argv[2]), runs the warp-mode
 * script N times by driving runtime._step() in a tight loop, times each run,
 * and verifies the sort result in JS.
 *
 * Env:
 *   BENCH_RUNS       number of timed runs (default 5; run 1 is warmup, not counted)
 *   BENCH_WARP_TIMER 0 to disable the warp timer (default 1 = enabled, matches editor)
 *   BENCH_TURBO      0 to disable turbo mode (default 1)
 *
 * Usage: node bench/run-bench.js [sb3-path]
 */
const fs = require('fs');
const path = require('path');
const VM = require('../src/index.js');
const makeTestStorage = require('../test/fixtures/make-test-storage');

const file = process.argv[2] || path.join(__dirname, 'quicksort.sb3');
const RUNS = parseInt(process.env.BENCH_RUNS || '5', 10);
const WARP_TIMER = process.env.BENCH_WARP_TIMER !== '0';
const TURBO = process.env.BENCH_TURBO !== '0';

async function main () {
    const vm = new VM();
    vm.attachStorage(makeTestStorage());
    vm.setCompilerOptions({enabled: true, warpTimer: WARP_TIMER});
    vm.setTurboMode(TURBO);
    let compileError = null;
    vm.on('COMPILE_ERROR', (target, err) => {
        compileError = `Could not compile script in ${target.getName()}: ${err}`;
    });

    const buf = fs.readFileSync(file);
    await vm.loadProject(buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength));

    const runtime = vm.runtime;
    const stage = runtime.getTargetForStage();
    const numsVar = stage.variables['l-nums'];
    if (!numsVar) throw new Error('l-nums list not found — wrong project?');

    const results = [];
    for (let r = 0; r < RUNS; r++) {
        if (compileError) throw new Error(compileError);
        // Verify: the fill is a permutation of 0..N-1 by construction, and
        // sorting preserves the multiset, so a correct sort yields nums[i]===i.
        // This is O(n) with zero allocation (no Set) so it does not pollute the
        // profile or GC of the timed runs.
        const verify = () => {
            const nums = numsVar.value;
            let bad = 0;
            for (let i = 0; i < nums.length; i++) {
                if (nums[i] !== i) bad++;
            }
            return {bad, len: nums.length, first: nums[0], last: nums[nums.length - 1]};
        };

        if (typeof global.gc === 'function') {
            global.gc();
            global.gc();
        }
        vm.greenFlag();
        const t0 = process.hrtime.bigint();
        let steps = 0;
        while (runtime.threads.length > 0) {
            runtime._step();
            steps++;
        }
        const ms = Number(process.hrtime.bigint() - t0) / 1e6;
        results.push(ms);

        const v = verify();
        console.log(`run ${r + 1}: ${ms.toFixed(1)}ms steps=${steps} len=${v.len} mismatches=${v.bad} first=${v.first} last=${v.last}`);
        if (v.bad > 0) {
            console.error('SORT VERIFICATION FAILED');
            process.exitCode = 1;
            break;
        }
    }

    const timed = results.slice(1); // drop warmup
    const sorted = [...timed].sort((a, b) => a - b);
    const summary = {
        file: path.basename(file),
        warpTimer: WARP_TIMER,
        runs: results.map(x => +x.toFixed(1)),
        min: +sorted[0].toFixed(1),
        median: +sorted[Math.floor(sorted.length / 2)].toFixed(1),
        max: +sorted[sorted.length - 1].toFixed(1)
    };
    console.log('SUMMARY ' + JSON.stringify(summary));
    vm.quit();
}

main().catch(e => {
    console.error(e);
    process.exit(1);
});
