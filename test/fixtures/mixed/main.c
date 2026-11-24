extern unsigned int calculate(unsigned int value);
extern unsigned int assembly_value(void);
volatile unsigned int observed;
signed int offset = -123;
unsigned int readings[3] = {4, 5, 6};
unsigned char wide_array[16] = {1};
struct packet {
    signed char tag;
    unsigned long payload;
};
struct packet sample = {-7, 0x12345678UL};
struct packet *sample_address = &sample;
static volatile unsigned int hidden = 17;
static int adjust(int value)
{
    return value + hidden;
}

int return_signed(void)
{
    return -123;
}

unsigned int *return_pointer(void)
{
    return (unsigned int *)&observed;
}

void return_void(void)
{
    observed = hidden;
}

int main(void)
{
    return_void();
    observed = calculate(adjust(9)) + assembly_value() + return_signed() + *return_pointer();
    return 0;
}
