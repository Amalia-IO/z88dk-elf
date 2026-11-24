'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { test } = require('node:test');
const { convert } = require('../lib/z88dk-elf');
const { runGdb } = require('./gdb-launch');
const { runGenericGdb } = require('./z80-generic-rsp-test-support');
const { machine } = require('./z80-probe-machine');

const root = path.resolve(__dirname, '..');
const available = { skip: !process.env.Z88DK_DOCKER_IMAGE || !process.env.Z80_GDB };

function build() {
    const directory = path.join(root, 'build', 'source-probe');
    fs.mkdirSync(directory, { recursive: true });
    const result = spawnSync('docker', ['run', '--rm', '--mount',
        `type=bind,source=${root},target=/work`, '-w', '/work', process.env.Z88DK_DOCKER_IMAGE,
        'zcc', '+cpm', '-compiler=sccz80', '-O0', '-debug', '-create-app', '-m',
        'test/fixtures/locations/elf_source_probe.c', '-o', 'build/source-probe/probe.bin'],
    { encoding: 'utf8', timeout: 120000 });
    assert.equal(result.status, 0, result.error?.message || result.stdout + result.stderr);
    const imagePath = path.join(directory, 'PROBE.COM');
    const elfPath = path.join(directory, 'probe.debug.elf');
    const metadata = convert(imagePath, path.join(directory, 'probe.map'), elfPath,
        [{ from: 'elf_source_probe.c', to: 'test/fixtures/locations/elf_source_probe.c' }],
        0x100, [], [], 'sccz80', root);
    return { imagePath, elfPath, metadata };
}

function execution(fixture, name, args = []) {
    const { metadata, imagePath } = fixture;
    const func = metadata.typed.functions.find(func => func.name === name);
    const frame = metadata.frames.find(frame => frame.entry === func.address);
    const main = metadata.typed.functions.find(func => func.name === 'main');
    const edge = frame.parentEdges.find(edge => edge.parentEntry === main.address);
    assert.ok(frame.complete && edge, `${name}: ${frame.gaps.join('\n')}`);
    const memory = Buffer.alloc(65536);
    fs.readFileSync(imagePath).copy(memory, metadata.origin);
    const sp = 0xf000;
    const parentSp = sp + edge.parentEntrySpOffsetAtChildEntry;
    memory.writeUInt16LE(edge.continuation, sp);
    memory.writeUInt16LE(0, parentSp);
    memory.writeUInt16LE(0, parentSp - 2);
    const framePointer = metadata.symbols.find(symbol => symbol.name === '__debug_framepointer').address;
    memory.writeUInt16LE(parentSp - 2, framePointer);
    args.forEach((value, index) => memory.writeUInt16LE(value & 0xffff, sp + 2 + index * 2));
    return { memory, cpu: machine(memory, { pc: func.address, sp }), func, frame };
}

function advance(state, predicate) {
    for (let steps = 0; steps < 10000; ++steps) {
        if (predicate()) return;
        state.cpu.step();
    }
    throw new Error('Probe did not reach requested executed state');
}

function scenario(fixture, state) {
    return { imagePath: fixture.imagePath, origin: fixture.metadata.origin,
        pc: state.cpu.registers.pc, sp: state.cpu.registers.sp,
        registers: state.cpu.registers, memoryHex: state.memory.toString('hex'), execute: true };
}

