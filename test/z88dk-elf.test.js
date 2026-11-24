'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { test } = require('node:test');
const { readMap, makeElf, convert } = require('../lib/z88dk-elf');
const { runGenericGdb } = require('./z80-generic-rsp-test-support');
const { runGdb } = require('./gdb-launch');

const encode = value => [...Buffer.from(value)].map(byte =>
    /[a-z0-9]/i.test(String.fromCharCode(byte)) ? String.fromCharCode(byte) :
        `_${byte.toString(16).padStart(2, '0')}`).join('');
const record = (name, address, kind = 'addr', section = 'code_alpha', visibility = 'public') =>
    `${name} = $${address.toString(16)} ; ${kind}, ${visibility}, , module, ${section},`;
const fixture = origin => [
    record('__head', origin, 'const', ''),
    record('__tail', origin + 16, 'const', ''),
    record('__code_alpha_tail', origin + 16, 'const', ''),
    record('arbitrary_entry', origin),
    record('private_label', origin + 3, 'addr', 'code_alpha', 'local'),
    record('external_data', 0x8000, 'addr', 'bss_alpha'),
    record(`__C_LINE_7_${encode('first.c::whatever::1::0')}`, origin),
    record(`__C_LINE_12_${encode('second.c::another::1::0')}`, origin + 4),
    record(`__ASM_LINE_9_${encode('routine.asm')}`, origin + 8),
].join('\n');

function sections(elf) {
    const offset = elf.readUInt32LE(32);
    const count = elf.readUInt16LE(48);
    const namesHeader = offset + elf.readUInt16LE(50) * 40;
    const namesOffset = elf.readUInt32LE(namesHeader + 16);
    return Array.from({ length: count }, (_, index) => {
        const header = offset + index * 40;
        const nameStart = namesOffset + elf.readUInt32LE(header);
        const start = elf.readUInt32LE(header + 16);
        const size = elf.readUInt32LE(header + 20);
        return { name: elf.toString('utf8', nameStart, elf.indexOf(0, nameStart)),
            address: elf.readUInt32LE(header + 12), data: elf.subarray(start, start + size),
            info: elf.readUInt32LE(header + 28) };
    });
}

function makeEntryScenario(metadata, imagePath, frame) {
    assert.ok(frame?.complete, `Missing complete frame at ${frame?.entry?.toString(16)}`);
    const main = metadata.typed.functions.find(func => func.name === 'main');
    const edge = frame.parentEdges.find(candidate => candidate.parentEntry === main.address);
    assert.ok(edge, `Frame 0x${frame.entry.toString(16)} has no analysed main call edge`);
    const entrySp = 0xf000;
    const row = frame.rows.find(candidate => candidate.pc === frame.entry);
    assert.ok(row && row.returnLocations.length);
    const sp = entrySp - edge.parentEntrySpOffsetAtChildEntry - row.entrySpOffset;
    const registers = { bc: 0x1234, de: 0x2468, hl: 0x5678, ix: 0x9876, iy: 0xaaaa };
    const words = new Map();
    const setWord = (address, value) => {
        assert.ok(address >= 0 && address <= 0xfffe, `Invalid test memory address 0x${address.toString(16)}`);
        const previous = words.get(address);
        assert.ok(previous === undefined || previous === value,
            `Inconsistent synthetic word at 0x${address.toString(16)}`);
        words.set(address, value);
    };
    const setLocations = (locations, value, currentSp) => {
        for (const location of locations) {
            if (location.kind === 'memory') setWord(currentSp + location.spOffset, value);
            else if (location.kind === 'absolute') setWord(location.address, value);
            else registers[location.name] = value;
        }
    };
    setLocations(row.returnLocations, edge.continuation, sp);
    for (const [name, locations] of Object.entries(row.savedRegisters)) {
        setLocations(locations, registers[name], sp);
    }
    const parent = metadata.frames.find(candidate => candidate.entry === main.address);
    const parentRow = parent.rows.find(candidate => candidate.pc === edge.continuation);
    assert.ok(parentRow && parentRow.returnLocations.length);
    const parentSp = entrySp - edge.parentEntrySpOffsetAtContinuation;
    setLocations(parentRow.returnLocations, 0, parentSp);
    for (const [name, locations] of Object.entries(parentRow.savedRegisters)) {
        setLocations(locations, registers[name], parentSp);
    }
    return { imagePath, origin: metadata.origin, pc: frame.entry, sp, registers,
        words: [...words], expectedCallerSp: parentSp, expectedReturnPc: edge.continuation,
        frameName: metadata.typed.functions.find(func => func.address === frame.entry)?.name };
}

