'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { createHash } = require('node:crypto');
const { version } = require('../package.json');
const { parseCdb } = require('./z88dk-cdb');
const { selectCompilers } = require('./compilers');
const { functionRanges } = require('./z80-function-ranges');
const { analyseStack, analyseFrames, proveCallSummaries } = require('./z80-stack-analysis');
const { analyseLocations } = require('./z88dk-locations');
const { presentationRows } = require('./z88dk-line-order');

function check(condition, message) {
    if (!condition) throw new Error(message);
}

function uint(value, size) {
    const bytes = Buffer.alloc(size);
    bytes.writeUIntLE(value, 0, size);
    return bytes;
}

function leb(value, signed = false) {
    const bytes = [];
    for (;;) {
        let byte = value & 127;
        value = Math.floor(value / 128);
        const done = signed ? (value === 0 && !(byte & 64)) ||
            (value === -1 && (byte & 64)) : value === 0;
        if (!done) byte |= 128;
        bytes.push(byte);
        if (done) return Buffer.from(bytes);
    }
}

const str = value => Buffer.from(`${value}\0`, 'utf8');
const concat = parts => Buffer.concat(parts);
const decode = text => decodeURIComponent(text.replace(/%/g, '%25')
    .replace(/_([0-9a-f]{2})/gi, '%$1'));
const canonical = file => file.replace(/\\/g, '/');
const isCode = (section, extra = []) => /^(code(?:_|$)|\.text$)/i.test(section) || extra.includes(section);

function mapPath(file, mappings) {
    const normalized = canonical(file);
    const matches = mappings.filter(({ from }) => normalized === canonical(from) ||
        normalized.startsWith(`${canonical(from).replace(/\/$/, '')}/`))
        .sort((a, b) => b.from.length - a.from.length);
    if (!matches.length) return normalized;
    const { from, to } = matches[0];
    return canonical(to).replace(/\/$/, '') + normalized.slice(canonical(from).replace(/\/$/, '').length);
}

