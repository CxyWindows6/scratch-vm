/**
 * Representative real-world workloads for VM hotspot profiling.
 *
 * Each workload is a self-contained sb3 project (built in memory, zipped with
 * the same tiny SVG costume asset) plus:
 *   - options: VM configuration (turbo / compiler / warpTimer / stepTime)
 *   - frames:  expected number of _step() calls to drain (guard = frames*3+100)
 *   - verify(runtime): independent JS expectation check of the final state
 *
 * Workloads (mapped to the task's seven categories):
 *   w1-many-sprites  30 sprites x repeat 3000 {change x; if x>1e9}  frame loop
 *   w2-interpreter   compiler OFF, warp proc, 2M {change x by 1; if gt; set}
 *   w3-clone-storm   4000 create-clone + delete-this-clone lifecycle
 *   w4-sensing-edge  5 sprites read timer/mouse/key per frame + 50 edge hats
 *   w5-broadcast     two sprites ping-pong 50k broadcasts each way
 *   w6-list-head     10k list, 10k x (insert at 1 + delete 1) O(n^2) splice
 *   w7-string-join   1M x (letter of + join + change counter)
 *
 * Determinism: w1/w4/w5 set runtime.currentStepTime to a tiny value so the
 * sequencer performs exactly one thread pass per _step() (the latency-critical
 * regime of a real 60fps project), making frame counts deterministic.
 */
const crypto = require('crypto');

// ---------------------------------------------------------------- asset
const svg = '<svg xmlns="http://www.w3.org/2000/svg" width="1" height="1"></svg>';
const svgMd5 = crypto.createHash('md5').update(Buffer.from(svg))
    .digest('hex');
const COSTUME = {
    name: 'c1',
    dataFormat: 'svg',
    assetId: svgMd5,
    md5ext: `${svgMd5}.svg`,
    rotationCenterX: 240,
    rotationCenterY: 180,
    bitmapResolution: 1
};

// ---------------------------------------------------------------- builder
class Builder {
    constructor () {
        this.idCounter = 0;
        this.targets = [];
        this.broadcasts = {}; // id -> name (stage-level)
    }

    sprite (name, id, x, y) {
        const t = {
            id,
            isStage: false,
            name,
            variables: {},
            lists: {},
            broadcasts: {},
            blocks: {},
            comments: {},
            currentCostume: 0,
            costumes: [Object.assign({}, COSTUME)],
            sounds: [],
            volume: 100,
            layerOrder: this.targets.length + 1,
            visible: true,
            x: typeof x === 'undefined' ? 0 : x,
            y: typeof y === 'undefined' ? 0 : y,
            size: 100,
            direction: 90,
            draggable: false,
            rotationStyle: 'all around'
        };
        this.targets.push(t);
        return t;
    }

    stage () {
        const t = {
            isStage: true,
            name: 'Stage',
            variables: {},
            lists: {},
            broadcasts: this.broadcasts,
            blocks: {},
            comments: {},
            currentCostume: 0,
            costumes: [Object.assign({}, COSTUME, {name: 'backdrop1'})],
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
        this.targets.unshift(t);
        return t;
    }

    project () {
        return {
            targets: this.targets,
            monitors: [],
            extensions: [],
            meta: {semver: '3.0.0', original: 'scratch3', vm: '2.1.46', agent: 'surge-workload-bench'}
        };
    }
}

// ---------------------------------------------------------------- block ops
let blockSeq = 0;
const mk = (target, opcode, opts = {}) => {
    const id = opts.id || (`k${++blockSeq}`);
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
        b.x = typeof opts.x === 'undefined' ? 0 : opts.x;
        b.y = typeof opts.y === 'undefined' ? 0 : opts.y;
    }
    if (opts.mutation) b.mutation = opts.mutation;
    target.blocks[id] = b;
    return id;
};

const chainIn = (target, ids) => {
    for (let i = 0; i < ids.length - 1; i++) {
        target.blocks[ids[i]].next = ids[i + 1];
        target.blocks[ids[i + 1]].parent = ids[i];
    }
    return ids[0];
};

