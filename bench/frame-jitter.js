/**
 * Frame-loop smoothness proxy: per-frame wall-clock interval stats while a
 * many-sprite project runs (runner-game shape). Compares two builds; a perf
 * change must not increase jitter (p99 / stddev of frame intervals).
 * Usage: node bench/frame-jitter.js --vm <path> [--frames 600]
 */
const path = require('path');
const JSZip = require('@turbowarp/jszip');

const argv = process.argv.slice(2);
const getOpt = (flag, dflt) => {
    const i = argv.indexOf(`--${flag}`);
    return i === -1 ? dflt : argv[i + 1];
};
const vmPath = path.resolve(getOpt('vm', path.join(__dirname, '..', 'src', 'index.js')));
const FRAMES = parseInt(getOpt('frames', '600'), 10);

const VM = require(vmPath);
const makeTestStorage = require('../test/fixtures/make-test-storage');
const {WORKLOADS, svg, svgMd5} = require('./workloads.js');

const main = async () => {
    const wl = WORKLOADS['w1-many-sprites'];
    const project = wl.build();
    const zip = new JSZip();
    zip.file('project.json', JSON.stringify(project));
    zip.file(`${svgMd5}.svg`, svg);
    const buf = await zip.generateAsync({type: 'nodebuffer', compression: 'DEFLATE'});
    const vm = new VM();
    vm.attachStorage(makeTestStorage());
    vm.setCompilerOptions({enabled: true, warpTimer: true});
    vm.setTurboMode(false);
    await vm.loadProject(buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength));
    const rt = vm.runtime;
    // editor-realistic step budget
    rt.currentStepTime = 1000 / 30;
    vm.greenFlag();
    // warmup 100 frames
    for (let i = 0; i < 100; i++) rt._step();
    const intervals = [];
    let prev = process.hrtime.bigint();
    for (let i = 0; i < FRAMES; i++) {
        rt._step();
        const now = process.hrtime.bigint();
        intervals.push(Number(now - prev) / 1e6);
        prev = now;
    }
    const sorted = [...intervals].sort((a, b) => a - b);
    const mean = intervals.reduce((a, b) => a + b, 0) / intervals.length;
    const sd = Math.sqrt(intervals.reduce((acc, b) => acc + ((b - mean) * (b - mean)), 0) / intervals.length);
    const p50 = sorted[Math.floor(sorted.length * 0.5)];
    const p99 = sorted[Math.floor(sorted.length * 0.99)];
    const max = sorted[sorted.length - 1];
    console.log(`JITTER ${JSON.stringify({
        vm: path.basename(vmPath),
        frames: FRAMES,
        meanMs: +mean.toFixed(3),
        sdMs: +sd.toFixed(3),
        p50Ms: +p50.toFixed(3),
        p99Ms: +p99.toFixed(3),
        maxMs: +max.toFixed(3)
    })}`);
    if (typeof rt.quit === 'function') rt.quit();
};

main().catch(e => {
    console.error(e);
    process.exit(1);
});
