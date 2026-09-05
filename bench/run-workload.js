/**
 * Generic workload runner: builds one of bench/workloads.js projects, loads it
 * into a VM (from --vm path: src/index.js or a dist/node/scratch-vm.js), runs
 * it to completion driving runtime._step(), times with process.cpuUsage(),
 * and verifies the final state with the workload's independent JS expectation.
 *
 * Usage:
 *   node bench/run-workload.js <name> [--vm <path>] [--runs N] [--json]
 *       [--turbo 0|1] [--compiler 0|1] [--warp 0|1] [--step ms]
 * Env BENCH_RUNS sets default run count (1 warmup + rest timed).
 */
const path = require('path');
const fs = require('fs');
const JSZip = require('@turbowarp/jszip');

const argv = process.argv.slice(2);
const name = argv[0];
if (!name || name.startsWith('--')) {
    console.error('usage: run-workload.js <workload> [options]');
    process.exit(2);
}
const getOpt = (flag, dflt) => {
    const i = argv.indexOf(`--${flag}`);
    return i === -1 ? dflt : argv[i + 1];
};
const vmPath = path.resolve(getOpt('vm', path.join(__dirname, '..', 'src', 'index.js')));
const RUNS = parseInt(getOpt('runs', process.env.BENCH_RUNS || '6'), 10);
const asBool = (v, dflt) => (typeof v === 'undefined' ? dflt : v === '1' || v === 'true');
const stepOverride = getOpt('step', null);

const {WORKLOADS, svg, svgMd5} = require('./workloads.js');
const wl = WORKLOADS[name];
if (!wl) {
    console.error(`unknown workload: ${name} (have: ${Object.keys(WORKLOADS).join(', ')})`);
    process.exit(2);
}

const VM = require(vmPath);
const makeTestStorage = require('../test/fixtures/make-test-storage');

/**
 * Build the sb3 zip buffer for the workload once.
 * @returns {Promise<Buffer>} zip contents
 */
const buildZip = () => {
    const project = wl.build();
    const zip = new JSZip();
    zip.file('project.json', JSON.stringify(project));
    zip.file(`${svgMd5}.svg`, svg);
    return zip.generateAsync({type: 'nodebuffer', compression: 'DEFLATE'});
};

/**
 * One full run: fresh VM, load, green flag, drain, verify.
 * @param {Buffer} buf the sb3 zip
 * @param {object} opts resolved options
 * @returns {Promise<object>} {ms, frames, verify}
 */
const oneRun = async (buf, opts) => {
    const vm = new VM();
    vm.attachStorage(makeTestStorage());
    vm.setCompilerOptions({enabled: opts.compiler, warpTimer: opts.warpTimer});
    vm.setTurboMode(opts.turbo);
    let compileError = null;
    vm.on('COMPILE_ERROR', (target, err) => {
        compileError = `compile error in ${target.getName()}: ${err}`;
    });
    const ab = buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);
    await vm.loadProject(ab);
    if (compileError) throw new Error(compileError);
    const rt = vm.runtime;
    if (opts.stepTime !== null) rt.currentStepTime = opts.stepTime;

    const maxFrames = ((wl.frames || 1000) * 3) + 1000;
    vm.greenFlag();
    const cpu0 = process.cpuUsage();
    let frames = 0;
    if (wl.mode === 'frames') {
        while (frames < wl.frames) {
            rt._step();
            frames++;
        }
    } else {
        while (rt.threads.length > 0 && frames < maxFrames) {
            rt._step();
            frames++;
        }
        if (frames >= maxFrames) throw new Error(`did not drain within ${maxFrames} frames`);
    }
    const cpu = process.cpuUsage(cpu0);
    const ms = (cpu.user + cpu.system) / 1000;
    const v = wl.verify(rt);
    if (typeof vm.quit === 'function') {
        vm.quit();
    } else {
        rt.stopAll();
        rt.dispose();
    }
    return {ms, frames, verify: v};
};

const main = async () => {
    const buf = await buildZip();
    const o = wl.options;
    const opts = {
        turbo: asBool(getOpt('turbo'), o.turbo),
        compiler: asBool(getOpt('compiler'), o.compiler),
        warpTimer: asBool(getOpt('warp'), o.warpTimer),
        stepTime: stepOverride === null ? o.stepTime : parseFloat(stepOverride)
    };
    const results = [];
    for (let r = 0; r < RUNS; r++) {
        if (typeof global.gc === 'function') {
            global.gc(); global.gc();
        }
        const res = await oneRun(buf, opts);
        results.push(res);
        console.log(`run ${r + 1}: ${res.ms.toFixed(1)}ms frames=${res.frames
        } verify=${res.verify.ok ? 'OK' : `FAIL ${res.verify.detail}`}`);
        if (!res.verify.ok) {
            console.error(`VERIFICATION FAILED: ${res.verify.detail}`);
            process.exitCode = 1;
            break;
        }
    }
    const timed = results.slice(1);
    const sorted = timed.map(x => x.ms).sort((a, b) => a - b);
    const summary = {
        workload: name,
        vm: path.relative(process.cwd(), vmPath),
        opts: {turbo: opts.turbo, compiler: opts.compiler, warpTimer: opts.warpTimer, stepTime: opts.stepTime},
        frames: results[0].frames,
        runs: results.map(x => +x.ms.toFixed(1)),
        min: +sorted[0].toFixed(1),
        median: +sorted[Math.floor(sorted.length / 2)].toFixed(1),
        max: +sorted[sorted.length - 1].toFixed(1)
    };
    console.log(`SUMMARY ${JSON.stringify(summary)}`);
    if (getOpt('json')) fs.writeFileSync(getOpt('json'), JSON.stringify(summary, null, 2));
};

main().catch(e => {
    console.error(e);
    process.exit(1);
});