// input descriptors
const inPrim = prim => [1, prim];
const inBlock = id => [2, id];
const pNum = v => [4, String(v)];
const pStr = v => [10, v];

// reporters
const varRep = (t, name, id) => mk(t, 'data_variable', {fields: {VARIABLE: [name, id]}});
const op2 = (t, opcode, a, b) => mk(t, opcode, {inputs: {OPERAND1: a, OPERAND2: b}});

// data commands
const setVar = (t, name, id, valueInput) => mk(t, 'data_setvariableto', {
    inputs: {VALUE: valueInput}, fields: {VARIABLE: [name, id]}
});
const changeVar = (t, name, id, valueInput) => mk(t, 'data_changevariableby', {
    inputs: {VALUE: valueInput}, fields: {VARIABLE: [name, id]}
});
const repeatN = (t, n, subId) => mk(t, 'control_repeat', {
    inputs: {TIMES: inPrim(pNum(n)), SUBSTACK: inBlock(subId)}
});
const ifDo = (t, condInput, subId) => mk(t, 'control_if', {
    inputs: {CONDITION: condInput, SUBSTACK: inBlock(subId)}
});

// broadcast
const addBroadcast = (builder, name) => {
    const id = `bc-${name}`;
    builder.broadcasts[id] = name;
    return id;
};
const broadcastCmd = (t, name, id) => {
    const menu = mk(t, 'event_broadcast_menu', {fields: {BROADCAST_OPTION: [name, id]}, shadow: true});
    return mk(t, 'event_broadcast', {inputs: {BROADCAST_INPUT: inPrim(menu)}});
};
const whenReceive = (t, name, id, bodyId) => mk(t, 'event_whenbroadcastreceived', {
    fields: {BROADCAST_OPTION: [name, id]}, topLevel: true, next: bodyId, x: 0, y: -200
});

// clones
const createCloneOf = (t, spriteName, spriteId) => {
    const menu = mk(t, 'control_create_clone_of_menu', {fields: {CLONE_OPTION: [spriteName, spriteId]}, shadow: true});
    return mk(t, 'control_create_clone_of', {inputs: {CLONE_OPTION: inPrim(menu)}});
};
const deleteThisClone = t => mk(t, 'control_delete_this_clone', {});
const whenClone = (t, bodyId) => mk(t, 'control_start_as_clone', {topLevel: true, next: bodyId, x: 0, y: -300});

// sensing
const sensingTimer = t => mk(t, 'sensing_timer', {});
const sensingMouseX = t => mk(t, 'sensing_mousex', {});
const sensingKeyPressed = (t, key) => {
    const menu = mk(t, 'sensing_keymenu', {fields: {KEY_OPTION: [key]}, shadow: true});
    return mk(t, 'sensing_keypressed', {inputs: {KEY_OPTION: inPrim(menu)}});
};
const whenGreaterTimer = (t, value) => mk(t, 'event_whengreaterthan', {
    fields: {WHENGREATERTHANMENU: ['TIMER']},
    inputs: {VALUE: inPrim(pNum(value))},
    topLevel: true,
    x: 0,
    y: -400
});

// strings
const joinOp = (t, a, b) => mk(t, 'operator_join', {inputs: {STRING1: a, STRING2: b}});
const letterOf = (t, letterInput, strInput) => mk(t, 'operator_letter_of', {
    inputs: {LETTER: letterInput, STRING: strInput}
});

// lists
const listAdd = (t, listName, listId, itemInput) => mk(t, 'data_addtolist', {
    inputs: {ITEM: itemInput}, fields: {LIST: [listName, listId]}
});
const listInsert = (t, listName, listId, indexInput, itemInput) => mk(t, 'data_insertatlist', {
    inputs: {INDEX: indexInput, ITEM: itemInput}, fields: {LIST: [listName, listId]}
});
const listDelete = (t, listName, listId, indexInput) => mk(t, 'data_deleteoflist', {
    inputs: {INDEX: indexInput}, fields: {LIST: [listName, listId]}
});
const listDeleteAll = (t, listName, listId) => mk(t, 'data_deletealloflist', {
    fields: {LIST: [listName, listId]}
});

