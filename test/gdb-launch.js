'use strict';

const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');

function command(executable, args) {
    if (process.platform !== 'win32' || !process.env.Z80_GDB_WSL_DISTRO) {
        return { executable, args };
    }
    return { executable: 'wsl.exe',
        args: ['-d', process.env.Z80_GDB_WSL_DISTRO, '-e', executable, ...args] };
}

function targetPath(filename) {
    if (process.platform !== 'win32' || !process.env.Z80_GDB_WSL_DISTRO) return filename;
    const spec = command('wslpath', ['-u', filename]);
    const result = spawnSync(spec.executable, spec.args, { encoding: 'utf8', timeout: 10000 });
    assert.equal(result.status, 0, result.error?.message || result.stderr);
    return result.stdout.trim();
}

function gdbCommand(args) {
    assert.ok(process.env.Z80_GDB, 'Set Z80_GDB to a Python-enabled Z80 GDB executable');
    return command(process.env.Z80_GDB, args);
}

function runGdb(elfFile, commands) {
    const spec = gdbCommand(['-nx', '-q', '-batch', targetPath(elfFile),
        ...commands.flatMap(value => ['-ex', value])]);
    const result = spawnSync(spec.executable, spec.args, { encoding: 'utf8', timeout: 30000 });
    assert.equal(result.status, 0, result.error?.message || result.stdout + result.stderr);
    assert.doesNotMatch(result.stderr,
        /Error in sourced|No symbol|No source|Dwarf Error|Internal error|not in symtab/i);
    return result;
}

module.exports = { command, targetPath, gdbCommand, runGdb };
