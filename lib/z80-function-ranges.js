'use strict';

function instruction(image, origin, address) {
    let offset = address - origin;
    const start = offset;
    let indexed = false;
    while (image[offset] === 0xdd || image[offset] === 0xfd) {
        indexed = true;
        ++offset;
        if (offset - start > 16) throw new Error(`Excessive index prefixes at 0x${address.toString(16)}`);
    }
    const opcode = image[offset++];
    if (opcode === undefined) return undefined;
    let flow = 'next';
    let target;
    let conditional = false;
    if (opcode === 0xcb) {
        offset += indexed ? 2 : 1;
    } else if (opcode === 0xed) {
        const extended = image[offset++];
        if (extended === undefined) return undefined;
        if ((extended & 0xc7) === 0x43) offset += 2;
        if ((extended & 0xc7) === 0x45) flow = 'return';
    } else {
        const x = opcode >> 6;
        const y = (opcode >> 3) & 7;
        const z = opcode & 7;
        const p = y >> 1;
        const q = y & 1;
        if (x === 0) {
            if (z === 0 && y >= 2) {
                const displacement = image[offset++];
                target = (origin + offset + (displacement < 128 ? displacement : displacement - 256)) & 0xffff;
                flow = 'branch';
                conditional = y !== 3;
            } else if ((z === 1 && !q) || (z === 2 && p >= 2)) offset += 2;
            else if (z === 6) offset += 1 + Number(indexed && y === 6);
            else if (indexed && (z === 4 || z === 5) && y === 6) ++offset;
        } else if (x === 1) {
            if (opcode === 0x76) flow = 'halt';
            else if (indexed && (y === 6 || z === 6)) ++offset;
        } else if (x === 2) {
            if (indexed && z === 6) ++offset;
        } else {
            if (z === 0 || (z === 1 && q && p === 0)) {
                flow = 'return';
                conditional = z === 0;
            } else if (z === 1 && q && p === 2) {
                flow = 'indirect';
            } else if (z === 2 || (z === 3 && y === 0)) {
                target = image[offset] | (image[offset + 1] << 8);
                offset += 2;
                flow = 'branch';
                conditional = z === 2;
            } else if (z === 4 || (z === 5 && q && p === 0)) {
                target = image[offset] | (image[offset + 1] << 8);
                offset += 2;
                flow = 'call';
                conditional = z === 4;
            } else if (z === 7) {
                flow = 'call';
                target = y * 8;
            } else if (z === 6 || (z === 3 && (y === 2 || y === 3))) ++offset;
            // CALL and RST continuations belong to this function; callees do not.
        }
    }
    if (offset > image.length) return undefined;
    return { address, end: origin + offset, flow, target, conditional };
}

function functionRanges(image, origin, entry, entries, bounds) {
    const pending = [{ address: entry, branch: false }];
    const instructions = new Map();
    const occupied = new Map();
    const gaps = [];
    const assumptions = new Set();
    while (pending.length) {
        const { address, branch } = pending.pop();
        if (instructions.has(address)) continue;
        if (address !== entry && entries.has(address)) {
            if (!branch) gaps.push(`Fallthrough into another function at 0x${address.toString(16)}`);
            continue;
        }
        if (address < origin || address >= origin + image.length) {
            gaps.push(`Control flow outside supplied image at 0x${address.toString(16)}`);
            continue;
        }
        if (bounds && (address < bounds.start || address >= bounds.end)) {
            gaps.push(`Control flow outside executable section at 0x${address.toString(16)}`);
            continue;
        }
        const decoded = instruction(image, origin, address);
        if (!decoded || (bounds && decoded.end > bounds.end)) {
            gaps.push(`Truncated instruction at 0x${address.toString(16)}`);
            continue;
        }
        for (let byte = address; byte < decoded.end; ++byte) {
            if (occupied.has(byte) && occupied.get(byte) !== address) {
                throw new Error(`Overlapping instructions at 0x${byte.toString(16)}`);
            }
            occupied.set(byte, address);
        }
        instructions.set(address, decoded);
        if (decoded.flow === 'call') assumptions.add('CALL/RST uses the ordinary return continuation');
        if (decoded.flow === 'indirect') gaps.push(`Indirect jump at 0x${address.toString(16)}`);
        if (decoded.flow === 'halt') gaps.push(`HALT continuation requires interrupt analysis at 0x${address.toString(16)}`);
        if (decoded.flow === 'branch') pending.push({ address: decoded.target, branch: true });
        if (decoded.flow === 'next' || decoded.flow === 'call' || decoded.conditional) {
            pending.push({ address: decoded.end, branch: false });
        }
    }
    const ranges = [];
    for (const decoded of [...instructions.values()].sort((a, b) => a.address - b.address)) {
        const last = ranges.at(-1);
        if (last && last.end === decoded.address) last.end = decoded.end;
        else ranges.push({ start: decoded.address, end: decoded.end });
    }
    return { ranges: gaps.length ? [] : ranges, gaps, assumptions: [...assumptions] };
}

module.exports = { instruction, functionRanges };