function readMap(text, imageSize, mappings = [], imageOrigin, sourceMappings = [], codeSections = [],
    compiler = 'auto') {
    check(Number.isInteger(imageSize) && imageSize > 0, 'Expected a nonempty contiguous image');
    check(imageOrigin === undefined || Number.isInteger(imageOrigin), 'Image origin must be an integer');
    const records = [];
    for (const [index, line] of text.split(/\r?\n/).entries()) {
        if (!line.trim()) continue;
        const match = /^(\S+)\s*=\s*\$([0-9a-f]+)\s*;\s*(.*)$/i.exec(line);
        check(match, `Invalid MAP record at line ${index + 1}`);
        const fields = match[3].split(',').map(field => field.trim());
        check(['addr', 'const'].includes(fields[0]) &&
            ['public', 'local'].includes(fields[1]), `Invalid MAP attributes at line ${index + 1}`);
        const rawValue = BigInt(`0x${match[2]}`);
        check(fields[0] === 'const' || rawValue <= 65535n,
            `Address symbol ${match[1]} is outside the Z80 address space`);
        records.push({ name: match[1], address: Number(BigInt.asUintN(32, rawValue)),
            valueHex: match[2], wideConstant: rawValue > 0xffffffffn,
            kind: fields[0], visibility: fields[1], module: fields[3], section: fields[4] || '' });
    }
    const boundary = name => {
        const matches = records.filter(record => record.name === name);
        check(matches.length === 1, `Missing or ambiguous MAP boundary ${name}`);
        return matches[0].address;
    };
    const origin = imageOrigin === undefined ? boundary('__head') : imageOrigin;
    const end = imageOrigin === undefined ? boundary('__tail') : imageOrigin + imageSize;
    check(imageSize > 0 && origin >= 0 && end <= 65536 && end - origin === imageSize,
        'MAP extent does not match the supplied contiguous image; supply --origin for a sectioned linker output');
    const cdbRecords = records.filter(record => record.name.startsWith('__CDBINFO__'))
        .map(record => ({ value: decode(record.name.slice(11)), address: record.address,
            module: record.module, section: record.section, kind: record.kind }));
    const cdb = cdbRecords.map(record => record.value);
    const sourceModules = [...new Set(records.filter(record => record.name.startsWith('__C_LINE_'))
        .map(record => record.module))];
    const compilers = selectCompilers([...cdbRecords,
        ...sourceModules.map(module => ({ module, value: '' }))], compiler);
    const symbols = records.filter(record => !/^__(?:CDBINFO__|C_LINE_|ASM_LINE_)/.test(record.name));
    for (const record of symbols.filter(record => record.kind === 'addr')) {
        check(record.address >= 0 && record.address <= 65535,
            `Address symbol ${record.name} is outside the Z80 address space`);
        check(!isCode(record.section, codeSections) || (record.address >= origin && record.address <= end),
            `Code symbol ${record.name} is outside the supplied image`);
    }
    const rows = [];
    const ignoredMarkers = [];
    for (const record of records) {
        const match = /^__(C|ASM)_LINE_(\d+)_(.+)$/.exec(record.name);
        if (!match) continue;
        const identity = decode(match[3]);
        const adapter = compilers.get(record.module);
        const sourceInfo = match[1] === 'C' && adapter ? adapter.sourceIdentity(identity) :
            { file: identity.split('::')[0] };
        const source = sourceInfo.file;
        const line = Number(match[2]);
        check(source && Number.isSafeInteger(line), `Invalid source marker ${record.name}`);
        // Assembly markers on generated .c input refer to compiler assembly, not C lines.
        if (!line || !isCode(record.section, codeSections) || record.address < origin || record.address >= end ||
            (match[1] === 'ASM' && /\.c$/i.test(source))) {
            ignoredMarkers.push(record.name);
            continue;
        }
        const moduleSource = sourceMappings.find(mapping => mapping.module === record.module &&
            canonical(mapping.file).split('/').at(-1) === canonical(source).split('/').at(-1));
        const file = mapPath(moduleSource ? moduleSource.file : source, mappings);
        rows.push({ address: record.address, file, line, kind: match[1],
            module: record.module, section: record.section,
            function: sourceInfo.function, scope: sourceInfo.scope, block: sourceInfo.block });
    }
    for (const file of new Set(rows.filter(row => row.kind === 'C').map(row => row.file))) {
        if (file.includes('/')) continue;
        check(new Set(rows.filter(row => row.kind === 'C' && row.file === file)
            .map(row => row.module)).size === 1,
        `Ambiguous C source ${file} across modules; use --source MODULE=PATH to distinguish them`);
    }
    const uniqueRows = rows.filter((row, index) => rows.findIndex(other =>
        other.address === row.address && other.file === row.file && other.line === row.line &&
        other.module === row.module && other.kind === row.kind && other.section === row.section &&
        other.function === row.function && other.scope === row.scope && other.block === row.block) === index)
        .sort((a, b) => a.address - b.address || a.file.localeCompare(b.file) || a.line - b.line);
    const typed = parseCdb(cdbRecords, symbols, compiler, sourceModules);
    const warnings = ['This entry point emits linked symbols, source lines, typed static data, function return types, proven stack locations and instruction-derived frame analysis; not DWARF CFI.',
        ...typed.warnings];
    if (typed.functions.length) warnings.push(
        'Stack parameters are emitted where described by CDB; signatures remain unspecified/variadic because complete parameter lists are not proven.');
    if (!uniqueRows.some(row => row.kind === 'C')) {
        warnings.push('No relocated C source markers: C source stepping is unavailable in this MAP.');
    }
    if (ignoredMarkers.length) warnings.push(`${ignoredMarkers.length} non-executable or generated-source markers excluded.`);
    if (symbols.some(symbol => symbol.wideConstant)) {
        warnings.push('MAP constants wider than ELF32 use their low 32 bits; original values are retained as valueHex.');
    }
    return { schemaVersion: 1, producer: { name: 'z88dk-elf', version },
        origin, end, symbols, rows: uniqueRows, cdb, cdbRecords, typed, codeSections, warnings };
}

