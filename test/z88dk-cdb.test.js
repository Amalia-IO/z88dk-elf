'use strict';

const assert = require('node:assert/strict');
const { test } = require('node:test');
const { parseCdb } = require('../lib/z88dk-cdb');
const { selectCompilers, normalizeRecords } = require('../lib/compilers');

const record = (value, module = 'unit') => ({ value, module });
const symbol = (name, address = 0x4000, module = 'unit') =>
    ({ name: `_${name}`, address, module, kind: 'addr', visibility: 'public' });
const variable = (name, size, expression, module = 'unit') =>
    record(`S:G$${name}$0_0$0({${size}}${expression}),E,0,0`, module);

test('code pointers retain function return types without guessing parameter prototypes', () => {
    const model = parseCdb([variable('callback', 2, 'DC,DF,SI:U')], [symbol('callback')]);
    const pointer = model.types[model.globals[0].type];
    assert.equal(pointer.kind, 'pointer');
    const callable = model.types[pointer.target];
    assert.equal(callable.kind, 'function');
    assert.equal(model.types[callable.target].name, 'unsigned int');
    assert.throws(() => parseCdb([variable('callback', 1, 'DC,DF,SI:U')], [symbol('callback')]),
        /Unsupported pointer representation/);
});

test('SDCC scalar, array, pointer and module-scoped structure types are data driven', () => {
    const records = [
        record('T:Funit$node[({0}S:S$value$0_0$0({2}SI:S),Z,0,0)({2}S:S$next$0_0$0({2}DG,STnode:S),Z,0,0)]'),
        variable('root', 4, 'STnode:S'),
        variable('head', 2, 'DG,STnode:S'),
        variable('values', 6, 'DA3d,SI:U'),
        record('T:Fother$node[({0}S:S$value$0_0$0({1}SC:U),Z,0,0)]', 'other'),
        variable('small', 1, 'STnode:S', 'other'),
    ];
    const model = parseCdb(records, [symbol('root'), symbol('head'), symbol('values'),
        symbol('small', 0x4100, 'other')]);
    assert.equal(model.globals.length, 4);
    const root = model.types[model.globals[0].type];
    assert.equal(root.kind, 'struct');
    assert.equal(root.members[1].type, model.globals[1].type);
    assert.equal(model.types[root.members[1].type].target, root.id);
    assert.equal(model.types[model.globals[2].type].count, 3);
    assert.notEqual(model.globals[3].type, root.id);
});

test('unlinked declarations and unsupported local locations never produce invented values', () => {
    const model = parseCdb([
        variable('missing', 2, 'SI:S'),
        record('S:Lunit.func$local$1_0$0({2}SI:S),R,0,0,[l,h]'),
        record('F:G$func$0_0$0({2}DF,SI:S),C,0,0'),
    ], []);
    assert.equal(model.globals.length, 0);
    assert.equal(model.types.length, 0);
    assert.equal(model.warnings.length, 3);
});

test('invalid or unknown linked metadata fails conversion rather than guessing a type', () => {
    assert.throws(() => parseCdb([variable('x', 2, 'unknown')], [symbol('x')]), /Unsupported CDB type/);
    assert.throws(() => parseCdb([variable('x', 1, 'SI:S')], [symbol('x')]), /Invalid scalar size/);
    assert.throws(() => parseCdb([variable('x', 5, 'DA3d,SI:S')], [symbol('x')]), /Invalid array extent/);
    assert.throws(() => parseCdb([variable('x', 2, 'DG,unknown')], [symbol('x')]), /pointee size/);
    assert.throws(() => parseCdb([variable('x', 2, 'SI:S')], [symbol('x'), symbol('x')]),
        /Ambiguous linked variable/);
    assert.throws(() => parseCdb([record('T:Funit$bad[garbled]')], []), /Invalid field metadata/);
});

test('forward-declared or size-less pointees remain explicitly incomplete', () => {
    const model = parseCdb([variable('x', 2, 'DG,STmissing:S')], [symbol('x')]);
    const pointer = model.types[model.globals[0].type];
    assert.equal(model.types[pointer.target].kind, 'incomplete');
    assert.equal(model.types[pointer.target].size, null);
    assert.match(model.warnings[0], /no complete size/);
});

