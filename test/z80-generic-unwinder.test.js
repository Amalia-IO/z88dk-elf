'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { test } = require('node:test');
const { readMap, makeElf } = require('../lib/z88dk-elf');
const { createHash } = require('node:crypto');
const { runGenericGdb } = require('./z80-generic-rsp-test-support');

const encode = value => [...Buffer.from(value)].map(byte =>
    /[a-z0-9]/i.test(String.fromCharCode(byte)) ? String.fromCharCode(byte) :
        `_${byte.toString(16).padStart(2, '0')}`).join('');
const mapRecord = (name, address, kind = 'addr', section = 'code_alpha', visibility = 'public') =>
    `${name} = $${address.toString(16)} ; ${kind}, ${visibility}, , unit, ${section},`;

function makeFixture(directory, variant = 'saved-register') {
    const origin = 0x100;
    const assemblyHelper = variant !== 'saved-register';
    const image = assemblyHelper ?
        Buffer.from(variant === 'register-return' ? 'cd08013333c90000e3e9' :
            'cd08013333c90000e1e5c9', 'hex') :
        Buffer.from('cd0801c900000000c5013412217856c1c9', 'hex');
    const cdb = value => mapRecord(`__CDBINFO__${encode(value)}`, origin, 'const', '');
    const map = [
        mapRecord('__head', origin, 'const', ''),
        mapRecord('__tail', origin + image.length, 'const', ''),
        mapRecord('__code_alpha_head', origin, 'const', ''),
        mapRecord('__code_alpha_tail', origin + image.length, 'const', ''),
        mapRecord('_main', origin),
        mapRecord(assemblyHelper ? '_helper' : '_callee', origin + 8),
        cdb('F:G$main$0_0$0({2}DF,SV:S),C,0,0'),
        ...(assemblyHelper ? [] : [cdb('F:G$callee$0_0$0({2}DF,SI:S),C,0,0')]),
        mapRecord(`__C_LINE_1_${encode('unwind.c::main::1::0')}`, origin, 'const', ''),
        ...(assemblyHelper ? [] :
            [mapRecord(`__C_LINE_2_${encode('unwind.c::callee::1::0')}`, origin + 8, 'const', '')]),
    ].join('\n');
    const metadata = readMap(map, image.length, [], origin);
    const elfPath = path.join(directory, 'generic.elf');
    const elf = makeElf(image, metadata);
    metadata.elfSha256 = createHash('sha256').update(elf).digest('hex');
    fs.writeFileSync(elfPath, elf);
    fs.writeFileSync(`${elfPath}.metadata.json`, JSON.stringify(metadata, null, 2));
    return { elfPath, metadata, image };
}

test('generic GDB unwinder reconstructs guarded caller PC, SP and saved registers over loopback RSP',
    { skip: !process.env.Z80_GDB }, async () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'z80-generic-unwind-'));
    try {
        const fixture = makeFixture(directory);
        const callee = fixture.metadata.frames.find(frame => frame.entry === 0x108);
        assert.ok(callee?.complete);
        const current = callee.rows.find(row => row.pc === 0x10c);
        assert.deepEqual(current.returnLocations, [{ kind: 'memory', spOffset: 2 }]);
        assert.deepEqual(current.savedRegisters.bc, [{ kind: 'memory', spOffset: 0 }]);
        assert.ok(callee.instructionBytes.some(item => item.address === 0x108));

        const { output, packets } = await runGenericGdb(fixture.elfPath, 'valid');
        assert.match(output, /Registered guarded generic Z80 unwinder/);
        assert.match(output, /#0\s+.*callee/);
        assert.match(output, /#1\s+.*main/);
        assert.match(output, /bc\s+0xbeef/);
        assert.match(output, /sp\s+0xf002/);
        assert.match(output, /pc\s+0x103/);
        assert.ok(packets.includes('g'));
        assert.ok(packets.some(packet => packet.startsWith('m')));
        assert.ok(!/Python Exception|Traceback|ambiguous frame rules|Cannot access/i.test(output), output);

        const registerFixture = makeFixture(directory, 'register-return');
        const { output: registerOutput } = await runGenericGdb(registerFixture.elfPath, 'register-return');
        assert.match(registerOutput, /#1\s+.*main/);
        assert.match(registerOutput, /pc\s+0x103/);
        assert.match(registerOutput, /sp\s+0xeffe/);
        assert.doesNotMatch(registerOutput, /Python Exception|ambiguous frame rules|Cannot access/i,
            registerOutput);

        const duplicateFixture = makeFixture(directory, 'duplicate-return');
        const duplicateFrame = duplicateFixture.metadata.frames.find(frame => frame.entry === 0x108);
        assert.deepEqual(duplicateFrame.rows.find(row => row.pc === 0x10a).returnLocations, [
            { kind: 'memory', spOffset: 0 }, { kind: 'register', name: 'hl' },
        ]);
        const { output: duplicateOutput } = await runGenericGdb(duplicateFixture.elfPath, 'duplicate-return');
        assert.match(duplicateOutput, /#1\s+.*main/);

        const inconsistent = await runGenericGdb(duplicateFixture.elfPath, 'mismatched-return');
        assert.match(inconsistent.output, /proven return locations disagree/);
    } finally {
        for (const filename of fs.readdirSync(directory)) fs.unlinkSync(path.join(directory, filename));
        fs.rmdirSync(directory);
    }
});

test('generic GDB unwinder rejects code mismatch and runtime stack aliasing',
    { skip: !process.env.Z80_GDB }, async () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'z80-generic-unwind-'));
    try {
        const fixture = makeFixture(directory);
        const mismatch = await runGenericGdb(fixture.elfPath, 'corrupt-code');
        assert.match(mismatch.output, /does not match the analysed ELF/);
        const prologue = await runGenericGdb(fixture.elfPath, 'corrupt-prologue');
        assert.match(prologue.output, /target code at 0x108 does not match the analysed ELF/);
        const alias = await runGenericGdb(fixture.elfPath, 'alias-stack');
        assert.match(alias.output, /tracked stack may alias executable code/);
    } finally {
        for (const filename of fs.readdirSync(directory)) fs.unlinkSync(path.join(directory, filename));
        fs.rmdirSync(directory);
    }
});