test('original source probe preserves incomplete arrays, block-copy locals and statement attribution',
    available, async () => {
        const fixture = build();
        const { metadata, elfPath } = fixture;
        assert.equal(metadata.typed.functions.length, 12);
        assert.equal(metadata.typed.globals.length, 7);
        assert.ok(metadata.typed.functions.every(func =>
            metadata.frames.find(frame => frame.entry === func.address).complete));
        const typed = metadata.typed.functions.find(func => func.name === 'typed_probe');
        assert.equal(typed.variables.length, 9);
        assert.ok(typed.variables.every(variable => variable.locations.length &&
            !variable.locationGaps.length), JSON.stringify(typed.variables));
        const commands = ['ptype message', 'p sizeof(message)', 'ptype record', 'p sizeof(record)'];
        for (const line of [69, 75, 83, 87]) {
            const row = metadata.rows.find(row => row.kind === 'C' && row.line === line);
            assert.ok(row);
            commands.push(`info line *0x${row.address.toString(16)}`);
        }
        const output = runGdb(elfPath, commands).stdout;
        assert.match(output, /type = char \[11\]/);
        assert.match(output, /\$1 = 11/);
        assert.match(output, /\$2 = 10/);
        for (const line of [69, 75, 83, 87]) assert.match(output, new RegExp(`Line ${line} of`));
        const message = metadata.typed.globals.find(global => global.name === 'message').address;
        const state = execution(fixture, 'typed_probe', [message, -123]);
        const ready = metadata.rows.find(row => row.kind === 'C' && row.line === 46).address;
        advance(state, () => state.cpu.registers.pc === ready);
        const remote = await runGenericGdb(elfPath, scenario(fixture, state),
            ['info args', 'info locals', 'p local_record.text', 'bt 2']);
        assert.doesNotMatch(remote.output, /optimized out|Python Exception|Cannot access|unavailable/);
        for (const expected of [/adjustment = -123/, /signed_local = -7/, /letter = 90 'Z'/,
            /wide = -123456/, /local_numbers = \{7, 8\}/, /local_message = "Local"/,
            /count = 321/, /label = "Stack"/, /Hello CP\/M/, /#1\s+.*main/]) {
            assert.match(remote.output, expected, remote.output);
        }
    });

test('original probe executes GDB finish with every previously verified ABI return type',
    available, async () => {
        const fixture = build();
        const pointer = fixture.metadata.typed.globals.find(global => global.name === 'counter').address;
        for (const [name, expected, size, type] of [
            ['return_signed_int', -123, 2, 'int'], ['return_unsigned_char', 200, 1, 'unsigned char'],
            ['return_signed_char', -37, 1, 'char'], ['return_unsigned_long', 0x12345678, 4, 'unsigned long'],
            ['return_pointer', pointer, 2, 'unsigned int *'],
        ]) {
            const state = execution(fixture, name);
            assert.equal(fixture.metadata.typed.types[state.func.returnType].size, size);
            const result = await runGenericGdb(fixture.elfPath, scenario(fixture, state),
                ['set remote software-breakpoint-packet on', `whatis ${name}`, 'finish',
                    'printf "ABI_RETURN=%ld\\n", (long)$', 'bt 2']);
            assert.ok(result.output.includes(`type = ${type}()`) ||
                result.output.includes(`type = ${type} ()`), result.output);
            assert.match(result.output, new RegExp(`ABI_RETURN=${expected}\\b`), result.output);
            assert.match(result.output, /Value returned is/);
            assert.ok(result.packets.includes('c'));
            assert.ok(result.packets.some(packet => packet.startsWith('Z0,')));
            assert.ok(result.packets.some(packet => packet.startsWith('z0,')));
        }
    });

test('original recursion executes four Step Outs and frame-isolated MI edits affect actual returns',
    available, async () => {
        const fixture = build();
        for (const editFrame of [undefined, 0, 1]) {
            const state = execution(fixture, 'recursive_probe', [3]);
            const depth = state.func.variables.find(variable => variable.name === 'depth');
            const ready = fixture.metadata.rows.find(row => row.kind === 'C' && row.line === 83).address;
            const location = depth.locations.find(location => location.start === ready);
            advance(state, () => state.cpu.registers.pc === ready &&
                state.cpu.word(state.cpu.registers.sp + location.spOffset) === 0);
            const commands = ['set remote software-breakpoint-packet on', 'set remote binary-download-packet off'];
            if (editFrame !== undefined) {
                commands.push('interpreter-exec mi "-var-create --thread 1 --frame 0 editglobal * counter"',
                    'interpreter-exec mi "-var-assign --thread 1 --frame 0 editglobal 777"',
                    'printf "GLOBAL=%u\\n", counter',
                    `interpreter-exec mi "-var-create --thread 1 --frame ${editFrame} editmarker * marker"`,
                    `interpreter-exec mi "-var-assign --thread 1 --frame ${editFrame} editmarker 150"`,
                    'maintenance flush dcache');
            }
            for (let frame = 0; frame < 4; ++frame) {
                commands.push(`frame ${frame}`, `printf "MARKER${frame}=%u\\n", marker`);
            }
            commands.push('frame 0');
            for (let frame = 0; frame < 4; ++frame) {
                commands.push('finish', `printf "RETURN${frame}=%u\\n", (unsigned int)$`);
            }
            const result = await runGenericGdb(fixture.elfPath, scenario(fixture, state), commands);
            let total = 0;
            for (let frame = 0; frame < 4; ++frame) {
                const value = editFrame === frame ? 150 : 100 + frame;
                total += value;
                assert.match(result.output, new RegExp(`MARKER${frame}=${value}\\b`), result.output);
                assert.match(result.output, new RegExp(`RETURN${frame}=${total}\\b`), result.output);
            }
            assert.ok(result.packets.filter(packet => packet === 'c').length >= 4);
            if (editFrame !== undefined) {
                assert.match(result.output, /GLOBAL=777/);
                assert.equal(result.packets.filter(packet => packet.startsWith('M')).length, 2);
            }
        }
    });

test('original branch-loop probe executes both branches and all three callback iterations',
    available, async () => {
        const fixture = build();
        for (const [choose, expected] of [[0, 23], [1, 13]]) {
            const state = execution(fixture, 'flow_probe', [choose]);
            const result = await runGenericGdb(fixture.elfPath, scenario(fixture, state),
                ['set remote software-breakpoint-packet on', 'finish',
                    'printf "FLOW_RETURN=%u\\n", (unsigned int)$']);
            assert.match(result.output, new RegExp(`FLOW_RETURN=${expected}\\b`), result.output);
            assert.ok(result.packets.includes('c'));
            const increment = fixture.metadata.typed.functions.find(func => func.name === 'increment');
            assert.equal(result.stubOutput.split('\n').filter(line =>
                line === `EXEC CALL ${increment.address.toString(16)}`).length, 3);
        }
    });
