'use strict';

const { instruction } = require('./z80-function-ranges');

const unknown = null;
const returnByte = index => ({ kind: 'return', index });
const stackAddress = offset => ({ kind: 'stack', offset });
const equal = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const pairs = ['bc', 'de', 'hl', 'sp'];
const recoverableRegisters = ['bc', 'de', 'hl', 'ix', 'iy'];
const bytes = ['b', 'c', 'd', 'e', 'h', 'l', 'a'];
const split = value => typeof value === 'number' ? [value & 255, (value >> 8) & 255] :
    value?.kind === 'return' ? [returnByte(0), returnByte(1)] :
    value?.kind === 'entry-word' ? [{ kind: 'entry-memory', address: value.address },
        { kind: 'entry-memory', address: value.address + 1 }] :
    [{ kind: 'low', value }, { kind: 'high', value }];
const combine = (low, high) => {
    if (typeof low === 'number' && typeof high === 'number') return low | (high << 8);
    if (low?.kind === 'return' && high?.kind === 'return' && low.index === 0 && high.index === 1) {
        return { kind: 'return' };
    }
    if (low?.kind === 'entry-memory' && high?.kind === 'entry-memory' &&
        high.address === low.address + 1) return { kind: 'entry-word', address: low.address };
    if (low?.kind === 'low' && high?.kind === 'high' && equal(low.value, high.value)) return low.value;
    return unknown;
};

class AnalysisGap extends Error {}