// motion
const changeXBy = (t, valueInput) => mk(t, 'motion_changexby', {inputs: {DX: valueInput}});
const setXTo = (t, valueInput) => mk(t, 'motion_setx', {inputs: {X: valueInput}});
const xPosition = t => mk(t, 'motion_xposition', {});

const whenFlag = (t, bodyId, x, y) => mk(t, 'event_whenflagclicked', {
    topLevel: true, next: bodyId, x: x || 0, y: y || 0
});

/**
 * Wrap a stack into a warp procedure called from a green-flag script.
 * @param {object} t target record
 * @param {string} procName procedure code name
 * @param {string} bodyId first block id of the body stack
 * @returns {string} the green-flag hat block id
 */
const warpProcedure = (t, procName, bodyId) => {
    const protoId = mk(t, 'procedures_prototype', {
        shadow: true,
        mutation: {
            tagName: 'mutation',
            children: [],
            warp: 'true',
            proccode: procName,
            argumentids: '[]',
            argumentnames: '[]',
            argumentdefaults: '[]',
            template: procName,
            widths: ''
        }
    });
    const defId = mk(t, 'procedures_definition', {
        inputs: {custom_block: [1, protoId]}, topLevel: true, x: 400, y: 0
    });
    t.blocks[bodyId].parent = defId;
    t.blocks[defId].next = bodyId;
    const callId = mk(t, 'procedures_call', {
        mutation: {
            tagName: 'mutation',
            children: [],
            proccode: procName,
            argumentids: '[]',
            warpids: '[]',
            warp: 'true'
        }
    });
    const hatId = whenFlag(t, callId, 400, -200);
    t.blocks[callId].parent = hatId;
    return hatId;
};

// ================================================================ workloads
const WORKLOADS = {};

WORKLOADS['w1-many-sprites'] = {
    options: {turbo: false, compiler: true, warpTimer: true, stepTime: 0.001},
    frames: 40000,
    build () {
        const B = new Builder();
        B.stage();
        for (let i = 0; i < 30; i++) {
            const t = B.sprite(`s${String(i).padStart(2, '0')}`, `sp${i}`, 30 + i, 100);
            const body = chainIn(t, [
                setXTo(t, inPrim(pNum(30 + i))),
                repeatN(t, 40000, chainIn(t, [
                    changeXBy(t, inPrim(pNum(1))),
                    ifDo(t, inBlock(op2(t, 'operator_gt', inBlock(xPosition(t)), inPrim(pNum(1e9)))),
                        chainIn(t, [setXTo(t, inPrim(pNum(0)))]))
                ]))
            ]);
            whenFlag(t, body);
        }
        return B.project();
    },
    verify (runtime) {
        for (let i = 0; i < 30; i++) {
            const t = runtime.getSpriteTargetByName(`s${String(i).padStart(2, '0')}`);
            if (!t) return {ok: false, detail: `missing s${i}`};
            const want = 30 + i + 40000;
            if (t.x !== want) return {ok: false, detail: `s${i}.x=${t.x} want ${want}`};
        }
        return {ok: true, detail: '30 sprites x=3030..3059'};
    }
};

