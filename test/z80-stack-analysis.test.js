'use strict';

const assert = require('node:assert/strict');
const { test } = require('node:test');
const { analyseStack, analyseFrames, proveCallSummaries, checkRuntimeGuards } = require('../lib/z80-stack-analysis');

function analyse(hex, origin = 0x4000, options) {
    const image = Buffer.from(hex, 'hex');
    return analyseStack(image, origin, origin,
        [{ start: origin, end: origin + image.length }], options);
}

test('recursive call contracts are checked at a fixed point and retain self edges', () => {
    const image = Buffer.from('c8c5cd0040c1c9', 'hex');
    const ranges = [{ start: 0x4000, end: 0x4007 }];
    const contracts = proveCallSummaries(image, 0x4000, [0x4000], ranges);
    assert.ok(contracts.callSummaries.has(0x4000));
    const frames = analyseFrames(image, 0x4000, [0x4000], ranges, contracts).frames;
    assert.equal(frames[0].complete, true);
    assert.deepEqual(frames[0].parentEdges, [{ parentEntry: 0x4000, continuation: 0x4005,
        parentEntrySpOffsetAtChildEntry: 4, parentEntrySpOffsetAtContinuation: 2 }]);
});

test('call contracts reject non-neutral assembly and unsupported instructions', () => {
    for (const hex of ['e3e9', 'f9c9', 'cb00c9']) {
        const image = Buffer.from(hex, 'hex');
        const ranges = [{ start: 0x4000, end: 0x4000 + image.length }];
        assert.equal(proveCallSummaries(image, 0x4000, [0x4000], ranges).callSummaries.size, 0);
    }
});

test('call summaries preserve only registers and absolute memory proven unchanged', () => {
    // A conditional recursive call followed by a BC clobber must propagate that
    // clobber, while saving/restoring the incoming absolute word proves preservation.
    const image = Buffer.from('2a0080e5c40040217856e1220080013412c9', 'hex');
    const ranges = [{ start: 0x4000, end: 0x4000 + image.length }];
    const contracts = proveCallSummaries(image, 0x4000, [0x4000], ranges);
    const summary = contracts.callSummaries.get(0x4000);
    assert.ok(summary);
    assert.ok(!summary.preservedRegisters.includes('bc'));
    assert.ok(!summary.clobberedAbsolute.includes(0x8000));
    assert.ok(summary.absoluteAddresses.includes(0x8000));
});

test('ordinary stack frames expose per-PC entry SP and saved continuation locations', () => {
    const model = analyse('c5d5d1c1c9');
    assert.equal(model.complete, true);
    assert.equal(model.exits[0].spDelta, 2);
    assert.equal(model.rows[2].entrySpOffset, 4);
    assert.deepEqual(model.rows[2].returnLocations, [{ kind: 'memory', spOffset: 4 }]);
    assert.equal(model.rows[2].callerEntrySpOffset, 6);
});

test('stack-pointer evidence is intersected when conditional paths disagree', () => {
    const result = analyse('dd210000dd392806dd210200dd39c9');
    assert.equal(result.frameComplete, true);
    const beforeBranch = result.frameRows.find(row => row.pc === 0x4006);
    assert.ok(beforeBranch.stackPointers.some(pointer =>
        pointer.register === 'ix' && pointer.entryOffset === 0));
    const joined = result.frameRows.find(row => row.pc === 0x400e);
    assert.ok(!joined.stackPointers.some(pointer => pointer.register === 'ix'));
});

test('calls are executed interprocedurally without assuming stack-neutral helpers', () => {
    // Callee exchanges its continuation for an extra word, then jumps back.
    const model = analyse('cd07403333c900e3e9');
    assert.equal(model.complete, true, model.gaps.join('\n'));
    assert.equal(model.rows.find(row => row.pc === 0x4003).entrySpOffset, 2);
    assert.equal(model.exits[0].spDelta, 2);
    assert.deepEqual(model.rows.find(row => row.pc === 0x4008).returnLocations,
        [{ kind: 'memory', spOffset: 2 }]);
    const image = Buffer.from('cd07403333c900e3e9', 'hex');
    const set = analyseFrames(image, 0x4000, [0x4000],
        [{ start: 0x4000, end: 0x4000 + image.length }]);
    const helper = set.frames.find(frame => frame.entry === 0x4007);
    assert.equal(helper.complete, true, helper.gaps.join('\n'));
    assert.equal(helper.exits[0].spDelta, 0, 'Actual cleanup is not the nominal caller-SP rule');
    assert.deepEqual(helper.rows[1].returnLocations, [{ kind: 'register', name: 'hl' }]);
    assert.deepEqual(helper.rows[1].savedRegisters.hl, [{ kind: 'memory', spOffset: 0 }]);
    assert.equal(helper.rows[1].callerEntrySpOffset, 2);
});

test('return continuation can move from stack to registers and back', () => {
    const model = analyse('e1e5e1e9');
    assert.equal(model.complete, true, model.gaps.join('\n'));
    assert.deepEqual(model.rows[1].returnLocations, [{ kind: 'register', name: 'hl' }]);
    assert.deepEqual(model.rows[2].returnLocations, [
        { kind: 'memory', spOffset: 0 }, { kind: 'register', name: 'hl' },
    ]);
    assert.equal(model.exits[0].spDelta, 2);
});

test('frame-pointer prologues and SP arithmetic are symbolic rather than pattern matched', () => {
    for (const origin of [0x100, 0x6000]) {
        const model = analyse('dde5dd210000dd39f5ddf9dde1c9', origin);
        assert.equal(model.complete, true, model.gaps.join('\n'));
        assert.equal(model.rows.find(row => row.pc === origin + 8).entrySpOffset, 2);
        assert.deepEqual(model.rows.find(row => row.pc === origin + 8).stackPointers,
            [{ register: 'ix', entryOffset: -2 }]);
        assert.equal(model.rows.find(row => row.pc === origin + 9).entrySpOffset, 4);
        assert.equal(model.rows.find(row => row.pc === origin + 11).entrySpOffset, 2);
        assert.equal(model.exits[0].spDelta, 2);
    }
});

