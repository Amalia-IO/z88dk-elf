"""Guarded unwinding from instruction-derived generic Z80 frame metadata."""

import json
import hashlib

import gdb
import gdb.unwinder


def require_fields(value, fields, context):
    if not isinstance(value, dict) or any(
            type(value.get(name)) is not expected for name, expected in fields.items()):
        raise gdb.GdbError("generic-z80-unwind: invalid %s metadata" % context)


def validate_locations(locations):
    if not isinstance(locations, list):
        raise gdb.GdbError("generic-z80-unwind: invalid recovery locations")
    for location in locations:
        if not isinstance(location, dict):
            raise gdb.GdbError("generic-z80-unwind: invalid recovery location")
        fields = {"register": {"name": str}, "memory": {"spOffset": int},
                  "absolute": {"address": int}}.get(location.get("kind"))
        if fields is None:
            raise gdb.GdbError("generic-z80-unwind: unsupported recovery location")
        require_fields(location, fields, "recovery location")


def validate_frames(metadata):
    for function in metadata["typed"]["functions"]:
        require_fields(function, {"name": str, "address": int}, "function")
    for frame in metadata["frames"]:
        require_fields(frame, {"entry": int, "complete": bool, "rows": list,
                               "instructionBytes": list, "parentEdges": list}, "frame")
        for row in frame["rows"]:
            require_fields(row, {"pc": int}, "frame row")
            if not frame["complete"] or row.get("unavailable"):
                continue
            require_fields(row, {"entrySpOffset": int, "callerEntrySpOffset": int,
                                 "returnLocations": list, "savedRegisters": dict}, "frame row")
            validate_locations(row["returnLocations"])
            for locations in row["savedRegisters"].values():
                validate_locations(locations)
        if not frame["complete"]:
            continue
        for instruction in frame["instructionBytes"]:
            require_fields(instruction, {"address": int, "bytes": str}, "instruction")
            try:
                encoded = bytes.fromhex(instruction["bytes"])
            except ValueError as error:
                raise gdb.GdbError("generic-z80-unwind: invalid instruction bytes") from error
            if not encoded:
                raise gdb.GdbError("generic-z80-unwind: empty instruction bytes")
        require_fields(frame, {"runtimeGuards": dict}, "frame")
        guards = frame["runtimeGuards"]
        require_fields(guards, {"stackOffsetBounds": dict, "spOffsetBounds": dict,
                               "disjointExecutableRanges": list,
                               "disjointAbsoluteAddresses": list}, "runtime guard")
        for name in ("stackOffsetBounds", "spOffsetBounds"):
            require_fields(guards[name], {"min": int, "max": int}, "runtime guard bounds")
        for code_range in guards["disjointExecutableRanges"]:
            require_fields(code_range, {"start": int, "end": int}, "runtime code range")
        if any(type(address) is not int for address in guards["disjointAbsoluteAddresses"]):
            raise gdb.GdbError("generic-z80-unwind: invalid absolute address guards")
        for edge in frame["parentEdges"]:
            require_fields(edge, {"continuation": int, "parentEntry": int,
                                 "parentEntrySpOffsetAtChildEntry": int,
                                 "parentEntrySpOffsetAtContinuation": int}, "caller edge")


def read_word(inferior, address):
    if address < 0 or address > 0xfffe:
        raise gdb.GdbError("generic-z80-unwind: 16-bit memory read would wrap")
    return int.from_bytes(bytes(inferior.read_memory(address, 2)), "little")


def check_guards(analysis, entry_sp):
    guards = analysis["runtimeGuards"]
    low = entry_sp + guards["stackOffsetBounds"]["min"]
    high = entry_sp + guards["stackOffsetBounds"]["max"]
    sp_bounds = guards["spOffsetBounds"]
    if min(low, entry_sp + sp_bounds["min"]) < 0 or \
            max(high, entry_sp + sp_bounds["max"]) > 0xffff:
        return "tracked stack or SP arithmetic wraps the address space"
    for code in guards["disjointExecutableRanges"]:
        if low < code["end"] and high >= code["start"]:
            return "tracked stack may alias executable code"
    for address in guards["disjointAbsoluteAddresses"]:
        if low <= address <= high:
            return "tracked stack may alias absolute address 0x%x" % address
    return None


