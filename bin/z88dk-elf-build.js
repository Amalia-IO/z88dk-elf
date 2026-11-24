#!/usr/bin/env node
'use strict';

const path = require('node:path');
const { build } = require('../lib/build-generic-debug');
try {
    if (process.argv.length !== 3) throw new Error('Usage: z88dk-elf-build CONFIG.json');
    build(path.resolve(process.argv[2]));
} catch (error) {
    console.error(`z88dk-elf build failed: ${error.message}`);
    process.exitCode = 1;
}
