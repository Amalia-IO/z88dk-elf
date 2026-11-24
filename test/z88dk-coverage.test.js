'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { test } = require('node:test');
const { convert } = require('../lib/z88dk-elf');
const { runGenericGdb } = require('./z80-generic-rsp-test-support');

function build(compiler) {
    const root = path.resolve(__dirname, '..');
    const name = `coverage-${compiler}`;
    fs.mkdirSync(path.join(root, 'build', 'generic-elf'), { recursive: true });
    const result = spawnSync('docker', ['run', '--rm', '--mount',
        `type=bind,source=${root},target=/work`, '-w', '/work', process.env.Z88DK_DOCKER_IMAGE,
        'zcc', '+cpm', ...(compiler === 'sdcc' ?
            ['-clib=sdcc_ix', '-SO0', '-Cs--fno-omit-frame-pointer'] : ['-O0']),
        `-compiler=${compiler}`, '-debug', '-create-app', '-m',
        'test/fixtures/locations/coverage.c', 'test/fixtures/locations/coverage.asm',
        '-o', `build/generic-elf/${name}.bin`], { encoding: 'utf8', timeout: 120000 });
    assert.equal(result.status, 0, result.stdout + result.stderr);
    const imagePath = path.join(root, 'build', 'generic-elf', `${name.toUpperCase()}.COM`);
    const elfPath = path.join(root, 'build', 'generic-elf', `${name}.debug.elf`);
    const metadata = convert(imagePath, path.join(root, 'build', 'generic-elf', `${name}.map`),
        elfPath, [], 0x100, [], ['code_user']);
    return { metadata, imagePath, elfPath };
}

