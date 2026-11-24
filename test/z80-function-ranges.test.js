'use strict';

const assert = require('node:assert/strict');
const { test } = require('node:test');
const { instruction, functionRanges } = require('../lib/z80-function-ranges');

test('Z80 instruction boundaries include indexed displacements and prefixed immediates', () => {
    for (const [hex, length] of [
        ['00', 1], ['010000', 3], ['dd210000', 4], ['dd360001', 4], ['fd7e01', 3],
        ['ddcb007e', 4], ['cb7e', 2], ['ed430000', 4], ['ed4b0000', 4], ['edb0', 2],
        ['ddfd210000', 5], ['c40000', 3], ['d301', 2], ['ddc9', 2],
    ]) {
        assert.equal(instruction(Buffer.from(hex, 'hex'), 0x4000, 0x4000).end, 0x4000 + length, hex);
    }
});

test('reachable ranges follow branches and exclude skipped data and callees', () => {
    const image = Buffer.from('1803ffffffcd0a40c900c9', 'hex');
    const model = functionRanges(image, 0x4000, 0x4000, new Set([0x4000, 0x400a]));
    assert.deepEqual(model.ranges, [{ start: 0x4000, end: 0x4002 },
        { start: 0x4005, end: 0x4009 }]);
    assert.deepEqual(model.gaps, []);
    assert.deepEqual(model.assumptions, ['CALL/RST uses the ordinary return continuation']);
});

test('conditional returns, loops, direct tail calls and relocated entries are supported', () => {
    for (const origin of [0x100, 0x6000]) {
        const model = functionRanges(Buffer.from('c020fdc9c9', 'hex'), origin, origin, new Set([origin]));
        assert.deepEqual(model.ranges, [{ start: origin, end: origin + 4 }]);
        const image = Buffer.from([0xc3, (origin + 3) & 255, (origin + 3) >> 8, 0xc9]);
        const tail = functionRanges(image, origin, origin, new Set([origin, origin + 3]));
        assert.deepEqual(tail.ranges, [{ start: origin, end: origin + 3 }]);
    }
});

test('unresolved control flow does not produce guessed function ranges', () => {
    for (const hex of ['e9', 'dde9', '1805', 'cd00', '00', '76']) {
        const model = functionRanges(Buffer.from(hex, 'hex'), 0x100, 0x100, new Set([0x100]));
        assert.deepEqual(model.ranges, [], hex);
        assert.ok(model.gaps.length, hex);
    }
    assert.throws(() => functionRanges(Buffer.from('c20101c9', 'hex'), 0x100, 0x100,
        new Set([0x100])), /Overlapping instructions/);
});

test('section boundaries and accidental fallthrough cannot fabricate function endings', () => {
    const image = Buffer.from('0000c9', 'hex');
    assert.match(functionRanges(image, 0x100, 0x100, new Set([0x100, 0x101])).gaps[0], /Fallthrough/);
    assert.match(functionRanges(image, 0x100, 0x100, new Set([0x100]),
        { start: 0x100, end: 0x102 }).gaps[0], /executable section/);
});
