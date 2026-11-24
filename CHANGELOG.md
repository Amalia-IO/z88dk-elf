# Changelog

Notable changes to z88dk-elf are documented here.

## 0.1.0 (unpublished)

### Added

- A dependency-free CLI that converts linked images and raw MAP files into
  ELF/DWARF, with SDCC and sccz80 support.
- GDB setup files and a guarded unwinder, plus Make integration for incremental
  conversion without taking over the existing build.
- An optional project-root-aware build wrapper and a consumer example.
- Schema and producer versioning, SHA-256 ELF/metadata identity checks, and
  portable regression tests.

### Improved

- Prefer statements over closing braces when source rows share an address,
  without changing scope analysis or removing breakpoint rows.
- Track source dependencies in Make and resolve incomplete array declarations
  against compatible complete definitions.
- Preserve guarded block-copy analysis and exercise the original source probe
  in integration regressions, including GDB return-value extraction and
  recursive-frame variable edits.
- Distinguish root stack-analysis coverage from independent frame coverage used
  by GDB, while retaining diagnostics for genuine frame gaps.

### Documentation and verification

- Document Linux, Windows/WSL, Docker and private-Node workflows, including
  prerequisites, installation diagnostics and Make overrides.
- Separate GDB-first verification, optional VS Code attachment and automated
  builds; include a complete consumer demo.
- Document CDT GDB VS Code extension 3.0.0 or later for the documented
  debugging experience.

This version has not yet been published.
