static volatile unsigned int hidden = 29;

static unsigned long adjust(unsigned int value)
{
    return (unsigned long)value + hidden;
}

unsigned int calculate(unsigned int value)
{
    unsigned int result = adjust(value);
    unsigned int index;
    for (index = 0; index < 4; ++index)
        result += index;
    return result;
}