function debugSections(metadata, sourceRoot) {
    metadata.sourceDependencies = [];
    if (!metadata.rows.length && !metadata.typed.globals.length && !metadata.typed.functions.length) return [];
    const abbrev = Buffer.from([
        1, 0x11, 1,
        0x03, 0x08, 0x25, 0x08, 0x10, 0x17, 0x55, 0x17, 0x13, 0x05, 0, 0,
        2, 0x24, 0, 0x03, 0x08, 0x0b, 0x0b, 0x3e, 0x0b, 0, 0,
        3, 0x0f, 0, 0x0b, 0x0b, 0x49, 0x13, 0, 0,
        4, 0x01, 1, 0x49, 0x13, 0, 0,
        5, 0x21, 0, 0x37, 0x0f, 0, 0,
        6, 0x13, 1, 0x03, 0x08, 0x0b, 0x0f, 0, 0,
        7, 0x0d, 0, 0x03, 0x08, 0x49, 0x13, 0x38, 0x0f, 0, 0,
        8, 0x34, 0, 0x03, 0x08, 0x49, 0x13, 0x02, 0x18, 0x3f, 0x0c, 0, 0,
        9, 0x3b, 0, 0x03, 0x08, 0, 0,
        10, 0x13, 0, 0x03, 0x08, 0x3c, 0x19, 0, 0,
        11, 0x2e, 1, 0x03, 0x08, 0x49, 0x13,
        0x11, 0x01, 0x55, 0x17, 0x3f, 0x0c, 0x3a, 0x0f, 0x3b, 0x0f, 0, 0,
        12, 0x18, 0, 0, 0,
        13, 0x05, 0, 0x03, 0x08, 0x49, 0x13, 0x02, 0x17, 0, 0,
        14, 0x34, 0, 0x03, 0x08, 0x49, 0x13, 0x02, 0x17, 0, 0,
        15, 0x0b, 1, 0x55, 0x17, 0, 0,
        16, 0x15, 1, 0x49, 0x13, 0, 0,
        0,
    ]);
    const units = [];
    const lines = [];
    const ranges = [];
    const locations = [];
    let lineOffset = 0;
    let rangeOffset = 0;
    let locationOffset = 0;
    const dependencies = new Map();
    const modules = new Set([...metadata.rows.map(row => row.module),
        ...metadata.typed.globals.map(global => global.module),
        ...metadata.typed.functions.map(func => func.module)]);
    for (const module of modules) {
        const result = debugUnit(metadata, module, lineOffset, rangeOffset, locationOffset,
            sourceRoot, dependencies);
        units.push(result.info);
        lines.push(result.line);
        ranges.push(result.ranges);
        locations.push(result.locations);
        lineOffset += result.line.length;
        rangeOffset += result.ranges.length;
        locationOffset += result.locations.length;
    }
    metadata.sourceDependencies = [...dependencies].map(([file, sha256]) => ({ file, sha256 }));
    return [
        { name: '.debug_abbrev', type: 1, data: abbrev },
        { name: '.debug_info', type: 1, data: concat(units) },
        { name: '.debug_line', type: 1, data: concat(lines) },
        { name: '.debug_ranges', type: 1, data: concat(ranges) },
        { name: '.debug_loc', type: 1, data: concat(locations) },
    ];
}

