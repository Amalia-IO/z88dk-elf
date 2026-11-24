'use strict';

const { selectCompilers, normalizeRecords } = require('./compilers');
const { buildDebugModel } = require('./z88dk-debug-model');

function parseCdb(records, symbols, compiler = 'auto', sourceModules = []) {
    const selected = selectCompilers([...records,
        ...sourceModules.map(module => ({ module, value: '' }))], compiler);
    const model = buildDebugModel(normalizeRecords(records, selected), symbols);
    model.compilers = Object.fromEntries([...selected].map(([module, adapter]) =>
        [module, adapter?.name || 'unknown']));
    for (const [module, adapter] of selected) {
        if (!adapter) model.warnings.push(
            `Compiler for module ${module} is unknown; only compiler-neutral metadata is interpreted. Use --compiler if known.`);
    }
    return model;
}

module.exports = { parseCdb };
