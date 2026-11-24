COMPILER ?= sdcc
ZCC ?= zcc
NODE ?= node
ELF_CLI := node_modules/z88dk-elf/bin/z88dk-elf.js
Z88DK_ELF_ROOT := $(shell "$(NODE)" "$(ELF_CLI)" --support-dir)
Z88DK_ELF_NODE := $(NODE)
Z88DK_ELF_IMAGE := build/PROGRAM.COM
Z88DK_ELF_MAP := build/program.map
Z88DK_ELF_OUTPUT := build/program.debug.elf
Z88DK_ELF_FLAGS := --compiler $(COMPILER) --origin 0100 --code-section code_user

ifeq ($(COMPILER),sdcc)
DEBUG_FLAGS := -clib=sdcc_ix -SO0 -Cs--fno-omit-frame-pointer
else ifeq ($(COMPILER),sccz80)
DEBUG_FLAGS := -O0
else
$(error COMPILER must be sdcc or sccz80)
endif

.DEFAULT_GOAL := debug-elf
.PHONY: FORCE
build/compiler: FORCE
	mkdir -p build
	printf '%s\n' "$(COMPILER)" > build/compiler.tmp
	cmp -s build/compiler.tmp $@ || mv build/compiler.tmp $@
	rm -f build/compiler.tmp

build/PROGRAM.COM build/program.map &: main.c coverage.asm build/compiler
	mkdir -p build
	$(ZCC) +cpm -compiler=$(COMPILER) $(DEBUG_FLAGS) -debug -create-app -m main.c coverage.asm -o build/program.bin

empty :=
space := $(empty) $(empty)
include $(subst $(space),\$(space),$(Z88DK_ELF_ROOT))/make/z88dk-elf.mk
