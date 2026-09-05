/**
 * Aggregate self-time per function from a V8 .cpuprofile.
 * Usage: node bench/analyze-profile.js <file.cpuprofile> [topN]
 */
const fs = require('fs');
const file = process.argv[2];
const TOP = parseInt(process.argv[3] || '25', 10);
const p = JSON.parse(fs.readFileSync(file, 'utf8'));
const nodeById = new Map(p.nodes.map(n => [n.id, n]));
const self = {};
let total = 0;
for (let i = 0; i < p.samples.length; i++) {
    const dt = p.timeDeltas[i];
    const n = nodeById.get(p.samples[i]);
    if (!n || !dt) continue;
    const cf = n.callFrame;
    const url = (cf.url || '').replace(/\\/g, '/');
    const base = url.slice(url.lastIndexOf('/') + 1);
    const key = `${cf.functionName || '(anon)'} @${base}:${cf.lineNumber + 1}`;
    self[key] = (self[key] || 0) + dt;
    total += dt;
}
const rows = Object.entries(self).sort((a, b) => b[1] - a[1]);
console.log('total samples ms:', (total / 1000).toFixed(0));
for (const [k, v] of rows.slice(0, TOP)) {
    console.log(`${((100 * v) / total).toFixed(2).padStart(6)}%  ${(v / 1000).toFixed(0).padStart(7)}ms  ${k}`);
}
