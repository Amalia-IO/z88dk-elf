# z88dk-elf

**Debug z88dk-built Z80 programs at source level with GDB and VS Code.**

z88dk-elf converts a linked z88dk image and its raw MAP file into an ELF/DWARF
debug companion. Use it with a Python-enabled Z80 GDB and a remote GDB stub;
your existing build and target binary remain unchanged.

The supported and verified target is CP/M with z88dk SDCC or sccz80. Other
targets and optimized builds are experimental.

Features include:

- C and assembly source breakpoints, stepping and linked symbols.
- Call stacks, recursive frames and Step Out return values.
- Typed globals, supported stack locals and parameters, arrays, structs and
  lexical scopes.
- GDB CLI and VS Code integration through CDT, with Make-friendly build hooks.

The converter reports unsupported or unproven locations rather than guessing;
see [coverage and limits](#cli-and-coverage). It produces an ELF debug
companion; for CP/M, deploy the matching COM file.

## Contents

- [Quick start: GDB](#quick-start-1-build-the-elf-and-debug-with-gdb)
- [Quick start: VS Code](#quick-start-2-debug-the-same-elf-in-vs-code-optional)
- [Status and requirements](#status-and-requirements)
- [Install without publishing](#install-without-publishing)
- [Linux/WSL prerequisites](#linuxwsl-prerequisites)
- [Install Z80 GDB](#install-z80-gdb-linuxwsl)
- [Makefile workflow](#makefile-workflow)
- [CLI and coverage](#cli-and-coverage)
- [Optional build wrapper](#optional-build-wrapper)
- [Tests and releases](#tests-and-releases)

## Quick start 1: build the ELF and debug with GDB

Start here to verify the build and remote connection. VS Code and CDT are not
required.

On Linux or WSL, you need Node.js 22.20.0 or later, either native `zcc` or
Docker with a z88dk image, and a Python-enabled `z80-unknown-elf-gdb`. See
[Linux/WSL prerequisites](#linuxwsl-prerequisites) and
[Install Z80 GDB](#install-z80-gdb-linuxwsl).

**Native Linux users:** run the commands below in a Linux terminal. Use native `zcc`, or Docker Engine with the z88dk image if you prefer.

**Windows users:** run these commands in your chosen WSL distro, not PowerShell.
The [VS Code quick start](#quick-start-2-debug-the-same-elf-in-vs-code-optional)
below explains how to reopen VS Code in that distro.

You also need a running remote GDB stub.

1. **Install** the local package tarball in your project (npm publication is
   not yet available):

   ```sh
   npm install --save-dev --save-exact --no-audit --no-fund /path/to/z88dk-elf-0.1.0.tgz
   ```

2. **Build and convert** a CP/M program:

   ```sh
   mkdir -p build
   zcc +cpm -compiler=sdcc -clib=sdcc_ix -SO0 -Cs--fno-omit-frame-pointer \
     -debug -create-app -m main.c -o build/program.bin
   node node_modules/z88dk-elf/bin/z88dk-elf.js \
     build/PROGRAM.COM build/program.map build/program.debug.elf \
     --compiler sdcc --origin 0100
   ```

   Replace `main.c` with your sources. For sccz80, use `-compiler=sccz80 -O0`
   instead of the SDCC compiler/library/optimization/frame-pointer flags, and
   convert with `--compiler sccz80`. Always use the unmodified MAP.
   If `zcc` is not installed on your Linux/WSL host, use the
   [Docker/private-Node Make invocation](#docker-and-private-node-with-make)
   instead of the native build command above.

   Proven stack locals are supported. Register-allocated locals may appear
   as `<optimized out>` even with these flags; disabling optimization does not
   force every local onto the stack. Check the converter's location diagnostics.

3. **Deploy the target binary**, not the ELF, using your platform's usual
   procedure. For CP/M, deploy the `.COM` file. Keep the ELF and its adjacent
   `.metadata.json` on the debugger host; they must match the deployed binary.

4. **Start GDB from your project directory** using your installed executable:

   ```sh
   "$HOME/opt/z80-gdb/bin/z80-unknown-elf-gdb" build/program.debug.elf
   ```

   Load the support files and connect (replace the host and port):

   ```gdb
   source node_modules/z88dk-elf/gdb/setup.gdb
   source node_modules/z88dk-elf/gdb/z80-generic-unwinder.py
   target remote YOUR_HOST:YOUR_PORT
   ```

5. **Stop at program entry**, then debug. For CP/M, the entry point is 0x0100:

   ```gdb
   hbreak *0x100
   continue
   ```

   Launch `PROGRAM.COM` from CP/M. Once the entry breakpoint hits, use
   `break main`, `continue`, `next`, `step`, `finish`, `bt` and `info locals`.
   Other stubs may use a different launch/entry procedure.

Rebuild, reconvert and deploy the matching COM after source changes.
Disconnect and close the GDB CLI session before attaching through VS Code;
only one debugger should be connected to the stub at a time.

## Quick start 2: debug the same ELF in VS Code (optional)

Reuse the ELF and metadata file from quick start 1
(`program.debug.elf` and `program.debug.elf.metadata.json`), along with the
matching deployed COM. Keep the metadata beside the ELF; the GDB unwinder uses
it to reconstruct stack frames. This workflow requires the CDT GDB extension.

1. **Open VS Code on the debugger host.** Native Linux users open the project
   normally. Windows users must use **WSL: Reopen Folder in WSL**, or run
   `code .` from the project directory in the chosen distro. Confirm the status
   bar identifies **WSL: Ubuntu-24.04** (or your chosen distro). Linux GDB must
   run in that WSL window.

2. **Install and configure CDT.** Install
   [CDT GDB Debug Adapter Extension](https://marketplace.visualstudio.com/items?itemName=eclipse-cdt.cdt-gdb-vscode)
   locally in Linux VS Code, or in the WSL extension host on Windows.
   Merge [launch.json](examples/launch.json) into your `.vscode/launch.json`,
   point `program` at the ELF you built, and **remove `preLaunchTask`** for
   this attach-only workflow.

3. **Attach.** Press **F5**, select **z88dk ELF: attach (Linux/WSL)**, and enter
   the absolute Linux GDB executable path and the same stub host/port.

4. **Debug.** For the tested stub's entry procedure, enter `>hbreak *0x100` in
   the Debug Console, Continue, and launch `PROGRAM.COM` from CP/M again.
   Once stopped, use source breakpoints, Step Into/Over/Out, Call Stack and
   Variables. Follow your platform's procedure if it differs.

### Optional: automate builds with Make or before F5

After manual debugging works, add [the Make target](#2-add-make-debug-elf).
For automatic builds before F5, merge [tasks.json](examples/tasks.json) and
restore `preLaunchTask`. Put any required Node/Docker overrides in the task or
your Makefile. The build task prepares the ELF; deployment remains your own
workflow.

## Status and requirements

The current package version is **0.1.0** and has not been published to npm.
Install from a local tarball or a reviewed Git checkout until publication.

| Component | Supported/verified scope |
| --- | --- |
| Target | CP/M, contiguous COM image, origin `0100` |
| Compilers | z88dk SDCC and sccz80, debug/unoptimized profiles below |
| Converter | Node.js 22.20.0 or later; no runtime npm dependencies |
| Complete debugger workflow | Linux/WSL and Python-enabled upstream Z80 GDB |
| Windows | Native Node conversion; Linux GDB must run in a WSL VS Code window |
| Make | GNU Make include tested with 4.3; it does not use grouped targets |
| Other targets/optimized builds | Experimental |

Verification includes regression tests, compiler builds, and real GDB
loopback tests, as well as prior live CP/M sessions with both compilers.
The tested GDB is upstream `19.0.50.20261002-git`, commit
`e522ebecf7381e1e03548a7d0816b8ce3c038984`.
The tested z88dk container is
`z88dk/z88dk@sha256:bb1569b1ae7604086168c32c1cf73d758ea410c2dcf4efdf029859b38246d1f5`.
CI runs the core tests on Linux and Windows with Node.js 22 and 24, and runs
the compiler/GDB integration tests on Linux.

## Install without publishing

From a checkout of this repository:

```sh
npm pack
```

In your project, install that tarball:

```sh
npm install --save-dev --save-exact --no-audit --no-fund /path/to/z88dk-elf-0.1.0.tgz
```

Keep the tarball at a stable project-relative location if committing the
dependency and lockfile. A Git checkout pinned to a reviewed tag/commit is
another option: invoke `node /path/to/checkout/bin/z88dk-elf.js` directly.
After official publication, the equivalent project-local install will be
`npm install --save-dev --save-exact z88dk-elf@0.1.0`.

`--no-audit --no-fund` skips npm's optional audit and funding requests.
Before installing, confirm `node --version` meets the minimum in the **same
terminal**. If installation appears stalled, retry with `--verbose`; its log
may help diagnose the wait, but is not guaranteed to identify it.

Discover support files without depending on global npm layout:

```sh
node node_modules/z88dk-elf/bin/z88dk-elf.js --support-dir
```

## Linux/WSL prerequisites

Run checks on the **same Linux host where VS Code/CDT and GDB run**.
For native Linux, use your ordinary terminal; for WSL, use the chosen distro's
VS Code WSL terminal:

```sh
node --version
npm --version
make --version
command -v zcc
```

Your distro's packaged Node may be too old; Ubuntu 24.04's default can be
**18.19.1**, below this tool's minimum. Install a supported Node release using
your preferred Node manager or a
private Linux installation; a system-wide Node.js change is not needed.
Here is a user-local installation using the official Node archive (Bash,
`curl`, `tar` and `sha256sum` required; x86-64 and ARM64 Linux):

```sh
(
  set -euo pipefail
  case "$(uname -m)" in
    x86_64) arch=x64 ;;
    aarch64|arm64) arch=arm64 ;;
    *) echo "Use a Node installation for your architecture" >&2; exit 1 ;;
  esac
  release="node-v22.20.0-linux-$arch"
  archive="$release.tar.xz"
  destination="$HOME/opt/$release"
  test ! -e "$destination" || { echo "$destination already exists; verify it instead" >&2; exit 1; }
  download=$(mktemp -d)
  cd "$download"
  curl -fLO "https://nodejs.org/dist/v22.20.0/$archive"
  curl -fLO https://nodejs.org/dist/v22.20.0/SHASUMS256.txt
  grep "  $archive\$" SHASUMS256.txt > selected.sha256
  sha256sum -c selected.sha256
  mkdir -p "$HOME/opt"
  tar -xJf "$archive" -C "$HOME/opt"
  "$destination/bin/node" --version
)
```

After successful installation, use the matching directory in this terminal:

```sh
export PATH="$HOME/opt/node-v22.20.0-linux-x64/bin:$PATH" # Use linux-arm64 on ARM64.
node --version
npm --version
```

The download directory is retained for diagnosis if download, checksum or
version verification fails. If you already have supported Node.js, use its
actual path. Keep this PATH in the shell used for `npm` and Make. For an
automatic VS Code build, configure the task's PATH or explicit Make overrides
as well; an existing VS Code process may not inherit a later terminal PATH change.

If `zcc` is absent, Docker is an alternative. Verify `docker version` succeeds
and you can run containers. On native Linux, use Docker Engine; Docker Desktop
is not required. On Windows/WSL, enable Docker Desktop's WSL integration for
the chosen distro if needed. A Windows Node/z88dk installation does not make
`node` or `zcc` available inside WSL.
The [Docker Make example](#docker-and-private-node-with-make) uses the
pinned image tested by this project; the first use may download it.

### Get zcc through Docker

Install [Docker Engine on Linux](https://docs.docker.com/engine/install/) or
[Docker Desktop with WSL integration on Windows](https://docs.docker.com/desktop/features/wsl/).
Once Docker is running and accessible from your Linux/WSL terminal, download
the tested z88dk toolchain and check its CP/M compiler frontend:

```sh
docker version
Z88DK_IMAGE='z88dk/z88dk@sha256:bb1569b1ae7604086168c32c1cf73d758ea410c2dcf4efdf029859b38246d1f5'
docker pull "$Z88DK_IMAGE"
docker run --rm "$Z88DK_IMAGE" zcc +cpm -h
```

The last command should print the zcc version/help and exit successfully.
The image contains zcc and its toolchain, so `zcc` runs inside Docker rather
than as a host executable.
Docker caches the image locally; `docker run` also pulls it automatically if
missing. Explicit `docker pull` separates download problems from build problems.

To compile your sources, bind-mount the project and run zcc inside the container
using the [Docker Make invocation](#docker-and-private-node-with-make).
The Make `ZCC` override is the container command, not a path to a host executable.

## Install Z80 GDB (Linux/WSL)

Run these commands **on your native Linux host**, or inside the WSL distro
where VS Code will run CDT, not in Windows PowerShell or another distro.
Ubuntu's ordinary `gdb` package
is not a substitute unless it supports both Z80 and embedded Python.

For Ubuntu 24.04 (or a compatible Debian-based host), install the build tools:

```sh
sudo apt-get update
sudo apt-get install -y git build-essential python3-dev libexpat1-dev \
  libgmp-dev libmpfr-dev texinfo bison flex
```

On other Linux distributions, install the equivalent development packages
using your package manager and adjust `--with-python` if Python is not at
`/usr/bin/python3`. The dependency command above is Ubuntu/Debian-specific;
the converter, Make and GDB invocation examples are not WSL-specific.

To reproduce the project's GDB verification, build the tested upstream
revision below. Alternatively, use an existing GDB that supports the Z80
architecture and embedded Python. Building from source takes several minutes
and installs into your home directory, without `sudo make install`:

```sh
(
  set -euo pipefail
  mkdir -p "$HOME/src"
  work=$(mktemp -d "$HOME/src/z80-gdb.XXXXXX")
  git init "$work/source"
  git -C "$work/source" remote add origin https://sourceware.org/git/binutils-gdb.git
  git -C "$work/source" fetch --depth 1 origin e522ebecf7381e1e03548a7d0816b8ce3c038984
  git -C "$work/source" checkout --detach FETCH_HEAD
  mkdir "$work/build"
  cd "$work/build"
  "$work/source/configure" --target=z80-unknown-elf \
    --prefix="$HOME/opt/z80-gdb" --with-python=/usr/bin/python3 --with-expat \
    --disable-werror --disable-sim --disable-nls
  make -j2 all-gdb
  make install-gdb
)
```

The source and build directories are retained under `~/src` for troubleshooting
or rebuilding.

Verify the executable **without relying on PATH**:

```sh
"$HOME/opt/z80-gdb/bin/z80-unknown-elf-gdb" --version
"$HOME/opt/z80-gdb/bin/z80-unknown-elf-gdb" -nx -q -batch \
  -ex 'set architecture z80' \
  -ex 'python import gdb.unwinder; print("GDB Python unwinder support: OK")'
```

Both commands must succeed. The second should report architecture `z80` and
`GDB Python unwinder support: OK`.

When the VS Code attach template asks for the GDB executable, enter the
**absolute Linux path** printed by:

```sh
printf '%s\n' "$HOME/opt/z80-gdb/bin/z80-unknown-elf-gdb"
```

Enter the absolute Linux path, rather than a Windows path or the literal
`$HOME`/`~`. Using the absolute path avoids needing to restart VS Code after a
PATH change.
For terminal commands in this session, optionally add it to PATH:

```sh
export PATH="$HOME/opt/z80-gdb/bin:$PATH"
```

On native Linux, open the project with `code .` and install CDT locally; no
WSL status-bar indicator is expected. On Windows, the executable does not
need to be on Windows PATH: open the project in the same WSL distro with
`code .`, confirm **WSL: your distro** in the status bar, and install CDT in
that WSL extension host. Then return to the
[GDB quick start](#quick-start-1-build-the-elf-and-debug-with-gdb).

# Makefile workflow

## 1. Build with debug metadata

Keep your existing source/object/library/link recipes. For the validated CP/M
profiles, ensure these flags reach the appropriate compile and link steps:

```sh
# SDCC: retain IX-based debug frames
zcc +cpm -compiler=sdcc -clib=sdcc_ix -SO0 -Cs--fno-omit-frame-pointer \
  -debug -create-app -m main.c helper.asm -o build/program.bin

# sccz80
zcc +cpm -compiler=sccz80 -O0 -debug -create-app -m \
  main.c helper.asm -o build/program.bin
```

These examples produce `build/PROGRAM.COM` and `build/program.map`. Output naming
may differ in your build; supply the actual files.
Preserve the **raw** MAP before sed/filtering/normalizing it for other tools.
The CDB and relocated source/scope markers must remain intact.
Both image and MAP must come from the same linked build.

## 2. Add `make debug-elf`

Smallest integration, with no include and no new build configuration:

```make
.PHONY: debug-elf
debug-elf: build/PROGRAM.COM build/program.map
	node node_modules/z88dk-elf/bin/z88dk-elf.js \
	  "$<" "build/program.map" "build/program.debug.elf" \
	  --compiler sdcc --origin 0100
```

This intentionally converts each time. For incremental conversion, add:

```make
NODE ?= node
Z88DK_ELF_ROOT := $(shell "$(NODE)" node_modules/z88dk-elf/bin/z88dk-elf.js --support-dir)
Z88DK_ELF_NODE := $(NODE)
Z88DK_ELF_IMAGE := build/PROGRAM.COM
Z88DK_ELF_MAP := build/program.map
Z88DK_ELF_OUTPUT := build/program.debug.elf
Z88DK_ELF_FLAGS := --compiler sdcc --origin 0100
# Optional: source/header inputs not already reflected in image/MAP.
Z88DK_ELF_EXTRA_DEPS := main.c include/config.h

empty :=
space := $(empty) $(empty)
include $(subst $(space),\$(space),$(Z88DK_ELF_ROOT))/make/z88dk-elf.mk
```

The include adds only `debug-elf` and preserves your default goal. Your existing
recipes still build the image and MAP. Invoke `make debug-elf` explicitly or
choose it as your project's default.

The helper hashes image, MAP, extra dependencies, converter runtime and options.
It also checks both generated outputs. Missing/corrupt outputs, changed flags,
or a tool update trigger conversion; a no-op preserves output timestamps.
An adjacent `.z88dk-elf-state.json` is disposable incremental state.
Downstream goals can depend on `debug-elf`; ELF/JSON do not have separate
independently running conversion recipes.

The project/package directory and individual image/MAP/output paths may contain
spaces. Escape Make include paths as above. `Z88DK_ELF_EXTRA_DEPS` is a Make list:
use whitespace-free names there, or invoke the helper with repeated quoted
`--dep` arguments yourself. Literal `$`, `#`, quotes and unusual shell characters
in Make path variables are unsupported. This integration requires GNU Make and
a POSIX shell; native Windows Make shells are not supported.

The [ELF debugging demo](examples/README.md) provides a complete consumer
example with C, assembly, Make and CDT templates. Its
[Makefile](examples/Makefile) supports both compiler profiles and uses GNU Make
4.3 grouped targets **for the example's build**, not for the converter include.

### Docker and private Node with Make

After copying the example Makefile and sources above, run this **from your
project directory on Linux or in WSL**. Replace the Node path with your private installation,
or use `NODE_BIN="$(command -v node)"` if a supported Node is already on PATH:

```sh
PROJECT_DIR="$(pwd -P)"
NODE_BIN="$HOME/opt/node-v22.20.0-linux-x64/bin/node"
Z88DK_IMAGE='z88dk/z88dk@sha256:bb1569b1ae7604086168c32c1cf73d758ea410c2dcf4efdf029859b38246d1f5'
make debug-elf COMPILER=sdcc NODE="$NODE_BIN" \
  ZCC="docker run --rm --mount \"type=bind,source=$PROJECT_DIR,target=/work\" -w /work $Z88DK_IMAGE zcc"
```

Use `COMPILER=sccz80` for that compiler. The example Makefile uses `NODE` for
both support-directory discovery and conversion. With your own Makefile, wire
`NODE` as in the include example above, or set `Z88DK_ELF_NODE` and the support
root explicitly.

The shell resolves the absolute mount path **before** passing it to Make.
Use `PROJECT_DIR` as shown; `$$PWD` passes through shell/Make expansion and can
resolve to an unintended path.
An explicit absolute `PROJECT_DIR` such as `/home/alex/my-project` also works.
`/mnt/c/...` paths apply only to Windows-backed projects inside WSL.

Use a pinned toolchain image for reproducible builds. Native zcc is the default.
For WSL projects, a checkout in the Linux filesystem provides the most
consistent Docker bind-mount behavior.

## 3. GDB or CDT attach

Start with GDB (replace paths/endpoint):

```sh
z80-unknown-elf-gdb build/program.debug.elf
```

```gdb
source node_modules/z88dk-elf/gdb/setup.gdb
source node_modules/z88dk-elf/gdb/z80-generic-unwinder.py
target remote YOUR_HOST:YOUR_PORT
```

Load the ELF **before** sourcing the unwinder. Keep its `.metadata.json` next to
it. The unwinder checks schema/producer and the complete ELF SHA-256 before
registering; runtime code and stack guards still apply.
For paths containing spaces, GDB `file` takes a quoted filename; `source`
interprets the rest of the command as the filename.

Your stub/platform controls how the COM is launched, entry breakpoints and
program-exit notification. Launch the COM using your platform's normal
procedure; the ELF is for GDB and is not the target program.

For VS Code, install `eclipse-cdt.cdt-gdb-vscode` in the **Linux/WSL extension
host**, then merge [tasks.json](examples/tasks.json) and
[launch.json](examples/launch.json) into your project's `.vscode` files.
The template uses `make debug-elf`, prompts for GDB/host/port, and attaches with
`run: preserve`. Adjust ELF/support paths for your installation.
For the manual-build quick start, remove `preLaunchTask`: F5 only attaches, so
run your successful Make command yourself before debugging. For automatic
builds, retain `preLaunchTask` and put the required `NODE`/`ZCC` overrides in the
task arguments or project Makefile; terminal overrides are not carried into the
VS Code task automatically.

### VS Code and CDT compatibility

Use CDT GDB extension **3.0.0 or later** for the documented VS Code debugging
experience. Earlier releases may not correctly handle instruction-breakpoint
stops, caller-frame variables or lexical-scope updates.

## CLI and coverage

```text
z88dk-elf IMAGE RAW_MAP OUTPUT_ELF
  [--compiler auto|sdcc|sccz80] [--origin HEX]
  [--path-map FROM=TO ...] [--source MODULE=PATH ...]
  [--code-section NAME ...]
```

Compiler auto-detection rejects conflicts/ambiguous encodings rather than
guessing. Use explicit compiler selection when known. Source/path mappings are
repeatable; duplicate prefixes/modules are rejected. Use `--source` to separate
same-basename modules and `--code-section` for nonstandard executable sections.
Warnings are printed to stderr and recorded in metadata.

Run conversion from your project/source root, or map source names to readable
paths with `--path-map`/`--source`. For shared-address C rows, the converter reads
the source to prefer statements over standalone closing braces in GDB's line
display. This does not reorder scope-analysis rows or remove breakpoint rows.
Missing source produces a warning and preserves the original line ordering.
The incremental Make helper tracks these source files, including when missing
files become available, so source-text changes trigger reconversion.

Verified coverage includes linked symbols, C/assembly source lines, static
types/data, proven stack parameters/locals, lexical blocks/shadowing, recursion,
validated indirect C calls and mixed-assembly register recovery.
Unsupported or unproven locations are omitted with coverage diagnostics.

Root stack analysis and independent frame analysis answer different questions.
An incomplete root analysis does not by itself mean the independent frame used
by GDB is incomplete. Even for a complete independent frame, individual PCs
and runtime guards can prevent unwinding. An incomplete independent frame is
not used by the guarded unwinder; GDB may fall back to another unwinder.

Important limits:

- No DWARF CFI; GDB embedded Python provides guarded unwinding.
- Indirect callbacks must belong to the validated linked C contract set.
  Arbitrary assembly/external callbacks or tail jumps are not covered.
- Complete parameter prototypes are not inferred. Function pointers may display
  as `unsigned int (*)()`.
- Interrupt/alternate-register/AF recovery and optimized register-local
  allocation lifetimes are not supported.

Metadata schema 1 is explicit. Incompatible future schemas must be rejected;
regenerate ELF and sidecar together with the corresponding tool version.
Conversion prepares both files before replacement and invalidates the old
sidecar first. A failed replacement cannot leave an accepted new-ELF/old-JSON
pair. It may leave an old ELF without a sidecar; rebuild the pair.
Do not convert the same output concurrently from independent Make processes,
or rebuild it while GDB is using it.

## Optional build wrapper

The optional `z88dk-elf-build CONFIG.json` wrapper provides another way to build.
Paths are relative to the config directory (the project root).
Copy [generic-debug.json](examples/generic-debug.json) into a project with
`main.c` and `coverage.asm`; choose `toolchain: native` or `docker`.
Docker accepts `dockerImage` (or `Z88DK_DOCKER_IMAGE`); native accepts `zcc`.
`zccArgs`, `codeSections`, and `pathMappings` are optional.

Output goes to `build/generic-debug`. Configure
`deploy: { "directory": "...", "name": "PROGRAM.COM" }` to copy the COM to an
existing directory and verify the bytes. The wrapper does not evaluate shell
commands.

## Tests and releases

```sh
npm test
# Release integration requires both variables and their tools.
Z88DK_DOCKER_IMAGE='z88dk/z88dk@sha256:bb1569b1ae7604086168c32c1cf73d758ea410c2dcf4efdf029859b38246d1f5' \
Z80_GDB=/path/to/z80-unknown-elf-gdb npm run test:integration
```

Core tests require Node; external compiler/GDB tests skip unless configured.
Windows-to-WSL tests additionally use `Z80_GDB_WSL_DISTRO` for the chosen distro.
Native Linux tests invoke GDB/stub directly.
The packaged-consumer test installs an npm tarball offline into a separate
project and exercises its CLI, Make and GDB when those tools are enabled.

The original sccz80 source probe is retained in
[test/fixtures/locations/elf_source_probe.c](test/fixtures/locations/elf_source_probe.c).
Its parity tests check incomplete array resolution, block-copy-initialized
scalar/array/string/struct locals, and shared-address source attribution.
Real GDB drives a bounded instruction-executing loopback stub to test `finish`
return extraction for signed int, signed/unsigned char, unsigned long and
pointer returns, four recursive Step Outs, and MI edits to globals and distinct
recursive frames. These are offline regressions; hardware sessions and the
rendered CDT UI are outside this test suite. The test interpreter reports
unsupported instructions as failures.
An incomplete array declaration is resolved only by one compatible complete
definition in the same module and linkage scope; unresolved or conflicting
metadata still fails conversion instead of guessing an extent.

For a release, verify rights/notices and repository/npm name and ownership,
run the mandatory integration suite, inspect `npm pack --dry-run`, and install
the tarball in a consumer project. Document CDT requirements, update the version
and changelog, then publish and tag the release. Releases are currently manual.

Converter: MIT; see [LICENSE](LICENSE) and [NOTICE](NOTICE).
