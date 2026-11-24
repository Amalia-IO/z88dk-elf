volatile unsigned int observed;
extern unsigned int assembly_value(void);

unsigned int recurse(unsigned int depth)
{
    volatile unsigned int local = depth + 10;
    if (depth)
        local += recurse(depth - 1);
    observed = local;
    return local;
}

unsigned int leaf(unsigned int value)
{
    volatile unsigned int local = value + 3;
    observed = local;
    return local;
}

unsigned int invoke(unsigned int (*callback)(unsigned int), unsigned int value)
{
    volatile unsigned int local = callback(value);
    observed = local;
    return local;
}

int main(void)
{
    observed = recurse(3);
    observed = invoke(leaf, 7);
    observed = assembly_value();
    return 0;
}