test('nested and conditional calls and conditional returns explore both paths', () => {
    const model = analyse('c40740c8c90000cd0b40c9c9');
    assert.equal(model.complete, true, model.gaps.join('\n'));
    assert.ok(model.exits.length >= 2);
    assert.ok(model.exits.every(exit => exit.spDelta === 2));
});

test('indexed memory loads target real H/L rather than index-byte registers', () => {
    const model = analyse('dde5dd210000dd39dd6e04dd6605dde1c9');
    assert.equal(model.complete, true, model.gaps.join('\n'));
    assert.equal(model.exits[0].spDelta, 2);
});

test('absolute memory is tracked under explicit runtime alias guards', () => {
    assert.equal(analyse('2a0080fd2a02803a0480c9').complete, true);
    const model = analyse('220080c9');
    assert.equal(model.complete, true, model.gaps.join('\n'));
    assert.deepEqual(model.runtimeGuards.disjointAbsoluteAddresses, [0x8000, 0x8001]);
    assert.equal(checkRuntimeGuards(model, 0xf000).valid, true);
    assert.equal(checkRuntimeGuards(model, 0x8000).valid, false);
    assert.match(checkRuntimeGuards(model, 0x8000).reason, /alias/);
});

test('stack pointers stored in ordinary absolute memory round-trip without runtime/helper names', () => {
    const model = analyse('210000392200802100002a0080f9c9');
    assert.equal(model.complete, true, model.gaps.join('\n'));
    assert.equal(model.exits[0].spDelta, 2);
    assert.equal(checkRuntimeGuards(model, 0xf000).valid, true);
    assert.equal(checkRuntimeGuards(model, 0x8000).valid, false);
});

test('runtime guards cover later stack growth, partial aliases and wrapping', () => {
    const model = analyse('220080c5c1c9');
    assert.equal(model.complete, true);
    assert.deepEqual(model.runtimeGuards.stackOffsetBounds, { min: -2, max: 1 });
    for (const sp of [0x7fff, 0x8000, 0x8001, 0x8002, 0x8003]) {
        assert.equal(checkRuntimeGuards(model, sp).valid, false, sp.toString(16));
    }
    assert.equal(checkRuntimeGuards(model, 0x8004).valid, true);
    assert.match(checkRuntimeGuards(model, 0).reason, /wraps/);
    assert.match(checkRuntimeGuards(model, 65535).reason, /wraps/);
    assert.equal(checkRuntimeGuards(model, -1).valid, false);
    assert.match(checkRuntimeGuards(model, 0x4000).reason, /executable code/);
    assert.match(checkRuntimeGuards(model, 65534).reason, /wraps/);
    const codeWrite = analyse('220040c9');
    assert.equal(codeWrite.complete, false);
    assert.match(codeWrite.gaps[0], /executable code/);
});

test('continuations stored only in absolute memory retain guarded recovery locations', () => {
    const model = analyse('e12200802100002a0080e9');
    assert.equal(model.complete, true, model.gaps.join('\n'));
    assert.ok(model.rows.some(row => row.returnLocations.some(location =>
        location.kind === 'absolute' && location.address === 0x8000)));
    assert.equal(checkRuntimeGuards(model, 0x8000).valid, false);
    assert.equal(checkRuntimeGuards(model, 0xf000).valid, true);
});

test('shared callees retain distinct call contexts rather than inventing a single root rule', () => {
    const model = analyse('cd1040c5cd1040c1c90000000000000000c9');
    assert.equal(model.complete, false);
    assert.equal(model.contextualComplete, true, model.gaps.join('\n'));
    const rows = model.contextRows.filter(row => row.pc === 0x4010);
    assert.equal(rows.length, 2);
    assert.deepEqual(rows.map(row => row.entrySpOffset).sort(), [2, 4]);
    assert.ok(rows.every(row => row.calls.length === 1 && row.returnLocations.length));
    assert.equal(model.frameComplete, true);
    assert.ok(model.frameRows.every(row => row.pc !== 0x4010));
    const image = Buffer.from('cd1040c5cd1040c1c90000000000000000c9', 'hex');
    const set = analyseFrames(image, 0x4000, [0x4000], [{ start: 0x4000, end: 0x4000 + image.length }]);
    assert.deepEqual(set.frames.map(frame => frame.entry), [0x4000, 0x4010]);
    assert.ok(set.frames.every(frame => frame.complete));
    assert.deepEqual(set.frames[1].rows[0].returnLocations, [{ kind: 'memory', spOffset: 0 }]);
    assert.equal(set.frames[1].rows[0].entrySpOffset, 0);
});

test('incoming register provenance survives saves, exchanges and restores, not clobbers', () => {
    const model = analyse('c5013412eb220080210000c1c9');
    const saved = model.frameRows.find(row => row.pc === 0x4004).savedRegisters;
    assert.deepEqual(saved.bc, [{ kind: 'memory', spOffset: 0 }]);
    assert.deepEqual(saved.hl, [{ kind: 'register', name: 'hl' }]);
    const stored = model.frameRows.find(row => row.pc === 0x400b).savedRegisters;
    assert.deepEqual(stored.de, [{ kind: 'absolute', address: 0x8000 }]);
    assert.deepEqual(stored.hl, [{ kind: 'register', name: 'de' }]);
    assert.deepEqual(model.frameRows.at(-1).savedRegisters.bc, [{ kind: 'register', name: 'bc' }]);
    const joined = analyse('2803010000c9');
    assert.equal(joined.frameComplete, true);
    assert.deepEqual(joined.frameRows.at(-1).savedRegisters.bc, []);
});