function analyseStack(image, origin, entry, executableRanges, options = {}) {
    const budget = options.budget ?? 10000;
    if (!Number.isInteger(budget) || budget < 1) throw new Error('Analysis budget must be a positive integer');
    const initial = { pc: entry, sp: 0, registers: Object.fromEntries(bytes.map(name => [name, unknown])),
        alternateRegisters: Object.fromEntries(bytes.slice(0, 6).map(name => [name, unknown])),
        ix: unknown, iy: unknown, memory: { 0: returnByte(0), 1: returnByte(1) },
        absoluteMemory: {}, calls: [] };
    for (const name of recoverableRegisters) {
        const value = { kind: 'entry-register', name };
        if (name === 'ix' || name === 'iy') initial[name] = value;
        else {
            const [low, high] = split(value);
            initial.registers[name[1]] = low;
            initial.registers[name[0]] = high;
        }
    }
    const pending = [initial];
    const joined = new Map();
    const rows = new Map();
    const contextRows = new Map();
    const frameRows = new Map();
    const callTargets = new Set();
    const gaps = new Set();
    const exits = [];
    const instructionBytes = new Map();
    const occupied = new Map();
    const stackBytes = new Set([0, 1]);
    const absoluteBytes = new Set();
    const spOffsets = new Set([0, 2]);
    const callEdges = [];
    const exitEffects = [];
    let indirectCalls = false;
    let stackBlockCopies = false;
    const absoluteInput = address => ({ kind: 'entry-memory', address });
    let steps = 0;
    let blockBytes = 0;
    const fail = (state, reason) => gaps.add(`0x${state.pc.toString(16)}: ${reason}`);
    const readByte = (state, address) => {
        if (address?.kind === 'stack') {
            stackBytes.add(address.offset);
            return state.memory[address.offset] ?? unknown;
        }
        if (typeof address === 'number') {
            absoluteBytes.add(address);
            if (!(address in state.absoluteMemory)) state.absoluteMemory[address] = absoluteInput(address);
            return state.absoluteMemory[address];
        }
        return unknown;
    };
    const writeByte = (state, address, value) => {
        if (address?.kind === 'stack') {
            stackBytes.add(address.offset);
            state.memory[address.offset] = value;
        } else if (typeof address === 'number') {
            if (executableRanges.some(range => address >= range.start && address < range.end)) {
                throw new AnalysisGap('Write may modify executable code');
            }
            absoluteBytes.add(address);
            state.absoluteMemory[address] = value;
        } else throw new AnalysisGap('Unresolved memory write may alias saved continuation');
    };
    const readPair = (state, name) => name === 'sp' ? stackAddress(state.sp) :
        name === 'ix' || name === 'iy' ? state[name] : combine(state.registers[name[1]], state.registers[name[0]]);
    const writePair = (state, name, value) => {
        if (name === 'sp') {
            if (value?.kind !== 'stack') throw new AnalysisGap('SP no longer relative to entry stack');
            state.sp = value.offset;
        } else if (name === 'ix' || name === 'iy') state[name] = value;
        else {
            const [low, high] = split(value);
            state.registers[name[1]] = low;
            state.registers[name[0]] = high;
        }
    };
    const add = (a, b) => typeof a === 'number' && b?.kind === 'stack' ? add(b, a) :
        typeof a === 'number' && typeof b === 'number' ? (a + b) & 65535 :
        a?.kind === 'stack' && typeof b === 'number' ?
            stackAddress(a.offset + (b > 32767 ? b - 65536 : b)) : unknown;
    const push = (state, value) => {
        state.sp -= 2;
        const [low, high] = split(value);
        writeByte(state, stackAddress(state.sp), low);
        writeByte(state, stackAddress(state.sp + 1), high);
    };
    const pop = state => {
        const value = combine(readByte(state, stackAddress(state.sp)),
            readByte(state, stackAddress(state.sp + 1)));
        delete state.memory[state.sp];
        delete state.memory[state.sp + 1];
        state.sp += 2;
        return value;
    };
    const transfer = (state, target) => {
        if (target?.kind === 'return') {
            spOffsets.add(state.sp);
            exits.push({ spDelta: state.sp, pc: state.pc });
            exitEffects.push({
                preservedRegisters: recoverableRegisters.filter(name =>
                    equal(readPair(state, name), { kind: 'entry-register', name })),
                clobberedAbsolute: Object.keys(state.absoluteMemory).map(Number).filter(address =>
                    !equal(state.absoluteMemory[address], absoluteInput(address))),
                clobberedStack: Object.keys(state.memory).map(Number).filter(offset => offset >= 2),
            });
        } else if (typeof target === 'number') {
            if (state.calls.at(-1)?.continuation === target) state.calls.pop();
            state.pc = target;
            pending.push(state);
        } else fail(state, 'Unresolved return or indirect continuation');
    };
    const applySummary = (state, summary, continuation, childEntrySp, target) => {
        for (const code of summary.instructionBytes || []) instructionBytes.set(code.address, code.bytes);
        for (const address of summary.absoluteAddresses || []) absoluteBytes.add(address);
        callEdges.push({ target, continuation, childEntrySpOffset: -childEntrySp,
            continuationSpOffset: -state.sp });
        for (const name of recoverableRegisters) {
            if (!summary.preservedRegisters.includes(name)) writePair(state, name, unknown);
        }
        state.registers.a = unknown;
        // Contracts advertise only main-bank preservation, never alternate-bank effects.
        for (const name of Object.keys(state.alternateRegisters)) state.alternateRegisters[name] = unknown;
        for (const address of summary.clobberedAbsolute) {
            absoluteBytes.add(address);
            state.absoluteMemory[address] = unknown;
        }
        for (const offset of summary.clobberedStack) {
            writeByte(state, stackAddress(childEntrySp + offset), unknown);
        }
        for (const key of Object.keys(state.memory)) {
            if (Number(key) < state.sp) delete state.memory[key];
        }
        state.pc = continuation;
        pending.push(state);
    };
    const record = (state, instructionEnd) => {
        instructionBytes.set(state.pc, image.subarray(state.pc - origin, instructionEnd - origin).toString('hex'));
        spOffsets.add(state.sp);
        const locate = value => {
            const locations = [];
            const [low, high] = split(value);
            for (const key of Object.keys(state.memory)) {
                const offset = Number(key);
                if (equal(state.memory[offset], low) && equal(state.memory[offset + 1], high)) {
                    locations.push({ kind: 'memory', spOffset: offset - state.sp });
                }
            }
            for (const name of recoverableRegisters) {
                if (equal(readPair(state, name), value)) locations.push({ kind: 'register', name });
            }
            for (const key of Object.keys(state.absoluteMemory)) {
                const address = Number(key);
                if (equal(state.absoluteMemory[address], low) &&
                    equal(state.absoluteMemory[(address + 1) & 65535], high)) {
                    locations.push({ kind: 'absolute', address });
                }
            }
            return locations.sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)));
        };
        const locations = locate({ kind: 'return' });
        const savedRegisters = Object.fromEntries(recoverableRegisters.map(name =>
            [name, locate({ kind: 'entry-register', name })]));
        const stackPointers = [
            ...recoverableRegisters.flatMap(name => {
                const value = readPair(state, name);
                return value?.kind === 'stack' ? [{ register: name, entryOffset: value.offset }] : [];
            }),
            ...Object.keys(state.absoluteMemory).flatMap(key => {
                const address = Number(key);
                const value = combine(state.absoluteMemory[address], state.absoluteMemory[address + 1]);
                return value?.kind === 'stack' ? [{ address, entryOffset: value.offset }] : [];
            }),
        ];
        const rule = { pc: state.pc, entrySpOffset: 0 - state.sp, callerEntrySpOffset: 2 - state.sp,
            instructionBytes: image.subarray(state.pc - origin, instructionEnd - origin).toString('hex'),
            returnLocations: locations, savedRegisters, stackPointers };
        const mergeRule = (map, key) => {
            const previous = map.get(key);
            if (previous?.unavailable) return;
            if (!previous) {
                map.set(key, rule);
            } else if (previous.entrySpOffset !== rule.entrySpOffset) {
                map.set(key, { pc: state.pc, unavailable: 'Conflicting stack/continuation states' });
            } else {
                const common = previous.returnLocations.filter(location =>
                    rule.returnLocations.some(other => equal(location, other)));
                const saved = Object.fromEntries(recoverableRegisters.map(name => [name,
                    previous.savedRegisters[name].filter(location =>
                        rule.savedRegisters[name].some(other => equal(location, other)))]));
                map.set(key, { ...rule, returnLocations: common, savedRegisters: saved,
                    stackPointers: previous.stackPointers.filter(pointer =>
                        rule.stackPointers.some(other => equal(pointer, other))) });
            }
        };
        mergeRule(rows, state.pc);
        mergeRule(contextRows, JSON.stringify([state.pc, state.calls]));
        if (!state.calls.length) mergeRule(frameRows, state.pc);
    };
    while (pending.length) {
        const state = pending.pop();
        if (++steps + blockBytes > budget) {
            gaps.add(`Analysis budget of ${budget} states/byte transfers exceeded; no completeness claimed`);
            break;
        }
        const key = JSON.stringify([state.pc, state.sp, state.calls]);
        const previous = joined.get(key);
        if (previous) {
            const mergeValue = (left, right) => equal(left, right) ? left : unknown;
            for (const name of ['ix', 'iy']) state[name] = mergeValue(previous[name], state[name]);
            for (const field of ['registers', 'alternateRegisters', 'memory', 'absoluteMemory']) {
                const values = {};
                for (const name of new Set([...Object.keys(previous[field]), ...Object.keys(state[field])])) {
                    const fallback = field === 'absoluteMemory' ? absoluteInput(Number(name)) : unknown;
                    const value = mergeValue(previous[field][name] ?? fallback, state[field][name] ?? fallback);
                    if (value !== unknown || field === 'registers' || field === 'alternateRegisters' ||
                        field === 'absoluteMemory') values[name] = value;
                }
                state[field] = values;
            }
            if (equal(previous, state)) continue;
        }
        joined.set(key, structuredClone(state));
        if (!executableRanges.some(range => state.pc >= range.start && state.pc < range.end)) {
            fail(state, 'Target outside supplied executable ranges');
            continue;
        }
        const decoded = instruction(image, origin, state.pc);
        if (!decoded || !executableRanges.some(range => state.pc >= range.start && decoded.end <= range.end)) {
            fail(state, 'Truncated or out-of-section instruction');
            continue;
        }
        record(state, decoded.end);
        let overlap = false;
        for (let byte = state.pc; byte < decoded.end; ++byte) {
            if (occupied.has(byte) && occupied.get(byte) !== state.pc) overlap = true;
            occupied.set(byte, state.pc);
        }
        if (overlap) {
            fail(state, 'Overlapping instruction boundaries');
            continue;
        }
        let offset = state.pc - origin;
        let index;
        while (image[offset] === 0xdd || image[offset] === 0xfd) {
            index = image[offset++] === 0xdd ? 'ix' : 'iy';
        }
        const opcode = image[offset++];
        const hl = index || 'hl';
        const pair = p => p === 2 ? hl : pairs[p];
        const x = opcode >> 6;
        const y = (opcode >> 3) & 7;
        const z = opcode & 7;
        const p = y >> 1;
        const q = y & 1;
        const memoryOperand = x === 1 && (y === 6 || z === 6);
        const byteName = code => ['b', 'c', 'd', 'e', index && !memoryOperand ? `${index}h` : 'h',
            index && !memoryOperand ? `${index}l` : 'l', undefined, 'a'][code];
        const memoryAddress = () => {
            const value = readPair(state, hl);
            const displacement = index ? image[offset++] : 0;
            return add(value, displacement < 128 ? displacement : displacement - 256);
        };
        try {
            if (opcode === 0x10) throw new AnalysisGap('DJNZ register/condition analysis not implemented');
            if (decoded.conditional) {
                const untaken = structuredClone(state);
                untaken.pc = decoded.end;
                pending.push(untaken);
            }
            if (decoded.flow === 'call') {
                callTargets.add(decoded.target);
                const summary = options.callSummaries?.get(decoded.target);
                if (summary) {
                    applySummary(state, summary, decoded.end, state.sp - 2, decoded.target);
                    continue;
                }
                if (state.calls.some(call => call.target === decoded.target) || decoded.target === entry) {
                    throw new AnalysisGap('Recursive call requires a proven interprocedural summary');
                }
                state.calls.push({ target: decoded.target, continuation: decoded.end });
                push(state, decoded.end);
                transfer(state, decoded.target);
                continue;
            }
            if (decoded.flow === 'return') {
                transfer(state, pop(state));
                continue;
            }
            if (decoded.flow === 'branch') {
                transfer(state, decoded.target);
                continue;
            }
            if (decoded.flow === 'indirect') {
                const target = readPair(state, hl);
                const call = state.calls.at(-1);
                const continuation = combine(readByte(state, stackAddress(state.sp)),
                    readByte(state, stackAddress(state.sp + 1)));
                if (target === unknown && call && continuation === call.continuation &&
                    options.indirectSummary) {
                    indirectCalls = true;
                    const childEntrySp = state.sp;
                    pop(state);
                    state.calls.pop();
                    for (const candidate of options.callSummaries.keys()) {
                        callTargets.add(candidate);
                    }
                    applySummary(state, options.indirectSummary, continuation, childEntrySp, null);
                } else transfer(state, target);
                continue;
            }
            if (decoded.flow === 'halt') throw new AnalysisGap('HALT requires interrupt stack analysis');
            if (opcode === 0xed) {
                const extended = image[offset];
                if (extended === 0xb0) {
                    const count = readPair(state, 'bc');
                    let source = readPair(state, 'hl');
                    let destination = readPair(state, 'de');
                    if (typeof count !== 'number') throw new AnalysisGap('LDIR requires a known byte count');
                    if (![source, destination].every(address =>
                        typeof address === 'number' || address?.kind === 'stack')) {
                        throw new AnalysisGap('LDIR requires resolved source and destination addresses');
                    }
                    if (source?.kind === 'stack' || destination?.kind === 'stack') stackBlockCopies = true;
                    // BC=0 transfers 65536 bytes, not zero. Charge byte work as well as states.
                    const length = count || 65536;
                    if (steps + blockBytes + length > budget) {
                        throw new AnalysisGap(`LDIR copy exceeds analysis budget of ${budget}`);
                    }
                    blockBytes += length;
                    for (let byte = 0; byte < length; ++byte) {
                        // Read after each preceding write: overlapping LDIR is not memmove.
                        writeByte(state, destination, readByte(state, source));
                        source = add(source, 1);
                        destination = add(destination, 1);
                        writePair(state, 'hl', source);
                        writePair(state, 'de', destination);
                        writePair(state, 'bc', (count - byte - 1) & 65535);
                        // LDIR repeats at the same PC and may be stopped between transfers.
                        if (byte + 1 < length) {
                            // Ignored DD/FD prefixes are not fetched again on repeat.
                            state.pc = origin + offset - 1;
                            record(state, decoded.end);
                        }
                    }
                } else if ([0x4a, 0x5a, 0x6a, 0x7a, 0x42, 0x52, 0x62, 0x72].includes(extended)) {
                    writePair(state, 'hl', unknown);
                } else throw new AnalysisGap(`Unsupported ED stack/register effects: ${extended.toString(16)}`);
            } else if (opcode === 0xcb) {
                throw new AnalysisGap('CB register/memory effects not implemented');
            } else if (opcode === 0xe3) {
                const value = readPair(state, hl);
                const saved = combine(readByte(state, stackAddress(state.sp)),
                    readByte(state, stackAddress(state.sp + 1)));
                const [low, high] = split(value);
                writeByte(state, stackAddress(state.sp), low);
                writeByte(state, stackAddress(state.sp + 1), high);
                writePair(state, hl, saved);
            } else if (opcode === 0xeb) {
                const value = readPair(state, 'de');
                writePair(state, 'de', readPair(state, 'hl'));
                writePair(state, 'hl', value);
            } else if (opcode === 0xd9) {
                for (const name of bytes.slice(0, 6)) {
                    [state.registers[name], state.alternateRegisters[name]] =
                        [state.alternateRegisters[name], state.registers[name]];
                }
            } else if (opcode === 0xf9) {
                writePair(state, 'sp', readPair(state, hl));
            } else if (x === 3 && z === 5 && !q) {
                push(state, p === 3 ? unknown : readPair(state, pair(p)));
            } else if (x === 3 && z === 1 && !q) {
                const value = pop(state);
                if (p !== 3) writePair(state, pair(p), value);
                else state.registers.a = unknown;
            } else if (x === 0 && z === 1) {
                if (!q) writePair(state, pair(p), image[offset] | (image[offset + 1] << 8));
                else writePair(state, hl, add(readPair(state, hl), readPair(state, pair(p))));
            } else if (x === 0 && z === 3) {
                writePair(state, pair(p), add(readPair(state, pair(p)), q ? -1 : 1));
            } else if (x === 0 && z === 2) {
                const address = p < 2 ? readPair(state, pairs[p]) :
                    image[offset] | (image[offset + 1] << 8);
                if (p === 2) {
                    if (q) writePair(state, hl, combine(readByte(state, address), readByte(state, add(address, 1))));
                    else {
                        const [low, high] = split(readPair(state, hl));
                        writeByte(state, address, low);
                        writeByte(state, add(address, 1), high);
                    }
                } else if (q) state.registers.a = readByte(state, address);
                else writeByte(state, address, state.registers.a);
            } else if (x === 1 || (x === 0 && (z === 4 || z === 5 || z === 6))) {
                const destination = y;
                let value;
                let address;
                if (destination === 6 || (x === 1 && z === 6)) address = memoryAddress();
                if (x === 1) value = z === 6 ? readByte(state, address) : state.registers[byteName(z)] ?? unknown;
                else if (z === 6) value = image[offset];
                else value = unknown;
                if (destination === 6) writeByte(state, address, value);
                else if (index && !memoryOperand && (destination === 4 || destination === 5)) {
                    throw new AnalysisGap('Index-byte writes not implemented');
                } else state.registers[byteName(destination)] = value;
            } else if (x === 2 || (x === 3 && z === 6) || (x === 0 && z === 7)) {
                if (!(x === 2 && y === 7) && opcode !== 0xfe) state.registers.a = unknown;
            } else if (opcode === 0x00 || opcode === 0xf3 || opcode === 0xfb) {
                // These instructions do not alter tracked stack/register values.
            } else {
                throw new AnalysisGap(`Unsupported stack/register effects: ${opcode.toString(16)}`);
            }
            state.pc = decoded.end;
            pending.push(state);
        } catch (error) {
            if (!(error instanceof AnalysisGap)) throw error;
            fail(state, error.message);
        }
    }
    const offsets = [...stackBytes].sort((a, b) => a - b);
    const addresses = [...absoluteBytes].sort((a, b) => a - b);
    const runtimeGuards = {
        stackOffsetBounds: { min: offsets[0], max: offsets.at(-1) },
        spOffsetBounds: { min: Math.min(...spOffsets), max: Math.max(...spOffsets) },
        disjointAbsoluteAddresses: addresses,
        disjointExecutableRanges: executableRanges.map(range => ({ ...range })),
    };
    const usable = row => !row.unavailable && row.returnLocations.length > 0;
    const contexts = [...contextRows].map(([key, row]) => ({ ...row, calls: JSON.parse(key)[1] }));
    return { entry, summarySafe: !stackBlockCopies, complete: !gaps.size && exits.length > 0 &&
        [...rows.values()].every(usable),
        contextualComplete: !gaps.size && exits.length > 0 && contexts.every(usable), exits,
        contextRows: contexts,
        frameComplete: !gaps.size && exits.length > 0 && [...frameRows.values()].every(usable),
        frameRows: [...frameRows.values()].sort((a, b) => a.pc - b.pc),
        instructionBytes: [...instructionBytes].sort((a, b) => a[0] - b[0])
            .map(([address, bytes]) => ({ address, bytes })),
        callTargets: [...callTargets].sort((a, b) => a - b), callEdges, exitEffects,
        rows: [...rows.values()].sort((a, b) => a.pc - b.pc), gaps: [...gaps], states: steps,
        runtimeGuards,
        assumptions: ['Entry-relative stack addresses must not wrap the 16-bit address space',
            'Tracked stack span must be disjoint from executable code',
            ...(indirectCalls ? ['Indirect call targets must belong to the validated call-contract set'] : []),
            ...(addresses.length ? ['Tracked stack span must be disjoint from all recorded absolute memory accesses'] : [])] };
}

