'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { test } = require('node:test');
const { configuration, build } = require('../lib/build-generic-debug');

test('generic build config rejects invalid compiler, sources, output and deployment names', () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'generic-build-'));
    const filename = path.join(directory, 'config.json');
    const valid = { compiler: 'sdcc', sources: ['main.c'], output: 'program' };
    try {
        for (const invalid of [{ compiler: 'gcc' }, { sources: [] }, { output: '../outside' },
            { deploy: { directory: 'disk', name: 'toolongname.COM' } }, { toolchain: 'unknown' },
            { zccArgs: ['-o', 'elsewhere.bin'] }, { zccArgs: ['-compiler=sdcc'] },
            { pathMappings: [{ from: '', to: 'main.c' }] }]) {
            fs.writeFileSync(filename, JSON.stringify({ ...valid, ...invalid }));
            assert.throws(() => configuration(filename));
        }
        fs.writeFileSync(filename, JSON.stringify(valid));
        assert.deepEqual(configuration(filename), valid);
    } finally {
        fs.unlinkSync(filename);
        fs.rmdirSync(directory);
    }
});

for (const compiler of ['sdcc', 'sccz80']) {
    test(`container generic workflow builds ${compiler} ELF with resolvable project sources`,
        { skip: !process.env.Z88DK_DOCKER_IMAGE }, () => {
            const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'generic-workflow-'));
            const filename = path.join(directory, 'config.json');
            try {
                const config = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'examples', 'generic-debug.json')));
                config.sources = ['test/fixtures/locations/coverage.c', 'test/fixtures/locations/coverage.asm'];
                config.compiler = compiler;
                config.toolchain = 'docker';
                config.output = `workflow-${compiler}`;
                config.deploy = { directory, name: 'VERIFY.COM' };
                fs.writeFileSync(filename, JSON.stringify(config));
                const result = build(filename, path.resolve(__dirname, '..'));
                assert.ok(result.metadata.frames.some(frame => frame.complete));
                assert.ok(result.metadata.rows.some(row =>
                    row.file === 'test/fixtures/locations/coverage.c'));
                assert.ok(fs.readFileSync(result.imagePath).equals(
                    fs.readFileSync(path.join(directory, 'VERIFY.COM'))));
                assert.ok(fs.existsSync(`${result.elfPath}.metadata.json`));
            } finally {
                const deployed = path.join(directory, 'VERIFY.COM');
                if (fs.existsSync(deployed)) fs.unlinkSync(deployed);
                fs.unlinkSync(filename);
                fs.rmdirSync(directory);
            }
        });
}