test('independent callees do not borrow caller-specific argument values', () => {
    const image = Buffer.from('210000cd0740c939e5e1c9', 'hex');
    const set = analyseFrames(image, 0x4000, [0x4000], [{ start: 0x4000, end: 0x400b }]);
    const helper = set.frames.find(frame => frame.entry === 0x4007);
    assert.equal(helper.complete, true);
    assert.deepEqual(helper.rows.find(row => row.pc === 0x4008).savedRegisters.hl, []);
    assert.ok(!helper.rows.some(row => row.savedRegisters.hl.some(location => location.kind === 'memory')));
    const limited = analyseFrames(image, 0x4000, [0x4000],
        [{ start: 0x4000, end: 0x400b }], { frameBudget: 1 });
    assert.match(limited.gaps[0], /budget/);
    assert.equal(limited.frames.length, 1);
    assert.throws(() => analyseFrames(image, 0x4000, [], [], { frameBudget: 0 }), /positive integer/);
    const writes = Buffer.from('210080cd0740c977c9', 'hex');
    const dependent = analyseFrames(writes, 0x4000, [0x4000],
        [{ start: 0x4000, end: 0x4000 + writes.length }]);
    assert.equal(dependent.frames.find(frame => frame.entry === 0x4000).complete, true);
    const unavailable = dependent.frames.find(frame => frame.entry === 0x4007);
    assert.equal(unavailable.complete, false);
    assert.match(unavailable.gaps[0], /Unresolved memory write/);
});

test('overwriting one byte of a saved register invalidates word recovery', () => {
    const model = analyse('c5210000393600013412d1c9');
    assert.equal(model.frameComplete, true, model.gaps.join('\n'));
    const clobbered = model.frameRows.find(row => row.pc === 0x400a);
    assert.deepEqual(clobbered.savedRegisters.bc, []);
    assert.deepEqual(model.frameRows.at(-1).savedRegisters.bc, []);
    assert.deepEqual(model.frameRows.at(-1).savedRegisters.de, []);
});

test('instruction-derived debug frame bookkeeping works at different code and storage addresses', () => {
    for (const [origin, storage] of [[0x2000, 0x8000], [0x6000, 0xa345]]) {
        const target = origin + 6;
        const low = storage & 255;
        const high = storage >> 8;
        const image = Buffer.from([0xcd, target & 255, target >> 8, 0x33, 0x33, 0xc9,
            0xc1, 0xe5, 0x2a, low, high, 0xe3, 0xe5,
            0x21, 2, 0, 0x39, 0x22, low, high, 0xe1, 0xc5, 0xc9]);
        const model = analyseStack(image, origin, origin, [{ start: origin, end: origin + image.length }]);
        assert.equal(model.complete, true, model.gaps.join('\n'));
        assert.equal(model.exits[0].spDelta, 2);
        assert.deepEqual(model.runtimeGuards.disjointAbsoluteAddresses, [storage, storage + 1]);
        assert.equal(checkRuntimeGuards(model, 0xf000).valid, true);
        assert.equal(checkRuntimeGuards(model, storage).valid, false);
    }
});

test('absolute reads cannot recover a continuation from a possibly aliased stack slot', () => {
    const model = analyse('2a0080e9');
    assert.equal(model.complete, false);
    assert.match(model.gaps[0], /Unresolved/);
    assert.equal(checkRuntimeGuards(model, 0x8000).valid, false);
});

test('LDIR copies symbolic words between absolute and stack memory without helper contracts', () => {
    for (const origin of [0x100, 0x6000]) {
        const restored = analyse('22008021feff39eb210080010200edb03b3be1c9', origin);
        assert.equal(restored.complete, true, restored.gaps.join('\n'));
        const afterCopy = restored.rows.find(row => row.pc === origin + 16);
        assert.deepEqual(afterCopy.savedRegisters.hl, [
            { kind: 'absolute', address: 0x8000 }, { kind: 'memory', spOffset: -2 },
        ]);
        assert.deepEqual(afterCopy.stackPointers, [{ register: 'de', entryOffset: 0 }]);
        assert.deepEqual(restored.rows.at(-1).savedRegisters.hl, [
            { kind: 'absolute', address: 0x8000 }, { kind: 'register', name: 'hl' },
        ]);
        assert.equal(restored.exits[0].spDelta, 2);

        const continuation = analyse('21000039110080010200edb0e12100002a0080e9', origin);
        assert.equal(continuation.complete, true, continuation.gaps.join('\n'));
        assert.deepEqual(continuation.rows.at(-1).returnLocations, [
            { kind: 'absolute', address: 0x8000 }, { kind: 'register', name: 'hl' },
        ]);
        assert.equal(continuation.exits[0].spDelta, 2);
        assert.deepEqual(continuation.runtimeGuards.disjointAbsoluteAddresses, [0x8000, 0x8001]);
        assert.equal(checkRuntimeGuards(continuation, 0xf000).valid, true);
        assert.equal(checkRuntimeGuards(continuation, 0x8000).valid, false);
    }
});

