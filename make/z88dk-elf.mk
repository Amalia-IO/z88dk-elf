# Set Z88DK_ELF_ROOT to the directory printed by z88dk-elf --support-dir.
ifndef Z88DK_ELF_ROOT
$(error Set Z88DK_ELF_ROOT before including z88dk-elf.mk)
endif
Z88DK_ELF_NODE ?= node
Z88DK_ELF_IMAGE ?= build/PROGRAM.COM
Z88DK_ELF_MAP ?= build/program.map
Z88DK_ELF_OUTPUT ?= build/program.debug.elf
Z88DK_ELF_FLAGS ?= --compiler auto --origin 0100
Z88DK_ELF_EXTRA_DEPS ?=

z88dk_elf_empty :=
z88dk_elf_space := $(z88dk_elf_empty) $(z88dk_elf_empty)
z88dk_elf_escape = $(subst $(z88dk_elf_space),\$(z88dk_elf_space),$(1))
z88dk_elf_default_goal := $(.DEFAULT_GOAL)

.PHONY: debug-elf
debug-elf: $(call z88dk_elf_escape,$(Z88DK_ELF_IMAGE)) $(call z88dk_elf_escape,$(Z88DK_ELF_MAP)) $(Z88DK_ELF_EXTRA_DEPS)
	"$(Z88DK_ELF_NODE)" "$(Z88DK_ELF_ROOT)/make/debug-elf.js" $(foreach dep,$(Z88DK_ELF_EXTRA_DEPS),--dep "$(dep)") -- "$(Z88DK_ELF_IMAGE)" "$(Z88DK_ELF_MAP)" "$(Z88DK_ELF_OUTPUT)" $(Z88DK_ELF_FLAGS)

.DEFAULT_GOAL := $(z88dk_elf_default_goal)