test('compiler adapters normalize to the same shared type model', () => {
    const symbols = [symbol('values')];
    const sdcc = parseCdb([variable('values', 16, 'DA16d,SC:U')], symbols, 'sdcc');
    const sccz80 = parseCdb([variable('values', 16, 'DA16x,SC:U')], symbols, 'sccz80');
    assert.deepEqual(sccz80.types, sdcc.types);
    assert.deepEqual(sccz80.globals, sdcc.globals);
    assert.equal(sccz80.compilers.unit, 'sccz80');
    assert.equal(sdcc.compilers.unit, 'sdcc');
});

test('incomplete array declarations resolve only against matching module definitions', () => {
    const complete = variable('message', 11, 'DA11x,SC:S');
    const incomplete = variable('message', -1, 'DA-1x,SC:S');
    for (const records of [[incomplete, complete], [complete, incomplete]]) {
        const snapshot = JSON.stringify(records);
        const model = parseCdb(records, [symbol('message')]);
        assert.equal(model.globals.length, 1);
        assert.equal(model.globals[0].size, 11);
        assert.equal(model.types[model.globals[0].type].count, 11);
        assert.equal(model.compilers.unit, 'sccz80');
        assert.equal(JSON.stringify(records), snapshot);
    }
    const sdcc = parseCdb([variable('message', -1, 'DA-1d,SC:S'),
        variable('message', 11, 'DA11d,SC:S')], [symbol('message')]);
    assert.equal(sdcc.types[sdcc.globals[0].type].count, 11);
    assert.equal(sdcc.compilers.unit, 'sdcc');
    assert.throws(() => parseCdb([incomplete], [], 'sdcc'), /Conflicting compiler/);
    for (const definitions of [[], [variable('message', 11, 'DA11x,SC:S', 'other')],
        [variable('message', 11, 'DA11x,SC:U')], [complete, complete],
        [complete, variable('message', 11, 'DA11x,SC:U')]]) {
        assert.throws(() => parseCdb([incomplete, ...definitions], [symbol('message')]),
            /Unresolved or ambiguous incomplete array/);
    }
    assert.throws(() => parseCdb([incomplete, variable('message', 5, 'DA3x,SC:S')],
        [symbol('message')]), /Invalid array extent/);
    assert.throws(() => parseCdb([variable('message', -1, 'SC:S')], [symbol('message')]),
        /Invalid incomplete declaration/);
});

test('compiler evidence is resolved per module and contradictory metadata is rejected', () => {
    const model = parseCdb([variable('a', 6, 'DA3d,SI:U', 'left'),
        variable('b', 6, 'DA3x,SI:U', 'right')],
    [symbol('a', 0x4000, 'left'), symbol('b', 0x5000, 'right')]);
    assert.deepEqual(model.compilers, { left: 'sdcc', right: 'sccz80' });
    assert.throws(() => parseCdb([variable('a', 6, 'DA3d,SI:U'),
        variable('b', 6, 'DA3x,SI:U')], []), /Conflicting compiler/);
    assert.throws(() => parseCdb([variable('a', 6, 'DA3d,SI:U')], [], 'sccz80'),
        /Conflicting compiler/);
    assert.throws(() => parseCdb([], [], 'invalid'), /Unknown compiler/);
    assert.equal(parseCdb([variable('a', 2, 'SI:U')], [symbol('a')]).compilers.unit, 'unknown');
});

test('adapters retain compiler source semantics without treating SDCC placeholder as a function', () => {
    const sdcc = selectCompilers([record('F:G$fn$0_0$0({2}DF,SI:S),C,0,0')]).get('unit');
    const sccz80 = selectCompilers([record('F:G$fn$0_0$0({0}DF,SI:S),C,0,0')]).get('unit');
    assert.deepEqual(sdcc.sourceIdentity('file.c::x::2::17\t'),
        { file: 'file.c', scope: 2, block: 17 });
    assert.deepEqual(sccz80.sourceIdentity('file.c::fn::2::17'),
        { file: 'file.c', function: 'fn', scope: 2, block: 17 });
});

