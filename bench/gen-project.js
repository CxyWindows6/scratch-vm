/**
 * Generates bench/quicksort.sb3 — a compute-bound benchmark project for scratch-vm.
 *
 * Everything runs inside a "run without screen refresh" (warp) procedure `bench`:
 *   1. Fill list `nums` with N unique numbers in scrambled order:
 *        value(i) = (i * 7919) mod N   for i = 1..N
 *      7919 is prime and coprime with N (N = 10^k), so this is a permutation of 0..N-1.
 *   2. Hoare quicksort with an explicit stack (list `stk`, pushed as lo,hi pairs,
 *      popped via `item last` + `delete last`). Uses only list primitives:
 *        item () of [] / replace item () of [] with () / length of [] / add () to [] / delete last of []
 *   3. Verify sortedness: count adjacent inversions into `bad` (0 == success).
 *
 * Usage: node bench/gen-project.js [N]     (default N=1000000)
 * Output: bench/quicksort.sb3 (zip) + bench/quicksort.project.json
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const JSZip = require('@turbowarp/jszip');

const N = parseInt(process.argv[2] || process.env.BENCH_N || '1000000', 10);
const MULT = 7919;

/**
 * Compute the greatest common divisor.
 * @param {number} a - first number.
 * @param {number} b - second number.
 * @returns {number} the greatest common divisor of a and b.
 */
const gcd = (a, b) => {
    while (b) {
        const t = b;
        b = a % b;
        a = t;
    }
    return a;
};
if (gcd(MULT, N) !== 1) throw new Error(`multiplier ${MULT} not coprime with N=${N}`);

// ---------------------------------------------------------------- block builder
let idCounter = 0;
const uid = () => `q${(++idCounter).toString(36)}`;
const blocks = {};

/** Build a block and register it in the global blocks table.
 * @param {string} opcode - the block opcode.
 * @param {object} opts - optional block properties.
 * @returns {string} the new block id.
 */
const mk = (opcode, opts = {}) => {
    const id = uid();
    const b = {
        opcode,
        next: opts.next || null,
        parent: opts.parent || null,
        inputs: opts.inputs || {},
        fields: opts.fields || {},
        shadow: !!opts.shadow,
        topLevel: !!opts.topLevel
    };
    if (b.topLevel) {
        b.x = opts.x || 0;
        b.y = opts.y || 0;
    }
    if (opts.mutation) b.mutation = opts.mutation;
    blocks[id] = b;
    return id;
};

/** Link a sequence of block ids into a stack.
 * @param {string[]} ids - block ids in execution order.
 * @returns {string} the first block id.
 */
const chain = ids => {
    for (let i = 0; i < ids.length - 1; i++) {
        blocks[ids[i]].next = ids[i + 1];
        blocks[ids[i + 1]].parent = ids[i];
    }
    return ids[0];
};

// input descriptors
const inPrim = prim => [1, prim]; // unobscured shadow (primitive)
const inBlock = id => [2, id]; // obscured by a real block, no shadow
const pNum = v => [4, String(v)]; // math_number
const pVar = (name, id) => [12, name, id]; // data_variable reporter

// variables and lists (all stage-global)
const V = {};
for (const name of ['i', 'j', 'lo', 'hi', 'pivot', 'tmp', 'bad']) V[name] = `v-${name}`;
const L = {nums: 'l-nums', stk: 'l-stk'};

const gVar = name => inPrim(pVar(name, V[name]));
const n = v => inPrim(pNum(v));

// reporters
const itemOf = (list, indexInput) => mk('data_itemoflist', {
    inputs: {INDEX: indexInput},
    fields: {LIST: [list, L[list]]}
});
const lenOf = list => mk('data_lengthoflist', {fields: {LIST: [list, L[list]]}});
const op2 = (opcode, a, b) => mk(opcode, {inputs: {OPERAND1: a, OPERAND2: b}});
const ar2 = (opcode, a, b) => mk(opcode, {inputs: {NUM1: a, NUM2: b}});
const lastMenu = () => mk('data_indexmenu', {fields: {INDEX: ['last']}, shadow: true});