function debugUnit(metadata, module, lineOffset, rangeOffset, locationOffset, sourceRoot, dependencies) {
    const rows = presentationRows(metadata.rows.filter(row => row.module === module),
        sourceRoot, metadata.warnings, dependencies);
    const globals = metadata.typed.globals.filter(global => global.module === module);
    const functions = metadata.typed.functions.filter(func => func.module === module);
    const locations = [];
    let locationCursor = locationOffset;
    const variableOffsets = new Map();
    for (const func of functions) {
        for (const variable of func.variables || []) {
            variableOffsets.set(variable, locationCursor);
            const parts = [uint(0xffff, 2), uint(metadata.origin, 2)];
            for (const location of variable.locations) {
                const expression = concat([uint(0x74, 1), leb(location.spOffset, true)]);
                parts.push(uint(location.start - metadata.origin, 2),
                    uint(location.end - metadata.origin, 2), uint(expression.length, 2), expression);
            }
            parts.push(uint(0, 2), uint(0, 2));
            const list = concat(parts);
            locations.push(list);
            locationCursor += list.length;
        }
    }
    const files = [...new Set(rows.map(row => row.file))];
    const header = concat([
        Buffer.from([1, 1, 1, 251, 14, 13]),
        Buffer.from([0, 1, 1, 1, 1, 0, 0, 0, 1, 0, 0, 1]),
        uint(0, 1),
        ...files.flatMap(file => [str(file), leb(0), leb(0), leb(0)]),
        uint(0, 1),
    ]);
    const program = [];
    const ranges = [uint(0xffff, 2), uint(metadata.origin, 2)];
    // Separate address runs prevent source rows from leaking into unmarked sections.
    const groups = new Map();
    for (const row of rows) {
        const group = groups.get(row.address) || [];
        group.push(row);
        groups.set(row.address, group);
    }
    const addresses = [...groups.keys()];
    for (const address of addresses) {
        program.push(Buffer.from([0, 3, 2]), uint(address, 2));
        let line = 1;
        for (const row of groups.get(address)) {
            program.push(uint(4, 1), leb(files.indexOf(row.file) + 1),
                uint(3, 1), leb(row.line - line, true), uint(1, 1));
            line = row.line;
        }
        const section = groups.get(address)[0].section;
        const tails = metadata.symbols.filter(symbol => symbol.name === `__${section}_tail`);
        check(tails.length === 1, `Missing or ambiguous section boundary for source rows in ${section}`);
        const nextRow = metadata.rows.find(row => row.address > address)?.address ?? metadata.end;
        const nextModule = metadata.symbols.filter(symbol => symbol.kind === 'addr' &&
            isCode(symbol.section, metadata.codeSections) && symbol.module !== module && symbol.address > address)
            .reduce((next, symbol) => Math.min(next, symbol.address), metadata.end);
        const end = Math.min(nextRow, nextModule, tails[0].address, metadata.end);
        check(end > address, `Invalid source range at 0x${address.toString(16)}`);
        check(end - metadata.origin <= 65535, 'A full 64K source range cannot be represented with 16-bit DWARF addresses');
        program.push(uint(2, 1), leb(end - address), Buffer.from([0, 1, 1]));
        ranges.push(uint(address - metadata.origin, 2), uint(end - metadata.origin, 2));
    }
    for (const func of functions) {
        for (const range of func.ranges) {
            ranges.push(uint(range.start - metadata.origin, 2), uint(range.end - metadata.origin, 2));
        }
    }
    ranges.push(uint(0, 2), uint(0, 2));
    const functionOffsets = new Map();
    for (const func of functions) {
        functionOffsets.set(func, rangeOffset + concat(ranges).length);
        ranges.push(uint(0xffff, 2), uint(metadata.origin, 2));
        for (const range of func.ranges) {
            check(range.end - metadata.origin <= 65535, 'Function range exceeds 16-bit DWARF bounds');
            ranges.push(uint(range.start - metadata.origin, 2), uint(range.end - metadata.origin, 2));
        }
        ranges.push(uint(0, 2), uint(0, 2));
    }
    const blockOffsets = new Map();
    for (const func of functions) {
        for (const block of func.lexicalBlocks || []) {
            blockOffsets.set(block, rangeOffset + concat(ranges).length);
            ranges.push(uint(0xffff, 2), uint(metadata.origin, 2));
            for (const range of block.ranges) {
                ranges.push(uint(range.start - metadata.origin, 2), uint(range.end - metadata.origin, 2));
            }
            ranges.push(uint(0, 2), uint(0, 2));
        }
    }
    const lineBody = concat([uint(4, 2), uint(header.length, 4), header, ...program]);
    const name = rows.find(row => row.kind === 'C')?.file || functions.find(func => func.file)?.file || files[0] || module;
    const language = rows.some(row => row.kind === 'C') || globals.length || functions.length ? 2 : 0x8001;
    const parts = [uint(4, 2), uint(0, 4), uint(2, 1),
        leb(1), str(name), str('z88dk generic MAP-to-ELF'),
        uint(lineOffset, 4), uint(rangeOffset, 4), uint(language, 2)];
    const offsets = new Map();
    const references = [];
    let cursor = 4 + concat(parts).length;
    const append = (...buffers) => {
        parts.push(...buffers);
        cursor += concat(buffers).length;
    };
    const reference = id => {
        const buffer = Buffer.alloc(4);
        references.push({ buffer, id });
        append(buffer);
    };
    for (const type of metadata.typed.types.filter(type => type.module === module)) {
        offsets.set(type.id, cursor);
        switch (type.kind) {
        case 'scalar':
            append(leb(2), str(type.name), uint(type.size, 1), uint(type.encoding, 1));
            break;
        case 'pointer':
            append(leb(3), uint(type.size, 1));
            reference(type.target);
            break;
        case 'function':
            append(leb(16));
            reference(type.target);
            append(leb(12), uint(0, 1));
            break;
        case 'array':
            append(leb(4));
            reference(type.target);
            append(leb(5), leb(type.count), uint(0, 1));
            break;
        case 'struct':
            append(leb(6), str(type.name), leb(type.size));
            for (const member of type.members) {
                append(leb(7), str(member.name));
                reference(member.type);
                append(leb(member.offset));
            }
            append(uint(0, 1));
            break;
        case 'void':
            append(leb(9), str(type.name));
            break;
        case 'incomplete':
            append(leb(10), str(type.name));
            break;
        default:
            throw new Error(`Unsupported DWARF type kind: ${type.kind}`);
        }
    }
    for (const global of globals) {
        append(leb(8), str(global.name));
        reference(global.type);
        append(leb(3), uint(0x03, 1), uint(global.address, 2), uint(Number(global.external), 1));
    }
    for (const func of functions) {
        append(leb(11), str(func.name));
        reference(func.returnType);
        append(uint(func.address, 2), uint(functionOffsets.get(func), 4), uint(Number(func.external), 1),
            leb(func.file ? files.indexOf(func.file) + 1 : 0), leb(func.line || 0));
        const emitted = (func.variables || []).filter(variable => variable.parameter ||
            !variable.locationGaps.some(gap => gap.startsWith('No source rows identify')));
        const ordered = variables => [...variables].sort((a, b) =>
            Number(b.parameter) - Number(a.parameter) ||
            (a.parameter ? a.location.offset - b.location.offset : 0));
        const emitVariables = variables => {
            for (const variable of ordered(variables)) {
                append(leb(variable.parameter ? 13 : 14), str(variable.name));
                reference(variable.type);
                append(uint(variableOffsets.get(variable), 4));
            }
        };
        const blocks = func.lexicalBlocks || [];
        const emittedParent = block => {
            let parent = block.parent;
            while (parent && !blocks.includes(parent)) parent = parent.parent;
            return parent || null;
        };
        const emitBlocks = parent => {
            for (const block of blocks.filter(block => emittedParent(block) === parent)) {
                append(leb(15), uint(blockOffsets.get(block), 4));
                emitVariables(emitted.filter(variable => variable.lexicalBlock === block));
                emitBlocks(block);
                append(uint(0, 1));
            }
        };
        emitVariables(emitted.filter(variable => !variable.lexicalBlock));
        emitBlocks(null);
        append(leb(12), uint(0, 1));
    }
    append(uint(0, 1));
    for (const { buffer, id } of references) {
        check(offsets.has(id), `Missing emitted type ${id}`);
        buffer.writeUInt32LE(offsets.get(id));
    }
    const infoBody = concat(parts);
    return { info: concat([uint(infoBody.length, 4), infoBody]),
        line: concat([uint(lineBody.length, 4), lineBody]), ranges: concat(ranges),
        locations: concat(locations) };
}

