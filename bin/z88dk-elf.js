#!/usr/bin/env node
'use strict';

const path = require('node:path');
const args = process.argv.slice(2);
if (args.length === 1 && args[0] === '--version') {
    console.log(require('../package.json').version);
} else if (args.length === 1 && args[0] === '--support-dir') {
    console.log(path.resolve(__dirname, '..'));
} else if (args.length === 1 && args[0] === '--help') {
    console.log(`Usage: z88dk-elf IMAGE RAW_MAP OUTPUT_ELF [options]

Convert an existing linked image and unmodified z88dk MAP.
Outputs OUTPUT_ELF and OUTPUT_ELF.metadata.json. No build or hardware access.

Options:
  --compiler auto|sdcc|sccz80
  --origin HEX                 Explicit image origin (CP/M: 0100)
  --path-map FROM=TO           Repeatable source prefix mapping
  --source MODULE=PATH         Repeatable module source override
  --code-section NAME          Repeatable executable section filter
  --support-dir                Print installed package directory
  --version
  --help`);
} else {
    require('../lib/z88dk-elf').runCli(args);
}
