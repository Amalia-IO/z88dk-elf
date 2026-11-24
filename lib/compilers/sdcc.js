'use strict';

module.exports = {
    name: 'sdcc',
    automaticScope(scope, level) {
        // z88dk's sdcc_opt.1 packs both CDB components into its C_LINE scope.
        return scope * 10000 + level;
    },
    automaticLocation(storage, onStack, offset) {
        if (storage !== 'B' || onStack !== 1) return undefined;
        return { kind: 'frame-stack', base: { register: 'ix' }, offset,
            parameter: offset >= 4 };
    },
    evidence(value) {
        return /^F:.*\(\{2\}DF,/.test(value) || /DA(?:-1|\d+)d,/.test(value);
    },
    normalizeType(expression) {
        if (/DA(?:-1|[0-9a-f]+)x,/i.test(expression)) {
            throw new Error(`sccz80 array encoding in SDCC metadata: ${expression}`);
        }
        return expression;
    },
    sourceIdentity(identity) {
        const [file, , scope, block] = identity.trimEnd().split('::');
        return { file, scope: scope === undefined ? undefined : Number(scope),
            block: block === undefined ? undefined : Number(block) };
    },
};
