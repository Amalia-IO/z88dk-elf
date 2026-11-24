'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { test } = require('node:test');
const { createHash } = require('node:crypto');
const { convert } = require('../lib/z88dk-elf');
const { incremental } = require('../make/debug-elf');
const { fixture } = require('./fixture');
const { command, targetPath, gdbCommand } = require('./gdb-launch');
const root = path.resolve(__dirname, '..');
const cli = path.join(root, 'bin', 'z88dk-elf.js');

test('CLI exposes help, version and installed support directory; bad flags fail explicitly', () => {
    for (const [flag, expected] of [['--help', /IMAGE RAW_MAP OUTPUT_ELF/],
        ['--version', /^0\.1\.0/], ['--support-dir', /z88dk-elf/]]) {
        const result = spawnSync(process.execPath, [cli, flag], { encoding: 'utf8' });
        assert.equal(result.status, 0, result.stderr);
        assert.match(result.stdout, expected);
    }
    const result = spawnSync(process.execPath, [cli, '--invalid'], { encoding: 'utf8' });
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /conversion failed.*Usage/);
});

test('converted pairs carry producer/schema and ELF identity, preserve inputs and invalidate failed replacement', () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'elf-pair-'));
    try {
        const { image, map, output } = fixture(directory);
        const metadata = convert(image, map, output);
        assert.equal(metadata.schemaVersion, 1);
        assert.equal(metadata.producer.version, '0.1.0');
        assert.equal(metadata.elfSha256,
            createHash('sha256').update(fs.readFileSync(output)).digest('hex'));
        assert.deepEqual(JSON.parse(fs.readFileSync(`${output}.metadata.json`)),
            JSON.parse(JSON.stringify(metadata)));
        assert.throws(() => convert(image, map, image), /overwrite an input/);
        const input = fs.readFileSync(image);
        assert.throws(() => convert(image, map, image.toUpperCase()),
            process.platform === 'win32' ? /overwrite an input/ : /ENOENT/);
        assert.deepEqual(fs.readFileSync(image), input);
        fs.unlinkSync(output);
        fs.mkdirSync(output);
        assert.throws(() => convert(image, map, output));
        assert.equal(fs.existsSync(`${output}.metadata.json`), false);
        assert.equal(fs.readdirSync(directory).some(name => name.startsWith('.z88dk-elf-')), false);
    } finally {
        fs.rmSync(directory, { recursive: true });
    }
});

test('Make cache detects no-op, inputs/options/dependencies, missing or edited outputs and failures', () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'elf-make-space '));
    try {
        const { image, map, output } = fixture(directory);
        const dependency = path.join(directory, 'extra.c');
        fs.writeFileSync(dependency, 'first');
        const args = ['--dep', dependency, '--', image, map, output, '--origin', '0100'];
        assert.equal(incremental(args), true);
        const before = fs.statSync(output).mtimeMs;
        assert.equal(incremental(args), false);
        assert.equal(fs.statSync(output).mtimeMs, before);
        fs.writeFileSync(dependency, 'second');
        assert.equal(incremental(args), true);
        assert.equal(incremental([...args, '--compiler', 'sdcc']), true);
        fs.unlinkSync(`${output}.metadata.json`);
        assert.equal(incremental(args), true);
        fs.unlinkSync(output);
        assert.equal(incremental(args), true);
        fs.appendFileSync(output, 'tampered');
        assert.equal(incremental(args), true);
        fs.appendFileSync(map, '\n');
        assert.equal(incremental(args), true);
        fs.writeFileSync(`${output}.z88dk-elf-state.json`, '{bad');
        assert.equal(incremental(args), true);
        fs.writeFileSync(image, Buffer.alloc(0));
        assert.throws(() => incremental(args), /Conversion failed/);
        assert.equal(fs.existsSync(`${output}.z88dk-elf-state.json`), false);
    } finally {
        fs.rmSync(directory, { recursive: true });
    }
});

