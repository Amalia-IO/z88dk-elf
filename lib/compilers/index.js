'use strict';

const sdcc = require('./sdcc');
const sccz80 = require('./sccz80');
const adapters = { sdcc, sccz80 };

function selectCompilers(records, requested = 'auto') {
    if (requested !== 'auto' && !Object.hasOwn(adapters, requested)) {
        throw new Error(`Unknown compiler ${requested}; expected auto, sdcc or sccz80`);
    }
    const modules = new Map();
    for (const record of records) {
        const evidence = modules.get(record.module) || new Set();
        for (const adapter of Object.values(adapters)) {
            if (adapter.evidence(record.value)) evidence.add(adapter.name);
        }
        modules.set(record.module, evidence);
    }
    const selected = new Map();
    for (const [module, evidence] of modules) {
        if (evidence.size > 1 || (requested !== 'auto' &&
            evidence.size && !evidence.has(requested))) {
            throw new Error(`Conflicting compiler metadata in module ${module}`);
        }
        const name = requested === 'auto' ? [...evidence][0] : requested;
        selected.set(module, name ? adapters[name] : undefined);
    }
    return selected;
}

function normalizeRecords(records, selected) {
    return records.map(record => {
        const adapter = selected.get(record.module);
        if (!adapter && /DA(?:-1|[0-9a-f]+)[xd],/i.test(record.value)) {
            throw new Error(`Ambiguous compiler metadata in module ${record.module}; specify --compiler`);
        }
        const automatic = /^S:L[^$]+\$[^$]+\$(\d+)_(\d+)\$\d+\(\{\d+\}[^)]*\),([^,]+),(\d+),(-?\d+)(?:,|$)/.exec(record.value);
        return { ...record, ...(automatic ? {
            automaticScope: adapter?.automaticScope(Number(automatic[1]), Number(automatic[2])),
            automaticLocation: adapter?.automaticLocation(automatic[3], Number(automatic[4]),
                Number(automatic[5])) } : {}), value: adapter ? record.value.replace(
            /\(\{(-?\d+)\}([^)]*)\)/g,
            (_, size, expression) => `({${size}}${adapter.normalizeType(expression)})`) : record.value };
    });
}

module.exports = { selectCompilers, normalizeRecords };