WORKLOADS['w2-interpreter'] = {
    options: {turbo: false, compiler: false, warpTimer: true, stepTime: null},
    frames: 1000,
    build () {
        const B = new Builder();
        const t = B.stage();
        t.variables['v-x'] = ['x', 0];
        t.variables['v-y'] = ['y', 0];
        t.variables['v-r'] = ['r', 0];
        const bcTick = addBroadcast(B, 'tick');
        const N = 2000000;
        const body = chainIn(t, [
            repeatN(t, N, chainIn(t, [
                changeVar(t, 'x', 'v-x', inPrim(pNum(1))),
                ifDo(t, inBlock(op2(t, 'operator_gt', inBlock(varRep(t, 'x', 'v-x')), inPrim(pNum(5)))),
                    chainIn(t, [setVar(t, 'y', 'v-y', inBlock(varRep(t, 'x', 'v-x')))]))
            ]))
        ]);
        const hatId = warpProcedure(t, 'hot', body);
        // deterministic broadcast dispatch after the warp loop (outside warp):
        // 20 plain broadcasts, each receiver runs before the next broadcast
        const callId = t.blocks[hatId].next;
        const bcLoop = repeatN(t, 20, broadcastCmd(t, 'tick', bcTick));
        t.blocks[callId].next = bcLoop;
        t.blocks[bcLoop].parent = callId;
        whenReceive(t, 'tick', bcTick, changeVar(t, 'r', 'v-r', inPrim(pNum(1))));
        return B.project();
    },
    verify (runtime) {
        const v = id => runtime.getTargetForStage().variables[id].value;
        const x = Number(v('v-x')); const y = Number(v('v-y')); const r = Number(v('v-r'));
        if (x !== 2000000) return {ok: false, detail: `x=${x}`};
        if (y !== 2000000) return {ok: false, detail: `y=${y}`};
        if (r !== 20) return {ok: false, detail: `r=${r}`};
        return {ok: true, detail: 'x=y=2000000 r=20'};
    }
};

WORKLOADS['w3-clone-storm'] = {
    options: {turbo: false, compiler: true, warpTimer: true, stepTime: null},
    frames: 100000,
    build () {
        const B = new Builder();
        const stage = B.stage();
        stage.variables['v-c'] = ['c', 0];
        stage.variables['v-phase'] = ['phase', 0];
        const bcDie = addBroadcast(B, 'die');
        const worker = B.sprite('Worker', 'spw', 0, 0);
        // 250 persistent clones (Scratch clone limit is 300) keep the target
        // list large so every create-clone hat scan walks ~250 targets; then
        // 20000 short-lived clones exercise the full create->hat->delete cycle.
        const body = chainIn(stage, [
            repeatN(stage, 250, createCloneOf(stage, 'Worker', 'spw')),
            setVar(stage, 'phase', 'v-phase', inPrim(pNum(1))),
            repeatN(stage, 20000, createCloneOf(stage, 'Worker', 'spw')),
            setVar(stage, 'phase', 'v-phase', inPrim(pNum(0))),
            broadcastCmd(stage, 'die', bcDie)
        ]);
        whenFlag(stage, body);
        whenClone(worker, chainIn(worker, [
            changeVar(worker, 'c', 'v-c', inPrim(pNum(1))),
            ifDo(worker, inBlock(op2(worker, 'operator_equals',
                inBlock(varRep(worker, 'phase', 'v-phase')), inPrim(pNum(1)))),
            chainIn(worker, [deleteThisClone(worker)]))
        ]));
        whenReceive(worker, 'die', bcDie, deleteThisClone(worker));
        return B.project();
    },
    verify (runtime) {
        const c = Number(runtime.getTargetForStage().variables['v-c'].value);
        if (c !== 20250) return {ok: false, detail: `c=${c}`};
        const clones = runtime.targets.filter(t => !t.isOriginal).length;
        if (clones !== 0) return {ok: false, detail: `clones=${clones}`};
        return {ok: true, detail: 'c=20250 clones=0'};
    }
};

