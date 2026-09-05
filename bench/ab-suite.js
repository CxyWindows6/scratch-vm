/**
 * Interleaved A/B benchmark: loads two VM builds in one process and alternates
 * runs (A,B,A,B,...) so machine drift hits both arms equally. Reports per-workload
 * medians and the paired ratio B/A.
 *
 * Usage: node --expose-gc bench/ab-suite.js --vmA <path> --vmB <path>
 *            [--workloads a,b,c] [--pairs 5] [--out file.json]
 */
const path = require('path');
const fs = require('fs');
const JSZip = require('@turbowarp/jszip');

const argv = process.argv.slice(2);
const getOpt = (flag, dflt) => {
    const i = argv.indexOf(`--${flag}`);
    return i === -1 ? dflt : argv[i + 1];
};
const vmAPath = path.resolve(getOpt('vmA'));
const vmBPath = path.resolve(getOpt('vmB'));
const PAIRS = parseInt(getOpt('pairs', '5'), 10);
const ALL = ['w1-many-sprites', 'w2-interpreter', 'w3-clone-storm', 'w4-sensing-edge',
    'w4b-frame-overhead', 'w5-broadcast', 'w6-list-head', 'w7-string-join'];
const workloads = getOpt('workloads') ? getOpt('workloads').split(',') : ALL;

const {WORKLOADS, svg, svgMd5} = require('./workloads.js');
const makeTestStorage = require('../test/fixtures/make-test-storage');

const VMA = require(vmAPath);
const VMB = require(vmBPath);

/**
 * @param {object} wl workload definition
 * @returns {Promise<Buffer>} sb3 zip buffer
 */
const buildZip = wl => {
    const project = wl.build();
    const zip = new JSZip();
    zip.file('project.json', JSON.stringify(project));
    zip.file(`${svgMd5}.svg`, svg);
    return zip.generateAsync({type: 'nodebuffer', compression: 'DEFLATE'});
};

/**
 * One timed run against one VM class.
 * @param {Function} VMClass constructor from a build
 * @param {Buffer} buf sb3 zip
 * @param {object} opts options
 * @returns {Promise<object>} {ms, frames, ok, detail}
 */
const oneRun = async (VMClass, buf, opts) => {
    const vm = new VMClass();
    vm.attachStorage(makeTestStorage());
    vm.setCompilerOptions({enabled: opts.compiler, warpTimer: opts.warpTimer});
    vm.setTurboMode(opts.turbo);
    let compileError = null;
    vm.on('COMPILE_ERROR', (target, err) => {
        compileError = `compile error: ${err}`;
    });
    const ab = buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);
    await vm.loadProject(ab);
    if (compileError) throw new Error(compileError);
    const rt = vm.runtime;
    if (opts.stepTime !== null) rt.currentStepTime = opts.stepTime;
    const wl = opts.wl;
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
        if (frames >= maxFrames) throw new Error('did not drain');
    }
    const cpu = process.cpuUsage(cpu0);
    const ms = (cpu.user + cpu.system) / 1000;
    const v = wl.verify(rt);
    if (typeof rt.quit === 'function') rt.quit();
    return {ms, frames, ok: v.ok, detail: v.detail};
};

const median = arr => {
    const s = [...arr].sort((a, b) => a - b);
    return s[Math.floor(s.length / 2)];
};

const main = async () => {
    const results = [];
    for (const name of workloads) {
        const wl = WORKLOADS[name];
        const buf = await buildZip(wl);
        const o = wl.options;
        const opts = {turbo: o.turbo, compiler: o.compiler, warpTimer: o.warpTimer, stepTime: o.stepTime, wl};
        // warmup pair (not timed into stats)
        await oneRun(VMA, buf, opts);
        await oneRun(VMB, buf, opts);
        const aMs = [];
        const bMs = [];
        for (let p = 0; p < PAIRS; p++) {
            if (typeof global.gc === 'function') {
                global.gc(); global.gc();
            }
            const a = await oneRun(VMA, buf, opts);
            if (!a.ok) throw new Error(`${name} verify FAIL(A): ${a.detail}`);
            if (typeof global.gc === 'function') {
                global.gc(); global.gc();
            }
            const b = await oneRun(VMB, buf, opts);
            if (!b.ok) throw new Error(`${name} verify FAIL(B): ${b.detail}`);
            aMs.push(a.ms);
            bMs.push(b.ms);
        }
        const medA = median(aMs);
        const medB = median(bMs);
        const row = {
            workload: name,
            A: +medA.toFixed(1),
            B: +medB.toFixed(1),
            ratio: +(medB / medA).toFixed(3),
            deltaPct: +((100 * (medB - medA)) / medA).toFixed(1),
            runsA: aMs.map(x => +x.toFixed(0)),
            runsB: bMs.map(x => +x.toFixed(0))
        };
        results.push(row);
        const sign = row.deltaPct > 0 ? '+' : '';
        console.log(`${name}: A=${row.A}ms B=${row.B}ms ratio=${row.ratio} (${sign}${row.deltaPct}%)`);
    }
    const out = {
        vmA: path.relative(process.cwd(), vmAPath),
        vmB: path.relative(process.cwd(), vmBPath),
        pairs: PAIRS,
        results
    };
    const outFile = getOpt('out');
    if (outFile) fs.writeFileSync(outFile, JSON.stringify(out, null, 2));
    console.log(`ABSUMMARY ${JSON.stringify(out)}`);
};

main().catch(e => {
    console.error(e);
    process.exit(1);
});