function proveCallSummaries(image, origin, entries, executableRanges) {
    const candidates = [...new Set(entries)];
    const summaries = new Map(candidates.map(entry => [entry, {
        preservedRegisters: [...recoverableRegisters], clobberedAbsolute: [], clobberedStack: [],
    }]));
    // Greatest fixed point: every retained contract is checked against all paths
    // using contracts no stronger than those checked for its callees.
    for (let iteration = 0; iteration < 64; ++iteration) {
        const indirectSummary = summaries.size === candidates.length && summaries.size ? {
            preservedRegisters: recoverableRegisters.filter(name =>
                [...summaries.values()].every(summary => summary.preservedRegisters.includes(name))),
            clobberedAbsolute: [...new Set([...summaries.values()].flatMap(summary => summary.clobberedAbsolute))],
            clobberedStack: [...new Set([...summaries.values()].flatMap(summary => summary.clobberedStack))],
        } : undefined;
        let changed = false;
        const next = new Map(summaries);
        for (const [entry, prior] of summaries) {
            const analysis = analyseStack(image, origin, entry, executableRanges,
                { callSummaries: summaries, indirectSummary });
            // Current contracts do not carry callee-relative stack access guard spans.
            if (!analysis.summarySafe || !analysis.contextualComplete || !analysis.exits.length ||
                analysis.exits.some(exit => exit.spDelta !== 2)) {
                next.delete(entry);
                changed = true;
                continue;
            }
            const summary = {
                preservedRegisters: prior.preservedRegisters.filter(name =>
                    analysis.exitEffects.every(effect => effect.preservedRegisters.includes(name))),
                clobberedAbsolute: [...new Set([...prior.clobberedAbsolute,
                    ...analysis.exitEffects.flatMap(effect => effect.clobberedAbsolute)])].sort((a, b) => a - b),
                clobberedStack: [...new Set([...prior.clobberedStack,
                    ...analysis.exitEffects.flatMap(effect => effect.clobberedStack)])].sort((a, b) => a - b),
            };
            next.set(entry, summary);
            if (!equal(prior, summary)) changed = true;
        }
        summaries.clear();
        for (const [entry, summary] of next) summaries.set(entry, summary);
        if (!changed) {
            const evidence = new Map();
            const absoluteAddresses = new Set();
            for (const entry of summaries.keys()) {
                const analysis = analyseStack(image, origin, entry, executableRanges,
                    { callSummaries: summaries, indirectSummary });
                for (const code of analysis.instructionBytes) evidence.set(code.address, code.bytes);
                for (const address of analysis.runtimeGuards.disjointAbsoluteAddresses) absoluteAddresses.add(address);
            }
            const proof = { instructionBytes: [...evidence].sort((a, b) => a[0] - b[0])
                .map(([address, bytes]) => ({ address, bytes })),
                absoluteAddresses: [...absoluteAddresses].sort((a, b) => a - b) };
            for (const summary of summaries.values()) Object.assign(summary, proof);
            if (indirectSummary) Object.assign(indirectSummary, proof);
            return { callSummaries: summaries, indirectSummary };
        }
    }
    return { callSummaries: new Map(), summaryGap: 'Call-contract fixed point exceeded 64 iterations' };
}

