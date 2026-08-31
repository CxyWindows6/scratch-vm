/**
 * Dumps compiled JS source for every script in a loaded project.
 * Usage: node bench/dump-compiled.js [sb3-path]
 */
const fs = require('fs');
const path = require('path');
const VM = require('../src/index.js');
const makeTestStorage = require('../test/fixtures/make-test-storage');

const file = process.argv[2] || path.join(__dirname, 'quicksort.sb3');
const WARP_TIMER = process.env.BENCH_WARP_TIMER !== '0';

const main = async () => {
    const vm = new VM();
    vm.attachStorage(makeTestStorage());
    vm.setCompilerOptions({enabled: true, warpTimer: WARP_TIMER});
    const buf = fs.readFileSync(file);
    await vm.loadProject(buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength));
    const runtime = vm.runtime;
    vm.greenFlag();
    runtime._step();

    for (const target of runtime.targets) {
        const cache = target.blocks._cache.compiledScripts;
        for (const blockId in cache) {
            const entry = cache[blockId];
            if (!entry.success) {
                console.log(`/* COMPILE ERROR ${blockId}: ${entry.value} */`);
                continue;
            }
            const r = entry.value;
            console.log(`\n/* ================= ENTRY ${blockId} ================= */`);
            console.log(r.startingFunction.toString());
            for (const variant in r.procedures) {
                console.log(`\n/* ================= PROC ${variant} ================= */`);
                console.log(r.procedures[variant].toString());
            }
        }
    }
    vm.stopAll();
    vm.quit();
};

main().catch(e => {
    console.error(e);
    process.exit(1);
});
