'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { createHash } = require('node:crypto');

function sourceContent(filename) {
    try {
        return fs.readFileSync(filename);
    } catch (error) {
        if (error.code !== 'ENOENT' && error.code !== 'ENOTDIR') throw error;
        return undefined;
    }
}

function sourceDigest(filename) {
    const content = sourceContent(filename);
    return content === undefined ? null : createHash('sha256').update(content).digest('hex');
}

function presentationRows(rows, sourceRoot, warnings, dependencies) {
    const shared = new Map();
    for (const row of rows.filter(row => row.kind === 'C')) {
        const key = JSON.stringify([row.file, row.address]);
        const group = shared.get(key) || [];
        group.push(row);
        shared.set(key, group);
    }
    const texts = new Map();
    const braces = new Set();
    for (const group of shared.values()) {
        if (new Set(group.map(row => row.line)).size < 2) continue;
        const file = group[0].file;
        if (!texts.has(file)) {
            const filename = path.resolve(sourceRoot, file);
            const content = sourceContent(filename);
            dependencies.set(filename, content === undefined ? null :
                createHash('sha256').update(content).digest('hex'));
            texts.set(file, content?.toString('utf8').split(/\r?\n/));
            if (content === undefined) {
                const warning = `Source unavailable for shared-address line attribution: ${file}; ` +
                    'closing-brace highlights may remain. Run conversion from the source root or use --path-map/--source.';
                if (!warnings.includes(warning)) warnings.push(warning);
            }
        }
        const lines = texts.get(file);
        if (!lines) continue;
        const text = row => lines[row.line - 1]?.trim();
        if (group.some(row => text(row) && !['{', '}'].includes(text(row)))) {
            for (const row of group) if (text(row) === '}') braces.add(row);
        }
    }
    // Only line-table presentation changes; scope analysis keeps the original row order.
    return [...rows].sort((a, b) => a.address - b.address ||
        a.file.localeCompare(b.file) || Number(braces.has(b)) - Number(braces.has(a)));
}

module.exports = { presentationRows, sourceDigest };
