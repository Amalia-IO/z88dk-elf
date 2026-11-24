'use strict';

const fs = require('node:fs');
const path = require('node:path');

function fixture(directory) {
    const encode = value => [...Buffer.from(value)].map(byte =>
        /[a-z0-9]/i.test(String.fromCharCode(byte)) ? String.fromCharCode(byte) :
            `_${byte.toString(16).padStart(2, '0')}`).join('');
    const record = (name, address, kind = 'addr') =>
        `${name} = $${address.toString(16)} ; ${kind}, public, , unit, code_user,`;
    const image = path.join(directory, 'PROGRAM.COM');
    const map = path.join(directory, 'program.map');
    const output = path.join(directory, 'program.debug.elf');
    const bytes = Buffer.from('cd0801c900000000c5013412217856c1c9', 'hex');
    fs.writeFileSync(image, bytes);
    fs.writeFileSync(map, [
        record('__head', 0x100, 'const'), record('__tail', 0x100 + bytes.length, 'const'),
        record('__code_user_head', 0x100, 'const'),
        record('__code_user_tail', 0x100 + bytes.length, 'const'),
        record('_main', 0x100), record('_callee', 0x108),
        record(`__CDBINFO__${encode('F:G$main$0_0$0({2}DF,SV:S),C,0,0')}`, 1, 'const'),
        record(`__CDBINFO__${encode('F:G$callee$0_0$0({2}DF,SI:S),C,0,0')}`, 1, 'const'),
        record(`__C_LINE_1_${encode('main.c::main::1::0')}`, 0x100, 'const'),
        record(`__C_LINE_2_${encode('main.c::callee::1::0')}`, 0x108, 'const'),
    ].join('\n'));
    return { image, map, output };
}

module.exports = { fixture };
