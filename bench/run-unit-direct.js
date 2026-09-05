/**
 * Runs every test/unit/*.js file directly under node (tap files are
 * self-executing) and reports pass/fail per file. Avoids the tap CLI, which
 * cannot spawn piped children under some sandboxes.
 * Usage: node bench/run-unit-direct.js [filter-substring]
 */
const fs = require('fs');
const path = require('path');
const {spawnSync} = require('child_process');

const filter = process.argv[2] || '';
const dir = path.join(__dirname, '..', 'test', 'unit');
const files = fs.readdirSync(dir).filter(f => f.endsWith('.js') && f.includes(filter));
let pass = 0;
const failed = [];
for (const f of files) {
    const res = spawnSync(process.execPath, [path.join(dir, f)], {stdio: 'ignore', timeout: 120000});
    if (res.status === 0) {
        pass++;
    } else {
        failed.push(`${f} (exit ${res.status})`);
    }
}
console.log(`PASS=${pass} FAIL=${failed.length} TOTAL=${files.length}`);
for (const f of failed) console.log('FAILED:', f);
