volatile unsigned int counter;

unsigned int increment(unsigned int value)
{
    unsigned int next = value + 1;
    counter = next;
    return next;
}

unsigned int caller(unsigned int seed)
{
    unsigned int saved = seed + 2;
    return increment(saved);
}

unsigned int typed_probe(int adjustment, char *text); unsigned int flow_probe(unsigned int choose); unsigned int scope_probe(void); unsigned int recursive_probe(unsigned int depth);
int return_signed_int(void); unsigned char return_unsigned_char(void); signed char return_signed_char(void); unsigned long return_unsigned_long(void); unsigned int *return_pointer(void);
int main(void)
{   return_signed_int(); return_unsigned_char(); return_signed_char(); return_unsigned_long(); return_pointer();
    return typed_probe(-123, "Hello CP/M") + flow_probe(0) + flow_probe(1) + scope_probe() + recursive_probe(3);
}

unsigned int numbers[3] = { 10, 20, 30 };
char message[] = "Hello CP/M";
int signed_values[3] = { -1, -123, 32767 };
unsigned int *numbers_ptr = numbers;
char *message_ptr = message;

struct probe_record {
    unsigned int count;
    char label[6];
    char *text;
};

struct probe_record record = { 123, "Hello", message };

unsigned int typed_probe(int adjustment, char *text)
{
    int signed_local = -7;
    char letter = 'Z';
    long wide = -123456L;
    unsigned int local_numbers[2] = { 7, 8 };
    char local_message[6] = "Local";
    char *local_text = text;
    struct probe_record local_record = { 321, "Stack", message };
    return caller(39);
}

unsigned int flow_probe(unsigned int choose)
{
    unsigned int total;
    unsigned int index;
    if (choose)
        total = 10;
    else
        total = 20;
    for (index = 0; index < 3; ++index)
        total = increment(total);
    return total;
}

unsigned int scope_probe(void)
{
    unsigned int value = 100;
    counter = value;
    {
        unsigned int value = 200;
        unsigned int inner_only = 201;
        counter = increment(value);
    }
    counter = value;
    {
        unsigned int value = 300;
        unsigned int sibling_only = 301;
        counter = increment(value);
    }
    return value;
}

unsigned int recursive_probe(unsigned int depth)
{
    unsigned int marker = depth + 100, result = 0;
    counter = marker;
    if (depth) {
        result = recursive_probe(depth - 1);
    }
    return marker + result;
}

int return_signed_int(void)
{
    return -123;
}

unsigned char return_unsigned_char(void)
{
    return 200;
}

signed char return_signed_char(void)
{
    return -37;
}

unsigned long return_unsigned_long(void)
{
    return 0x12345678UL;
}

unsigned int *return_pointer(void)
{
    return &counter;
}
