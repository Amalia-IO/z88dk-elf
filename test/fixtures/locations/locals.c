volatile unsigned int observed;

unsigned int leaf(unsigned int argument)
{
    volatile unsigned int temporary = argument + 3;
    return temporary;
}

unsigned int parent(unsigned int argument)
{
    volatile unsigned int local = argument + 7;
    return leaf(local) + local;
}

int main(void)
{
    observed = parent(11);
    return 0;
}
