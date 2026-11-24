#include <stdio.h>

static unsigned int increment(unsigned int value)
{
    return value + 1;
}

int main(void)
{
    volatile unsigned int counter = 0;

    while (1) {
        counter = increment(counter);
    }
}
