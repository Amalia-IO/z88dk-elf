volatile unsigned int observed;

unsigned int shadow(unsigned int value)
{
    volatile unsigned int total = value + 1;
    {
        volatile unsigned int total = value + 20;
        volatile unsigned int extra = total + 1;
        observed = total + extra;
    }
    {
        volatile unsigned int other = total + 2;
        observed = other;
    }
    return total;
}

int main(void)
{
    observed = shadow(5);
    return 0;
}