function analyseFrames(image, origin, entries, executableRanges, options = {}) {
    const frameBudget = options.frameBudget ?? 256;
    if (!Number.isInteger(frameBudget) || frameBudget < 1) {
        throw new Error('Frame-analysis budget must be a positive integer');
    }
    const roots = new Map();
    const pending = [...new Set(entries)];
    const frames = [];
    const gaps = [];
    while (pending.length) {
        const entry = pending.shift();
        if (roots.has(entry)) continue;
        if (roots.size >= frameBudget) {
            gaps.push(`Frame-analysis budget of ${frameBudget} entries exceeded; no full coverage claimed`);
            break;
        }
        const analysis = options.rootAnalyses?.get(entry) ??
            analyseStack(image, origin, entry, executableRanges, options);
        roots.set(entry, analysis);
        frames.push({ entry, complete: analysis.frameComplete, rows: analysis.frameRows,
            instructionBytes: analysis.instructionBytes,
            contextRows: analysis.contextRows,
            callEdges: analysis.callEdges,
            exits: analysis.exits, gaps: analysis.gaps, runtimeGuards: analysis.runtimeGuards,
            assumptions: analysis.assumptions, callTargets: analysis.callTargets });
        for (const target of analysis.callTargets) {
            if (!roots.has(target) && !pending.includes(target)) pending.push(target);
        }
    }
    for (const child of frames) {
        child.parentEdges = [];
        for (const parent of frames) {
            for (const edge of parent.callEdges || []) {
                if (edge.target !== child.entry && !(edge.target === null &&
                    options.callSummaries?.has(child.entry))) continue;
                child.parentEdges.push({ parentEntry: parent.entry, continuation: edge.continuation,
                    parentEntrySpOffsetAtChildEntry: edge.childEntrySpOffset,
                    parentEntrySpOffsetAtContinuation: edge.continuationSpOffset,
                    ...(edge.target === null ? { indirect: true } : {}) });
            }
            for (const callRow of parent.contextRows) {
                if (callRow.pc !== child.entry || callRow.unavailable || callRow.calls.length !== 1 ||
                    callRow.calls[0].target !== child.entry) continue;
                const continuation = callRow.calls[0].continuation;
                const resume = parent.rows.find(row => row.pc === continuation);
                if (!resume || resume.unavailable) continue;
                child.parentEdges.push({ parentEntry: parent.entry, continuation,
                    parentEntrySpOffsetAtChildEntry: callRow.entrySpOffset,
                    parentEntrySpOffsetAtContinuation: resume.entrySpOffset });
            }
        }
        child.parentEdges.sort((a, b) => a.parentEntry - b.parentEntry ||
            a.continuation - b.continuation);
    }
    for (const frame of frames) delete frame.contextRows;
    frames.sort((a, b) => a.entry - b.entry);
    return { roots, frames, gaps };
}

function checkRuntimeGuards(analysis, entrySp) {
    if (!Number.isInteger(entrySp) || entrySp < 0 || entrySp > 65535) {
        return { valid: false, reason: 'Entry SP is outside the Z80 address space' };
    }
    const { min, max } = analysis.runtimeGuards.stackOffsetBounds;
    const low = entrySp + min;
    const high = entrySp + max;
    const sp = analysis.runtimeGuards.spOffsetBounds;
    if (low < 0 || high > 65535 || entrySp + sp.min < 0 || entrySp + sp.max > 65535) {
        return { valid: false, reason: 'Tracked stack or SP arithmetic wraps the address space' };
    }
    if (analysis.runtimeGuards.disjointExecutableRanges.some(range => low < range.end && high >= range.start)) {
        return { valid: false, reason: 'Stack may alias executable code' };
    }
    const alias = analysis.runtimeGuards.disjointAbsoluteAddresses.find(address => address >= low && address <= high);
    if (alias !== undefined) return { valid: false, reason: `Stack may alias absolute address 0x${alias.toString(16)}` };
    return { valid: true };
}

module.exports = { analyseStack, analyseFrames, proveCallSummaries, checkRuntimeGuards };
