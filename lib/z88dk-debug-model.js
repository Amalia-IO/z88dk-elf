'use strict';

function check(condition, message) {
    if (!condition) throw new Error(message);
}

const scalarTypes = {
    SC: { name: 'char', size: 1 }, SI: { name: 'int', size: 2 },
    SS: { name: 'short', size: 2 }, SL: { name: 'long', size: 4 },
    SF: { name: 'float', size: 4, encoding: 4 },
};

function buildDebugModel(records, symbols) {
    const structures = new Map();
    const declarations = [];
    const functionDeclarations = [];
    const automaticDeclarations = [];
    const warnings = [];
    for (const record of records) {
        if (record.value.startsWith('F:')) {
            const match = /^F:([GF])[^$]*\$([^$]+)\$[^()]*\(\{\d+\}DF,([^)]*)\),C,/.exec(record.value);
            check(match, `Invalid function metadata: ${record.value}`);
            functionDeclarations.push({ module: record.module, scope: match[1],
                name: match[2], expression: match[3] });
        } else if (record.value.startsWith('T:')) {
            const match = /^T:F[^$]*\$([^\[]+)\[(.*)\]$/.exec(record.value);
            check(match, `Invalid structure metadata: ${record.value}`);
            const fields = [];
            const pattern = /\(\{(\d+)\}S:S\$([^$]+)\$[^()]*\(\{(\d+)\}([^)]*)\),Z,0,0\)/y;
            let position = 0;
            while (position < match[2].length) {
                pattern.lastIndex = position;
                const field = pattern.exec(match[2]);
                check(field, `Invalid field metadata in ${match[1]}`);
                fields.push({ offset: Number(field[1]), name: field[2],
                    size: Number(field[3]), expression: field[4] });
                position = pattern.lastIndex;
            }
            const key = `${record.module}:${match[1]}`;
            check(!structures.has(key), `Duplicate structure metadata: ${key}`);
            structures.set(key, fields);
        } else if (record.value.startsWith('S:L')) {
            const match = /^S:L(.+)\.([^.$]+)\$([^$]+)\$(\d+)_(\d+)\$(\d+)\(\{(\d+)\}([^)]*)\),/.exec(record.value);
            check(match, `Invalid automatic variable metadata: ${record.value}`);
            automaticDeclarations.push({ module: record.module, function: match[2], name: match[3],
                scope: Number(match[4]), level: Number(match[5]), block: Number(match[6]),
                sourceScope: record.automaticScope,
                size: Number(match[7]), expression: match[8], location: record.automaticLocation });
        } else if (/^S:[GF]/.test(record.value)) {
            const match = /^S:([GF])[^$]*\$([^$]+)\$[^()]*\(\{(-?\d+)\}([^)]*)\),([^,]+),/.exec(record.value);
            check(match, `Invalid variable metadata: ${record.value}`);
            if (match[4].startsWith('DF,')) continue;
            declarations.push({ module: record.module, scope: match[1],
                name: match[2], size: Number(match[3]), expression: match[4], storage: match[5] });
        }
    }

    const incompleteDeclarations = declarations.filter(declaration => declaration.size === -1);
    for (const declaration of incompleteDeclarations) {
        const array = /^DA-1d,(.+)$/.exec(declaration.expression);
        check(array, `Invalid incomplete declaration: ${declaration.module}:${declaration.name}`);
        const matches = declarations.filter(other => other.module === declaration.module &&
            other.scope === declaration.scope && other.name === declaration.name &&
            other.size > 0);
        check(matches.length === 1 && matches[0].storage === declaration.storage &&
            /^DA\d+d,/.test(matches[0].expression) &&
            matches[0].expression.replace(/^DA\d+d,/, '') === array[1],
            `Unresolved or ambiguous incomplete array: ${declaration.module}:${declaration.name}`);
        declarations.splice(declarations.indexOf(declaration), 1);
    }

    const types = [];
    const typeIds = new Map();
    function type(expression, size, module) {
        const key = `${module}:${size}:${expression}`;
        if (typeIds.has(key)) return typeIds.get(key);
        const id = types.length;
        const descriptor = { id, expression, size, module };
        typeIds.set(key, id);
        types.push(descriptor);
        const scalar = /^(SC|SI|SS|SL|SF):([US])$/.exec(expression);
        const pointer = /^D[GC],(.+)$/.exec(expression);
        const functionType = /^DF,(.+)$/.exec(expression);
        const array = /^DA(\d+)d,(.+)$/.exec(expression);
        const structure = /^ST([^:]+):[US]$/.exec(expression);
        if (scalar) {
            const definition = scalarTypes[scalar[1]];
            check(size === definition.size, `Invalid scalar size: ${expression}, ${size}`);
            const unsigned = scalar[2] === 'U' && !definition.encoding;
            Object.assign(descriptor, { kind: 'scalar',
                name: `${unsigned ? 'unsigned ' : ''}${definition.name}`,
                encoding: definition.encoding || (scalar[1] === 'SC' ? (unsigned ? 8 : 6) :
                    (unsigned ? 7 : 5)) });
        } else if (expression === 'SV:S' || expression === 'SV:U') {
            check(size === 0, `Invalid void size: ${size}`);
            Object.assign(descriptor, { kind: 'void', name: 'void' });
        } else if (functionType) {
            const scalar = /^([^:]+):[US]$/.exec(functionType[1]);
            const returnSize = /^D[GC],/.test(functionType[1]) ? 2 :
                functionType[1].startsWith('SV:') ? 0 :
                scalarTypes[scalar?.[1]]?.size;
            check(returnSize !== undefined, `Unsupported function-pointer return layout: ${expression}`);
            Object.assign(descriptor, { kind: 'function', target: type(functionType[1], returnSize, module) });
        } else if (pointer) {
            check(size === 2, `Unsupported pointer representation: ${expression}, ${size}`);
            const targetScalar = /^([^:]+):[US]$/.exec(pointer[1]);
            let targetSize;
            if (/^D[GC],/.test(pointer[1])) targetSize = 2;
            else if (pointer[1].startsWith('DF,')) targetSize = 0;
            else if (pointer[1].startsWith('SV:')) targetSize = 0;
            else if (targetScalar && scalarTypes[targetScalar[1]]) targetSize = scalarTypes[targetScalar[1]].size;
            else {
                const known = [...declarations, ...automaticDeclarations].filter(declaration => declaration.module === module &&
                    declaration.expression === pointer[1]);
                const sizes = new Set(known.map(declaration => declaration.size));
                check(sizes.size <= 1, `Ambiguous pointee size for ${expression}`);
                check(sizes.size || /^ST([^:]+):[US]$/.test(pointer[1]),
                    `Missing pointee size for ${expression}`);
                targetSize = sizes.size ? [...sizes][0] : null;
            }
            Object.assign(descriptor, { kind: 'pointer', target: type(pointer[1], targetSize, module) });
        } else if (array) {
            const count = Number(array[1]);
            check(Number.isSafeInteger(count) && count > 0 && size > 0 && size % count === 0,
                `Invalid array extent: ${expression}, ${size}`);
            Object.assign(descriptor, { kind: 'array', count,
                target: type(array[2], size / count, module) });
        } else if (structure) {
            if (size === null) {
                Object.assign(descriptor, { kind: 'incomplete', name: structure[1] });
                warnings.push(`Pointee ${structure[1]} in ${module} has no complete size in CDB; emitted as an incomplete type.`);
                return id;
            }
            const fields = structures.get(`${module}:${structure[1]}`);
            check(fields, `Missing structure definition for ${expression} in ${module}`);
            check(size > 0 && new Set(fields.map(field => field.name)).size === fields.length,
                `Invalid structure definition for ${expression}`);
            let end = 0;
            for (const field of fields) {
                check(field.size > 0 && field.offset >= end && field.offset + field.size <= size,
                    `Invalid field layout: ${structure[1]}.${field.name}`);
                end = field.offset + field.size;
            }
            Object.assign(descriptor, { kind: 'struct', name: structure[1], members: fields.map(field => ({
                name: field.name, offset: field.offset,
                type: type(field.expression, field.size, module),
            })) });
        } else {
            throw new Error(`Unsupported CDB type ${expression}`);
        }
        return id;
    }

    const globals = [];
    let unlinked = 0;
    for (const declaration of declarations) {
        const candidates = symbols.filter(symbol => symbol.kind === 'addr' &&
            symbol.name === `_${declaration.name}` &&
            (declaration.scope === 'G' ? symbol.visibility === 'public' :
                symbol.module === declaration.module && symbol.visibility === 'local'));
        if (!candidates.length) {
            ++unlinked;
            continue;
        }
        check(candidates.length === 1, `Ambiguous linked variable ${declaration.name}`);
        check(declaration.storage === 'E' || declaration.storage === 'D',
            `Unsupported static storage ${declaration.storage}: ${declaration.name}`);
        check(declaration.size > 0 && candidates[0].address + declaration.size <= 65536,
            `Invalid linked variable extent: ${declaration.name}`);
        globals.push({ name: declaration.name, module: declaration.module, address: candidates[0].address,
            size: declaration.size, type: type(declaration.expression, declaration.size, declaration.module),
            external: declaration.scope === 'G' });
    }
    if (unlinked) warnings.push(`${unlinked} data declarations have no linked storage and are not emitted.`);
    const functions = [];
    for (const declaration of functionDeclarations) {
        const candidates = symbols.filter(symbol => symbol.kind === 'addr' &&
            symbol.name === `_${declaration.name}` && symbol.module === declaration.module &&
            symbol.visibility === (declaration.scope === 'G' ? 'public' : 'local'));
        if (!candidates.length) {
            warnings.push(`Function ${declaration.name} in ${declaration.module} has no linked entry and is not emitted.`);
            continue;
        }
        check(candidates.length === 1, `Ambiguous linked function ${declaration.name} in ${declaration.module}`);
        check(!functions.some(func => func.module === declaration.module && func.name === declaration.name),
            `Duplicate function definition ${declaration.name} in ${declaration.module}`);
        const expression = declaration.expression;
        const scalar = /^([^:]+):[US]$/.exec(expression);
        const size = /^D[GC],/.test(expression) ? 2 : expression.startsWith('SV:') ? 0 :
            scalarTypes[scalar?.[1]]?.size;
        check(size !== undefined, `Unsupported function return layout: ${expression}`);
        functions.push({ name: declaration.name, module: declaration.module,
            address: candidates[0].address, section: candidates[0].section,
            external: declaration.scope === 'G', returnType: type(expression, size, declaration.module),
            ranges: [] });
    }
    for (const declaration of automaticDeclarations) {
        const func = functions.find(func => func.module === declaration.module &&
            func.name === declaration.function);
        if (!func) {
            warnings.push(`Automatic ${declaration.function}.${declaration.name} in ${declaration.module} has no linked function and is not emitted.`);
            continue;
        }
        const variable = { ...declaration, type: type(declaration.expression, declaration.size, declaration.module),
            parameter: Boolean(declaration.location?.parameter), locations: [], locationGaps: [] };
        if (!declaration.location) variable.locationGaps.push('Compiler metadata has no supported stack location; register allocation lifetimes are not proven.');
        (func.variables ||= []).push(variable);
    }
    return { types, globals, functions, warnings };
}

module.exports = { buildDebugModel };