test('whole-map conversion has no source, function, helper or instruction restrictions', () => {
    for (const origin of [0, 0x100, 0x8000]) {
        const image = Buffer.alloc(16, 0xff);
        Buffer.from('ddfde3e9edb0cb7fc9', 'hex').copy(image);
        const metadata = readMap(fixture(origin), image.length);
        assert.equal(metadata.origin, origin);
        assert.deepEqual(metadata.rows.map(row => row.file), ['first.c', 'second.c', 'routine.asm']);
        const elf = makeElf(image, metadata);
        assert.equal(elf.readUInt32LE(24), origin);
        const entries = sections(elf);
        assert.deepEqual(entries.find(section => section.name === '.text').data, image);
        assert.equal(entries.find(section => section.name === '.symtab').info, 2);
        const strings = entries.find(section => section.name === '.strtab').data.toString();
        assert.ok(strings.includes('arbitrary_entry\0'));
        assert.ok(strings.includes('private_label\0'));
        assert.ok(strings.includes('external_data\0'));
        assert.ok(!strings.includes('__C_LINE_'));
        assert.ok(metadata.warnings.some(warning => warning.includes('not DWARF CFI')));
    }
});

test('source path mappings use longest prefix and preserve all modules', () => {
    const map = fixture(0x100).replace(encode('first.c::whatever::1::0'),
        encode('C:\\project\\sub\\first.c::whatever::1::0'));
    const metadata = readMap(map, 16, [
        { from: 'C:\\project', to: '/workspace' },
        { from: 'C:\\project\\sub', to: '/source' },
    ]);
    assert.equal(metadata.rows[0].file, '/source/first.c');
    assert.equal(metadata.rows[1].file, 'second.c');
});

test('UTF-8 source identifiers round-trip without Latin-1 corruption', () => {
    const file = 'sources/caf\u00e9.c';
    const map = fixture(0x100).replace(encode('first.c::whatever::1::0'),
        encode(`${file}::whatever::1::0`));
    assert.equal(readMap(map, 16).rows[0].file, file);
});

test('missing lines and CDB metadata are explicit, not fabricated', () => {
    const map = fixture(0x100).split('\n').filter(line => !line.startsWith('__C_LINE_') &&
        !line.startsWith('__ASM_LINE_')).join('\n');
    const metadata = readMap(`${map}\n${record(`__CDBINFO__${encode('F:G$anything$0_0$0({2}DF,SV:S),C,0,0')}`, 1, 'const', 'IGNORE')}`, 16);
    assert.equal(metadata.rows.length, 0);
    assert.equal(metadata.cdb.length, 1);
    assert.ok(metadata.warnings.some(warning => warning.startsWith('No relocated C source markers')));
    assert.ok(metadata.warnings.some(warning => warning.includes('has no linked entry')));
    assert.ok(!sections(makeElf(Buffer.alloc(16), metadata)).some(section =>
        section.name.startsWith('.debug')));
});

test('invalid image extents, malformed records and missing line-section bounds are rejected', () => {
    assert.throws(() => readMap(fixture(0x100), 15), /extent/);
    assert.throws(() => readMap(`${fixture(0x100)}\ninvalid`, 16), /Invalid MAP record/);
    assert.throws(() => readMap(fixture(0x100).replace('__head', 'other'), 16), /boundary/);
    const metadata = readMap(fixture(0x100).replace('__code_alpha_tail', '__unrelated_tail'), 16);
    assert.throws(() => makeElf(Buffer.alloc(16), metadata), /section boundary/);
    const sectioned = fixture(0x100).replace('__head = $100', '__head = $0')
        .replace('__tail = $110', '__tail = $0');
    assert.throws(() => readMap(sectioned, 16), /--origin/);
    assert.equal(readMap(sectioned, 16, [], 0x100).origin, 0x100);
});

test('same-basename source modules must be mapped explicitly rather than merged', () => {
    const map = `${fixture(0x100)}\n${record(`__C_LINE_8_${encode('first.c::x::1::1')}`, 0x102)
        .replace(', module,', ', other_module,')}`;
    assert.throws(() => readMap(map, 16), /Ambiguous C source/);
    const metadata = readMap(map, 16, [], undefined, [
        { module: 'module', file: 'left/first.c' },
        { module: 'other_module', file: 'right/first.c' },
    ]);
    assert.ok(metadata.rows.some(row => row.file === 'left/first.c'));
    assert.ok(metadata.rows.some(row => row.file === 'right/first.c'));
});

test('resolved shared source paths retain separate module identities', () => {
    const file = 'include/shared.h::x::1::1';
    const map = `${fixture(0x100)}\n${record(`__C_LINE_2_${encode(file)}`, 0x102)}\n${
        record(`__C_LINE_2_${encode(file)}`, 0x102).replace(', module,', ', another_module,')}`;
    const metadata = readMap(map, 16);
    const shared = metadata.rows.filter(row => row.file === 'include/shared.h');
    assert.equal(shared.length, 2);
    assert.notEqual(shared[0].module, shared[1].module);
    assert.doesNotThrow(() => makeElf(Buffer.alloc(16), metadata));
});

test('compiler source scopes at a shared line/address are retained independently', () => {
    const map = `${fixture(0x100)}\n${record(`__C_LINE_7_${encode('first.c::fn::2::3')}`, 0x100)}`;
    const metadata = readMap(map, 16, [], undefined, [], [], 'sccz80');
    const rows = metadata.rows.filter(row => row.file === 'first.c' && row.line === 7);
    assert.equal(rows.length, 2);
    assert.equal(rows.find(row => row.function === 'fn').block, 3);
});