test('nested sccz80 type normalization preserves raw records and module identities', () => {
    const records = [record('T:Funit$matrix[({0}S:S$values$0_0$0({32}DA2x,DA16x,SC:U),Z,0,0)]'),
        variable('object', 32, 'STmatrix:S')];
    const raw = JSON.stringify(records);
    const normalized = normalizeRecords(records, selectCompilers(records));
    assert.ok(normalized[0].value.includes('DA2d,DA16d,SC:U'));
    assert.equal(JSON.stringify(records), raw);
    assert.equal(normalized[0].module, records[0].module);
    const model = parseCdb(records, [symbol('object')]);
    const structure = model.types[model.globals[0].type];
    const outer = model.types[structure.members[0].type];
    assert.equal(outer.count, 2);
    assert.equal(model.types[outer.target].count, 16);
});

test('function definitions use linked module identity and decoded return types', () => {
    const definitions = [record('F:G$signed_result$0_0$0({2}DF,SI:S),C,0,0'),
        record('F:Funit$private_result$0_0$0({2}DF,DG,SI:U),C,0,0')];
    const privateSymbol = { ...symbol('private_result'), visibility: 'local', address: 0x4100 };
    const model = parseCdb(definitions, [symbol('signed_result'), privateSymbol], 'sdcc');
    assert.equal(model.functions.length, 2);
    assert.equal(model.types[model.functions[0].returnType].name, 'int');
    assert.equal(model.types[model.functions[1].returnType].kind, 'pointer');
    assert.equal(model.functions[1].external, false);
    assert.deepEqual(model.functions[0].ranges, []);
    assert.throws(() => parseCdb(definitions, [symbol('signed_result'), symbol('signed_result')]),
        /Ambiguous linked function/);
    const voidResult = parseCdb([record('F:G$done$0_0$0({0}DF,DV),C,0,0')],
        [symbol('done')], 'sccz80');
    assert.equal(voidResult.types[voidResult.functions[0].returnType].kind, 'void');
});

test('automatic declarations retain compiler stack bases, types and lexical identities', () => {
    for (const compiler of ['sdcc', 'sccz80']) {
        const model = parseCdb([
            record(`F:G$func$0_0$0({${compiler === 'sdcc' ? 2 : 0}}DF,SI:U),C,0,0`),
            record('S:Lfile.c.func$argument$0_0$0({2}SI:U),B,1,4'),
            record('S:Lfile.c.func$local$1_0$3({2}SI:S),B,1,-2'),
            record('S:Lfile.c.func$register_local$1_0$3({2}SI:U),R,0,0,[l,h]'),
        ], [symbol('func')], compiler);
        const [parameter, local, unavailable] = model.functions[0].variables;
        assert.equal(parameter.parameter, true);
        assert.equal(local.parameter, false);
        assert.equal(local.block, 3);
        assert.equal(local.scope, 1);
        assert.equal(local.sourceScope, compiler === 'sdcc' ? 10000 : 1);
        assert.equal(model.types[parameter.type].name, 'unsigned int');
        assert.equal(model.types[local.type].name, 'int');
        assert.deepEqual(parameter.location.base, compiler === 'sdcc' ?
            { register: 'ix' } : { entryOffset: -2 });
        assert.equal(unavailable.locations.length, 0);
        assert.match(unavailable.locationGaps[0], /lifetimes are not proven/);
    }
});

test('SDCC packed source scopes preserve both CDB lexical components', () => {
    const records = [record('F:G$func$0_0$0({2}DF,SI:U),C,0,0'),
        record('S:Llocals_c.func$local$2_3$7({2}SI:U),B,1,-2')];
    const adapters = selectCompilers(records);
    const normalized = normalizeRecords(records, adapters);
    assert.equal(normalized[1].automaticScope, 20003);
    assert.equal(adapters.get('unit').sourceIdentity('locals.c::x::20003::7\t').scope,
        normalized[1].automaticScope);
});

test('automatic declarations contribute recorded sizes for pointer targets', () => {
    const model = parseCdb([
        record('F:G$func$0_0$0({2}DF,SI:U),C,0,0'),
        record('S:Lfile.c.func$values$1_0$3({6}DA3d,SI:U),B,1,-6'),
        record('S:Lfile.c.func$pointer$1_0$3({2}DG,DA3d,SI:U),B,1,-8'),
    ], [symbol('func')], 'sdcc');
    const [array, pointer] = model.functions[0].variables;
    assert.equal(model.types[pointer.type].target, array.type);
});
