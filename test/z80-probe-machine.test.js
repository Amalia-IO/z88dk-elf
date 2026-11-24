'use strict';

const assert = require('node:assert/strict');
const { test } = require('node:test');
const { machine } = require('./z80-probe-machine');

test('probe interpreter executes actual block-copy bytes and balanced push/pop/return', () => {
    const memory = Buffer.alloc(65536);
    Buffer.from('212001113001010300edb0213412e5e1c9', 'hex').copy(memory, 0x100);
    Buffer.from('010203', 'hex').copy(memory, 0x120);
    memory.writeUInt16LE(0, 0xf000);
    const cpu = machine(memory, { pc: 0x100, sp: 0xf000 });
    for (let index = 0; index < 8; ++index) cpu.step();
    assert.equal(cpu.registers.pc, 0);
    assert.equal(cpu.registers.hl, 0x1234);
    assert.equal(cpu.registers.bc, 0);
    assert.equal(cpu.registers.sp, 0xf002);
    assert.equal(memory.subarray(0x130, 0x133).toString('hex'), '010203');
});

test('probe interpreter preserves overlapping LDIR semantics and rejects unsupported instructions', () => {
    const memory = Buffer.alloc(65536);
    Buffer.from('edb076', 'hex').copy(memory, 0x100);
    memory[0x120] = 42;
    const cpu = machine(memory, { pc: 0x100, sp: 0xf000, hl: 0x120, de: 0x121, bc: 3 });
    cpu.step();
    assert.deepEqual([...memory.subarray(0x120, 0x124)], [42, 42, 42, 42]);
    assert.equal(cpu.registers.hl, 0x123);
    assert.equal(cpu.registers.de, 0x124);
    assert.throws(() => cpu.step(), /Unsupported regression instruction 0x76 at 0x102/);
});