test('LDIR advances real HL and DE and zeroes BC, including ignored index prefixes', () => {
    for (const prefix of ['', 'dd', 'fd', 'ddfd']) {
        const result = analyse(`21fcff39eb21000039010400${prefix}edb003c5210000395e2356c1c9`);
        assert.equal(result.complete, true, result.gaps.join('\n'));
        const row = result.rows.find(candidate => candidate.instructionBytes === '03');
        assert.deepEqual(row.stackPointers, [
            { register: 'de', entryOffset: 0 }, { register: 'hl', entryOffset: 4 },
        ]);
        assert.deepEqual(result.runtimeGuards.stackOffsetBounds, { min: -4, max: 3 });
    }
    // Use the zeroed BC to copy one byte on the next instruction, and its advanced pointers.
    const result = analyse('210080110090010200edb003edb0c9');
    assert.equal(result.complete, true, result.gaps.join('\n'));
    assert.deepEqual(result.runtimeGuards.disjointAbsoluteAddresses,
        [0x8000, 0x8001, 0x8002, 0x9000, 0x9001, 0x9002]);
});

test('LDIR tracks every copied byte under stack/code/absolute alias guards', () => {
    const result = analyse('21fdff39eb210080010300edb0c9');
    assert.equal(result.complete, true, result.gaps.join('\n'));
    assert.deepEqual(result.runtimeGuards.stackOffsetBounds, { min: -3, max: 1 });
    assert.deepEqual(result.runtimeGuards.disjointAbsoluteAddresses, [0x8000, 0x8001, 0x8002]);
    for (const sp of [0x7fff, 0x8000, 0x8001, 0x8002, 0x8003, 0x8004, 0x8005]) {
        assert.equal(checkRuntimeGuards(result, sp).valid, false, sp.toString(16));
    }
    assert.equal(checkRuntimeGuards(result, 0x8006).valid, true);
    assert.match(checkRuntimeGuards(result, 2).reason, /wraps/);
    assert.match(checkRuntimeGuards(result, 65535).reason, /wraps/);
    assert.match(checkRuntimeGuards(result, 0x4002).reason, /executable code/);

    const wrapped = analyse('21ffff110090010200edb0c9');
    assert.equal(wrapped.complete, true, wrapped.gaps.join('\n'));
    assert.deepEqual(wrapped.runtimeGuards.disjointAbsoluteAddresses, [0, 0x9000, 0x9001, 65535]);
    assert.equal(checkRuntimeGuards(wrapped, 0xf000).valid, true);
    const wrappedWrite = analyse('21008011ffff010200edb0c9');
    assert.equal(wrappedWrite.complete, true, wrappedWrite.gaps.join('\n'));
    assert.deepEqual(wrappedWrite.exitEffects[0].clobberedAbsolute, [0, 65535]);
});

test('LDIR uses sequential overlap semantics and invalidates overwritten continuation bytes', () => {
    const corrupt = analyse('21010039eb21000039010200edb0c9');
    assert.equal(corrupt.complete, false);
    assert.match(corrupt.gaps.join('\n'), /Unresolved return/);
    assert.deepEqual(corrupt.rows.at(-1).returnLocations, []);
    const partial = analyse('21010039eb210080010100edb0c9');
    assert.equal(partial.complete, false);
    assert.deepEqual(partial.rows.at(-1).returnLocations, []);
    const self = analyse('21000039eb21000039010200edb0c9');
    assert.equal(self.complete, true, self.gaps.join('\n'));
    assert.deepEqual(self.rows.at(-1).returnLocations, [{ kind: 'memory', spOffset: 0 }]);
    const propagated = analyse('220080210080110180010200edb0c9');
    assert.equal(propagated.complete, true, propagated.gaps.join('\n'));
    assert.deepEqual(propagated.rows.at(-1).savedRegisters.hl, []);
    const backwards = analyse('22008021008011ff7f010200edb0c9');
    assert.equal(backwards.complete, true, backwards.gaps.join('\n'));
    assert.deepEqual(backwards.rows.at(-1).savedRegisters.hl, [{ kind: 'absolute', address: 0x7fff }]);
});

test('LDIR repeat-PC rules intersect evidence at intermediate transfers', () => {
    const result = analyse('21020039eb210080010300edb0c9');
    assert.equal(result.complete, true, result.gaps.join('\n'));
    const copy = result.rows.find(row => row.instructionBytes === 'edb0');
    assert.deepEqual(copy.stackPointers, [], 'DE changes at every repeated LDIR PC');
    assert.deepEqual(result.rows.at(-1).stackPointers, [{ register: 'de', entryOffset: 5 }]);
    const overwritten = analyse('220080210090110080010200edb0c9');
    assert.equal(overwritten.complete, true, overwritten.gaps.join('\n'));
    assert.deepEqual(overwritten.rows.find(row => row.instructionBytes === 'edb0').savedRegisters.hl, []);
    assert.deepEqual(overwritten.rows.at(-1).savedRegisters.hl, []);
});

