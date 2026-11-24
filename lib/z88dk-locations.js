'use strict';

const scopeKey = (depth, block) => `${depth}:${block}`;

// Rebuilds the lexical tree from (depth, block) source-row transitions in code order.
// A known block ID reported at a shallower depth is an exit to that depth, not a new block.
function lexicalScopes(func, sources) {
    const nodes = new Map();
    const deepest = new Map();
    const states = [];
    let current = null;
    for (const source of sources) {
        const depth = source.scope;
        const key = scopeKey(depth, source.block);
        if (nodes.has(key)) {
            current = nodes.get(key);
        } else if ((deepest.get(source.block) ?? -Infinity) > depth) {
            while (current && current.depth > depth) current = current.parent;
        } else {
            let parent = current;
            while (parent && parent.depth >= depth) parent = parent.parent;
            current = { key, depth, block: source.block, parent, ranges: [] };
            nodes.set(key, current);
        }
        deepest.set(source.block, Math.max(deepest.get(source.block) ?? -Infinity, depth));
        if (states.at(-1)?.address === source.address) states.at(-1).node = current;
        else states.push({ address: source.address, node: current });
    }
    for (const [index, state] of states.entries()) {
        const range = func.ranges.find(range => state.address >= range.start && state.address < range.end);
        const end = Math.min(states[index + 1]?.address ?? range.end, range.end);
        for (let node = state.node; node; node = node.parent) {
            const last = node.ranges.at(-1);
            if (last?.end === state.address) last.end = end;
            else node.ranges.push({ start: state.address, end });
        }
    }
    const at = pc => {
        let node = null;
        for (const state of states) {
            if (state.address > pc) break;
            node = state.node;
        }
        return node;
    };
    const contains = (node, key) => {
        for (; node; node = node.parent) if (node.key === key) return true;
        return false;
    };
    return { nodes, at, contains };
}

function analyseLocations(metadata) {
    metadata.warnings = metadata.warnings.filter(warning => !warning.startsWith('Location unavailable for '));
    for (const func of metadata.typed.functions) {
        const frame = metadata.frames.find(frame => frame.entry === func.address);
        const sources = metadata.rows.filter(row => row.module === func.module && row.kind === 'C' &&
            func.ranges.some(range => row.address >= range.start && row.address < range.end))
            .sort((a, b) => a.address - b.address);
        const scopes = lexicalScopes(func, sources);
        func.lexicalBlocks = [];
        for (const variable of func.variables || []) {
            variable.locations = [];
            variable.lexicalBlock = undefined;
            if (variable.location) variable.locationGaps = [];
            const key = scopeKey(variable.sourceScope ?? variable.scope, variable.block);
            // CDB nesting levels 0 and 1 are parameters and the function body; deeper levels are C blocks.
            if (!variable.parameter && variable.scope > 1) {
                const node = scopes.nodes.get(key);
                if (!node?.ranges.length) {
                    variable.locationGaps.push('No source rows identify the declaring lexical block; variable not emitted.');
                    continue;
                }
                variable.lexicalBlock = node;
                if (!func.lexicalBlocks.includes(node)) func.lexicalBlocks.push(node);
            }
            if (!variable.location) continue;
            if (!frame?.complete) {
                variable.locationGaps.push('Independent frame analysis is incomplete.');
                continue;
            }
            if (func.variables.filter(other => other.name === variable.name &&
                scopeKey(other.sourceScope ?? other.scope, other.block) === key).length !== 1) {
                variable.locationGaps.push('Same-named declarations share one lexical scope; no location emitted.');
                continue;
            }
            for (const row of frame.rows) {
                if (row.unavailable) continue;
                const end = row.pc + row.instructionBytes.length / 2;
                if (!func.ranges.some(range => row.pc >= range.start && end <= range.end)) continue;
                const base = variable.location.base;
                const pointers = row.stackPointers.filter(pointer => base.register ?
                    pointer.register === base.register :
                    pointer.address !== undefined && pointer.entryOffset === base.entryOffset);
                const offsets = new Set(pointers.map(pointer => pointer.entryOffset));
                if (offsets.size !== 1) continue;
                const entryOffset = [...offsets][0] + variable.location.offset;
                // Only expose allocated locals, never stack slots already released by an epilogue.
                if (!variable.parameter && (entryOffset < -row.entrySpOffset ||
                    entryOffset + variable.size > 0)) continue;
                if (!variable.parameter && !scopes.contains(scopes.at(row.pc), key)) continue;
                variable.locations.push({ start: row.pc, end, spOffset: row.entrySpOffset + entryOffset });
            }
            if (!variable.locations.length) variable.locationGaps.push('No PC has a proven compiler frame base and variable extent/scope.');
        }
        for (const variable of func.variables || []) {
            for (const gap of variable.locationGaps) {
                const warning = `Location unavailable for ${func.name}.${variable.name} in ${func.module}: ${gap}`;
                if (!metadata.warnings.includes(warning)) metadata.warnings.push(warning);
            }
        }
    }
}

module.exports = { analyseLocations };
