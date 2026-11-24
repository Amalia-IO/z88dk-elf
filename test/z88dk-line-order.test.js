'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { test } = require('node:test');
const { presentationRows } = require('../lib/z88dk-line-order');

test('statement presentation moves only shared standalone C braces without mutating scope rows', () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'elf-line-order-'));
    try {
        fs.writeFileSync(path.join(directory, 'main.c'), 'while (1) {\ncall();\n}\n}\n');
        const rows = [1, 2, 3, 4].map(line => ({
            file: 'main.c', kind: 'C', address: line === 4 ? 0x101 : 0x100,
            line, scope: line === 3 ? 1 : 2, block: line,
        }));
        const snapshot = JSON.stringify(rows);
        const dependencies = new Map();
        const warnings = [];
        assert.deepEqual(presentationRows(rows, directory, warnings, dependencies).map(row => row.line),
            [3, 1, 2, 4]);
        assert.equal(JSON.stringify(rows), snapshot);
        assert.equal(dependencies.size, 1);
        assert.deepEqual(warnings, []);
        const assembly = rows.map(row => ({ ...row, kind: 'ASM' }));
        assert.deepEqual(presentationRows(assembly, directory, warnings, new Map()), assembly);
        fs.unlinkSync(path.join(directory, 'main.c'));
        const missing = new Map();
        assert.deepEqual(presentationRows(rows, directory, warnings, missing), rows);
        assert.match(warnings[0], /Source unavailable.*main.c/);
        assert.equal(missing.get(path.join(directory, 'main.c')), null);
    } finally {
        fs.rmSync(directory, { recursive: true });
    }
});