test('LDIR rules agree with concrete execution at every repeat, including overlap and prefixed PCs', () => {
    const programs = [
        '22008021feff39eb210080010200edb03b3be1c9',
        '21000039110080010200edb0e12100002a0080e9',
        '220080210080110180010200edb0c9',
        '22008021008011ff7f010200edb0c9',
        '21000039eb21000039010200edb0c9',
        '21000039eb21000039010300ddfdedb0c9',
        '21ffff110090010200edb0c9',
        '21008011ffff010200edb0c9',
        '210080110090010200edb0d9d9c9',
        '210080110090010200edb021000039d921feff39f9d9f9c9',
    ];
    for (const origin of [0x100, 0x6000]) {
        for (const entrySp of [0xc100, 0xf000]) {
            for (const hex of programs) {
                const image = Buffer.from(hex, 'hex');
                const model = analyse(hex, origin);
                assert.equal(model.complete, true, model.gaps.join('\n'));
                assert.equal(checkRuntimeGuards(model, entrySp).valid, true);
                const memory = Buffer.alloc(65536, 0x55);
                image.copy(memory, origin);
                const incoming = { bc: 0xabcd, de: 0x1357, hl: 0x2468, ix: 0x9876, iy: 0xaaaa };
                const registers = { ...incoming };
                const alternate = { bc: 0x1111, de: 0x2222, hl: 0x3333 };
                const continuation = 0x9876;
                memory.writeUInt16LE(continuation, entrySp);
                let pc = origin;
                let sp = entrySp;
                let steps = 0;
                let copies = 0;
                const word = address => memory[address] | (memory[(address + 1) & 65535] << 8);
                const read = location => location.kind === 'register' ? registers[location.name] :
                    word(location.kind === 'absolute' ? location.address : sp + location.spOffset);
                while (pc !== continuation) {
                    assert.ok(++steps < 60, hex);
                    const row = model.rows.find(candidate => candidate.pc === pc);
                    assert.ok(row && !row.unavailable, `${hex}: missing row at ${pc.toString(16)}`);
                    assert.equal(sp + row.entrySpOffset, entrySp);
                    assert.equal(sp + row.callerEntrySpOffset, entrySp + 2);
                    assert.ok(row.returnLocations.length);
                    for (const location of row.returnLocations) assert.equal(read(location), continuation);
                    for (const [name, locations] of Object.entries(row.savedRegisters)) {
                        for (const location of locations) assert.equal(read(location), incoming[name]);
                    }
                    for (const pointer of row.stackPointers) {
                        const value = pointer.register ? registers[pointer.register] : word(pointer.address);
                        assert.equal(value, entrySp + pointer.entryOffset);
                    }
                    let opcode = memory[pc++];
                    while (opcode === 0xdd || opcode === 0xfd) opcode = memory[pc++];
                    switch (opcode) {
                    case 0x01: registers.bc = word(pc); pc += 2; break;
                    case 0x11: registers.de = word(pc); pc += 2; break;
                    case 0x21: registers.hl = word(pc); pc += 2; break;
                    case 0x22: memory.writeUInt16LE(registers.hl, word(pc)); pc += 2; break;
                    case 0x2a: registers.hl = word(word(pc)); pc += 2; break;
                    case 0x39: registers.hl = (registers.hl + sp) & 65535; break;
                    case 0xeb: [registers.de, registers.hl] = [registers.hl, registers.de]; break;
                    case 0x3b: --sp; break;
                    case 0xf9: sp = registers.hl; break;
                    case 0xd9:
                        for (const name of ['bc', 'de', 'hl']) {
                            [registers[name], alternate[name]] = [alternate[name], registers[name]];
                        }
                        break;
                    case 0xe1: registers.hl = word(sp); sp += 2; break;
                    case 0xe9: pc = registers.hl; break;
                    case 0xc9: pc = word(sp); sp += 2; break;
                    case 0xed: {
                        const repeatPc = pc - 1;
                        assert.equal(memory[pc++], 0xb0);
                        memory[registers.de] = memory[registers.hl];
                        registers.hl = (registers.hl + 1) & 65535;
                        registers.de = (registers.de + 1) & 65535;
                        registers.bc = (registers.bc - 1) & 65535;
                        ++copies;
                        if (registers.bc !== 0) pc = repeatPc;
                        break;
                    }
                    default: assert.fail(`Unexpected concrete opcode ${opcode.toString(16)}`);
                    }
                }
                assert.equal(sp, entrySp + 2);
                assert.ok(copies >= 2);
                if (hex === programs[2]) {
                    assert.deepEqual([...memory.subarray(0x8000, 0x8003)], [0x68, 0x68, 0x68]);
                }
                if (hex === programs[3]) assert.equal(word(0x7fff), incoming.hl);
            }
        }
    }
});

test('LDIR unknown inputs, writes into code and excessive copies fail closed', () => {
    for (const [hex, options, reason] of [
        ['edb0c9', undefined, /known byte count/],
        ['010100edb0c9', undefined, /resolved source and destination/],
        ['210080010100edb0c9', undefined, /resolved source and destination/],
        ['110080010100edb0c9', undefined, /resolved source and destination/],
        ['21008011ff3f010200edb0c9', undefined, /executable code/],
        ['21008011ff3f010200edb0c9', { budget: 100 }, /executable code/],
        ['210080110090010000edb0c9', undefined, /budget/],
        ['210080110040010000edb0c9', { budget: 70000 }, /executable code/],
        ['210080110090011027edb0c9', undefined, /budget/],
        ['210080110090010400edb0c9', { budget: 7 }, /budget/],
        ['2100801100900102002803010300edb0c9', undefined, /known byte count/],
    ]) {
        const result = analyse(hex, 0x4000, options);
        assert.equal(result.complete, false, hex);
        assert.equal(result.frameComplete, false, hex);
        assert.equal(result.contextualComplete, false, hex);
        assert.match(result.gaps.join('\n'), reason);
    }
    const image = Buffer.from('210080110090010000edb0c9', 'hex');
    const ranges = [{ start: 0x4000, end: 0x4000 + image.length }];
    assert.equal(proveCallSummaries(image, 0x4000, [0x4000], ranges).callSummaries.size, 0);
    const repeated = '210080110090010200edb003edb0c9';
    assert.match(analyse(repeated, 0x4000, { budget: 9 }).gaps.join('\n'), /budget/);
    const bounded = analyse(repeated, 0x4000, { budget: 10 });
    assert.equal(bounded.complete, true, bounded.gaps.join('\n'));
    assert.equal(bounded.states, 7, 'Reported states do not count individual byte transfers');
});