WORKLOADS['w4-sensing-edge'] = {
    options: {turbo: false, compiler: true, warpTimer: true, stepTime: 0.001},
    frames: 400000,
    build () {
        const B = new Builder();
        B.stage();
        for (let i = 0; i < 5; i++) {
            const t = B.sprite(`p${i}`, `wp${i}`, 0, 0);
            t.variables[`v-c${i}`] = ['cnt', 0];
            t.variables[`v-t${i}`] = ['tv', 0];
            t.variables[`v-m${i}`] = ['mv', 0];
            t.variables[`v-k${i}`] = ['kv', 0];
            const body = chainIn(t, [
                repeatN(t, 400000, chainIn(t, [
                    setVar(t, 'tv', `v-t${i}`, inBlock(sensingTimer(t))),
                    setVar(t, 'mv', `v-m${i}`, inBlock(sensingMouseX(t))),
                    ifDo(t, inBlock(sensingKeyPressed(t, 'space')),
                        chainIn(t, [changeVar(t, 'kv', `v-k${i}`, inPrim(pNum(1)))])),
                    changeVar(t, 'cnt', `v-c${i}`, inPrim(pNum(1)))
                ]))
            ]);
            whenFlag(t, body);
        }
        return B.project();
    },
    verify (runtime) {
        for (let i = 0; i < 5; i++) {
            const t = runtime.getSpriteTargetByName(`p${i}`);
            const cnt = Number(t.variables[`v-c${i}`].value);
            const mv = Number(t.variables[`v-m${i}`].value);
            const kv = Number(t.variables[`v-k${i}`].value);
            if (cnt !== 400000) return {ok: false, detail: `p${i}.cnt=${cnt}`};
            if (mv !== 0) return {ok: false, detail: `p${i}.mv=${mv}`};
            if (kv !== 0) return {ok: false, detail: `p${i}.kv=${kv}`};
        }
        return {ok: true, detail: '5x cnt=400000'};
    }
};

// Pure per-frame fixed cost: 50 sprites, no running threads, 50 edge-activated
// hats evaluated every frame, 20 visible variable monitors updated every frame.
// mode=frames: run exactly F _step() calls (work per frame is VM-speed
// independent because no script threads ever survive a frame).
WORKLOADS['w4b-frame-overhead'] = {
    options: {turbo: false, compiler: true, warpTimer: true, stepTime: 0.001},
    mode: 'frames',
    frames: 5000,
    build () {
        const B = new Builder();
        const stage = B.stage();
        const monitors = [];
        for (let i = 0; i < 50; i++) {
            const t = B.sprite(`e${i}`, `we${i}`, 0, 0);
            t.variables[`v-e${i}`] = ['ev', 0];
            const hat = whenGreaterTimer(t, 999999);
            t.blocks[hat].next = changeVar(t, 'ev', `v-e${i}`, inPrim(pNum(1)));
        }
        // 20 stage variable monitors, visible -> monitor threads every frame
        for (let i = 0; i < 20; i++) {
            const id = `v-mon${i}`;
            stage.variables[id] = [`mon${i}`, i];
            monitors.push({
                id,
                mode: 'default',
                opcode: 'data_variable',
                params: {VARIABLE: `mon${i}`},
                spriteName: null,
                value: i,
                x: 5 + i,
                y: 5,
                width: 0,
                height: 0,
                visible: true,
                min: 0,
                max: 100
            });
        }
        const proj = B.project();
        proj.monitors = monitors;
        return proj;
    },
    verify (runtime) {
        // edge hats never fire (timer > 999999 false): all ev counters must be 0
        for (let i = 0; i < 50; i++) {
            const t = runtime.getSpriteTargetByName(`e${i}`);
            const ev = Number(t.variables[`v-e${i}`].value);
            if (ev !== 0) return {ok: false, detail: `e${i}.ev=${ev}`};
        }
        if (runtime.targets.length !== 51) return {ok: false, detail: `targets=${runtime.targets.length}`};
        return {ok: true, detail: 'no edge fired'};
    }
};

