'use strict';

const { spawnSync } = require('node:child_process');
if (!process.env.Z88DK_DOCKER_IMAGE || !process.env.Z80_GDB) {
    console.error('Integration requires Z88DK_DOCKER_IMAGE and Z80_GDB; set Z80_GDB_WSL_DISTRO when using WSL from Windows.');
    process.exitCode = 1;
} else {
    const result = spawnSync(process.execPath, ['--test', '--test-concurrency=1', 'test/*.test.js'],
        { cwd: require('node:path').resolve(__dirname, '..'), stdio: 'inherit' });
    if (result.error) throw result.error;
    process.exitCode = result.status === null ? 1 : result.status;
}