test('LDIR absolute call contracts propagate all accesses and clobbers but stack copies remain guarded inline', () => {
    const absolute = Buffer.from('cd0440c9210080110090010200edb0c9', 'hex');
    const ranges = [{ start: 0x4000, end: 0x4000 + absolute.length }];
    const contracts = proveCallSummaries(absolute, 0x4000, [0x4000, 0x4004], ranges);
    assert.equal(contracts.callSummaries.size, 2);
    const summary = contracts.callSummaries.get(0x4004);
    assert.deepEqual(summary.clobberedAbsolute, [0x9000, 0x9001]);
    assert.deepEqual(summary.absoluteAddresses, [0x8000, 0x8001, 0x9000, 0x9001]);
    for (const name of ['bc', 'de', 'hl']) assert.ok(!summary.preservedRegisters.includes(name));
    const caller = analyseStack(absolute, 0x4000, 0x4000, ranges, contracts);
    assert.equal(caller.complete, true, caller.gaps.join('\n'));
    assert.equal(checkRuntimeGuards(caller, 0xf000).valid, true);
    assert.equal(checkRuntimeGuards(caller, 0x8000).valid, false);
    assert.equal(checkRuntimeGuards(caller, 0x9000).valid, false);

    // Existing contracts cannot express this callee's distant entry-relative stack guard.
    const stack = Buffer.from('cd0440c92100ff39eb210080010400edb0c9', 'hex');
    const stackRanges = [{ start: 0x4000, end: 0x4000 + stack.length }];
    const safeContracts = proveCallSummaries(stack, 0x4000, [0x4000, 0x4004], stackRanges);
    assert.equal(safeContracts.callSummaries.size, 0);
    const inlined = analyseStack(stack, 0x4000, 0x4000, stackRanges, safeContracts);
    assert.equal(inlined.complete, true, inlined.gaps.join('\n'));
    assert.equal(checkRuntimeGuards(inlined, 0xf000).valid, true);
    assert.match(checkRuntimeGuards(inlined, 0x4102).reason, /executable code/);
    assert.match(checkRuntimeGuards(inlined, 0x100).reason, /wraps/);
    assert.deepEqual(inlined.runtimeGuards.stackOffsetBounds, { min: -258, max: 1 });
});

test('EXX explicitly exchanges BC/DE/HL banks without advertising alternate-bank recovery', () => {
    const result = analyse('d9d9c9');
    assert.equal(result.complete, true, result.gaps.join('\n'));
    for (const name of ['bc', 'de', 'hl']) {
        assert.deepEqual(result.rows[1].savedRegisters[name], []);
        assert.deepEqual(result.rows[2].savedRegisters[name], [{ kind: 'register', name }]);
        assert.ok(result.exitEffects[0].preservedRegisters.includes(name));
    }
    for (const name of ['ix', 'iy']) {
        assert.deepEqual(result.rows[1].savedRegisters[name], [{ kind: 'register', name }]);
    }
    const clobbered = analyse('d901341211785621bc9ad9c9');
    assert.equal(clobbered.complete, true, clobbered.gaps.join('\n'));
    for (const name of ['bc', 'de', 'hl']) {
        assert.deepEqual(clobbered.rows.at(-1).savedRegisters[name], [{ kind: 'register', name }]);
    }
    const exchanged = analyse('d9c9');
    assert.equal(exchanged.complete, true);
    for (const name of ['bc', 'de', 'hl']) {
        assert.deepEqual(exchanged.rows.at(-1).savedRegisters[name], []);
        assert.ok(!exchanged.exitEffects[0].preservedRegisters.includes(name));
    }
    const alternateReturn = analyse('e1d9d9e9');
    assert.equal(alternateReturn.complete, false);
    assert.deepEqual(alternateReturn.rows[2].returnLocations, []);
    assert.equal(alternateReturn.exits[0].spDelta, 2);
    assert.ok(alternateReturn.rows.every(row => row.returnLocations.every(location =>
        location.kind !== 'register' || !location.name.includes("'"))));
});

test('EXX alternate provenance widens at joins and is not assumed preserved across call summaries', () => {
    const joined = analyse('d92803213412d9c9');
    assert.equal(joined.complete, true, joined.gaps.join('\n'));
    assert.deepEqual(joined.rows.at(-1).savedRegisters.hl, [{ kind: 'register', name: 'hl' }]);
    const divergent = analyse('d92805d9210000d9d9c9');
    assert.equal(divergent.complete, true, divergent.gaps.join('\n'));
    assert.deepEqual(divergent.rows.at(-1).savedRegisters.hl, []);

    const image = Buffer.from('d9cd0640d9c9c9', 'hex');
    const ranges = [{ start: 0x4000, end: 0x4000 + image.length }];
    const inline = analyseStack(image, 0x4000, 0x4000, ranges);
    assert.equal(inline.complete, true);
    assert.deepEqual(inline.rows.at(-2).savedRegisters.hl, [{ kind: 'register', name: 'hl' }]);
    const contracts = proveCallSummaries(image, 0x4000, [0x4006], ranges);
    const summarized = analyseStack(image, 0x4000, 0x4000, ranges, contracts);
    assert.equal(summarized.complete, true);
    assert.deepEqual(summarized.rows.at(-1).savedRegisters.hl, []);
    assert.ok(!summarized.exitEffects[0].preservedRegisters.includes('hl'));
    const hidden = Buffer.from('e1d9cd0740d9e9c9', 'hex');
    const hiddenRanges = [{ start: 0x4000, end: 0x4000 + hidden.length }];
    const hiddenContracts = proveCallSummaries(hidden, 0x4000, [0x4007], hiddenRanges);
    const lostReturn = analyseStack(hidden, 0x4000, 0x4000, hiddenRanges, hiddenContracts);
    assert.equal(lostReturn.complete, false);
    assert.match(lostReturn.gaps.join('\n'), /Unresolved/);
    assert.deepEqual(lostReturn.rows.at(-1).returnLocations, []);
});

