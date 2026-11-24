# z88dk ELF debugging demo

This example builds a CP/M program with C recursion, an indirect function call
and a small assembly function. It uses z88dk-elf to create a matching ELF for
GDB and the optional CDT GDB VS Code extension. The COM is the executable for
the target; the ELF and its adjacent metadata file stay on the debugger host.

Work in a separate project directory on Linux or WSL. You need Node 22.20.0 or
newer, GNU Make 4.3 or newer, z88dk (native or Docker), a Python-enabled Z80
GDB and a remote GDB stub. See the [main README](../README.md) for installation,
Docker and target-specific guidance. On Windows, use a WSL terminal and open
the project in the WSL VS Code extension host.

## Set up the demo

From the root of a z88dk-elf checkout, copy the example to a new directory:

```sh
mkdir "$HOME/z88dk-elf-demo"
mkdir "$HOME/z88dk-elf-demo/.vscode"
cp examples/Makefile examples/main.c examples/coverage.asm "$HOME/z88dk-elf-demo/"
cp examples/launch.json examples/tasks.json "$HOME/z88dk-elf-demo/.vscode/"
cd "$HOME/z88dk-elf-demo"
```

Stop if either `mkdir` fails; do not overwrite an existing project.

Install the z88dk-elf package in that directory. The package is not yet
published to npm; replace the path with the absolute path to your local tarball:

```sh
npm install --save-dev --save-exact --no-audit --no-fund /path/to/z88dk-elf-0.1.0.tgz
```

Build the executable and its debug files with a native zcc:

```sh
make debug-elf COMPILER=sdcc
```

Use `COMPILER=sccz80` to try the other compiler. The
[Docker and private Node instructions](../README.md#docker-and-private-node-with-make)
show how to supply a Docker zcc instead. The outputs are
`build/PROGRAM.COM`, `build/program.debug.elf` and
`build/program.debug.elf.metadata.json`.

## Debug

Deploy the matching COM using your target's normal procedure. Do not copy into
a mounted disk or an active directory export. Keep the ELF and metadata
together on the host. Connect only one debugger to the remote stub at a time.

Start GDB with the ELF, then load the support files:

```sh
z80-unknown-elf-gdb build/program.debug.elf
```

```gdb
source node_modules/z88dk-elf/gdb/setup.gdb
source node_modules/z88dk-elf/gdb/z80-generic-unwinder.py
target remote YOUR_HOST:YOUR_PORT
hbreak *0x100
continue
```

Launch `PROGRAM.COM` on CP/M. After the entry breakpoint, try `break recurse`,
`continue`, `bt`, `info locals` and `finish`; `leaf`, `invoke` and
`assembly_value` provide further C and assembly examples.

For VS Code, install CDT GDB in the Linux/WSL extension host, open this demo
directory there, and select **z88dk ELF: attach (Linux/WSL)**. For the first
manual build, remove `preLaunchTask` from `.vscode/launch.json`; otherwise the
included task builds with its default native tools. Close the GDB CLI session
before attaching in VS Code. See the
[VS Code quick start](../README.md#quick-start-2-debug-the-same-elf-in-vs-code-optional)
for setup and build-task overrides.