test('wide linker constants retain exact original bits and use valid ELF32 symbol values', () => {
    const metadata = readMap(`${fixture(0x100)}\n${record('negative_constant', 1, 'const', '')
        .replace('$1 ', '$FFFFFFFFFFFFFFFF ')}`, 16);
    const constant = metadata.symbols.find(symbol => symbol.name === 'negative_constant');
    assert.equal(constant.address, 0xffffffff);
    assert.equal(constant.valueHex, 'FFFFFFFFFFFFFFFF');
    assert.ok(metadata.warnings.some(warning => warning.includes('low 32 bits')));
    assert.doesNotThrow(() => makeElf(Buffer.alloc(16), metadata));
});

test('arbitrary assembly section names can be classified explicitly', () => {
    const map = fixture(0x2000).replaceAll('code_alpha', 'custom_instructions');
    assert.equal(readMap(map, 16).rows.length, 0);
    const metadata = readMap(map, 16, [], undefined, [], ['custom_instructions']);
    assert.equal(metadata.rows.length, 3);
    assert.doesNotThrow(() => makeElf(Buffer.alloc(16), metadata));
});

test('function range emission preserves disjoint code and reports unresolved flow', () => {
    const origin = 0x4000;
    const map = [fixture(origin), record('__code_alpha_head', origin, 'const', ''),
        record('_choose', origin), record(`__CDBINFO__${encode(
            'F:G$choose$0_0$0({2}DF,SI:S),C,0,0')}`, 1, 'const', 'IGNORE')].join('\n');
    const metadata = readMap(map, 16);
    const image = Buffer.alloc(16, 0xff);
    Buffer.from('1803ffffffc9', 'hex').copy(image);
    const elf = makeElf(image, metadata);
    assert.deepEqual(metadata.typed.functions[0].ranges, [
        { start: origin, end: origin + 2 }, { start: origin + 5, end: origin + 6 },
    ]);
    const entries = sections(elf);
    const strings = entries.find(section => section.name === '.strtab').data;
    const symbols = entries.find(section => section.name === '.symtab').data;
    let found = false;
    for (let offset = 16; offset < symbols.length; offset += 16) {
        const nameOffset = symbols.readUInt32LE(offset);
        const name = strings.toString('utf8', nameOffset, strings.indexOf(0, nameOffset));
        if (name === '_choose') {
            assert.equal(symbols[offset + 12] & 15, 2);
            assert.equal(symbols.readUInt32LE(offset + 8), 0, 'No fabricated contiguous ELF extent');
            found = true;
        }
    }
    assert.ok(found);
    const unresolved = readMap(map, 16);
    image[0] = 0xe9;
    makeElf(image, unresolved);
    assert.deepEqual(unresolved.typed.functions[0].ranges, []);
    assert.match(unresolved.typed.functions[0].rangeGaps[0], /Indirect jump/);
    assert.ok(unresolved.warnings.some(warning => warning.includes('no proven address ranges')));
    assert.equal(unresolved.typed.functions[0].stackAnalysis.complete, false);
    assert.equal(unresolved.frames.find(frame => frame.entry === origin).complete, false);
    assert.ok(unresolved.warnings.some(warning =>
        warning.includes('Root stack analysis incomplete for choose in ') &&
        warning.includes('Independent frame analysis is incomplete or missing; the GDB unwinder cannot use this frame.')));
});

test('GDB resolves multiple source files and assembly rows at arbitrary origins',
    { skip: !process.env.Z80_GDB }, () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'z88dk-generic-elf-'));
    try {
        for (const origin of [0x100, 0x4000]) {
            const imagePath = path.join(directory, 'image.bin');
            const mapFile = path.join(directory, 'image.map');
            const elfFile = path.join(directory, 'image.elf');
            fs.writeFileSync(imagePath, Buffer.alloc(16, 0xc9));
            fs.writeFileSync(mapFile, fixture(origin));
            convert(imagePath, mapFile, elfFile);
            const output = runGdb(elfFile, ['info address arbitrary_entry', 'info line first.c:7',
                'info line second.c:12', 'info line routine.asm:9']);
            for (const address of [origin, origin + 4, origin + 8]) {
                assert.ok(output.stdout.includes(`0x${address.toString(16)}`), output.stdout);
            }
            assert.match(output.stdout, /Line 7 of "first.c"/);
            assert.match(output.stdout, /Line 12 of "second.c"/);
            assert.match(output.stdout, /Line 9 of "routine.asm"/);
        }
    } finally {
        for (const filename of fs.readdirSync(directory)) fs.unlinkSync(path.join(directory, filename));
        fs.rmdirSync(directory);
    }
});