// commands
const setVar = (name, valueInput) => mk('data_setvariableto', {
    inputs: {VALUE: valueInput},
    fields: {VARIABLE: [name, V[name]]}
});
const changeVar = (name, valueInput) => mk('data_changevariableby', {
    inputs: {VALUE: valueInput},
    fields: {VARIABLE: [name, V[name]]}
});
const addToList = (list, itemInput) => mk('data_addtolist', {
    inputs: {ITEM: itemInput},
    fields: {LIST: [list, L[list]]}
});
const replaceItem = (list, indexInput, itemInput) => mk('data_replaceitemoflist', {
    inputs: {INDEX: indexInput, ITEM: itemInput},
    fields: {LIST: [list, L[list]]}
});
const deleteOf = (list, indexInput) => mk('data_deleteoflist', {
    inputs: {INDEX: indexInput},
    fields: {LIST: [list, L[list]]}
});
const deleteAll = list => mk('data_deletealloflist', {fields: {LIST: [list, L[list]]}});
const repeat = (timesInput, substackId) => mk('control_repeat', {
    inputs: {TIMES: timesInput, SUBSTACK: inBlock(substackId)}
});
const whileDo = (condInput, substackId) => mk('control_while', {
    inputs: {CONDITION: condInput, SUBSTACK: inBlock(substackId)}
});
const ifDo = (condInput, substackId) => mk('control_if', {
    inputs: {CONDITION: condInput, SUBSTACK: inBlock(substackId)}
});
const lt = (a, b) => inBlock(op2('operator_lt', a, b));
const gt = (a, b) => inBlock(op2('operator_gt', a, b));

// ---------------------------------------------------------------- algorithm body
const fillLoop = repeat(n(N), chain([
    changeVar('i', n(1)),
    addToList('nums', inBlock(ar2('operator_mod',
        inBlock(ar2('operator_multiply', gVar('i'), n(MULT))),
        n(N))))
]));

const swapBlock = ifDo(lt(gVar('i'), gVar('j')), chain([
    setVar('tmp', inBlock(itemOf('nums', gVar('i')))),
    replaceItem('nums', gVar('i'), inBlock(itemOf('nums', gVar('j')))),
    replaceItem('nums', gVar('j'), gVar('tmp'))
]));

const scanLoop = whileDo(lt(gVar('i'), gVar('j')), chain([
    changeVar('i', n(1)),
    // do { i++ } while (item i of nums) < pivot
    whileDo(lt(inBlock(itemOf('nums', gVar('i'))), gVar('pivot')), chain([changeVar('i', n(1))])),
    changeVar('j', n(-1)),
    // do { j-- } while (item j of nums) > pivot
    whileDo(gt(inBlock(itemOf('nums', gVar('j'))), gVar('pivot')), chain([changeVar('j', n(-1))])),
    swapBlock
]));

const partition = ifDo(lt(gVar('lo'), gVar('hi')), chain([
    setVar('pivot', inBlock(itemOf('nums', gVar('lo')))),
    setVar('i', inBlock(ar2('operator_subtract', gVar('lo'), n(1)))),
    setVar('j', inBlock(ar2('operator_add', gVar('hi'), n(1)))),
    scanLoop,
    // push [lo, j] if lo < j
    ifDo(lt(gVar('lo'), gVar('j')), chain([
        addToList('stk', gVar('lo')),
        addToList('stk', gVar('j'))
    ])),
    // push [j+1, hi] if j+1 < hi
    ifDo(lt(inBlock(ar2('operator_add', gVar('j'), n(1))), gVar('hi')), chain([
        addToList('stk', inBlock(ar2('operator_add', gVar('j'), n(1)))),
        addToList('stk', gVar('hi'))
    ]))
]));

const mainLoop = whileDo(gt(inBlock(lenOf('stk')), n(0)), chain([
    setVar('hi', inBlock(itemOf('stk', inBlock(lastMenu())))),
    deleteOf('stk', inBlock(lastMenu())),
    setVar('lo', inBlock(itemOf('stk', inBlock(lastMenu())))),
    deleteOf('stk', inBlock(lastMenu())),
    partition
]));