def location_value(pending, inferior, location):
    kind = location["kind"]
    if kind == "register":
        return int(pending.read_register(location["name"])) & 0xffff
    if kind == "memory":
        sp = int(pending.read_register("sp")) & 0xffff
        return read_word(inferior, sp + location["spOffset"])
    if kind == "absolute":
        return read_word(inferior, location["address"])
    raise gdb.GdbError("generic-z80-unwind: unsupported recovery location %s" % kind)


def verify_code(inferior, frame, pc):
    instructions = frame["instructionBytes"]
    if not instructions or not any(item["address"] == pc for item in instructions):
        raise gdb.GdbError(
            "generic-z80-unwind: frame has no code evidence for PC 0x%x" % pc)
    ranges = []
    for item in instructions:
        address = item["address"]
        expected = bytes.fromhex(item["bytes"])
        if ranges and ranges[-1][0] + len(ranges[-1][1]) == address:
            ranges[-1] = (ranges[-1][0], ranges[-1][1] + expected)
        else:
            ranges.append((address, expected))
    for address, expected in ranges:
        actual = bytes(inferior.read_memory(address, len(expected)))
        if actual != expected:
            raise gdb.GdbError(
                "generic-z80-unwind: target code at 0x%x does not match the analysed ELF" % address)


class GenericZ80Unwinder(gdb.unwinder.Unwinder):
    def __init__(self, metadata):
        super().__init__("generic-z80-instruction-analysis")
        self.frames = metadata.get("frames", [])
        self.frames_by_entry = {frame["entry"]: frame for frame in self.frames}
        self.symbol_functions = metadata.get("typed", {}).get("functions", [])

    def caller_stack_pointer(self, frame, row, return_pc, sp, inferior):
        edges = [edge for edge in frame["parentEdges"] if edge["continuation"] == return_pc]
        if not edges:
            if any(not edge.get("indirect", False) for edge in frame["parentEdges"]):
                raise gdb.GdbError(
                    "generic-z80-unwind: no analysed caller edge for return PC 0x%x" % return_pc)
            return sp + row["callerEntrySpOffset"]
        recovered = set()
        for edge in edges:
            parent = self.frames_by_entry.get(edge["parentEntry"])
            if parent is None or not parent["complete"]:
                continue
            parent_entry_sp = sp + row["entrySpOffset"] + \
                edge["parentEntrySpOffsetAtChildEntry"]
            if not 0 <= parent_entry_sp <= 0xffff:
                continue
            reason = check_guards(parent, parent_entry_sp)
            if reason:
                continue
            verify_code(inferior, parent, return_pc)
            resume_sp = parent_entry_sp - edge["parentEntrySpOffsetAtContinuation"]
            if 0 <= resume_sp <= 0xffff:
                recovered.add(resume_sp)
        if len(recovered) != 1:
            raise gdb.GdbError(
                "generic-z80-unwind: caller stack state is ambiguous at return PC 0x%x" % return_pc)
        return recovered.pop()

    def __call__(self, pending):
        pc = int(pending.read_register("pc")) & 0xffff
        sp = int(pending.read_register("sp")) & 0xffff
        matches = [(frame, row) for frame in self.frames for row in frame["rows"]
                   if row["pc"] == pc]
        if not matches:
            return None

        name = pending.name()
        if name:
            named_entries = {function["address"] for function in self.symbol_functions
                             if function["name"] == name}
            filtered = [(frame, row) for frame, row in matches if frame["entry"] in named_entries]
            if filtered:
                matches = filtered

        inferior = gdb.selected_inferior()
        candidates = []
        rejected = []
        for frame, row in matches:
            if not frame["complete"]:
                rejected.append("independent frame analysis is incomplete")
                continue
            if row.get("unavailable") or not row["returnLocations"]:
                rejected.append(row.get("unavailable", "no proven return continuation"))
                continue
            verify_code(inferior, frame, pc)
            entry_sp = sp + row["entrySpOffset"]
            caller_sp = sp + row["callerEntrySpOffset"]
            if not 0 <= entry_sp <= 0xffff or not 0 <= caller_sp <= 0xffff:
                rejected.append("derived entry or caller SP is outside the Z80 address space")
                continue
            reason = check_guards(frame, entry_sp)
            if reason:
                rejected.append(reason)
                continue

            return_values = {location_value(pending, inferior, location)
                             for location in row["returnLocations"]}
            if len(return_values) != 1:
                raise gdb.GdbError(
                    "generic-z80-unwind: proven return locations disagree at 0x%x" % pc)
            saved = {}
            for register, locations in row["savedRegisters"].items():
                values = {location_value(pending, inferior, location) for location in locations}
                if len(values) > 1:
                    raise gdb.GdbError(
                        "generic-z80-unwind: proven %s recovery locations disagree at 0x%x" %
                        (register, pc))
                if values:
                    saved[register] = values.pop()
            return_pc = return_values.pop()
            caller_sp = self.caller_stack_pointer(frame, row, return_pc, sp, inferior)
            if not 0 <= caller_sp <= 0xffff:
                rejected.append("derived caller stack pointer is outside the Z80 address space")
                continue
            candidates.append((frame["entry"], return_pc, caller_sp, saved))

        if not candidates:
            reason = rejected[0] if rejected else "no usable frame rule"
            raise gdb.GdbError("generic-z80-unwind: cannot unwind PC 0x%x: %s" % (pc, reason))
        identities = {(entry, return_pc, caller_sp)
                      for entry, return_pc, caller_sp, _ in candidates}
        if len(identities) != 1:
            raise gdb.GdbError(
                "generic-z80-unwind: ambiguous frame rules for PC 0x%x" % pc)

        entry, return_pc, caller_sp = next(iter(identities))
        common_registers = set(candidates[0][3])
        for _, _, _, saved in candidates[1:]:
            common_registers.intersection_update(saved)
        for register in common_registers:
            values = {saved[register] for _, _, _, saved in candidates}
            if len(values) != 1:
                raise gdb.GdbError(
                    "generic-z80-unwind: ambiguous %s recovery for PC 0x%x" % (register, pc))

        info = pending.create_unwind_info(gdb.unwinder.FrameId(caller_sp, entry))
        pc_type = pending.read_register("pc").type
        sp_type = pending.read_register("sp").type
        info.add_saved_register("pc", gdb.Value(return_pc).cast(pc_type))
        info.add_saved_register("sp", gdb.Value(caller_sp).cast(sp_type))
        for register in common_registers:
            value = candidates[0][3][register]
            info.add_saved_register(register, gdb.Value(value).cast(pending.read_register(register).type))
        return info


