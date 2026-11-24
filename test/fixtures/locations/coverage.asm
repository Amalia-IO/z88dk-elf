SECTION code_user
PUBLIC _assembly_value

_assembly_value:
    push bc
    ld bc,1234
    ld hl,42
    pop bc
    ret