test('GNU Make include handles a project path with spaces and parallel downstream consumers',
    { skip: process.platform === 'win32' && !process.env.Z80_GDB_WSL_DISTRO }, () => {
        const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'elf make space '));
        try {
            const inputs = path.join(directory, 'input space');
            fs.mkdirSync(inputs);
            fixture(inputs);
            const output = path.join(directory, 'output space', 'program.debug.elf');
            const support = targetPath(root).replace(/\\/g, '/');
            fs.writeFileSync(path.join(directory, 'Makefile'), `Z88DK_ELF_ROOT := ${support}
Z88DK_ELF_IMAGE := input space/PROGRAM.COM
Z88DK_ELF_MAP := input space/program.map
Z88DK_ELF_OUTPUT := output space/program.debug.elf
empty :=
space := $(empty) $(empty)
include $(subst $(space),\\$(space),$(Z88DK_ELF_ROOT))/make/z88dk-elf.mk
.PHONY: all first second
all: first second
first second: debug-elf
`);
            const spec = command('make', ['-C', targetPath(directory), '-j4']);
            const run = () => spawnSync(spec.executable, spec.args, { encoding: 'utf8', timeout: 30000 });
            let result = run();
            assert.equal(result.status, 0, result.error?.message || result.stdout + result.stderr);
            const before = fs.statSync(output).mtimeMs;
            result = run();
            assert.equal(result.status, 0, result.stdout + result.stderr);
            assert.match(result.stdout, /up to date/);
            assert.equal(fs.statSync(output).mtimeMs, before);
            fs.unlinkSync(`${output}.metadata.json`);
            assert.equal(run().status, 0);
            assert.ok(fs.existsSync(`${output}.metadata.json`));
            fs.unlinkSync(output);
            assert.equal(run().status, 0);
            assert.ok(fs.existsSync(output));
        } finally {
            fs.rmSync(directory, { recursive: true });
        }
    });

test('GDB rejects missing/corrupt/unsupported/stale metadata before registration',
    { skip: !process.env.Z80_GDB }, () => {
        const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'elf-schema-'));
        try {
            const { image, map, output } = fixture(directory);
            const metadata = convert(image, map, output);
            const sidecar = `${output}.metadata.json`;
            const source = targetPath(path.join(root, 'gdb', 'z80-generic-unwinder.py'));
            const spec = gdbCommand(['-nx', '-q', '-batch', targetPath(output), '-ex', `source ${source}`]);
            const run = () => {
                const result = spawnSync(spec.executable, spec.args, { encoding: 'utf8', timeout: 15000 });
                return { status: result.status, output: result.stdout + result.stderr };
            };
            const valid = run();
            assert.equal(valid.status, 0, valid.output);
            assert.match(valid.output, /Registered guarded/);
            for (const [value, pattern] of [
                ['{bad', /cannot read ELF metadata/],
                [JSON.stringify({ ...metadata, schemaVersion: 999 }), /unsupported metadata schema/],
                [JSON.stringify({ ...metadata, schemaVersion: true }), /unsupported metadata schema/],
                [JSON.stringify({ ...metadata, elfSha256: 'bad' }), /hash mismatch/],
                [JSON.stringify({ ...metadata, frames: {} }), /invalid frame\/type metadata/],
                [JSON.stringify({ ...metadata, frames: [{}] }), /invalid frame metadata/],
            ]) {
                fs.writeFileSync(sidecar, value);
                const result = run();
                assert.notEqual(result.status, 0, result.output);
                assert.match(result.output, pattern);
                assert.doesNotMatch(result.output, /Registered guarded/);
            }
            fs.unlinkSync(sidecar);
            const result = run();
            assert.notEqual(result.status, 0);
            assert.match(result.output, /cannot read ELF metadata/);
        } finally {
            fs.rmSync(directory, { recursive: true });
        }
    });