test('EXX retains real stack pointers while main-bank arithmetic changes them', () => {
    for (const origin of [0x100, 0x6000]) {
        const model = analyse('21000039d921feff39f9d9f9c9', origin);
        assert.equal(model.complete, true, model.gaps.join('\n'));
        const recovered = model.rows.find(row => row.pc === origin + 11);
        assert.deepEqual(recovered.stackPointers, [{ register: 'hl', entryOffset: 0 }]);
        assert.equal(recovered.entrySpOffset, 2);
        assert.equal(model.exits[0].spDelta, 2);
        assert.deepEqual(model.rows.find(row => row.pc === origin + 5).stackPointers, []);
    }
    // A is not exchanged: use it to overwrite the saved continuation after EXX.
    const unchangedA = analyse('3e0021000039d9d977c9');
    assert.equal(unchangedA.complete, false);
    assert.deepEqual(unchangedA.rows.at(-1).returnLocations, []);
});

const sourceProbeDirectory = require('node:path').join(__dirname, '..', 'build', 'source-probe');
test('built original source fixture restores nine typed locals and main-to-recursive parent edge',
    { skip: !['PROBE.COM', 'probe.map'].every(name =>
        require('node:fs').existsSync(require('node:path').join(sourceProbeDirectory, name))) }, () => {
        const fs = require('node:fs');
        const path = require('node:path');
        const { readMap, makeElf } = require('../lib/z88dk-elf');
        const root = path.resolve(__dirname, '..');
        const image = fs.readFileSync(path.join(sourceProbeDirectory, 'PROBE.COM'));
        const metadata = readMap(fs.readFileSync(path.join(sourceProbeDirectory, 'probe.map'), 'utf8'),
            image.length, [{ from: 'elf_source_probe.c', to: 'test/fixtures/locations/elf_source_probe.c' }],
            0x100, [], [], 'sccz80');
        makeElf(image, metadata, root);
        const main = metadata.typed.functions.find(func => func.name === 'main');
        const typed = metadata.typed.functions.find(func => func.name === 'typed_probe');
        assert.equal(typed.variables.length, 9);
        for (const variable of typed.variables) {
            assert.ok(variable.locations.length, variable.name);
            assert.deepEqual(variable.locationGaps, [], variable.name);
        }
        for (const name of ['main', 'typed_probe', 'recursive_probe']) {
            const func = metadata.typed.functions.find(func => func.name === name);
            const frame = metadata.frames.find(frame => frame.entry === func.address);
            assert.equal(frame.complete, true, frame.gaps.join('\n'));
            assert.equal(checkRuntimeGuards(frame, 0xf000).valid, true);
            if (name !== 'main') assert.ok(frame.parentEdges.some(edge => edge.parentEntry === main.address));
        }
    });

test('changing loop counters converge by widening values without widening SP or call context', () => {
    const model = analyse('0100000320fdc9');
    assert.equal(model.complete, true, model.gaps.join('\n'));
    assert.ok(model.states < 40, model.states);
    assert.ok(model.exits.every(exit => exit.spDelta === 2));
    const absoluteLoop = analyse('2100002200802320fac9');
    assert.equal(absoluteLoop.complete, true, absoluteLoop.gaps.join('\n'));
    assert.ok(absoluteLoop.states < 60, absoluteLoop.states);
});

test('conflicting stack paths are explicitly unavailable at join points', () => {
    const model = analyse('2801c5c9');
    assert.equal(model.complete, false);
    assert.equal(model.rows.find(row => row.pc === 0x4003).unavailable,
        'Conflicting stack/continuation states');
    assert.ok(model.gaps.some(gap => gap.includes('Unresolved return')));
});

test('recursive calls, stack aliasing, external calls and unsupported effects never silently succeed', () => {
    for (const [hex, reason] of [
        ['cd0040c9', /Recursive/], ['77c9', /alias/], ['cd0000c9', /executable/],
        ['f9c9', /SP no longer/], ['edb0c9', /known byte count/], ['cb00c9', /CB/],
        ['10fec9', /DJNZ/], ['76c9', /interrupt/],
    ]) {
        const model = analyse(hex);
        assert.equal(model.complete, false, hex);
        assert.ok(model.gaps.some(gap => reason.test(gap)), `${hex}: ${model.gaps}`);
    }
    assert.match(analyse('c5c30040', 0x4000, { budget: 20 }).gaps.join('\n'), /budget/);
    assert.throws(() => analyse('c9', 0x4000, { budget: 0 }), /positive integer/);
});

