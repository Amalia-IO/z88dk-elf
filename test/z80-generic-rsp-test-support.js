'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { command, targetPath, gdbCommand } = require('./gdb-launch');

async function runGenericGdb(elfPath, scenario, commands = ['bt 4', 'frame 1',
    'info registers bc sp pc']) {
    let payloadPath;
    let payloadDirectory;
    let mode;
    if (typeof scenario === 'string') mode = scenario;
    else {
        mode = 'scenario';
        payloadDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'z80-generic-rsp-'));
        payloadPath = path.join(payloadDirectory, 'scenario.json');
        fs.writeFileSync(payloadPath, JSON.stringify({ ...scenario, imagePath: targetPath(scenario.imagePath) }));
    }
    const stubPath = targetPath(path.join(__dirname, 'z80-generic-rsp-stub.js'));
    const args = [stubPath, mode];
    if (payloadPath) args.push(targetPath(payloadPath));
    const stubCommand = command(process.env.Z80_GDB_WSL_DISTRO ? 'node' : process.execPath, args);
    const stub = spawn(stubCommand.executable, stubCommand.args);
    let stubOutput = '';
    let readyResolve;
    let readyReject;
    const ready = new Promise((resolve, reject) => { readyResolve = resolve; readyReject = reject; });
    let readyTimer = setTimeout(() => readyReject(new Error(`RSP stub failed to start: ${stubOutput}`)), 10000);
    stub.stdout.on('data', chunk => {
        stubOutput += chunk;
        const match = /READY (\d+)/.exec(stubOutput);
        if (match) readyResolve(Number(match[1]));
    });
    stub.stderr.on('data', chunk => { stubOutput += chunk; });
    stub.on('error', readyReject);
    stub.on('exit', code => readyReject(new Error(`RSP stub exited (${code}): ${stubOutput}`)));
    let child;
    let timer;
    try {
        const port = await ready;
        clearTimeout(readyTimer);
        readyTimer = undefined;
        const sourcePath = targetPath(path.join(__dirname, '..', 'gdb', 'z80-generic-unwinder.py'));
        const elfTargetPath = targetPath(elfPath);
        const gdbCommands = [`file "${elfTargetPath.replace(/\\/g, '/')}"`, `source ${sourcePath}`,
            `target remote 127.0.0.1:${port}`, ...commands, 'disconnect'];
        const spec = gdbCommand(['-nx', '-q', '-batch',
            ...gdbCommands.flatMap(value => ['-ex', value])]);
        child = spawn(spec.executable, spec.args);
        let output = '';
        child.stdout.on('data', chunk => { output += chunk; });
        child.stderr.on('data', chunk => { output += chunk; });
        timer = setTimeout(() => child.kill(), 30000);
        const status = await new Promise((resolve, reject) => {
            child.on('error', reject);
            child.on('close', resolve);
        });
        assert.equal(status, 0, output + '\nLoopback stub:\n' + stubOutput);
        const packets = [...stubOutput.matchAll(/^PACKET (.*)$/gm)].map(match => match[1]);
        return { output, packets, stubOutput, memoryReadBytes: packets.filter(packet => packet.startsWith('m'))
            .reduce((total, packet) => total + Number.parseInt(packet.split(',')[1], 16), 0) };
    } finally {
        clearTimeout(readyTimer);
        clearTimeout(timer);
        if (child && child.exitCode === null) child.kill();
        if (stub.exitCode === null) stub.kill();
        if (payloadPath && fs.existsSync(payloadPath)) fs.unlinkSync(payloadPath);
        if (payloadDirectory && fs.existsSync(payloadDirectory)) fs.rmdirSync(payloadDirectory);
    }
}

module.exports = { runGenericGdb };