function makeElf(image, metadata, sourceRoot = process.cwd()) {
    const entries = new Set(metadata.typed.functions.map(func => func.address));
    const executableRanges = [];
    for (const section of new Set(metadata.symbols.filter(symbol => metadata.typed.functions.length &&
        symbol.kind === 'addr' && isCode(symbol.section, metadata.codeSections)).map(symbol => symbol.section))) {
        const heads = metadata.symbols.filter(symbol => symbol.name === `__${section}_head`);
        const tails = metadata.symbols.filter(symbol => symbol.name === `__${section}_tail`);
        check(heads.length === 1 && tails.length === 1,
            `Missing or ambiguous executable section bounds for ${section}`);
        if (tails[0].address > heads[0].address) {
            executableRanges.push({ start: Math.max(metadata.origin, heads[0].address),
                end: Math.min(metadata.end, tails[0].address) });
        }
    }
    const contracts = proveCallSummaries(image, metadata.origin, entries, executableRanges);
    metadata.callContracts = [...contracts.callSummaries].map(([entry, summary]) => ({ entry, ...summary }));
    if (contracts.summaryGap) metadata.warnings.push(contracts.summaryGap);
    for (const func of metadata.typed.functions) {
        check(isCode(func.section, metadata.codeSections), `Function ${func.name} is not in an executable section`);
        const heads = metadata.symbols.filter(symbol => symbol.name === `__${func.section}_head`);
        const tails = metadata.symbols.filter(symbol => symbol.name === `__${func.section}_tail`);
        check(heads.length === 1 && tails.length === 1, `Missing or ambiguous executable section bounds for ${func.name}`);
        check(func.address >= heads[0].address && func.address < tails[0].address,
            `Function ${func.name} entry is outside its section`);
        const analysis = functionRanges(image, metadata.origin, func.address, entries,
            { start: heads[0].address, end: tails[0].address });
        func.ranges = analysis.ranges;
        func.rangeGaps = analysis.gaps;
        func.rangeAssumptions = analysis.assumptions;
        if (analysis.gaps.length) {
            const warning = `Function ${func.name} in ${func.module} has no proven address ranges: ${analysis.gaps.join('; ')}`;
            if (!metadata.warnings.includes(warning)) metadata.warnings.push(warning);
        }
        const ownedRows = metadata.rows.filter(row => row.kind === 'C' && row.module === func.module);
        const scoped = ownedRows.filter(row => row.function === func.name);
        const sources = scoped.length ? scoped : ownedRows.filter(row => row.address === func.address);
        func.file = sources[0]?.file;
        func.line = sources[0]?.line;
        func.stackAnalysis = analyseStack(image, metadata.origin, func.address, executableRanges, contracts);
    }
    const frameSet = analyseFrames(image, metadata.origin, entries, executableRanges,
        { ...contracts, rootAnalyses: new Map(metadata.typed.functions.map(func => [func.address, func.stackAnalysis])) });
    metadata.frames = frameSet.frames;
    metadata.frameAnalysisGaps = frameSet.gaps;
    for (const func of metadata.typed.functions.filter(func => !func.stackAnalysis.complete)) {
        const details = func.stackAnalysis.gaps.length ? func.stackAnalysis.gaps.join('; ') :
            'No complete unambiguous return-continuation rules';
        const frame = metadata.frames.find(candidate => candidate.entry === func.address);
        const independent = frame?.complete ?
            'Independent frame analysis is complete; runtime guards and per-PC availability still apply.' :
            'Independent frame analysis is incomplete or missing; the GDB unwinder cannot use this frame.';
        const warning = `Root stack analysis incomplete for ${func.name} in ${func.module}: ${details}. ${independent}`;
        if (!metadata.warnings.includes(warning)) metadata.warnings.push(warning);
    }
    if (metadata.frames.some(frame => frame.assumptions.includes(
        'Indirect call targets must belong to the validated call-contract set'))) {
        metadata.warnings.push('Indirect-call continuation rules are conditional on targets belonging to the validated linked C function contract set; unrecorded assembly callbacks and external targets are not covered.');
    }
    analyseLocations(metadata);
    for (const gap of frameSet.gaps) {
        const warning = `Independent frame analysis incomplete: ${gap}`;
        if (!metadata.warnings.includes(warning)) metadata.warnings.push(warning);
    }
    for (const frame of frameSet.frames.filter(frame => !frame.complete)) {
        const detail = frame.gaps.length ? frame.gaps.join('; ') : 'No complete independent continuation rules';
        const warning = `Independent frame at 0x${frame.entry.toString(16)} incomplete: ${detail}`;
        if (!metadata.warnings.includes(warning)) metadata.warnings.push(warning);
    }
    if (metadata.typed.functions.some(func => func.rangeAssumptions.length)) {
        const warning = 'Static function ranges assume ordinary CALL/RST return continuations; the separate stack-analysis results do not replace this range pass yet.';
        if (!metadata.warnings.includes(warning)) metadata.warnings.push(warning);
    }
    if (metadata.typed.functions.length) {
        const warning = 'Root stack-analysis rows are not independent unwind rules. The opt-in GDB unwinder consumes independent frame rows only; all rules are conditional on runtimeGuards: validate entry SP, no address-space wrap, and stack disjointness from recorded absolute accesses and executable code.';
        if (!metadata.warnings.includes(warning)) metadata.warnings.push(warning);
    }
    const dataRanges = metadata.typed.globals.filter(global =>
        global.address >= metadata.origin && global.address + global.size <= metadata.end)
        .map(global => ({ start: global.address, end: global.address + global.size }))
        .sort((a, b) => a.start - b.start);
    const merged = [];
    for (const range of dataRanges) {
        const last = merged.at(-1);
        if (last && range.start <= last.end) last.end = Math.max(last.end, range.end);
        else merged.push({ ...range });
    }
    const sections = [{ name: '', type: 0, data: Buffer.alloc(0) }];
    let start = metadata.origin;
    let textCount = 0;
    let dataCount = 0;
    const segment = (end, data) => {
        if (end === start) return;
        const count = data ? dataCount++ : textCount++;
        const name = `${data ? '.data' : '.text'}${count ? `.${count}` : ''}`;
        sections.push({ name, type: 1, flags: data ? 3 : 6, address: start,
            data: image.subarray(start - metadata.origin, end - metadata.origin) });
        start = end;
    };
    for (const range of merged) {
        segment(range.start, false);
        segment(range.end, true);
    }
    segment(metadata.end, false);
    const allocatedCount = sections.length;
    sections.push(...debugSections(metadata, sourceRoot));
    const strings = [str('')];
    const symbols = [Buffer.alloc(16)];
    let offset = 1;
    const ordered = [...metadata.symbols].sort((a, b) =>
        Number(a.visibility === 'public') - Number(b.visibility === 'public'));
    for (const record of ordered) {
        strings.push(str(record.name));
        const func = metadata.typed.functions.find(func => record.name === `_${func.name}` &&
            record.module === func.module && record.kind === 'addr');
        const global = metadata.typed.globals.find(global => record.name === `_${global.name}` &&
            record.module === global.module && record.kind === 'addr');
        const binding = (record.visibility === 'public' ? 0x10 : 0) | (func ? 2 : global ? 1 : 0);
        const size = global ? global.size : func?.ranges.length === 1 && func.ranges[0].start === record.address ?
            func.ranges[0].end - record.address : 0;
        // Only linked CDB definitions establish function/object types; other labels remain untyped.
        const sectionIndex = sections.findIndex((section, index) => index > 0 && index < allocatedCount &&
            record.address >= section.address && record.address < section.address + section.data.length);
        symbols.push(concat([uint(offset, 4), uint(record.address, 4), uint(size, 4),
            uint(binding, 1), uint(0, 1), uint(record.kind === 'const' || sectionIndex < 0 ?
                0xfff1 : sectionIndex, 2)]));
        offset += str(record.name).length;
    }
    const strtab = sections.length;
    sections.push({ name: '.strtab', type: 3, data: concat(strings) });
    sections.push({ name: '.symtab', type: 2, data: concat(symbols), link: strtab,
        info: 1 + ordered.filter(record => record.visibility === 'local').length, entsize: 16 });
    const shstrtab = sections.length;
    sections.push({ name: '.shstrtab', type: 3, data: Buffer.alloc(0) });
    const sectionNames = [str('')];
    let nameOffset = 1;
    for (const section of sections.slice(1)) {
        section.nameOffset = nameOffset;
        sectionNames.push(str(section.name));
        nameOffset += str(section.name).length;
    }
    sections[shstrtab].data = concat(sectionNames);
    let fileOffset = 52;
    for (const section of sections.slice(1)) {
        fileOffset = Math.ceil(fileOffset / 4) * 4;
        section.offset = fileOffset;
        fileOffset += section.data.length;
    }
    const shoff = Math.ceil(fileOffset / 4) * 4;
    const elf = Buffer.alloc(shoff + sections.length * 40);
    Buffer.from([0x7f, 0x45, 0x4c, 0x46, 1, 1, 1]).copy(elf);
    concat([uint(2, 2), uint(220, 2), uint(1, 4), uint(metadata.origin, 4), uint(0, 4),
        uint(shoff, 4), uint(1, 4), uint(52, 2), uint(0, 2), uint(0, 2),
        uint(40, 2), uint(sections.length, 2), uint(shstrtab, 2)]).copy(elf, 16);
    sections.slice(1).forEach((section, index) => {
        section.data.copy(elf, section.offset);
        concat([section.nameOffset, section.type, section.flags || 0, section.address || 0,
            section.offset, section.data.length, section.link || 0, section.info || 0,
            1, section.entsize || 0].map(value => uint(value, 4)))
            .copy(elf, shoff + (index + 1) * 40);
    });
    return elf;
}

