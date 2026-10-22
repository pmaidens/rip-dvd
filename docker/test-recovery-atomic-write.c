#define main production_main
#include "recovery-atomic-write.c"
#undef main
#include <assert.h>

static unsigned char disk[4096];
static int scenario;

static void put_u32(unsigned char *data, size_t offset, uint32_t value) {
    memcpy(data + offset, &value, sizeof(value));
}

static void put_u64(unsigned char *data, size_t offset, uint64_t value) {
    memcpy(data + offset, &value, sizeof(value));
}

static int fake_query(int fd, unsigned char *data) {
    (void)fd;
    put_u32(data, 0x00, WRITER_STATX_DIOALIGN | WRITER_STATX_WRITE_ATOMIC);
    put_u64(data, 0x08, WRITER_STATX_ATTR_WRITE_ATOMIC);
    put_u64(data, 0x38, WRITER_STATX_ATTR_WRITE_ATOMIC);
    put_u32(data, 0x98, 512);
    put_u32(data, 0x9c, 512);
    put_u32(data, 0xa8, 4096);
    put_u32(data, 0xac, 8192);
    put_u32(data, 0xb0, 1);
    if (scenario == 1) put_u64(data, 0x38, 0);
    return 0;
}

static ssize_t fake_write(int fd, const void *data, size_t length,
                          off_t offset) {
    (void)fd;
    assert(offset == 4096 && length == sizeof(disk));
    if (scenario == 2) return (ssize_t)length / 2;
    memcpy(disk, data, length);
    return (ssize_t)length;
}

static int fake_sync(int fd) {
    (void)fd;
    return scenario == 3 ? -1 : 0;
}

static ssize_t fake_read(int fd, void *data, size_t length, off_t offset) {
    (void)fd;
    assert(offset == 4096);
    memcpy(data, disk, length);
    if (scenario == 4) ((unsigned char *)data)[0] ^= 1;
    return (ssize_t)length;
}

int main(void) {
    const struct writer_operations operations = {
        .query = fake_query,
        .write_atomic = fake_write,
        .synchronize = fake_sync,
        .read_back = fake_read,
    };
    struct writer_capability capability = {0};
    scenario = 0;
    assert(inspect_atomic_capability(-1, &capability, &operations) == 0);
    assert(capability.unit_bytes == 4096);
    assert(capability.memory_alignment == 512);
    scenario = 1;
    assert(inspect_atomic_capability(-1, &capability, &operations) == 1);
    unsigned char expected[4096], actual[4096];
    memset(expected, 0xa5, sizeof(expected));
    int write_scenarios[] = {0, 2, 3, 4};
    for (size_t index = 0; index < sizeof(write_scenarios) / sizeof(int); ++index) {
        scenario = write_scenarios[index];
        int result = commit_atomic_unit(
            -1, expected, actual, 4096, sizeof(expected), &operations);
        assert(result == (scenario == 0 ? 0 : 1));
    }
    struct timespec parsed;
    assert(nanoseconds_to_timespec(1234567890123456789ULL, &parsed) == 0);
    assert(parsed.tv_sec == 1234567890);
    assert(parsed.tv_nsec == 123456789);
    puts("Atomic recovery writer tests passed");
    return 0;
}
