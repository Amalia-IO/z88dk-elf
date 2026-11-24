'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { test } = require('node:test');
const { convert } = require('../lib/z88dk-elf');
const { fixture } = require('./fixture');
const { runGdb } = require('./gdb-launch');
const { incremental } = require('../make/debug-elf');

test('real GDB attributes shared loop/statement/brace address to statement and retains brace breakpoint',
    { skip: !process.env.Z80_GDB }, () => {
        const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'elf-shared-lines-'));
        try {
            const { image, map, output } = fixture(directory);
            fs.writeFileSync(path.join(directory, 'main.c'), '\n'.repeat(11) +
                'while (1) {\n    counter = increment(counter);\n}\n');
            const marker = line =>
                `__C_LINE_${line}_main_2ec_3a_3amain_3a_3a1_3a_3a0 = $100 ; addr, public, , unit, code_user,`;
            fs.appendFileSync(map, '\n' + [12, 13, 14].map(marker).join('\n'));
            const metadata = convert(image, map, output, [], undefined, [], [], 'auto', directory);
            const mainRows = metadata.rows.filter(row => row.address === 0x100);
            assert.deepEqual(mainRows.map(row => row.line), [1, 12, 13, 14]);
            const result = runGdb(output, ['break main.c:13', 'break main.c:14',
                'info line *0x100', 'maint info line-table main.c']).stdout;
            assert.match(result, /Breakpoint 1 .*line 13/);
            assert.match(result, /Breakpoint 2 .*line 14/);
            assert.match(result, /Line 13 of/);
        } finally {
            fs.rmSync(directory, { recursive: true });
        }
    });

test('incremental conversion tracks source content, disappearance and availability for presentation', () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'elf-source-cache-'));
    try {
        const { image, map, output } = fixture(directory);
        const source = path.join(directory, 'main.c');
        fs.writeFileSync(source, 'main();\n}\n');
        fs.appendFileSync(map,
            '\n__C_LINE_2_main_2ec_3a_3amain_3a_3a1_3a_3a0 = $100 ; addr, public, , unit, code_user,');
        const args = ['--', image, map, output, '--path-map', `main.c=${source}`];
        assert.equal(incremental(args), true);
        assert.equal(incremental(args), false);
        fs.writeFileSync(source, 'main();\nother();\n');
        assert.equal(incremental(args), true);
        assert.equal(incremental(args), false);
        fs.unlinkSync(source);
        assert.equal(incremental(args), true);
        assert.equal(incremental(args), false);
        fs.writeFileSync(source, 'main();\n}\n');
        assert.equal(incremental(args), true);
        assert.equal(incremental(args), false);
    } finally {
        fs.rmSync(directory, { recursive: true });
    }
});