function convert(imagePath, mapFile, output, mappings = [], imageOrigin, sourceMappings = [], codeSections = [],
    compiler = 'auto', sourceRoot = process.cwd()) {
    const destination = path.resolve(output);
    const sidecar = `${destination}.metadata.json`;
    const identity = filename => process.platform === 'win32' ?
        path.resolve(filename).toLowerCase() : path.resolve(filename);
    check(![imagePath, mapFile].some(input =>
        [destination, sidecar].map(identity).includes(identity(input))), 'Output must not overwrite an input');
    const image = fs.readFileSync(imagePath);
    const metadata = readMap(fs.readFileSync(mapFile, 'utf8'), image.length, mappings, imageOrigin,
        sourceMappings, codeSections, compiler);
    const elf = makeElf(image, metadata, sourceRoot);
    metadata.elfSha256 = createHash('sha256').update(elf).digest('hex');
    const temporary = fs.mkdtempSync(path.join(path.dirname(destination), '.z88dk-elf-'));
    const temporaryElf = path.join(temporary, 'image.elf');
    const temporaryMetadata = path.join(temporary, 'metadata.json');
    let replaced = false;
    try {
        fs.writeFileSync(temporaryElf, elf);
        fs.writeFileSync(temporaryMetadata, JSON.stringify(metadata, null, 2));
        // Invalidate the old pair before replacing either file.
        if (fs.existsSync(sidecar)) fs.unlinkSync(sidecar);
        fs.renameSync(temporaryElf, destination);
        replaced = true;
        fs.renameSync(temporaryMetadata, sidecar);
    } catch (error) {
        if (replaced) fs.unlinkSync(destination);
        throw error;
    } finally {
        for (const filename of [temporaryElf, temporaryMetadata]) {
            if (fs.existsSync(filename)) fs.unlinkSync(filename);
        }
        fs.rmdirSync(temporary);
    }
    return metadata;
}

