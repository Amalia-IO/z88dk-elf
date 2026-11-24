'use strict';

// Bounded instruction execution for regressions, not a general Z80 emulator.
function machine(memory, initial) {
    const registers = { af: 0, bc: 0, de: 0, hl: 0, ix: 0, iy: 0,
        "bc'": 0, "de'": 0, "hl'": 0, ...initial };
    const word = address => memory.readUInt16LE(address);
    const push = value => {
        registers.sp -= 2;
        memory.writeUInt16LE(value & 0xffff, registers.sp);
    };
    const pop = () => {
        const value = word(registers.sp);
        registers.sp += 2;
        return value;
    };
    const byte = index => {
        const pair = ['bc', 'bc', 'de', 'de', 'hl', 'hl', null, 'af'][index];
        if (index === 6) return memory[registers.hl];
        return (registers[pair] >> (index % 2 === 0 || index === 7 ? 8 : 0)) & 255;
    };
    const setByte = (index, value) => {
        const pair = ['bc', 'bc', 'de', 'de', 'hl', 'hl', null, 'af'][index];
        if (index === 6) memory[registers.hl] = value;
        else {
            const high = index % 2 === 0 || index === 7;
            registers[pair] = high ? (value << 8) | (registers[pair] & 255) :
                (registers[pair] & 0xff00) | value;
        }
    };
    let zero = false;
    let carry = false;
    const step = () => {
        const pc = registers.pc;
        const op = memory[pc];
        let next = pc + 1;
        if ([0x01, 0x11, 0x21, 0x31].includes(op)) {
            registers[['bc', 'de', 'hl', 'sp'][op >> 4]] = word(pc + 1);
            next += 2;
        } else if ([0xc5, 0xd5, 0xe5, 0xf5].includes(op)) {
            push(registers[['bc', 'de', 'hl', 'af'][(op >> 4) - 12]]);
        } else if ([0xc1, 0xd1, 0xe1, 0xf1].includes(op)) {
            registers[['bc', 'de', 'hl', 'af'][(op >> 4) - 12]] = pop();
        } else if (op === 0x22) {
            memory.writeUInt16LE(registers.hl, word(pc + 1)); next += 2;
        } else if (op === 0x2a) {
            registers.hl = word(word(pc + 1)); next += 2;
        } else if (op === 0x02 || op === 0x12) {
            memory[registers[op === 0x02 ? 'bc' : 'de']] = byte(7);
        } else if (op === 0x0a || op === 0x1a) {
            setByte(7, memory[registers[op === 0x0a ? 'bc' : 'de']]);
        } else if ((op & 0xc7) === 0x06) {
            setByte((op >> 3) & 7, memory[pc + 1]); next++;
        } else if (op >= 0x40 && op <= 0x7f && op !== 0x76) {
            setByte((op >> 3) & 7, byte(op & 7));
        } else if ([0x03, 0x13, 0x23, 0x33, 0x0b, 0x1b, 0x2b, 0x3b].includes(op)) {
            const pair = ['bc', 'de', 'hl', 'sp'][(op >> 4) & 3];
            registers[pair] = (registers[pair] + ((op & 8) ? -1 : 1)) & 0xffff;
        } else if ([0x09, 0x19, 0x29, 0x39].includes(op)) {
            const result = registers.hl + registers[['bc', 'de', 'hl', 'sp'][op >> 4]];
            carry = result > 0xffff; registers.hl = result & 0xffff;
        } else if (op === 0xeb) {
            [registers.de, registers.hl] = [registers.hl, registers.de];
        } else if (op === 0xe3) {
            const value = word(registers.sp);
            memory.writeUInt16LE(registers.hl, registers.sp); registers.hl = value;
        } else if (op === 0xf9) registers.sp = registers.hl;
        else if (op === 0xd9) {
            for (const name of ['bc', 'de', 'hl']) {
                [registers[name], registers[`${name}'`]] = [registers[`${name}'`], registers[name]];
            }
        }
        else if (op === 0xb5 || op === 0xa7) {
            const value = op === 0xb5 ? byte(7) | byte(5) : byte(7);
            setByte(7, value); zero = value === 0; carry = false;
        } else if (op === 0xcd) {
            push(pc + 3); next = word(pc + 1);
        } else if (op === 0xc9) next = pop();
        else if ([0xc3, 0xca, 0xc2, 0xd2, 0xda].includes(op)) {
            const taken = op === 0xc3 || (op === 0xca ? zero : op === 0xc2 ? !zero :
                op === 0xd2 ? !carry : carry);
            next = taken ? word(pc + 1) : pc + 3;
        } else if (op === 0xe9) next = registers.hl;
        else if (op === 0xed && memory[pc + 1] === 0x52) {
            const result = registers.hl - registers.de - Number(carry);
            registers.hl = result & 0xffff; carry = result < 0; zero = registers.hl === 0;
            next++;
        } else if (op === 0xed && memory[pc + 1] === 0xb0) {
            const count = registers.bc || 65536;
            for (let index = 0; index < count; ++index) {
                memory[registers.de] = memory[registers.hl];
                registers.de = (registers.de + 1) & 0xffff;
                registers.hl = (registers.hl + 1) & 0xffff;
            }
            registers.bc = 0; next++;
        } else {
            throw new Error(`Unsupported regression instruction 0x${op.toString(16)} at 0x${pc.toString(16)}`);
        }
        registers.pc = next;
    };
    return { registers, step, word };
}

module.exports = { machine };