for (const compiler of ['sdcc', 'sccz80']) {
test(`container ${compiler} multi-file C and assembly build converts without program-specific rules`,
    { skip: !process.env.Z88DK_DOCKER_IMAGE }, async () => {
        const root = path.resolve(__dirname, '..');
        const build = path.join(root, 'build', 'generic-elf');
        fs.mkdirSync(build, { recursive: true });
        const command = spawnSync('docker', ['run', '--rm', '--mount',
            `type=bind,source=${root},target=/work`, '-w', '/work', process.env.Z88DK_DOCKER_IMAGE,
            'zcc', '+cpm', ...(compiler === 'sdcc' ? ['-clib=sdcc_ix', '-SO0'] : ['-O0']),
            `-compiler=${compiler}`, '-debug',
            '-create-app', '-m', 'test/fixtures/mixed/main.c',
            'test/fixtures/mixed/calculate.c', 'test/fixtures/mixed/value.asm',
            '-o', `build/generic-elf/mixed-${compiler}.bin`], { encoding: 'utf8', timeout: 120000 });
        assert.equal(command.status, 0, command.stdout + command.stderr);
        const elfFile = path.join(build, `mixed-${compiler}.debug.elf`);
        const metadata = convert(path.join(build, `MIXED-${compiler.toUpperCase()}.COM`),
            path.join(build, `mixed-${compiler}.map`), elfFile, [], 0x100);
        assert.ok(Object.values(metadata.typed.compilers).every(name => name === compiler));
        const explicitFile = path.join(build, `mixed-${compiler}.explicit.elf`);
        const explicit = spawnSync(process.execPath, [path.join(__dirname, '..', 'bin', 'z88dk-elf.js'),
            path.join(build, `MIXED-${compiler.toUpperCase()}.COM`),
            path.join(build, `mixed-${compiler}.map`), explicitFile, '--origin', '0100',
            '--compiler', compiler], { encoding: 'utf8' });
        assert.equal(explicit.status, 0, explicit.stderr);
        assert.deepEqual(fs.readFileSync(explicitFile), fs.readFileSync(elfFile));
        const rejectedFile = path.join(build, `mixed-${compiler}.wrong.elf`);
        const rejected = spawnSync(process.execPath, [path.join(__dirname, '..', 'bin', 'z88dk-elf.js'),
            path.join(build, `MIXED-${compiler.toUpperCase()}.COM`),
            path.join(build, `mixed-${compiler}.map`), rejectedFile, '--origin', '0100',
            '--compiler', compiler === 'sdcc' ? 'sccz80' : 'sdcc'], { encoding: 'utf8' });
        assert.equal(rejected.status, 1);
        assert.match(rejected.stderr, /Conflicting compiler metadata/);
        assert.ok(!fs.existsSync(rejectedFile));
        const sourceRow = metadata.rows.find(row => row.kind === 'C' && row.scope !== undefined);
        assert.ok(sourceRow, 'Compiler scope metadata retained');
        if (compiler === 'sccz80') assert.ok(sourceRow.function);
        else assert.equal(sourceRow.function, undefined);
        for (const name of ['_main', '_calculate', '_assembly_value', '_observed']) {
            assert.ok(metadata.symbols.some(symbol => symbol.name === name), name);
        }
        assert.ok(metadata.rows.some(row => row.file.endsWith('main.c')));
        assert.ok(metadata.rows.some(row => row.file.endsWith('calculate.c')));
        assert.ok(metadata.rows.some(row => row.file.endsWith('value.asm')));
        assert.ok(metadata.cdb.length);
        assert.equal(metadata.typed.globals.length, 8);
        assert.equal(metadata.typed.functions.length, 7);
        assert.deepEqual(metadata.frameAnalysisGaps, []);
        assert.ok(metadata.frames.length > metadata.typed.functions.length,
            'Direct-call assembly targets acquire frame records without CDB definitions');
        assert.ok(metadata.typed.functions.every(func => func.ranges.length && !func.rangeGaps.length),
            JSON.stringify(metadata.typed.functions));
        assert.equal(metadata.typed.functions.filter(func => func.name === 'adjust').length, 2);
        for (const func of metadata.typed.functions) {
            assert.ok(func.stackAnalysis.rows.some(row => row.pc === func.address));
            assert.equal(typeof func.stackAnalysis.complete, 'boolean');
            assert.equal(func.stackAnalysis.frameComplete, true, `${compiler} ${func.name}`);
            const frame = metadata.frames.find(frame => frame.entry === func.address);
            assert.ok(frame?.complete, `${compiler} frame ${func.name}`);
            assert.deepEqual(frame.rows, func.stackAnalysis.frameRows);
            assert.ok(frame.rows.every(row => Object.keys(row.savedRegisters).length === 5));
            assert.equal(func.stackAnalysis.contextualComplete, true,
                `${compiler} ${func.module}:${func.name}: ${JSON.stringify(func.stackAnalysis.gaps)}`);
            assert.deepEqual(func.stackAnalysis.gaps, []);
            assert.ok(func.stackAnalysis.states < 1000, `${func.name}: ${func.stackAnalysis.states}`);
            assert.ok(func.stackAnalysis.contextRows.every(row => !row.unavailable && row.returnLocations.length));
            assert.ok(func.stackAnalysis.runtimeGuards.disjointExecutableRanges.length);
            assert.ok(func.stackAnalysis.exits.every(exit => exit.spDelta === 2));
            if (!func.stackAnalysis.complete) {
                assert.ok(metadata.warnings.some(warning =>
                    warning.includes(`Root stack analysis incomplete for ${func.name} in ${func.module}:`) &&
                    warning.includes('Independent frame analysis is complete; runtime guards and per-PC availability still apply.')));
            }
        }
        if (compiler === 'sdcc') {
            assert.ok(metadata.typed.functions.every(func => func.stackAnalysis.complete));
            assert.equal(metadata.frames.length, 8);
            assert.ok(metadata.frames.every(frame => frame.complete));
        } else {
            assert.deepEqual(metadata.typed.functions.filter(func => !func.stackAnalysis.complete)
                .map(func => func.name).sort(), ['calculate']);
            assert.ok(metadata.typed.functions.every(func =>
                func.stackAnalysis.runtimeGuards.disjointAbsoluteAddresses.length));
            assert.equal(metadata.frames.length, 13);
            const incomplete = metadata.frames.filter(frame => !frame.complete);
            assert.equal(incomplete.length, 1);
            assert.match(incomplete[0].gaps[0], /Unresolved memory write/);
            assert.ok(metadata.warnings.some(warning => warning.includes(
                `Independent frame at 0x${incomplete[0].entry.toString(16)} incomplete`)));
        }
        assert.ok(metadata.warnings.some(warning => warning.includes('conditional on runtimeGuards')));
        assert.ok(metadata.typed.functions.every(func => func.file && func.line > 0));
        const image = fs.readFileSync(path.join(build, `MIXED-${compiler.toUpperCase()}.COM`));
        const elfSections = sections(fs.readFileSync(elfFile)).filter(section =>
            section.name.startsWith('.text') || section.name.startsWith('.data'));
        const restored = Buffer.alloc(image.length);
        let restoredBytes = 0;
        for (const section of elfSections) {
            section.data.copy(restored, section.address - metadata.origin);
            restoredBytes += section.data.length;
        }
        assert.equal(restoredBytes, image.length);
        assert.deepEqual(restored, image, 'ELF segmentation preserves every linked byte');
        const mainRow = metadata.rows.find(row => row.module === metadata.typed.functions.find(func =>
            func.name === 'main').module && row.line > 0);
        const output = runGdb(elfFile,
            ['ptype observed', 'ptype offset', 'ptype readings', 'ptype sample', 'ptype sample_address',
                'print sizeof(sample)', 'print &observed', `break main.c:${mainRow.line}`, 'break calculate',
                'break test/fixtures/mixed/value.asm:4', 'print offset', 'print readings',
                'print sample', 'print *sample_address',
                "print 'main.c'::hidden", "print 'calculate.c'::hidden", 'ptype wide_array',
                'print sizeof(wide_array)', 'ptype calculate', 'ptype return_signed',
                'ptype return_pointer', 'ptype return_void',
                "ptype 'main.c'::adjust", "ptype 'calculate.c'::adjust",
                'info address main', 'info address calculate']);
        assert.match(output.stdout, /type = unsigned int/);
        assert.match(output.stdout, /type = int/);
        assert.match(output.stdout, /type = unsigned int \[3\]/);
        assert.match(output.stdout, /signed char tag;|char tag;/);
        assert.match(output.stdout, /unsigned long payload;/);
        assert.match(output.stdout, /type = struct packet \{[^}]*\} \*/);
        assert.match(output.stdout, /\$1 = 5/);
        assert.ok(output.stdout.includes(`0x${metadata.typed.globals.find(global =>
            global.name === 'observed').address.toString(16)}`), output.stdout);
        assert.equal((output.stdout.match(/Breakpoint \d+ at/g) || []).length, 3, output.stdout);
        assert.match(output.stdout, /\$3 = -123/);
        assert.match(output.stdout, /\$4 = \{4, 5, 6\}/);
        assert.equal((output.stdout.match(/payload = 305419896/g) || []).length, 2, output.stdout);
        assert.equal((output.stdout.match(/tag = -7/g) || []).length, 2, output.stdout);
        assert.match(output.stdout, /\$7 = 17/);
        assert.match(output.stdout, /\$8 = 29/);
        assert.match(output.stdout, /type = unsigned char \[16\]/);
        assert.match(output.stdout, /\$9 = 16/);
        assert.match(output.stdout, /type = unsigned int \(unsigned int, \.\.\.\)/);
        assert.match(output.stdout, /type = int \(\)/);
        assert.match(output.stdout, /type = unsigned int \*\(\)/);
        assert.match(output.stdout, /type = void \(\)/);
        assert.match(output.stdout, /type = unsigned long \(unsigned int, \.\.\.\)/);
        assert.match(output.stdout, /type = void \(\)\r?\ntype = int \(int, \.\.\.\)\r?\ntype = unsigned long \(unsigned int, \.\.\.\)/);
        assert.match(output.stdout, /Symbol "main" is a function at address/);
        assert.match(output.stdout, /Symbol "calculate" is a function at address/);

        for (const candidate of [
            metadata.frames.find(frame => frame.entry === metadata.typed.functions.find(func =>
                func.name === 'calculate').address),
            metadata.frames.find(frame => metadata.symbols.some(symbol =>
                symbol.name === '_assembly_value' && symbol.address === frame.entry)),
        ]) {
            const scenario = makeEntryScenario(metadata,
                path.join(build, `MIXED-${compiler.toUpperCase()}.COM`), candidate);
            const remote = await runGenericGdb(elfFile, scenario,
                ['bt 4', 'frame 1', 'info registers bc sp pc', 'frame 0', 'info locals']);
            assert.match(remote.output, /Registered guarded generic Z80 unwinder/);
            if (scenario.frameName) assert.match(remote.output, new RegExp(`#0\\s+.*${scenario.frameName}\\b`),
                remote.output);
            else assert.match(remote.output, new RegExp(`#0\\s+.*(?:assembly_value|0x0*${candidate.entry.toString(16)})`),
                remote.output);
            assert.match(remote.output, /#1\s+.*main/, remote.output);
            assert.match(remote.output, new RegExp(`pc\\s+0x0*${scenario.expectedReturnPc.toString(16)}\\b`),
                remote.output);
            assert.match(remote.output, new RegExp(`sp\\s+0x0*${scenario.expectedCallerSp.toString(16)}\\b`),
                remote.output);
            assert.match(remote.output, /bc\s+0x1234\b/, remote.output);
            assert.ok(remote.memoryReadBytes > 0,
                `Expected code and stack verification reads for ${compiler}:${candidate.entry.toString(16)}`);
            assert.ok(remote.memoryReadBytes < 2048,
                `${compiler}:${candidate.entry.toString(16)} read ${remote.memoryReadBytes} bytes over RSP`);
            assert.doesNotMatch(remote.output, /Python Exception|ambiguous frame rules|Cannot access/,
                remote.output);
            if (compiler === 'sdcc' && scenario.frameName === 'calculate') {
                assert.match(remote.output, /result = <optimized out>/, remote.output);
                assert.match(remote.output, /index = <optimized out>/, remote.output);
            }
        }
    });
}

