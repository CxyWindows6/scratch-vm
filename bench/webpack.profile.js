/**
 * Production-mode build WITHOUT minification, for CPU profiling only.
 * Same module graph / babel transpile as the real production bundle, but
 * function names survive so --cpu-prof output is readable.
 *
 * Usage: npx webpack --config bench/webpack.profile.js --bail
 * Output: bench/dist-profile/scratch-vm.js
 */
process.env.NODE_ENV = 'production';
const path = require('path');
const configs = require('../webpack.config.js');
const nodeCfg = configs.find(c => c.target === 'node');

module.exports = [Object.assign({}, nodeCfg, {
    mode: 'production',
    devtool: false,
    optimization: {minimize: false},
    output: Object.assign({}, nodeCfg.output, {
        path: path.resolve(__dirname, 'dist-profile')
    })
})];
