#define main production_main
#include "recovery-atomic-probe.c"
#undef main
#include <assert.h>

static unsigned char disk[8192];
static int writes, synchronizations;
static int scenario;

static void put_u32(unsigned char *data, size_t offset, uint32_t value) {
    memcpy(data + offset, &value, sizeof(value));
}
static void put_u64(unsigned char *data, size_t offset, uint64_t value) {
    memcpy(data + offset, &value, sizeof(value));
}
static int fake_query(int fd, unsigned char *data) {
    (void)fd;
    put_u32(data, 0, PROBE_STATX_DIOALIGN | PROBE_STATX_WRITE_ATOMIC);
    put_u64(data, 0x08, PROBE_STATX_ATTR_WRITE_ATOMIC);
    put_u64(data, 0x38, PROBE_STATX_ATTR_WRITE_ATOMIC);
    put_u32(data, 0x98, 512);
    put_u32(data, 0x9c, 512);
    put_u32(data, 0xa8, scenario == 3 ? 2097152 : 4096);
    put_u32(data, 0xac, scenario == 3 ? 2097152 : 8192);
    put_u32(data, 0xb0, 1);
    if (scenario == 1) put_u32(data, 0, PROBE_STATX_DIOALIGN);
    if (scenario == 2) put_u32(data, 0xa8, 3000);
    if (scenario == 7) put_u32(data, 0xb0, 0);
    if (scenario == 8) put_u32(data, 0x98, 0);
    if (scenario == 9) put_u64(data, 0x38, 0);
    if (scenario == 10) { errno = ENOSYS; return -1; }
    if (scenario == 11) put_u32(data, 0x9c, 16384);
    if (scenario == 12) {
        put_u32(data, 0, PROBE_STATX_DIOALIGN | PROBE_STATX_WRITE_ATOMIC | PROBE_STATX_DIO_READ_ALIGN);
        put_u32(data, 0xb4, 0);
    }
    return 0;
}
static ssize_t fake_write(int fd, const void *data, size_t length) {
    (void)fd;
    assert((uintptr_t)data % 512 == 0);
    assert(length == 4096);
    ++writes;
    if (scenario == 4 && writes == 2) return (ssize_t)length / 2;
    memcpy(disk, data, length);
    return (ssize_t)length;
}
static int fake_sync(int fd) {
    (void)fd;
    ++synchronizations;
    return scenario == 5 ? -1 : 0;
}
static ssize_t fake_read(int fd, void *data, size_t length) {
    (void)fd;
    memcpy(data, disk, length);
    if (scenario == 6) ((unsigned char *)data)[0] = 0;
    return (ssize_t)length;
}

int main(void) {
    const struct probe_operations operations = {
        .query = fake_query, .write_atomic = fake_write,
        .synchronize = fake_sync, .read_back = fake_read,
    };
    for (scenario = 0; scenario <= 12; ++scenario) {
        writes = synchronizations = 0;
        struct probe_result result = probe_file(-1, 983040, &operations);
        enum probe_status expected = scenario == 0 ? PROBE_SUPPORTED :
            scenario == 3 ? PROBE_CAPACITY :
            scenario >= 4 && scenario <= 6 ? PROBE_FAILED : PROBE_UNSUPPORTED;
        assert(result.status == expected);
        if (scenario == 0) {
            assert(result.unit_bytes == 4096 && result.memory_alignment == 512);
            assert(writes == 2 && synchronizations == 2);
        }
        if (scenario == 4) assert(writes == 2 && synchronizations == 1);
        if (expected == PROBE_UNSUPPORTED || expected == PROBE_CAPACITY) assert(writes == 0);
    }
    /* Exercise the production syscall path on this host, including hosts that
     * correctly report no atomic support, and refuse non-probe input. */
    char path[] = "/tmp/rip-dvd-atomic-contract-XXXXXX";
    int fd = mkstemp(path);
    assert(fd >= 0 && close(fd) == 0);
    char *arguments[] = { "atomic-probe", path, "983040", NULL };
    assert(production_main(3, arguments) == 0);
    fd = open(path, O_WRONLY | O_TRUNC);
    assert(fd >= 0 && write(fd, "retained", 8) == 8 && close(fd) == 0);
    assert(production_main(3, arguments) == 1);
    fd = open(path, O_RDONLY);
    char retained[8];
    assert(fd >= 0 && read(fd, retained, 8) == 8 && close(fd) == 0);
    assert(memcmp(retained, "retained", 8) == 0);
    assert(unlink(path) == 0);
    puts("Atomic recovery storage contract tests passed");
    return 0;
}