function runCli(args) {
    try {
        check(args.length >= 3, 'Usage: node z88dk-elf.js IMAGE RAW_MAP OUTPUT_ELF [--compiler auto|sdcc|sccz80] [--origin HEX] [--path-map FROM=TO ...] [--source MODULE=PATH ...] [--code-section NAME ...]');
        const mappings = [];
        const sourceMappings = [];
        const codeSections = [];
        let imageOrigin;
        let compiler = 'auto';
        let compilerSpecified = false;
        for (let index = 3; index < args.length; index += 2) {
            if (args[index] === '--compiler') {
                check(!compilerSpecified && ['auto', 'sdcc', 'sccz80'].includes(args[index + 1]),
                    'Expected a single --compiler auto|sdcc|sccz80');
                compiler = args[index + 1];
                compilerSpecified = true;
                continue;
            }
            if (args[index] === '--origin') {
                check(imageOrigin === undefined && /^(?:0x)?[0-9a-f]{1,4}$/i.test(args[index + 1] || ''),
                    'Expected a single --origin HEX within the Z80 address space');
                imageOrigin = parseInt(args[index + 1].replace(/^0x/i, ''), 16);
                continue;
            }
            if (args[index] === '--code-section') {
                check(args[index + 1] && !/\s/.test(args[index + 1]), 'Expected --code-section NAME');
                check(!codeSections.includes(args[index + 1]), 'Duplicate code section');
                codeSections.push(args[index + 1]);
                continue;
            }
            check(['--path-map', '--source'].includes(args[index]) && args[index + 1]?.includes('='),
                'Expected --path-map FROM=TO or --source MODULE=PATH');
            const position = args[index + 1].indexOf('=');
            const from = args[index + 1].slice(0, position);
            const to = args[index + 1].slice(position + 1);
            check(from && to, 'Path mappings need nonempty source and destination prefixes');
            if (args[index] === '--source') {
                check(!sourceMappings.some(mapping => mapping.module === from),
                    `Duplicate source mapping for module ${from}`);
                sourceMappings.push({ module: from, file: to });
            } else {
                check(!mappings.some(mapping => mapping.from === from), `Duplicate path mapping ${from}`);
                mappings.push({ from, to });
            }
        }
        const metadata = convert(...args.slice(0, 3), mappings, imageOrigin, sourceMappings, codeSections, compiler);
        for (const warning of metadata.warnings) console.error(`Coverage: ${warning}`);
        console.log(`ELF: ${args[2]} (${metadata.symbols.length} symbols, ${metadata.rows.length} source rows)`);
    } catch (error) {
        console.error(`z88dk ELF conversion failed: ${error.message}`);
        process.exitCode = 1;
    }
}

if (require.main === module) runCli(process.argv.slice(2));

module.exports = { readMap, makeElf, convert, runCli };