function buildLocationFixture(compiler, keepFramePointer = true, source = 'locals') {
    const root = path.resolve(__dirname, '..');
    const build = path.join(root, 'build', 'generic-elf');
    const name = `${source}-${compiler}${keepFramePointer ? '' : '-no-frame'}`;
    fs.mkdirSync(build, { recursive: true });
    const result = spawnSync('docker', ['run', '--rm', '--mount',
        `type=bind,source=${root},target=/work`, '-w', '/work', process.env.Z88DK_DOCKER_IMAGE,
        'zcc', '+cpm', ...(compiler === 'sdcc' ?
            ['-clib=sdcc_ix', '-SO0', ...(keepFramePointer ? ['-Cs--fno-omit-frame-pointer'] : [])] : ['-O0']),
        `-compiler=${compiler}`, '-debug', '-create-app', '-m',
        `test/fixtures/locations/${source}.c`, '-o', `build/generic-elf/${name}.bin`],
    { encoding: 'utf8', timeout: 120000 });
    assert.equal(result.status, 0, result.stdout + result.stderr);
    const imagePath = path.join(build, `${name.toUpperCase()}.COM`);
    const elfPath = path.join(build, `${name}.debug.elf`);
    const metadata = convert(imagePath, path.join(build, `${name}.map`), elfPath,
        [{ from: `${source}.c`, to: `test/fixtures/locations/${source}.c` },
            ...(source.includes('-') ? [{ from: `${source.replace(/-/g, '_')}.c`,
                to: `test/fixtures/locations/${source}.c` }] : [])], 0x100,
        [], [], 'auto', root);
    return { metadata, imagePath, elfPath };
}