WORKLOADS['w5-broadcast'] = {
    options: {turbo: false, compiler: true, warpTimer: true, stepTime: 0.001},
    frames: 250000,
    build () {
        const B = new Builder();
        const stage = B.stage();
        stage.variables['v-ca'] = ['ca', 0];
        stage.variables['v-cb'] = ['cb', 0];
        const bcB = addBroadcast(B, 'to-b');
        const bcA = addBroadcast(B, 'to-a');
        const a = B.sprite('A', 'spa', 0, 0);
        const b = B.sprite('B', 'spb', 0, 0);
        whenFlag(a, repeatN(a, 250000, broadcastCmd(a, 'to-b', bcB)));
        whenReceive(b, 'to-b', bcB, chainIn(b, [
            changeVar(b, 'cb', 'v-cb', inPrim(pNum(1))),
            broadcastCmd(b, 'to-a', bcA)
        ]));
        whenReceive(a, 'to-a', bcA, changeVar(a, 'ca', 'v-ca', inPrim(pNum(1))));
        return B.project();
    },
    verify (runtime) {
        const v = id => Number(runtime.getTargetForStage().variables[id].value);
        const ca = v('v-ca'); const cb = v('v-cb');
        if (ca !== 250000 || cb !== 250000) return {ok: false, detail: `ca=${ca} cb=${cb}`};
        return {ok: true, detail: 'ca=cb=250000'};
    }
};

WORKLOADS['w6-list-head'] = {
    options: {turbo: false, compiler: true, warpTimer: true, stepTime: null},
    frames: 1000,
    build () {
        const B = new Builder();
        const t = B.stage();
        t.variables['v-i'] = ['i', 0];
        t.lists['l-L'] = ['L', []];
        const body = chainIn(t, [
            listDeleteAll(t, 'L', 'l-L'),
            setVar(t, 'i', 'v-i', inPrim(pNum(0))),
            repeatN(t, 40000, chainIn(t, [
                changeVar(t, 'i', 'v-i', inPrim(pNum(1))),
                listAdd(t, 'L', 'l-L', inBlock(varRep(t, 'i', 'v-i')))
            ])),
            repeatN(t, 40000, chainIn(t, [
                listInsert(t, 'L', 'l-L', inPrim(pNum(1)), inPrim(pNum(999))),
                listDelete(t, 'L', 'l-L', inPrim(pNum(1)))
            ]))
        ]);
        warpProcedure(t, 'hot', body);
        return B.project();
    },
    verify (runtime) {
        const L = runtime.getTargetForStage().variables['l-L'].value;
        if (L.length !== 40000) return {ok: false, detail: `len=${L.length}`};
        if (Number(L[0]) !== 1 || Number(L[39999]) !== 40000) {
            return {ok: false, detail: `first=${L[0]} last=${L[9999]}`};
        }
        return {ok: true, detail: 'len=40000 head=1 tail=40000'};
    }
};

WORKLOADS['w7-string-join'] = {
    options: {turbo: false, compiler: true, warpTimer: true, stepTime: null},
    frames: 1000,
    build () {
        const B = new Builder();
        const t = B.stage();
        t.variables['v-n'] = ['n', 0];
        t.variables['v-s'] = ['s', ''];
        const body = chainIn(t, [
            repeatN(t, 10000000, chainIn(t, [
                changeVar(t, 'n', 'v-n', inPrim(pNum(1))),
                setVar(t, 's', 'v-s', inBlock(joinOp(t,
                    inBlock(letterOf(t, inPrim(pNum(3)), inPrim(pStr('world')))),
                    inBlock(varRep(t, 'n', 'v-n')))))
            ]))
        ]);
        warpProcedure(t, 'hot', body);
        return B.project();
    },
    verify (runtime) {
        const st = runtime.getTargetForStage();
        const n = Number(st.variables['v-n'].value);
        const s = String(st.variables['v-s'].value);
        if (n !== 10000000) return {ok: false, detail: `n=${n}`};
        if (s !== `r${n}`) return {ok: false, detail: `s=${s}`};
        return {ok: true, detail: 'n=10000000 s=r10000000'};
    }
};

module.exports = {WORKLOADS,
    Builder,
    svgMd5,
    svg,
    resetBlockSeq: () => {
        blockSeq = 0;
    }};
