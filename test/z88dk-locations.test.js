'use strict';

const assert = require('node:assert/strict');
const { test } = require('node:test');
const { analyseLocations } = require('../lib/z88dk-locations');

function fixture(base = { register: 'ix' }) {
    const variable = { name: 'local', size: 2, scope: 1, block: 2, parameter: false,
        location: { base, offset: -2 }, locations: [], locationGaps: [] };
    const func = { name: 'func', module: 'unit', address: 0x100, variables: [variable],
        ranges: [{ start: 0x100, end: 0x110 }] };
    const row = { pc: 0x104, instructionBytes: 'c9', entrySpOffset: 4,
        stackPointers: [{ register: 'ix', entryOffset: -2 }, { address: 0x8000, entryOffset: -2 }] };
    return { typed: { functions: [func] }, frames: [{ entry: 0x100, complete: true, rows: [row] }],
        rows: [{ module: 'unit', kind: 'C', address: 0x104, scope: 1, block: 2 }], warnings: [] };
}

test('proven stack locations combine compiler base with per-PC SP and scope', () => {
    for (const base of [{ register: 'ix' }, { entryOffset: -2 }]) {
        const metadata = fixture(base);
        analyseLocations(metadata);
        assert.deepEqual(metadata.typed.functions[0].variables[0].locations,
            [{ start: 0x104, end: 0x105, spOffset: 0 }]);
        assert.deepEqual(metadata.warnings, []);
    }
});

test('missing bases, released slots, scope ambiguity and incomplete frames never invent locations', () => {
    for (const change of [
        m => { m.frames[0].rows[0].stackPointers = []; },
        m => { m.frames[0].rows[0].entrySpOffset = 2; },
        m => { m.rows[0].block = 3; },
        m => { m.frames[0].complete = false; },
        m => { m.typed.functions[0].variables.push({ ...m.typed.functions[0].variables[0], locationGaps: [] }); },
    ]) {
        const metadata = fixture();
        change(metadata);
        analyseLocations(metadata);
        assert.deepEqual(metadata.typed.functions[0].variables[0].locations, []);
        assert.ok(metadata.warnings.length);
    }
});

test('parameter stack slots need a proven base but not a local lexical scope', () => {
    const metadata = fixture();
    const variable = metadata.typed.functions[0].variables[0];
    variable.parameter = true;
    variable.location.offset = 4;
    metadata.rows = [];
    analyseLocations(metadata);
    assert.deepEqual(variable.locations, [{ start: 0x104, end: 0x105, spOffset: 6 }]);
});

test('compiler-normalized lexical scopes match packed source markers', () => {
    const metadata = fixture();
    metadata.rows[0].scope = 10000;
    metadata.typed.functions[0].variables[0].sourceScope = 10000;
    analyseLocations(metadata);
    assert.equal(metadata.typed.functions[0].variables[0].locations.length, 1);
});

test('lexical blocks follow nesting, sibling replacement and retained-ID exits', () => {
    const local = (name, scope, block) => ({ name, size: 2, scope, block, parameter: false,
        location: { base: { register: 'ix' }, offset: -2 }, locations: [], locationGaps: [] });
    const variables = [local('total', 1, 1), local('total', 2, 2), local('other', 2, 3)];
    const func = { name: 'func', module: 'unit', address: 0x100, variables,
        ranges: [{ start: 0x100, end: 0x140 }] };
    const sourceRows = [[0x100, 0, 0], [0x104, 1, 1], [0x110, 2, 2], [0x120, 1, 2],
        [0x120, 2, 3], [0x130, 1, 3], [0x138, 0, 3]];
    const metadata = { typed: { functions: [func] }, warnings: [],
        frames: [{ entry: 0x100, complete: true, rows: [0x104, 0x112, 0x124, 0x132, 0x13a].map(pc => ({
            pc, instructionBytes: '00', entrySpOffset: 4,
            stackPointers: [{ register: 'ix', entryOffset: -2 }] })) }],
        rows: sourceRows.map(([address, scope, block]) => ({ module: 'unit', kind: 'C', address, scope, block })) };
    analyseLocations(metadata);
    const pcs = variable => variable.locations.map(location => location.start);
    assert.deepEqual(pcs(variables[0]), [0x104, 0x112, 0x124, 0x132]);
    assert.deepEqual(pcs(variables[1]), [0x112]);
    assert.deepEqual(pcs(variables[2]), [0x124]);
    assert.equal(func.lexicalBlocks.length, 2);
    assert.deepEqual(func.lexicalBlocks.map(block => [block.key, block.parent.key, block.ranges]), [
        ['2:2', '1:1', [{ start: 0x110, end: 0x120 }]],
        ['2:3', '1:1', [{ start: 0x120, end: 0x130 }]],
    ]);
});

test('repeated location analysis does not duplicate gaps or retain stale coverage warnings', () => {
    const metadata = fixture();
    metadata.frames[0].complete = false;
    analyseLocations(metadata);
    const first = structuredClone(metadata);
    analyseLocations(metadata);
    assert.deepEqual(metadata, first);
    metadata.frames[0].complete = true;
    analyseLocations(metadata);
    assert.equal(metadata.typed.functions[0].variables[0].locations.length, 1);
    assert.deepEqual(metadata.typed.functions[0].variables[0].locationGaps, []);
    assert.deepEqual(metadata.warnings, []);
});
