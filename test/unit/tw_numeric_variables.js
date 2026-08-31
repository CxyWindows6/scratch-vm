const {test} = require('tap');
const VM = require('../../src/index.js');
const {computeAlwaysNumericVariables, blockIsAlwaysNumeric} = require('../../src/compiler/numeric-variables.js');

/**
 * Build a stage project whose variables are written in various ways, then assert
 * which ones the "always numeric" analysis classifies as safe to treat as numbers
 * across warp-timer yields.
 * @returns {object} a project descriptor loadable by vm.loadProject.
 */
const buildProject = () => {
    const blocks = {};
    // set str to "hello"  -> disqualifies v-str
    blocks.setStr = {
        opcode: 'data_setvariableto',
        next: null,
        parent: null,
        inputs: {VALUE: [1, [10, 'hello']]},
        fields: {VARIABLE: ['str', 'v-str']},
        shadow: false,
        topLevel: true,
        x: 0,
        y: 0
    };
    // set setstr to (join "a" "b") -> disqualifies v-setstr
    blocks.join = {
        opcode: 'operator_join',
        next: null,
        parent: 'setSetstr',
        inputs: {STRING1: [1, [10, 'a']], STRING2: [1, [10, 'b']]},
        fields: {},
        shadow: false,
        topLevel: false
    };
    blocks.setSetstr = {
        opcode: 'data_setvariableto',
        next: null,
        parent: null,
        inputs: {VALUE: [2, 'join']},
        fields: {VARIABLE: ['setstr', 'v-setstr']},
        shadow: false,
        topLevel: true,
        x: 0,
        y: 100
    };
    // change chg by 1 -> keeps v-chg numeric
    blocks.changeChg = {
        opcode: 'data_changevariableby',
        next: null,
        parent: null,
        inputs: {VALUE: [1, [4, '1']]},
        fields: {VARIABLE: ['chg', 'v-chg']},
        shadow: false,
        topLevel: true,
        x: 0,
        y: 200
    };
    // set vlist to (item 1 of list a) -> disqualifies v-list (list contents unknown)
    blocks.item = {
        opcode: 'data_itemoflist',
        next: null,
        parent: 'setList',
        inputs: {INDEX: [1, [4, '1']]},
        fields: {LIST: ['a', 'l-a']},
        shadow: false,
        topLevel: false
    };
    blocks.setList = {
        opcode: 'data_setvariableto',
        next: null,
        parent: null,
        inputs: {VALUE: [2, 'item']},
        fields: {VARIABLE: ['vlist', 'v-list']},
        shadow: false,
        topLevel: true,
        x: 0,
        y: 300
    };
    // set arith to (num) + (2) -> keeps v-arith numeric (operator coerces)
    blocks.add = {
        opcode: 'operator_add',
        next: null,
        parent: 'setArith',
        inputs: {NUM1: [1, [12, 'num', 'v-num']], NUM2: [1, [4, '2']]},
        fields: {},
        shadow: false,
        topLevel: false
    };
    blocks.setArith = {
        opcode: 'data_setvariableto',
        next: null,
        parent: null,
        inputs: {VALUE: [2, 'add']},
        fields: {VARIABLE: ['arith', 'v-arith']},
        shadow: false,
        topLevel: true,
        x: 0,
        y: 400
    };

    return {
        targets: [{
            isStage: true,
            name: 'Stage',
            variables: {
                'v-num': ['num', 0],
                'v-str': ['str', 'hello'],
                'v-setstr': ['setstr', 0],
                'v-chg': ['chg', 0],
                'v-list': ['vlist', 0],
                'v-arith': ['arith', 0],
                'v-cloud': ['cloud', 0, true]
            },
            lists: {'l-a': ['a', [1, 2, 3]]},
            broadcasts: {},
            blocks,
            comments: {},
            currentCostume: 0,
            costumes: [],
            sounds: [],
            volume: 100,
            layerOrder: 0,
            x: 0,
            y: 0,
            size: 100,
            direction: 90,
            draggable: false,
            visible: true,
            rotationStyle: 'all around'
        }],
        monitors: [],
        extensions: [],
        meta: {semver: '3.0.0'}
    };
};

test('computeAlwaysNumericVariables classifies writes soundly', async t => {
    const vm = new VM();
    await vm.loadProject(buildProject());
    const numeric = computeAlwaysNumericVariables(vm.runtime);

    t.ok(numeric.has('v-num'), 'never-written numeric-initial variable is numeric');
    t.ok(numeric.has('v-chg'), 'change-by-number keeps variable numeric');
    t.ok(numeric.has('v-arith'), 'set to arithmetic result is numeric');
    t.notOk(numeric.has('v-str'), 'string initial value disqualifies');
    t.notOk(numeric.has('v-setstr'), 'set to join (string) disqualifies');
    t.notOk(numeric.has('v-list'), 'set to list item disqualifies');
    t.notOk(numeric.has('v-cloud'), 'cloud variable is never numeric');

    vm.quit();
    t.end();
});

test('blockIsAlwaysNumeric recognizes number-producing opcodes', t => {
    t.ok(blockIsAlwaysNumeric({opcode: 'math_number', fields: {NUM: {value: 5}}}), 'number literal');
    t.ok(blockIsAlwaysNumeric({opcode: 'math_number', fields: {NUM: {value: '5'}}}), 'numeric string literal');
    t.notOk(blockIsAlwaysNumeric({opcode: 'math_number', fields: {NUM: {value: 'abc'}}}), 'non-numeric literal');
    t.ok(blockIsAlwaysNumeric({opcode: 'operator_add', fields: {}}), 'addition is numeric');
    t.ok(blockIsAlwaysNumeric({opcode: 'operator_mod', fields: {}}), 'mod is numeric');
    t.ok(blockIsAlwaysNumeric({opcode: 'data_lengthoflist', fields: {}}), 'list length is numeric');
    t.notOk(blockIsAlwaysNumeric({opcode: 'data_variable', fields: {}}), 'variable read is not provably numeric');
    t.notOk(blockIsAlwaysNumeric({opcode: 'operator_join', fields: {}}), 'join is not numeric');
    t.notOk(blockIsAlwaysNumeric(null), 'null is not numeric');
    t.end();
});