test('symbolic continuation rules agree with concrete execution through stack exchange and indirect return', () => {
    for (const [origin, storage] of [[0x100, null], [0x6000, null], [0x100, 0x8000], [0x6000, 0xa345]]) {
        const helper = origin + 9;
        const indirect = storage === null ? [0xe9] :
            [0x22, storage & 255, storage >> 8, 0x21, 0, 0, 0x2a, storage & 255, storage >> 8, 0xe9];
        const image = Buffer.from([0x21, 0, 0, 0xcd, helper & 255, helper >> 8,
            0x33, 0x33, 0xc9, 0x39, 0x23, 0x23, 0x7e, 0x23, 0x66, 0x6f, 0xe3, ...indirect]);
        const model = analyseStack(image, origin, origin, [{ start: origin, end: origin + image.length }]);
        assert.equal(model.complete, true, model.gaps.join('\n'));
        const memory = Buffer.alloc(65536);
        image.copy(memory, origin);
        const entrySp = 0xf000;
        assert.equal(checkRuntimeGuards(model, entrySp).valid, true);
        const continuation = 0x9876;
        memory.writeUInt16LE(continuation, entrySp);
        let pc = origin;
        let sp = entrySp;
        let hl = 0;
        let a = 0;
        let steps = 0;
        while (pc !== continuation) {
            assert.ok(++steps < 40);
            const row = model.rows.find(row => row.pc === pc);
            assert.ok(row && !row.unavailable, `Missing rule at ${pc.toString(16)}`);
            assert.equal(sp + row.entrySpOffset, entrySp);
            assert.equal(sp + row.callerEntrySpOffset, entrySp + 2);
            for (const location of row.returnLocations) {
                const actual = location.kind === 'memory' ? memory.readUInt16LE(sp + location.spOffset) :
                    location.kind === 'absolute' ? memory.readUInt16LE(location.address) : hl;
                assert.equal(actual, continuation, `Invalid saved continuation at ${pc.toString(16)}`);
            }
            const opcode = memory[pc++];
            switch (opcode) {
            case 0x21: hl = memory.readUInt16LE(pc); pc += 2; break;
            case 0x22: memory.writeUInt16LE(hl, memory.readUInt16LE(pc)); pc += 2; break;
            case 0x2a: hl = memory.readUInt16LE(memory.readUInt16LE(pc)); pc += 2; break;
            case 0xcd: {
                const target = memory.readUInt16LE(pc);
                pc += 2;
                sp -= 2;
                memory.writeUInt16LE(pc, sp);
                pc = target;
                break;
            }
            case 0x33: ++sp; break;
            case 0xc9: pc = memory.readUInt16LE(sp); sp += 2; break;
            case 0x39: hl = (hl + sp) & 65535; break;
            case 0x23: hl = (hl + 1) & 65535; break;
            case 0x7e: a = memory[hl]; break;
            case 0x66: hl = (hl & 255) | (memory[hl] << 8); break;
            case 0x6f: hl = (hl & 0xff00) | a; break;
            case 0xe3: {
                const value = memory.readUInt16LE(sp);
                memory.writeUInt16LE(hl, sp);
                hl = value;
                break;
            }
            case 0xe9: pc = hl; break;
            default: assert.fail(`Unexpected concrete test opcode ${opcode}`);
            }
        }
        assert.equal(sp, entrySp + 2);
    }
});

test('independent nested-frame SP, continuations and saved registers agree with concrete execution', () => {
    for (const origin of [0x100, 0x6000]) {
        const child = origin + 14;
        const leaf = origin + 23;
        const image = Buffer.from([0xdd, 0xe5, 0xdd, 0x21, 0, 0, 0xdd, 0x39,
            0xcd, child & 255, child >> 8, 0xdd, 0xe1, 0xc9,
            0xe5, 0x21, 0x34, 0x12, 0xcd, leaf & 255, leaf >> 8, 0xe1, 0xc9,
            0xd5, 0x11, 0x78, 0x56, 0xd1, 0xc9]);
        const set = analyseFrames(image, origin, [origin], [{ start: origin, end: origin + image.length }]);
        assert.deepEqual(set.gaps, []);
        assert.deepEqual(set.frames.map(frame => frame.entry), [origin, child, leaf]);
        assert.ok(set.frames.every(frame => frame.complete));
        const memory = Buffer.alloc(65536);
        image.copy(memory, origin);
        const initial = { bc: 0xabcd, de: 0x1357, hl: 0x2468, ix: 0x9876, iy: 0xaaaa };
        const registers = { ...initial };
        let sp = 0xf000;
        let pc = origin;
        const continuation = 0x4321;
        memory.writeUInt16LE(continuation, sp);
        const active = [{ entry: origin, entrySp: sp, registers: { ...registers }, continuation }];
        let steps = 0;
        while (active.length) {
            assert.ok(++steps < 40);
            const frame = active.at(-1);
            const analysis = set.frames.find(candidate => candidate.entry === frame.entry);
            assert.equal(checkRuntimeGuards(analysis, frame.entrySp).valid, true);
            const row = analysis.rows.find(candidate => candidate.pc === pc);
            assert.ok(row && !row.unavailable, `No frame rule for ${pc.toString(16)}`);
            assert.equal(sp + row.entrySpOffset, frame.entrySp);
            assert.equal(sp + row.callerEntrySpOffset, frame.entrySp + 2);
            const read = location => location.kind === 'register' ? registers[location.name] :
                memory.readUInt16LE(location.kind === 'absolute' ? location.address : sp + location.spOffset);
            assert.ok(row.returnLocations.length);
            for (const location of row.returnLocations) assert.equal(read(location), frame.continuation);
            for (const [name, locations] of Object.entries(row.savedRegisters)) {
                for (const location of locations) {
                    assert.equal(read(location), frame.registers[name], `${pc.toString(16)} saved ${name}`);
                }
            }
            let opcode = memory[pc++];
            let index;
            if (opcode === 0xdd) {
                index = 'ix';
                opcode = memory[pc++];
            }
            const hl = index || 'hl';
            const push = value => { sp -= 2; memory.writeUInt16LE(value, sp); };
            const pop = () => { const value = memory.readUInt16LE(sp); sp += 2; return value; };
            switch (opcode) {
            case 0xe5: push(registers[hl]); break;
            case 0xe1: registers[hl] = pop(); break;
            case 0xd5: push(registers.de); break;
            case 0xd1: registers.de = pop(); break;
            case 0x21: registers[hl] = memory.readUInt16LE(pc); pc += 2; break;
            case 0x11: registers.de = memory.readUInt16LE(pc); pc += 2; break;
            case 0x39: registers[hl] = (registers[hl] + sp) & 65535; break;
            case 0xcd: {
                const target = memory.readUInt16LE(pc);
                pc += 2;
                push(pc);
                active.push({ entry: target, entrySp: sp, registers: { ...registers }, continuation: pc });
                pc = target;
                break;
            }
            case 0xc9: pc = pop(); active.pop(); break;
            default: assert.fail(`Unexpected concrete instruction ${opcode.toString(16)}`);
            }
        }
        assert.equal(pc, continuation);
        assert.equal(sp, 0xf002);
        assert.deepEqual(registers, initial);
    }
});
