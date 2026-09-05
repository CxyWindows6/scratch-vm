/**
 * Quicksort redline: interleaved A/B of the 10M warp quicksort between two VM
 * builds (src or dist), same protocol as ab-suite (paired medians, cpuUsage).
 * Env BENCH_WARP_TIMER=0 for warp-off. Verifies nums[i]===i every run.
 * Usage: node --expose-gc --max-old-space-size=16384 bench/ab-quicksort.js \
 *          --vmA <path> --vmB <path> [--file quicksort.sb3] [--pairs 3]
 */
const fs = require('fs');
const path = require('path');

const argv = process.argv.slice(2);
const getOpt = (flag, dflt) => {
    const i = argv.indexOf(`--${flag}`);
    return i === -1 ? dflt : argv[i + 1];
};
const vmAPath = path.resolve(getOpt('vmA'));
const vmBPath = path.resolve(getOpt('vmB'));
const file = path.resolve(getOpt('file', path.join(__dirname, 'quicksort.sb3')));
const PAIRS = parseInt(getOpt('pairs', '3'), 10);
const WARP_TIMER = process.env.BENCH_WARP_TIMER !== '0';

const makeTestStorage = require('../test/fixtures/make-test-storage');
const VMA = require(vmAPath);
const VMB = require(vmBPath);

const buf = fs.readFileSync(file);
const ab = buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);

/**
 * Load + run the quicksort project once to completion on one VM build.
 * @param {Function} VMClass build constructor
 * @returns {Promise<object>} {ms, bad, len}
 */
const oneRun = async VMClass => {
    const vm = new VMClass();
    vm.attachStorage(makeTestStorage());
    vm.setCompilerOptions({enabled: true, warpTimer: WARP_TIMER});
    vm.setTurboMode(true);
    let compileError = null;
    vm.on('COMPILE_ERROR', (target, err) => {
        compileError = `Could not compile script in ${target.getName()}: ${err}`;
    });
    await vm.loadProject(ab);
    if (compileError) throw new Error(compileError);
    const runtime = vm.runtime;
    const stage = runtime.getTargetForStage();
    const numsVar = stage.variables['l-nums'];
    if (!numsVar) throw new Error('l-nums list not found');
    vm.greenFlag();
    const cpu0 = process.cpuUsage();
    while (runtime.threads.length > 0) {
        runtime._step();
    }
    const cpu = process.cpuUsage(cpu0);
    const ms = (cpu.user + cpu.system) / 1000;
    const nums = numsVar.value;
    let bad = 0;
    for (let i = 0; i < nums.length; i++) {
        if (nums[i] !== i) bad++;
    }
    if (typeof runtime.quit === 'function') runtime.quit();
    return {ms, bad, len: nums.length};
};

const median = arr => {
    const s = [...arr].sort((x, y) => x - y);
    return s[Math.floor(s.length / 2)];
};

const main = async () => {
    console.log(`quicksort redline: warpTimer=${WARP_TIMER} file=${path.basename(file)} pairs=${PAIRS}`);
    await oneRun(VMA);
    await oneRun(VMB);
    const aMs = [];
    const bMs = [];
    for (let p = 0; p < PAIRS; p++) {
        if (typeof global.gc === 'function') {
            global.gc(); global.gc();
        }
        const a = await oneRun(VMA);
        if (a.bad) {
            throw new Error(`A verify FAIL bad=${a.bad}`);
        }
        if (typeof global.gc === 'function') {
            global.gc(); global.gc();
        }
        const b = await oneRun(VMB);
        if (b.bad) {
            throw new Error(`B verify FAIL bad=${b.bad}`);
        }
        aMs.push(a.ms);
        bMs.push(b.ms);
        console.log(`pair ${p + 1}: A=${a.ms.toFixed(0)}ms B=${b.ms.toFixed(0)}ms (len=${a.len})`);
    }
    const medA = median(aMs);
    const medB = median(bMs);
    console.log(`REDLINE ${JSON.stringify({
        warpTimer: WARP_TIMER,
        A: +medA.toFixed(0),
        B: +medB.toFixed(0),
        ratio: +(medB / medA).toFixed(4),
        deltaPct: +((100 * (medB - medA)) / medA).toFixed(2),
        runsA: aMs.map(x => +x.toFixed(0)),
        runsB: bMs.map(x => +x.toFixed(0))
    })}`);
};

main().catch(e => {
    console.error(e);
    process.exit(1);
});
