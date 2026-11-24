'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { convert } = require('./z88dk-elf');

function check(condition, message) {
    if (!condition) throw new Error(message);
}

function configuration(filename) {
    const config = JSON.parse(fs.readFileSync(filename, 'utf8'));
    check(['sdcc', 'sccz80'].includes(config.compiler), 'compiler must be sdcc or sccz80');
    check(Array.isArray(config.sources) && config.sources.length &&
        config.sources.every(source => typeof source === 'string' && source.length),
    'sources must be a nonempty array of paths relative to the project root');
    check(typeof config.output === 'string' && /^[a-z0-9_-]+$/i.test(config.output),
        'output must be a filename stem containing letters, digits, underscores or hyphens');
    for (const field of ['zccArgs', 'codeSections']) {
        check(config[field] === undefined || (Array.isArray(config[field]) &&
            config[field].every(value => typeof value === 'string' && value.length)),
        `${field} must be an array of nonempty strings`);
    }
    check(config.toolchain === undefined || ['docker', 'native'].includes(config.toolchain),
        'toolchain must be docker or native');
    check(!(config.zccArgs || []).some(arg => /^-(?:o(?:$|[=.]|[^A-Z])|compiler(?:=|$)|clib(?:=|$))/.test(arg) ||
        ['-Cs--omit-frame-pointer', '-no-debug', '-no-create-app'].includes(arg)),
    'zccArgs must not override output, compiler, library or required debug settings');
    check(config.pathMappings === undefined || (Array.isArray(config.pathMappings) &&
        config.pathMappings.every(mapping => typeof mapping.from === 'string' && mapping.from &&
            typeof mapping.to === 'string' && mapping.to)), 'pathMappings needs from/to strings');
    check(config.deploy === undefined || (typeof config.deploy.directory === 'string' &&
        /^[a-z0-9_]{1,8}\.COM$/i.test(config.deploy.name)),
    'deploy needs directory and a CP/M 8.3 COM name');
    check(config.dockerImage === undefined || (typeof config.dockerImage === 'string' && config.dockerImage),
        'dockerImage must be a nonempty string');
    check(config.zcc === undefined || (typeof config.zcc === 'string' && config.zcc),
        'zcc must be a nonempty executable path');
    return config;
}

function build(filename, root = path.dirname(path.resolve(filename))) {
    const config = configuration(filename);
    for (const source of config.sources) {
        check(!path.isAbsolute(source) && !source.split(/[\\/]/).includes('..'),
            `Source must be inside the project root: ${source}`);
        check(fs.statSync(path.join(root, source)).isFile(), `Source is not a file: ${source}`);
    }
    const directory = path.join(root, 'build', 'generic-debug');
    fs.mkdirSync(directory, { recursive: true });
    const stem = path.join(directory, config.output);
    const args = ['+cpm', ...(config.compiler === 'sdcc' ?
        ['-clib=sdcc_ix', '-SO0', '-Cs--fno-omit-frame-pointer'] : ['-O0']),
    `-compiler=${config.compiler}`, '-debug', '-create-app', '-m', ...(config.zccArgs || []),
    ...config.sources, '-o', `build/generic-debug/${config.output}.bin`];
    const docker = (config.toolchain || 'docker') === 'docker';
    const command = docker ? 'docker' : (config.zcc || 'zcc');
    const commandArgs = docker ? ['run', '--rm', '--mount',
        `type=bind,source=${root},target=/work`, '-w', '/work',
        config.dockerImage || process.env.Z88DK_DOCKER_IMAGE || 'z88dk/z88dk:latest', 'zcc', ...args] : args;
    const result = spawnSync(command, commandArgs, { cwd: root, stdio: 'inherit', timeout: 120000 });
    if (result.error) throw result.error;
    check(result.status === 0, `${command} build failed (exit ${result.status}, signal ${result.signal})`);
    const image = path.join(directory, `${config.output.toUpperCase()}.COM`);
    const elf = `${stem}.debug.elf`;
    const basenames = config.sources.map(source => path.basename(source));
    const mappings = config.sources.filter((source, index) =>
        basenames.filter(name => name === basenames[index]).length === 1)
        .map(source => ({ from: path.basename(source), to: source.replace(/\\/g, '/') }));
    mappings.unshift(...(config.pathMappings || []));
    const metadata = convert(image, `${stem}.map`, elf, mappings, 0x100, [], config.codeSections || [],
        config.compiler, root);
    for (const warning of metadata.warnings) console.error(`Coverage: ${warning}`);
    if (config.deploy) {
        const destination = path.resolve(root, config.deploy.directory);
        check(fs.statSync(destination).isDirectory(), `Deployment directory does not exist: ${destination}`);
        const deployed = path.join(destination, config.deploy.name.toUpperCase());
        fs.copyFileSync(image, deployed);
        check(fs.readFileSync(image).equals(fs.readFileSync(deployed)), `Deployment verification failed: ${deployed}`);
        console.log(`Verified COM copy: ${deployed}`);
    }
    console.log(`ELF: ${elf}\nCOM: ${image}\nNo PCW connection or launch was performed.`);
    return { metadata, imagePath: image, elfPath: elf };
}

if (require.main === module) {
    try {
        check(process.argv.length === 3, 'Usage: z88dk-elf-build CONFIG.json');
        build(path.resolve(process.argv[2]));
    } catch (error) {
        console.error(`Generic debug build failed: ${error.message}`);
        process.exitCode = 1;
    }
}

module.exports = { configuration, build };