for (const compiler of ['sdcc', 'sccz80']) {
    test(`container ${compiler} recursion, function pointers and assembly recover independent frames`,
        { skip: !process.env.Z88DK_DOCKER_IMAGE }, async () => {
            const { metadata, imagePath, elfPath } = build(compiler);
            const func = name => metadata.typed.functions.find(func => func.name === name);
            const frame = name => metadata.frames.find(frame => frame.entry === func(name).address);
            const source = (name, line) => metadata.rows.find(row => row.kind === 'C' &&
                row.module === func(name).module && row.line === line &&
                func(name).ranges.some(range => row.address >= range.start && row.address < range.end)).address;
            for (const name of ['recurse', 'leaf', 'invoke', 'main']) {
                assert.ok(frame(name).complete, frame(name).gaps.join('\n'));
            }
            if (compiler === 'sccz80') {
                for (const name of ['recurse', 'leaf', 'invoke']) {
                    assert.equal(func(name).stackAnalysis.complete, false, name);
                    assert.ok(metadata.warnings.some(warning =>
                        warning.includes(`Root stack analysis incomplete for ${name} in ${func(name).module}:`) &&
                        warning.includes('Independent frame analysis is complete; runtime guards and per-PC availability still apply.')), name);
                }
                assert.ok(metadata.frames.some(candidate => !candidate.complete &&
                    candidate.gaps.some(gap => gap.includes('Unresolved return or indirect continuation'))));
            }
            const run = async (pc, entrySp, words, commands, selectedFrame) => {
                const row = selectedFrame.rows.find(row => row.pc === pc);
                assert.ok(row && !row.unavailable);
                for (const pointer of row.stackPointers.filter(pointer => pointer.address !== undefined)) {
                    words.set(pointer.address, entrySp + pointer.entryOffset);
                }
                const result = await runGenericGdb(elfPath, { imagePath, origin: 0x100, pc,
                    sp: entrySp - row.entrySpOffset, registers: { ix: entrySp - 2, bc: 0xbeef },
                    words: [...words] }, ['set backtrace past-main off', ...commands]);
                assert.doesNotMatch(result.output, /Python Exception|Cannot access|Dwarf Error|optimized out/,
                    result.output);
                return result.output;
            };
            const recursive = frame('recurse');
            const selfEdge = recursive.parentEdges.find(edge => edge.parentEntry === recursive.entry);
            const mainEdge = recursive.parentEdges.find(edge => edge.parentEntry === func('main').address);
            assert.ok(selfEdge && mainEdge);
            const words = new Map();
            let entrySp = 0xf000;
            for (let depth = 0; depth <= 3; ++depth) {
                const parentSp = entrySp + (depth === 3 ?
                    mainEdge.parentEntrySpOffsetAtChildEntry : selfEdge.parentEntrySpOffsetAtChildEntry);
                words.set(entrySp, depth === 3 ? mainEdge.continuation : selfEdge.continuation);
                words.set(entrySp + 2, depth);
                words.set(entrySp - 2, parentSp - 2);
                words.set(entrySp - 4, depth + 10);
                if (depth === 3) words.set(parentSp, 0);
                entrySp = parentSp;
            }
            const commands = ['bt 5'];
            for (let depth = 0; depth <= 3; ++depth) {
                commands.push(`frame ${depth}`, 'print depth', 'print local');
            }
            const recursion = await run(source('recurse', 9), 0xf000, words, commands, recursive);
            for (let depth = 0; depth <= 3; ++depth) {
                assert.match(recursion, new RegExp(`#${depth}\\s+.*recurse \\(depth=${depth}\\)`), recursion);
                assert.match(recursion, new RegExp(`\\$${2 * depth + 1} = ${depth}\\b`), recursion);
                assert.match(recursion, new RegExp(`\\$${2 * depth + 2} = ${depth + 10}\\b`), recursion);
            }
            assert.match(recursion, /#4\s+.*main/, recursion);

            const leaf = frame('leaf');
            const indirectEdge = leaf.parentEdges.find(edge => edge.parentEntry === func('invoke').address);
            const invokeEdge = frame('invoke').parentEdges.find(edge => edge.parentEntry === func('main').address);
            assert.ok(indirectEdge && invokeEdge);
            const leafSp = 0xf000;
            const invokeSp = leafSp + indirectEdge.parentEntrySpOffsetAtChildEntry;
            const mainSp = invokeSp + invokeEdge.parentEntrySpOffsetAtChildEntry;
            const indirectWords = new Map([[leafSp, indirectEdge.continuation], [leafSp + 2, 7],
                [leafSp - 4, 10], [leafSp - 2, invokeSp - 2],
                [invokeSp, invokeEdge.continuation], [invokeSp - 2, mainSp - 2],
                [mainSp, 0],
                [invokeSp + (compiler === 'sdcc' ? 2 : 4), leaf.entry],
                [invokeSp + (compiler === 'sdcc' ? 4 : 2), 7]]);
            const indirect = await run(source('leaf', 16), leafSp, indirectWords,
                ['bt 3', 'print value', 'print local', 'frame 1', 'print value', 'print callback',
                    'whatis callback'], leaf);
            assert.match(indirect, /#0\s+.*leaf \(value=7\)/, indirect);
            assert.match(indirect, /#1\s+.*invoke/, indirect);
            assert.match(indirect, /\$1 = 7[\s\S]*\$2 = 10[\s\S]*\$3 = 7/, indirect);
            assert.match(indirect, /type = unsigned int \(\*\)\(\)/, indirect);
            assert.ok(metadata.warnings.some(warning => warning.startsWith(
                'Indirect-call continuation rules are conditional')));
            const corruptWords = new Map(indirectWords);
            const proofAddress = func('recurse').address;
            corruptWords.set(proofAddress, fs.readFileSync(imagePath).readUInt16LE(proofAddress - 0x100) ^ 1);
            const leafRow = leaf.rows.find(row => row.pc === source('leaf', 16));
            const rejected = await runGenericGdb(elfPath, { imagePath, origin: 0x100,
                pc: leafRow.pc, sp: leafSp - leafRow.entrySpOffset,
                registers: { ix: leafSp - 2 }, words: [...corruptWords] }, ['bt 3']);
            assert.match(rejected.output, /target code.*does not match the analysed ELF/, rejected.output);

            const assemblyAddress = metadata.symbols.find(symbol => symbol.name === '_assembly_value').address;
            const assembly = metadata.frames.find(frame => frame.entry === assemblyAddress);
            assert.ok(assembly.complete);
            const edge = assembly.parentEdges.find(edge => edge.parentEntry === func('main').address);
            assert.ok(edge);
            const assemblyWords = new Map([[0xf000, edge.continuation], [0xeffe, 0xbeef],
                [0xf000 + edge.parentEntrySpOffsetAtChildEntry, 0]]);
            const mixed = await run(assemblyAddress + 4, 0xf000, assemblyWords,
                ['bt 2', 'frame 1', 'info registers bc'], assembly);
            assert.match(mixed, /#0\s+.*assembly_value/, mixed);
            assert.match(mixed, /#1\s+.*main/, mixed);
            assert.match(mixed, /bc\s+0xbeef/, mixed);
            assert.ok(fs.existsSync(`${elfPath}.metadata.json`));
        });
}
