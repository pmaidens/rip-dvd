#define _GNU_SOURCE
#include <errno.h>
#include <fcntl.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/stat.h>
#include <sys/syscall.h>
#include <sys/uio.h>
#include <unistd.h>

/* Stable Linux statx ABI offsets, including fields absent from Bookworm headers.
 * https://github.com/torvalds/linux/blob/v6.15/include/uapi/linux/stat.h
 * Unknown result-mask bits are never treated as a capability. */
#define PROBE_STATX_DIOALIGN 0x00002000U
#define PROBE_STATX_WRITE_ATOMIC 0x00010000U
#define PROBE_STATX_DIO_READ_ALIGN 0x00020000U
#define PROBE_STATX_ATTR_WRITE_ATOMIC 0x00400000ULL
#define PROBE_RWF_ATOMIC 0x00000040
#define PROBE_RWF_SYNC 0x00000004
#define MAX_PROBE_BYTES 1048576U

enum probe_status { PROBE_SUPPORTED, PROBE_UNSUPPORTED, PROBE_CAPACITY, PROBE_FAILED };
struct probe_result {
    enum probe_status status;
    uint32_t unit_bytes;
    uint32_t memory_alignment;
};
struct probe_operations {
    int (*query)(int, unsigned char *);
    ssize_t (*write_atomic)(int, const void *, size_t);
    int (*synchronize)(int);
    ssize_t (*read_back)(int, void *, size_t);
};

static uint32_t read_u32(const unsigned char *data, size_t offset) {
    uint32_t value;
    memcpy(&value, data + offset, sizeof(value));
    return value;
}

static uint64_t read_u64(const unsigned char *data, size_t offset) {
    uint64_t value;
    memcpy(&value, data + offset, sizeof(value));
    return value;
}

static int power_of_two(uint32_t value) {
    return value != 0 && (value & (value - 1)) == 0;
}

static int query_atomic(int fd, unsigned char *data) {
    return (int)syscall(SYS_statx, fd, "", AT_EMPTY_PATH,
        PROBE_STATX_DIOALIGN | PROBE_STATX_WRITE_ATOMIC | PROBE_STATX_DIO_READ_ALIGN,
        data);
}

static ssize_t write_atomic(int fd, const void *data, size_t length) {
    struct iovec vector = { .iov_base = (void *)data, .iov_len = length };
    return pwritev2(fd, &vector, 1, 0, PROBE_RWF_ATOMIC | PROBE_RWF_SYNC);
}

static ssize_t read_back(int fd, void *data, size_t length) {
    return pread(fd, data, length, 0);
}

static struct probe_result probe_file(
    int fd, uint32_t capacity, const struct probe_operations *operations
) {
    struct probe_result result = { .status = PROBE_UNSUPPORTED };
    _Alignas(8) unsigned char attributes[256] = {0};
    if (operations->query(fd, attributes) != 0) {
        if (errno != ENOSYS && errno != EINVAL && errno != EOPNOTSUPP)
            result.status = PROBE_FAILED;
        return result;
    }
    uint32_t mask = read_u32(attributes, 0x00);
    uint32_t required = PROBE_STATX_DIOALIGN | PROBE_STATX_WRITE_ATOMIC;
    if ((mask & required) != required ||
        !(read_u64(attributes, 0x38) & PROBE_STATX_ATTR_WRITE_ATOMIC) ||
        !(read_u64(attributes, 0x08) & PROBE_STATX_ATTR_WRITE_ATOMIC)) return result;
    uint32_t minimum = read_u32(attributes, 0xa8);
    uint32_t maximum = read_u32(attributes, 0xac);
    uint32_t segments = read_u32(attributes, 0xb0);
    uint32_t memory_alignment = read_u32(attributes, 0x98);
    uint32_t offset_alignment = read_u32(attributes, 0x9c);
    uint32_t read_alignment = (mask & PROBE_STATX_DIO_READ_ALIGN)
        ? read_u32(attributes, 0xb4) : offset_alignment;
    if (!power_of_two(minimum) || !power_of_two(maximum) || maximum < minimum ||
        segments < 1 || !power_of_two(memory_alignment) ||
        memory_alignment > MAX_PROBE_BYTES || !power_of_two(offset_alignment) ||
        !power_of_two(read_alignment)) return result;
    uint32_t unit = minimum;
    if (unit < offset_alignment) unit = offset_alignment;
    if (unit < read_alignment) unit = read_alignment;
    if (unit > maximum) return result;
    result.unit_bytes = unit;
    result.memory_alignment = memory_alignment;
    if (unit > capacity) {
        result.status = PROBE_CAPACITY;
        return result;
    }
    void *buffer = NULL;
    size_t allocation_alignment = memory_alignment < sizeof(void *)
        ? sizeof(void *) : memory_alignment;
    result.status = PROBE_FAILED;
    if (posix_memalign(&buffer, allocation_alignment, unit) != 0) return result;
    /* The second atomic write overwrites already synchronized contents. Never
     * retry short writes as fragments or fall back to buffered writes. */
    for (int pass = 0; pass < 2; ++pass) {
        memset(buffer, pass == 0 ? 0x35 : 0xca, unit);
        if (operations->write_atomic(fd, buffer, unit) != (ssize_t)unit ||
            operations->synchronize(fd) != 0) goto finished;
    }
    memset(buffer, 0, unit);
    if (operations->read_back(fd, buffer, unit) != (ssize_t)unit) goto finished;
    for (uint32_t index = 0; index < unit; ++index) {
        if (((unsigned char *)buffer)[index] != 0xca) goto finished;
    }
    result.status = PROBE_SUPPORTED;
finished:
    free(buffer);
    return result;
}

int main(int argc, char **argv) {
    if (argc != 3) return 2;
    char *end = NULL;
    errno = 0;
    unsigned long capacity = strtoul(argv[2], &end, 10);
    if (errno || end == argv[2] || *end || capacity == 0 || capacity > MAX_PROBE_BYTES)
        return 2;
    int fd = open(argv[1], O_RDWR | O_DIRECT | O_SYNC | O_NOFOLLOW | O_CLOEXEC | O_NONBLOCK);
    if (fd < 0) {
        if (errno == EINVAL || errno == EOPNOTSUPP) {
            puts("{\"status\":\"unsupported\"}");
            return 0;
        }
        return 1;
    }
    struct stat metadata;
    if (fstat(fd, &metadata) != 0 || !S_ISREG(metadata.st_mode) ||
        metadata.st_nlink != 1 || metadata.st_uid != geteuid() || metadata.st_size != 0) {
        close(fd);
        return 1;
    }
    const struct probe_operations operations = {
        .query = query_atomic, .write_atomic = write_atomic,
        .synchronize = fsync, .read_back = read_back,
    };
    struct probe_result result = probe_file(fd, (uint32_t)capacity, &operations);
    if (close(fd) != 0 || result.status == PROBE_FAILED) return 1;
    if (result.status == PROBE_UNSUPPORTED) {
        puts("{\"status\":\"unsupported\"}");
    } else {
        printf("{\"status\":\"%s\",\"unitBytes\":%u,\"memoryAlignmentBytes\":%u}\n",
            result.status == PROBE_SUPPORTED ? "supported" : "capacity_insufficient",
            result.unit_bytes, result.memory_alignment);
    }
    return 0;
}
