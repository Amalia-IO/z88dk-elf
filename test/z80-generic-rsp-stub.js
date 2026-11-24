'use strict';

const net = require('node:net');
const fs = require('node:fs');
const { machine } = require('./z80-probe-machine');

const mode = process.argv[2];
if (!['scenario', 'valid', 'corrupt-code', 'alias-stack', 'register-return',
    'duplicate-return', 'mismatched-return', 'corrupt-prologue'].includes(mode)) {
    throw new Error(`Unknown RSP fixture mode: ${mode}`);
}

const scenario = mode === 'scenario' ? JSON.parse(fs.readFileSync(process.argv[3], 'utf8')) : undefined;
const memory = Buffer.alloc(65536);
if (scenario) {
    const image = fs.readFileSync(scenario.imagePath);
    image.copy(memory, scenario.origin);
    if (scenario.memoryHex) Buffer.from(scenario.memoryHex, 'hex').copy(memory);
}
const registerReturn = mode === 'register-return';
const duplicateReturn = ['duplicate-return', 'mismatched-return'].includes(mode);
const syntheticImage = registerReturn ? 'cd08013333c90000e3e9' : duplicateReturn ?
    'cd08013333c90000e1e5c9' : 'cd0801c900000000c5013412217856c1c9';
if (!scenario) Buffer.from(syntheticImage, 'hex').copy(memory, 0x100);
const registers = Buffer.alloc(26);
const putWord = (address, value) => memory.writeUInt16LE(value, address);
if (scenario) {
    const registerMap = { af: 0, bc: 2, de: 4, hl: 6, sp: 8, pc: 10, ix: 12, iy: 14,
        "af'": 16, "bc'": 18, "de'": 20, "hl'": 22, ir: 24 };
    for (const [name, value] of Object.entries(scenario.registers || {})) {
        registers.writeUInt16LE(value, registerMap[name]);
    }
    registers.writeUInt16LE(scenario.sp, registerMap.sp);
    registers.writeUInt16LE(scenario.pc, registerMap.pc);
    for (const [address, value] of scenario.words || []) putWord(address, value);
} else {
    if (mode === 'corrupt-code') memory[0x10c] ^= 1;
    if (mode === 'corrupt-prologue') memory[0x108] ^= 1;
    if (registerReturn || duplicateReturn) {
        registers.writeUInt16LE(0xeffe, 8);
        putWord(0xeffe, registerReturn ? 0x5678 : 0x0103);
        putWord(0xf000, registerReturn || duplicateReturn ? 0 : 0x0103);
    } else if (mode === 'alias-stack') {
        registers.writeUInt16LE(0x00fe, 8);
        putWord(0x00fe, 0xbeef);
        putWord(0x0100, 0x0103);
    } else {
        registers.writeUInt16LE(0xeffe, 8);
        putWord(0xeffe, 0xbeef);
        putWord(0xf000, 0x0103);
        putWord(0xf002, 0);
    }
    registers.writeUInt16LE(0x1234, 2);
    registers.writeUInt16LE(0x2468, 4);
    registers.writeUInt16LE(registerReturn ? 0x0103 : mode === 'duplicate-return' ?
        0x0103 : mode === 'mismatched-return' ? 0x0105 : 0x5678, 6);
    registers.writeUInt16LE(registerReturn ? 0x0109 : mode === 'duplicate-return' ||
        mode === 'mismatched-return' ? 0x010a : 0x010c, 10);
    registers.writeUInt16LE(0x9876, 12);
    registers.writeUInt16LE(0xaaaa, 14);
}

const registerNames = ['af', 'bc', 'de', 'hl', 'sp', 'pc', 'ix', 'iy',
    "af'", "bc'", "de'", "hl'", 'ir'];
const executing = scenario?.execute ? machine(memory, Object.fromEntries(registerNames.map(
    (name, index) => [name, registers.readUInt16LE(index * 2)]))) : undefined;
const breakpoints = new Set();
const syncRegisters = () => {
    for (const [name, value] of Object.entries(executing.registers)) {
        registers.writeUInt16LE(value & 0xffff, registerNames.indexOf(name) * 2);
    }
};
const xml = '<?xml version="1.0"?><!DOCTYPE target SYSTEM "gdb-target.dtd">' +
    '<target><architecture>z80</architecture><feature name="org.gnu.gdb.z80.cpu">' +
    registerNames.map((name, index) =>
        `<reg name="${name}" bitsize="16" regnum="${index}"/>`).join('') +
    '</feature></target>';
const server = net.createServer(socket => {
    let input = '';
    socket.on('data', chunk => {
        input += chunk.toString();
        for (;;) {
            const packet = /\$([^#]*)#([0-9a-f]{2})/i.exec(input);
            if (!packet) break;
            input = input.slice(packet.index + packet[0].length);
            const command = packet[1];
            process.stdout.write(`PACKET ${command}\n`);
            let response = '';
            if (command.startsWith('qSupported')) response = 'PacketSize=4000;qXfer:features:read+';
            else if (command.startsWith('qXfer:features:read:target.xml:')) {
                const [, offset, size] = /:([0-9a-f]+),([0-9a-f]+)$/i.exec(command);
                const start = parseInt(offset, 16);
                const end = start + parseInt(size, 16);
                response = (end >= xml.length ? 'l' : 'm') + xml.slice(start, end);
            } else if (command === '?') response = 'T05thread:1;';
            else if (command === 'g') response = registers.toString('hex');
            else if (command.startsWith('m')) {
                const [, address, size] = /^m([0-9a-f]+),([0-9a-f]+)$/i.exec(command);
                response = memory.subarray(parseInt(address, 16),
                    parseInt(address, 16) + parseInt(size, 16)).toString('hex');
            } else if (executing && command.startsWith('M')) {
                const [, address, size, hex] = /^M([0-9a-f]+),([0-9a-f]+):([0-9a-f]+)$/i.exec(command);
                const bytes = Buffer.from(hex, 'hex');
                if (bytes.length !== parseInt(size, 16)) throw new Error('Invalid regression memory write');
                bytes.copy(memory, parseInt(address, 16)); response = 'OK';
            } else if (executing && /^[Zz]0,/.test(command)) {
                const address = parseInt(command.split(',')[1], 16);
                if (command[0] === 'Z') breakpoints.add(address);
                else breakpoints.delete(address);
                response = 'OK';
            } else if (executing && command === 'c') {
                for (let steps = 0; ; ++steps) {
                    if (steps >= 10000) throw new Error('Regression execution exceeded instruction limit');
                    const pc = executing.registers.pc;
                    if (memory[pc] === 0xcd) {
                        process.stdout.write(`EXEC CALL ${memory.readUInt16LE(pc + 1).toString(16)}\n`);
                    }
                    executing.step();
                    if (breakpoints.has(executing.registers.pc)) break;
                    if (executing.registers.pc === 0) throw new Error('Regression returned without a breakpoint');
                }
                syncRegisters(); response = 'T05thread:1;';
            } else if (command === 'qfThreadInfo') response = 'm1';
            else if (command === 'qsThreadInfo') response = 'l';
            else if (command === 'qC') response = 'QC1';
            else if (command.startsWith('H') || command.startsWith('T')) response = 'OK';
            else if (command === 'qAttached') response = '1';
            const checksum = [...Buffer.from(response)].reduce((sum, byte) => (sum + byte) & 255, 0);
            socket.write(`+$${response}#${checksum.toString(16).padStart(2, '0')}`);
        }
    });
    socket.on('close', () => server.close());
});
server.listen(0, '127.0.0.1', () => {
    process.stdout.write(`READY ${server.address().port}\n`);
});
