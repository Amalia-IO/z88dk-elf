'use strict';

module.exports = {
    name: 'sccz80',
    automaticScope(scope) {
        return scope;
    },
    automaticLocation(storage, onStack, offset) {
        if (storage !== 'B' || onStack !== 1) return undefined;
        // Debug CDB offsets exclude the saved debug-frame link below entry SP.
        return { kind: 'frame-stack', base: { entryOffset: -2 }, offset,
            parameter: offset >= 4 };
    },
    evidence(value) {
        return /^F:.*\(\{0\}DF,/.test(value) || /DA(?:-1|\d+)x,/.test(value);
    },
    normalizeType(expression) {
        if (/DA(?:-1|\d+)d,/.test(expression)) {
            throw new Error(`SDCC array encoding in sccz80 metadata: ${expression}`);
        }
        return expression.replace(/DA(-1|\d+)x,/g, 'DA$1d,')
            .replace(/(^|,)DV(?=,|$)/g, '$1SV:S');
    },
    sourceIdentity(identity) {
        const [file, func, scope, block] = identity.trimEnd().split('::');
        return { file, function: func,
            scope: scope === undefined ? undefined : Number(scope),
            block: block === undefined ? undefined : Number(block) };
    },
};