test('packed npm installation converts independently and supplies Make/GDB support files', () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'elf installed consumer '));
    try {
        const npmPath = path.join(path.dirname(process.execPath), 'node_modules', 'npm', 'bin', 'npm-cli.js');
        const npm = process.platform === 'win32' ?
            { executable: process.execPath, prefix: [npmPath] } : { executable: 'npm', prefix: [] };
        const runNpm = (args, cwd) => {
            const result = spawnSync(npm.executable, [...npm.prefix, ...args],
                { cwd, encoding: 'utf8', timeout: 60000 });
            assert.equal(result.status, 0, result.error?.message || result.stdout + result.stderr);
            return result;
        };
        const packed = JSON.parse(runNpm(['pack', '--json', '--pack-destination', directory], root).stdout)[0];
        const names = packed.files.map(file => file.path);
        for (const name of ['bin/z88dk-elf.js', 'lib/z88dk-locations.js',
            'gdb/z80-generic-unwinder.py', 'make/z88dk-elf.mk', 'LICENSE', 'NOTICE']) {
            assert.ok(names.includes(name), name);
        }
        assert.ok(!names.some(name => name.startsWith('cdt-patch/')), names.join('\n'));
        assert.ok(!names.some(name => /^(test|build|node_modules)\//.test(name)), names.join('\n'));
        const tarball = path.join(directory, packed.filename);
        fs.writeFileSync(path.join(directory, 'package.json'), JSON.stringify({
            private: true, devDependencies: { 'z88dk-elf': `file:${tarball.replace(/\\/g, '/')}` },
        }));
        runNpm(['install', '--offline', '--ignore-scripts', '--no-audit', '--no-fund'], directory);
        const entrypoint = runNpm(['exec', '--offline', '--no', '--', 'z88dk-elf', '--version'], directory);
        assert.match(entrypoint.stdout, /^0\.1\.0/m);
        const installed = path.join(directory, 'node_modules', 'z88dk-elf');
        const installedCli = path.join(installed, 'bin', 'z88dk-elf.js');
        let result = spawnSync(process.execPath, [installedCli, '--support-dir'], { encoding: 'utf8' });
        assert.equal(result.status, 0, result.stderr);
        assert.equal(result.stdout.trim(), installed);
        const { image, map, output } = fixture(directory);
        result = spawnSync(process.execPath, [installedCli, image, map, output], { encoding: 'utf8' });
        assert.equal(result.status, 0, result.stderr);
        assert.ok(JSON.parse(fs.readFileSync(`${output}.metadata.json`)).frames.some(frame => frame.complete));
        if (process.platform !== 'win32' || process.env.Z80_GDB_WSL_DISTRO) {
            const support = targetPath(installed).replace(/\\/g, '/');
            fs.writeFileSync(path.join(directory, 'Makefile'), `Z88DK_ELF_ROOT := ${support}
Z88DK_ELF_IMAGE := PROGRAM.COM
Z88DK_ELF_MAP := program.map
Z88DK_ELF_OUTPUT := program.debug.elf
empty :=
space := $(empty) $(empty)
include $(subst $(space),\\$(space),$(Z88DK_ELF_ROOT))/make/z88dk-elf.mk
`);
            const spec = command('make', ['-C', targetPath(directory), '-j4', 'debug-elf']);
            const make = () => spawnSync(spec.executable, spec.args, { encoding: 'utf8', timeout: 30000 });
            result = make();
            assert.equal(result.status, 0, result.stdout + result.stderr);
            const stateFile = `${output}.z88dk-elf-state.json`;
            const before = JSON.parse(fs.readFileSync(stateFile)).fingerprint;
            fs.appendFileSync(path.join(installed, 'lib', 'z88dk-locations.js'), '\n');
            result = make();
            assert.equal(result.status, 0, result.stdout + result.stderr);
            assert.notEqual(JSON.parse(fs.readFileSync(stateFile)).fingerprint, before);
            assert.match(make().stdout, /up to date/);
        }
        if (process.env.Z80_GDB) {
            const spec = gdbCommand(['-nx', '-q', '-batch', targetPath(output), '-ex',
                `source ${targetPath(path.join(installed, 'gdb', 'z80-generic-unwinder.py'))}`,
                '-ex', 'info address main']);
            result = spawnSync(spec.executable, spec.args, { encoding: 'utf8', timeout: 15000 });
            assert.equal(result.status, 0, result.stdout + result.stderr);
            assert.match(result.stdout, /Registered guarded generic Z80 unwinder/);
            assert.match(result.stdout, /main.*0x100/);
        }
    } finally {
        fs.rmSync(directory, { recursive: true });
    }
});