const verifyLoop = repeat(
    inBlock(ar2('operator_subtract', inBlock(lenOf('nums')), n(1))),
    chain([
        changeVar('i', n(1)),
        ifDo(gt(
            inBlock(itemOf('nums', gVar('i'))),
            inBlock(itemOf('nums', inBlock(ar2('operator_add', gVar('i'), n(1)))))
        ), chain([
            changeVar('bad', n(1))
        ]))
    ])
);

const body = chain([
    deleteAll('nums'),
    deleteAll('stk'),
    setVar('i', n(0)),
    fillLoop,
    addToList('stk', n(1)),
    addToList('stk', inBlock(lenOf('nums'))),
    mainLoop,
    setVar('bad', n(0)),
    setVar('i', n(0)),
    verifyLoop
]);

// ---------------------------------------------------------------- procedure + hat
const protoId = mk('procedures_prototype', {
    shadow: true,
    mutation: {
        tagName: 'mutation',
        children: [],
        warp: 'true',
        proccode: 'bench',
        argumentids: '[]',
        argumentnames: '[]',
        argumentdefaults: '[]',
        template: 'bench',
        widths: ''
    }
});
const defId = mk('procedures_definition', {
    inputs: {custom_block: [1, protoId]},
    topLevel: true,
    x: 400,
    y: 0
});
blocks[body].parent = defId;
blocks[defId].next = body;

const callId = mk('procedures_call', {
    mutation: {
        tagName: 'mutation',
        children: [],
        proccode: 'bench',
        argumentids: '[]',
        warpids: '[]',
        warp: 'true'
    }
});
const hatId = mk('event_whenflagclicked', {topLevel: true, x: 400, y: -200, next: callId});
blocks[callId].parent = hatId;

// ---------------------------------------------------------------- stage + project
// A tiny SVG costume; assetId = its real md5 so storage validation passes.
const svg = '<svg xmlns="http://www.w3.org/2000/svg" width="1" height="1"></svg>';
const svgMd5 = crypto.createHash('md5').update(Buffer.from(svg))
    .digest('hex');

const stage = {
    isStage: true,
    name: 'Stage',
    variables: Object.fromEntries(Object.entries(V).map(([name, id]) => [id, [name, 0]])),
    lists: {[L.nums]: ['nums', []], [L.stk]: ['stk', []]},
    broadcasts: {},
    blocks,
    comments: {},
    currentCostume: 0,
    costumes: [{
        name: 'backdrop1',
        dataFormat: 'svg',
        assetId: svgMd5,
        md5ext: `${svgMd5}.svg`,
        rotationCenterX: 240,
        rotationCenterY: 180,
        bitmapResolution: 1
    }],
    sounds: [],
    volume: 100,
    layerOrder: 0,
    tempo: 60,
    videoTransparency: 50,
    videoState: 'off',
    textToSpeechLanguage: null,
    visible: true,
    x: 0,
    y: 0,
    size: 100,
    direction: 90,
    draggable: false,
    rotationStyle: 'all around'
};

const project = {
    targets: [stage],
    monitors: [],
    extensions: [],
    meta: {semver: '3.0.0', original: 'scratch3', vm: '2.1.46', agent: 'surge-compute-bench'}
};

const outDir = __dirname;
fs.writeFileSync(path.join(outDir, 'quicksort.project.json'), JSON.stringify(project));

const zip = new JSZip();
zip.file('project.json', JSON.stringify(project));
zip.file(`${svgMd5}.svg`, svg);
zip.generateAsync({type: 'nodebuffer', compression: 'DEFLATE'}).then(buf => {
    fs.writeFileSync(path.join(outDir, 'quicksort.sb3'), buf);
    console.log(`wrote bench/quicksort.sb3 (N=${N}, ${buf.length} bytes, ${Object.keys(blocks).length} blocks)`);
});