progspace = gdb.current_progspace()
elf = progspace.filename
if not elf:
    raise gdb.GdbError("Load the generic ELF before sourcing z80-generic-unwinder.py")
try:
    with open(elf + ".metadata.json", encoding="utf-8") as stream:
        metadata = json.load(stream)
except (OSError, ValueError) as error:
    raise gdb.GdbError("generic-z80-unwind: cannot read ELF metadata: %s" % error) from error
if not isinstance(metadata, dict) or type(metadata.get("schemaVersion")) is not int or \
        metadata["schemaVersion"] != 1:
    raise gdb.GdbError("generic-z80-unwind: unsupported metadata schema; regenerate with z88dk-elf")
producer = metadata.get("producer")
if not isinstance(producer, dict) or producer.get("name") != "z88dk-elf" or \
        not isinstance(producer.get("version"), str):
    raise gdb.GdbError("generic-z80-unwind: missing metadata producer")
try:
    with open(elf, "rb") as stream:
        digest = hashlib.sha256(stream.read()).hexdigest()
except OSError as error:
    raise gdb.GdbError("generic-z80-unwind: cannot read ELF: %s" % error) from error
if metadata.get("elfSha256") != digest:
    raise gdb.GdbError("generic-z80-unwind: ELF/metadata hash mismatch; regenerate the pair")
if not isinstance(metadata.get("frames"), list) or \
        not isinstance(metadata.get("typed"), dict) or \
        not isinstance(metadata["typed"].get("functions"), list):
    raise gdb.GdbError("generic-z80-unwind: invalid frame/type metadata")
if not metadata.get("frames"):
    raise gdb.GdbError("generic-z80-unwind: ELF metadata has no independent frame analysis")
validate_frames(metadata)
gdb.unwinder.register_unwinder(progspace, GenericZ80Unwinder(metadata), replace=True)
gdb.write("Registered guarded generic Z80 unwinder for this ELF.\n")
