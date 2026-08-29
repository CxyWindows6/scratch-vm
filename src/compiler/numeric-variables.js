// @ts-check

/**
 * @fileoverview Global "always numeric" variable analysis.
 *
 * The compiler's type-state analysis (iroptimizer.js) refines a variable's type
 * from its writes, but it conservatively resets all variable types to ANY whenever
 * a block can yield — which, with the warp timer enabled (the editor default), is
 * every loop iteration. That throws away the fact that a loop counter like `i` is
 * always a number, so `item (i) of [list]` falls back to the slow `listGet()` call
 * instead of the inlined `list.value[(i | 0) - 1] ?? ""`.
 *
 * This module computes, across *every* script of *every* target, the set of scalar
 * variables that can only ever hold a JavaScript number at runtime. For those
 * variables the type state can safely fall back to NUMBER instead of ANY after a
 * yield, because no thread — no matter the interleaving — can store a non-number
 * (e.g. the string "last") into them.
 *
 * The analysis is deliberately conservative: a variable is only reported numeric if
 *   - it is a non-cloud scalar variable,
 *   - its initial value is a number, and
 *   - every write to it anywhere in the project is a number-producing operation
 *     (`change x by`, `set x to <number literal>`, or `set x to <arithmetic>`).
 * Anything unknown (extension writes, null-id auto-created variables, list reads,
 * joins, text, ...) disqualifies the variable.
 */

const Variable = require('../engine/variable.js');

/**
 * Opcodes whose *result* is always a JavaScript number (possibly NaN), regardless
 * of the runtime types of their inputs, because they coerce their inputs.
 * @type {Set<string>}
 */
const NUMBER_PRODUCING_OPS = new Set([
    'operator_add',
    'operator_subtract',
    'operator_multiply',
    'operator_divide',
    'operator_mod',
    'operator_round',
    'operator_mathop',
    'operator_random',
    'data_lengthoflist'
]);

/**
 * Number-literal reporter opcodes (the value is in fields.NUM).
 * @type {Set<string>}
 */
const NUMBER_LITERAL_OPS = new Set([
    'math_number',
    'math_integer',
    'math_whole_number',
    'math_positive_number',
    'math_angle'
]);

/**
 * @param {*} block A deserialized block, or null/undefined.
 * @returns {boolean} true if this block always evaluates to a number.
 */
const blockIsAlwaysNumeric = block => {
    if (!block) return false;
    if (NUMBER_LITERAL_OPS.has(block.opcode)) {
        const num = block.fields && block.fields.NUM && block.fields.NUM.value;
        // Accept real numbers (including NaN, which is still a "number" type for
        // our purposes) and numeric strings; reject "", "abc", and other garbage.
        if (typeof num === 'number') return true;
        if (typeof num === 'string') return num.trim() !== '' && !Number.isNaN(Number(num));
        return false;
    }
    return NUMBER_PRODUCING_OPS.has(block.opcode);
};

/**
 * Resolve the block wired into a named input of a parent block.
 * @param {*} blocks The whole block container.
 * @param {*} parent The block that owns the input.
 * @param {string} inputName e.g. "VALUE".
 * @returns {*|null}
 */
const inputBlock = (blocks, parent, inputName) => {
    const input = parent.inputs && parent.inputs[inputName];
    if (!input) return null;
    const id = typeof input === 'object' ? input.block : input;
    if (!id) return null;
    return blocks[id] || null;
};

/**
 * Compute the set of variable ids that always hold a number.
 * @param {import('../engine/runtime')} runtime
 * @returns {Set<string>} set of scalar variable ids that are always numeric
 */
const computeAlwaysNumericVariables = runtime => {
    /** @type {Map<string, boolean>} varId -> still a numeric candidate */
    const candidates = new Map();
    /** @type {Map<string, string>} varName -> varId (for null-id safety) */
    const nameToId = new Map();

    // 1. Definitions: only non-cloud scalar variables with a numeric initial value.
    for (const target of runtime.targets) {
        for (const id in target.variables) {
            const v = target.variables[id];
            if (v.type !== Variable.SCALAR_TYPE || v.isCloud) {
                candidates.set(id, false);
                continue;
            }
            if (typeof v.value !== 'number') {
                candidates.set(id, false);
                continue;
            }
            if (!candidates.has(id)) candidates.set(id, true);
            if (!nameToId.has(v.name)) nameToId.set(v.name, id);
        }
    }

    /**
     * Record a write to a variable.
     * @param {string|null} id
     * @param {string|null} name
     * @param {boolean} numeric whether this write always produces a number
     */
    const recordWrite = (id, name, numeric) => {
        if (id) {
            if (!candidates.has(id)) {
                // Writing a variable we never saw defined: be conservative.
                candidates.set(id, false);
            } else if (!numeric) {
                candidates.set(id, false);
            }
        }
        // A null-id write (auto-created variable) targets a variable by name; if that
        // name matches a known candidate and the write is not provably numeric, kill it.
        if (!id && name && numeric === false) {
            const mapped = nameToId.get(name);
            if (mapped) candidates.set(mapped, false);
        }
    };

    // 2. Writes across every target's block container.
    for (const target of runtime.targets) {
        const blocks = target.blocks._blocks;
        for (const id in blocks) {
            const b = blocks[id];
            if (b.opcode === 'data_changevariableby') {
                const f = b.fields && b.fields.VARIABLE;
                // change coerces to a number, so it is always numeric-producing.
                recordWrite(f && f.id, f && f.value, true);
            } else if (b.opcode === 'data_setvariableto') {
                const f = b.fields && b.fields.VARIABLE;
                const value = inputBlock(blocks, b, 'VALUE');
                recordWrite(f && f.id, f && f.value, blockIsAlwaysNumeric(value));
            }
        }
    }

    /** @type {Set<string>} */
    const result = new Set();
    for (const [id, ok] of candidates) {
        if (ok) result.add(id);
    }
    return result;
};

module.exports = {
    computeAlwaysNumericVariables,
    // exported for unit testing
    blockIsAlwaysNumeric
};
