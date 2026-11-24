#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { createHash } = require('node:crypto');
const { spawnSync } = require('node:child_process');
const { sourceDigest } = require('../lib/z88dk-line-order');

function digest(filename) {
    return createHash('sha256').update(fs.readFileSync(filename)).digest('hex');
}

function runtimeFiles(directory) {
    return fs.readdirSync(directory, { withFileTypes: true }).flatMap(entry => {
        const filename = path.join(directory, entry.name);
        return entry.isDirectory() ? runtimeFiles(filename) : [filename];
    }).sort();
}

function incremental(args) {
    const separator = args.indexOf('--');
    if (separator < 0 || separator % 2 !== 0) {
        throw new Error('Usage: debug-elf.js [--dep FILE ...] -- IMAGE RAW_MAP OUTPUT_ELF [flags]');
    }
    const dependencies = [];
    for (let index = 0; index < separator; index += 2) {
        if (args[index] !== '--dep' || !args[index + 1]) throw new Error('Expected --dep FILE');
        dependencies.push(args[index + 1]);
    }
    const conversion = args.slice(separator + 1);
    if (conversion.length < 3) throw new Error('Expected IMAGE RAW_MAP OUTPUT_ELF');
    const [image, map, output] = conversion;
    const root = path.resolve(__dirname, '..');
    const files = [image, map, ...dependencies, path.join(root, 'package.json'),
        ...runtimeFiles(path.join(root, 'lib')), ...runtimeFiles(path.join(root, 'bin')),
        ...runtimeFiles(path.join(root, 'make'))];
    const fingerprint = sourceFiles => createHash('sha256').update(JSON.stringify({
        conversion, files: files.map(filename => [path.resolve(filename), digest(filename)]),
        sources: sourceFiles.map(filename => [filename, sourceDigest(filename)]),
    })).digest('hex');
    const sidecar = `${output}.metadata.json`;
    const stateFile = `${output}.z88dk-elf-state.json`;
    if (fs.existsSync(stateFile) && fs.existsSync(output) && fs.existsSync(sidecar)) {
        let state;
        try {
            state = JSON.parse(fs.readFileSync(stateFile, 'utf8'));
        } catch (error) {
            if (!(error instanceof SyntaxError)) throw error;
            console.error(`z88dk-elf: invalid incremental state ${stateFile}; rebuilding`);
        }
        if (Array.isArray(state?.sourceFiles) && state.fingerprint === fingerprint(state.sourceFiles) &&
            state.elf === digest(output) &&
            state.metadata === digest(sidecar)) {
            console.log(`z88dk-elf: up to date: ${output}`);
            return false;
        }
    }
    fs.mkdirSync(path.dirname(path.resolve(output)), { recursive: true });
    if (fs.existsSync(stateFile)) fs.unlinkSync(stateFile);
    const result = spawnSync(process.execPath, [path.join(root, 'bin', 'z88dk-elf.js'), ...conversion],
        { stdio: 'inherit' });
    if (result.error) throw result.error;
    if (result.status !== 0) throw new Error(`Conversion failed (exit ${result.status}, signal ${result.signal})`);
    const metadata = JSON.parse(fs.readFileSync(sidecar, 'utf8'));
    const sourceFiles = metadata.sourceDependencies.map(source => source.file);
    fs.writeFileSync(stateFile, JSON.stringify({
        fingerprint: fingerprint(sourceFiles), sourceFiles, elf: digest(output), metadata: digest(sidecar),
    }) + '\n');
    return true;
}

if (require.main === module) {
    try {
        incremental(process.argv.slice(2));
    } catch (error) {
        console.error(`z88dk-elf Make integration failed: ${error.message}`);
        process.exitCode = 1;
    }
}

module.exports = { incremental };