for (const compiler of ['sdcc', 'sccz80']) {
test(`container ${compiler} stack arguments and locals are readable in active and caller frames`,
    { skip: !process.env.Z88DK_DOCKER_IMAGE }, async () => {
        const { metadata, imagePath, elfPath } = buildLocationFixture(compiler);
        const leaf = metadata.typed.functions.find(func => func.name === 'leaf');
        const parent = metadata.typed.functions.find(func => func.name === 'parent');
        for (const func of [leaf, parent]) {
            assert.equal(func.variables.length, 2);
            assert.equal(func.variables.filter(variable => variable.parameter).length, 1);
            assert.ok(func.variables.every(variable => variable.locations.length && !variable.locationGaps.length),
                JSON.stringify(func.variables));
        }
        assert.ok(sections(fs.readFileSync(elfPath)).some(section => section.name === '.debug_loc'));
        const leafFrame = metadata.frames.find(frame => frame.entry === leaf.address);
        const edge = leafFrame.parentEdges.find(edge => edge.parentEntry === parent.address);
        assert.ok(edge);
        const local = leaf.variables.find(variable => variable.name === 'temporary');
        const stop = metadata.rows.find(row => row.module === leaf.module && row.line === 6 &&
            local.locations.some(location => row.address >= location.start && row.address < location.end));
        assert.ok(stop, 'Expected readable local at the return statement');
        const row = leafFrame.rows.find(row => row.pc === stop.address);
        const parentEntrySp = 0xf000;
        const parentFrame = metadata.frames.find(frame => frame.entry === parent.address);
        const main = metadata.typed.functions.find(func => func.name === 'main');
        const mainEdge = parentFrame.parentEdges.find(edge => edge.parentEntry === main.address);
        assert.ok(mainEdge);
        const mainEntrySp = parentEntrySp + mainEdge.parentEntrySpOffsetAtChildEntry;
        const leafEntrySp = parentEntrySp - edge.parentEntrySpOffsetAtChildEntry;
        const sp = leafEntrySp - row.entrySpOffset;
        // These are compiler ABI slots, independent of emitted location-list offsets.
        const words = new Map([
            [mainEntrySp, 0], [parentEntrySp, mainEdge.continuation], [parentEntrySp + 2, 11],
            [parentEntrySp - 4, 18], [leafEntrySp, edge.continuation],
            [leafEntrySp + 2, 18], [leafEntrySp - 4, 21],
            [parentEntrySp - 2, 0x1234], [leafEntrySp - 2, 0x1234],
        ]);
        for (const pointer of row.stackPointers.filter(pointer => pointer.address !== undefined)) {
            words.set(pointer.address, leafEntrySp + pointer.entryOffset);
        }
        const scenario = { imagePath, origin: metadata.origin, pc: row.pc, sp,
            registers: { bc: 0x1234, de: 0x2468, hl: 21, ix: leafEntrySp - 2, iy: 0xabcd },
            words: [...words] };
        const remote = await runGenericGdb(elfPath, scenario, ['bt 3', 'info args', 'info locals',
            'print argument', 'print temporary', 'frame 1', 'info args', 'info locals',
            'print argument', 'print local', 'frame 0', 'print temporary']);
        assert.match(remote.output, /#0\s+.*leaf \(argument=18\)/, remote.output);
        assert.match(remote.output, /#1\s+.*parent \(argument=11\)/, remote.output);
        assert.match(remote.output, /temporary = 21/, remote.output);
        assert.match(remote.output, /local = 18/, remote.output);
        assert.match(remote.output, /\$1 = 18/, remote.output);
        assert.match(remote.output, /\$2 = 21/, remote.output);
        assert.match(remote.output, /\$3 = 11/, remote.output);
        assert.match(remote.output, /\$4 = 18/, remote.output);
        assert.match(remote.output, /\$5 = 21/, remote.output);
        assert.doesNotMatch(remote.output, /Python Exception|Cannot access|Dwarf Error|optimized out/, remote.output);

        const entry = await runGenericGdb(elfPath, { ...scenario, pc: leaf.address, sp: leafEntrySp },
            ['info args', 'info locals']);
        assert.match(entry.output, /argument = <optimized out>/, entry.output);
        assert.match(entry.output, /temporary = <optimized out>/, entry.output);

        const released = leafFrame.rows.find(row => row.pc > stop.address &&
            row.entrySpOffset < 4);
        assert.ok(released);
        const exit = await runGenericGdb(elfPath, { ...scenario, pc: released.pc,
            sp: leafEntrySp - released.entrySpOffset }, ['info locals']);
        assert.match(exit.output, /temporary = <optimized out>/, exit.output);
    });
}

test('container SDCC without a proven IX base reports stack variables unavailable',
    { skip: !process.env.Z88DK_DOCKER_IMAGE }, async () => {
        const { metadata, imagePath, elfPath } = buildLocationFixture('sdcc', false);
        const leaf = metadata.typed.functions.find(func => func.name === 'leaf');
        assert.ok(leaf.variables.every(variable => !variable.locations.length && variable.locationGaps.length));
        const frame = metadata.frames.find(frame => frame.entry === leaf.address);
        const row = frame.rows.find(row => row.entrySpOffset === 2);
        assert.ok(row);
        const edge = frame.parentEdges[0];
        const parentFrame = metadata.frames.find(frame => frame.entry === edge.parentEntry);
        const mainEdge = parentFrame.parentEdges[0];
        const leafEntrySp = 0xf002;
        const parentEntrySp = leafEntrySp + edge.parentEntrySpOffsetAtChildEntry;
        const mainEntrySp = parentEntrySp + mainEdge.parentEntrySpOffsetAtChildEntry;
        const result = await runGenericGdb(elfPath, { imagePath, origin: metadata.origin,
            pc: row.pc, sp: 0xf000, words: [[0xf000, 21], [leafEntrySp, edge.continuation],
                [leafEntrySp + 2, 18], [parentEntrySp, mainEdge.continuation],
                [parentEntrySp + 2, 11], [mainEntrySp, 0]] },
        ['info args', 'info locals']);
        assert.match(result.output, /argument = <optimized out>/, result.output);
        assert.match(result.output, /temporary = <optimized out>/, result.output);
        assert.doesNotMatch(result.output, /Python Exception|Dwarf Error/, result.output);
    });

for (const compiler of ['sdcc', 'sccz80']) {
test(`container ${compiler} loop breakpoint highlights the statement, not its shared closing brace`,
    { skip: !process.env.Z88DK_DOCKER_IMAGE || !process.env.Z80_GDB }, () => {
        const { metadata, elfPath } = buildLocationFixture(compiler, true, 'line-loop');
        const rowsBefore = JSON.stringify(metadata.rows);
        const frameLocations = JSON.stringify(metadata.typed.functions.map(func => func.variables));
        const rowsCount = metadata.rows.length;
        const root = path.resolve(__dirname, '..');
        const image = fs.readFileSync(path.join(path.dirname(elfPath), `LINE-LOOP-${compiler.toUpperCase()}.COM`));
        makeElf(image, metadata, root);
        assert.equal(JSON.stringify(metadata.rows), rowsBefore);
        assert.equal(JSON.stringify(metadata.typed.functions.map(func => func.variables)), frameLocations);
        const statement = metadata.rows.find(row => row.kind === 'C' && row.line === 13);
        assert.ok(statement);
        const output = runGdb(elfPath, ['break line-loop.c:13', 'info breakpoints',
            `info line *0x${statement.address.toString(16)}`]).stdout;
        assert.match(output, /Breakpoint 1 .*line 13/);
        assert.match(output, /Line 13 of/);
        assert.equal(metadata.rows.length, rowsCount, 'Keep all original breakpoint rows');
    });
}

for (const compiler of ['sdcc', 'sccz80']) {
test(`container ${compiler} nested blocks emit lexical scopes that resolve shadowed locals`,
    { skip: !process.env.Z88DK_DOCKER_IMAGE }, async () => {
        const { metadata, imagePath, elfPath } = buildLocationFixture(compiler, true, 'scopes');
        const shadow = metadata.typed.functions.find(func => func.name === 'shadow');
        const main = metadata.typed.functions.find(func => func.name === 'main');
        assert.equal(shadow.lexicalBlocks.length, 2);
        assert.ok(shadow.lexicalBlocks.every(block => block.ranges.length &&
            !shadow.lexicalBlocks.includes(block.parent)));
        assert.ok(shadow.variables.every(variable => variable.locations.length && !variable.locationGaps.length),
            JSON.stringify(shadow.variables.map(({ name, locationGaps }) => ({ name, locationGaps }))));
        const totals = shadow.variables.filter(variable => variable.name === 'total');
        const outer = totals.find(variable => !variable.lexicalBlock);
        const inner = totals.find(variable => variable.lexicalBlock);
        const byName = name => shadow.variables.find(variable => variable.name === name);
        const at = (variable, pc) => variable.locations.find(location => pc >= location.start && pc < location.end);
        const frame = metadata.frames.find(frame => frame.entry === shadow.address);
        const edge = frame.parentEdges.find(edge => edge.parentEntry === main.address);
        assert.ok(edge);
        const entrySp = 0xf000;
        const run = async (pc, values, commands) => {
            const row = frame.rows.find(row => row.pc === pc);
            const sp = entrySp - row.entrySpOffset;
            const words = new Map([[entrySp, edge.continuation], [entrySp + 2, 5],
                [entrySp + edge.parentEntrySpOffsetAtChildEntry, 0]]);
            for (const [variable, value] of values) words.set(sp + at(variable, pc).spOffset, value);
            for (const pointer of row.stackPointers.filter(pointer => pointer.address !== undefined)) {
                words.set(pointer.address, entrySp + pointer.entryOffset);
            }
            const result = await runGenericGdb(elfPath, { imagePath, origin: metadata.origin, pc, sp,
                registers: { bc: 0x1234, de: 0x2468, hl: 0, ix: entrySp - 2, iy: 0xabcd },
                words: [...words] }, commands);
            assert.doesNotMatch(result.output, /Python Exception|Dwarf Error|Cannot access/, result.output);
            return result.output;
        };

        const innerPc = frame.rows.find(row => at(inner, row.pc) && at(byName('extra'), row.pc) &&
            at(outer, row.pc)).pc;
        const nested = await run(innerPc, [[outer, 6], [inner, 25], [byName('extra'), 26]],
            ['print total', 'print extra', 'print value', 'info locals']);
        assert.match(nested, /\$1 = 25/, nested);
        assert.match(nested, /\$2 = 26/, nested);
        assert.match(nested, /\$3 = 5/, nested);
        for (const local of [/total = 25/, /extra = 26/, /total = 6/]) assert.match(nested, local, nested);

        const siblingPc = frame.rows.find(row => at(byName('other'), row.pc) && at(outer, row.pc)).pc;
        const sibling = await run(siblingPc, [[outer, 6], [byName('other'), 8]],
            ['print total', 'print other', 'print extra']);
        assert.match(sibling, /\$1 = 6/, sibling);
        assert.match(sibling, /\$2 = 8/, sibling);
        assert.match(sibling, /No symbol "extra" in current context/, sibling);

        const returnRow = metadata.rows.find(row => row.module === shadow.module && row.kind === 'C' &&
            row.line === 15 && at(outer, row.address));
        assert.ok(returnRow);
        const after = await run(returnRow.address, [[outer, 6]], ['print total', 'print other']);
        assert.match(after, /\$1 = 6/, after);
        assert.match(after, /No symbol "other" in current context/, after);
    });
}
