// @ts-check

const {IRGenerator} = require('./irgen');
const {IROptimizer} = require('./iroptimizer');
const JSGenerator = require('./jsgen');
const {computeAlwaysNumericVariables} = require('./numeric-variables');

const compile = (/** @type {import("../engine/thread")} */ thread) => {
    const irGenerator = new IRGenerator(thread);
    const ir = irGenerator.generate();

    const runtime = thread.target.runtime;
    let numericVars = runtime._numericVarsCache;
    if (!numericVars) {
        numericVars = computeAlwaysNumericVariables(runtime);
        runtime._numericVarsCache = numericVars;
    }

    const irOptimizer = new IROptimizer(ir, numericVars);
    irOptimizer.optimize();

    const procedures = {};
    const target = thread.target;

    const compileScript = (/** @type {import("./intermediate").IntermediateScript} */ script) => {
        if (script.cachedCompileResult) {
            return script.cachedCompileResult;
        }

        const compiler = new JSGenerator(script, ir, target);
        const result = compiler.compile();
        script.cachedCompileResult = result;
        return result;
    };

    const entry = compileScript(ir.entry);

    for (const procedureVariant of Object.keys(ir.procedures)) {
        const procedureData = ir.procedures[procedureVariant];
        const procedureTree = compileScript(procedureData);
        procedures[procedureVariant] = procedureTree;
    }

    return {
        startingFunction: entry,
        yields: ir.entry.yields,
        procedures,
        executableHat: ir.entry.executableHat
    };
};

module.exports = compile;
