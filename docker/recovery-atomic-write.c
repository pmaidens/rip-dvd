#define _GNU_SOURCE
#include <errno.h>
#include <fcntl.h>
#include <inttypes.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/stat.h>
#include <sys/syscall.h>
#include <sys/uio.h>
#include <unistd.h>

#define WRITER_STATX_DIOALIGN 0x00002000U
#define WRITER_STATX_WRITE_ATOMIC 0x00010000U
#define WRITER_STATX_DIO_READ_ALIGN 0x00020000U
#define WRITER_STATX_ATTR_WRITE_ATOMIC 0x00400000ULL
#define WRITER_RWF_ATOMIC 0x00000040
#define WRITER_RWF_SYNC 0x00000004
#define MAX_UNIT_BYTES 983040U

struct writer_capability {
    uint32_t unit_bytes;
    uint32_t memory_alignment;
};

struct writer_operations {
    int (*query)(int, unsigned char *);
    ssize_t (*write_atomic)(int, const void *, size_t, off_t);
    int (*synchronize)(int);
    ssize_t (*read_back)(int, void *, size_t, off_t);
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
        WRITER_STATX_DIOALIGN | WRITER_STATX_WRITE_ATOMIC |
            WRITER_STATX_DIO_READ_ALIGN,
        data);
}

static ssize_t write_atomic(int fd, const void *data, size_t length,
                            off_t offset) {
    struct iovec vector = { .iov_base = (void *)data, .iov_len = length };
    return pwritev2(fd, &vector, 1, offset,
                    WRITER_RWF_ATOMIC | WRITER_RWF_SYNC);
}

static ssize_t read_back(int fd, void *data, size_t length, off_t offset) {
    return pread(fd, data, length, offset);
}

static int inspect_atomic_capability(
    int fd, struct writer_capability *capability,
    const struct writer_operations *operations
) {
    _Alignas(8) unsigned char attributes[256] = {0};
    if (operations->query(fd, attributes) != 0) return 1;
    uint32_t mask = read_u32(attributes, 0x00);
    uint32_t required = WRITER_STATX_DIOALIGN | WRITER_STATX_WRITE_ATOMIC;
    uint32_t minimum = read_u32(attributes, 0xa8);
    uint32_t maximum = read_u32(attributes, 0xac);
    uint32_t segments = read_u32(attributes, 0xb0);
    uint32_t memory_alignment = read_u32(attributes, 0x98);
    uint32_t offset_alignment = read_u32(attributes, 0x9c);
    uint32_t read_alignment = (mask & WRITER_STATX_DIO_READ_ALIGN)
        ? read_u32(attributes, 0xb4) : offset_alignment;
    if ((mask & required) != required ||
        !(read_u64(attributes, 0x38) & WRITER_STATX_ATTR_WRITE_ATOMIC) ||
        !(read_u64(attributes, 0x08) & WRITER_STATX_ATTR_WRITE_ATOMIC) ||
        !power_of_two(minimum) || !power_of_two(maximum) || maximum < minimum ||
        segments < 1 || !power_of_two(memory_alignment) ||
        !power_of_two(offset_alignment) || !power_of_two(read_alignment)) return 1;
    uint32_t unit = minimum;
    if (unit < offset_alignment) unit = offset_alignment;
    if (unit < read_alignment) unit = read_alignment;
    if (unit > maximum || unit > MAX_UNIT_BYTES ||
        memory_alignment > MAX_UNIT_BYTES) return 1;
    capability->unit_bytes = unit;
    capability->memory_alignment = memory_alignment;
    return 0;
}

static int descriptor_holds_exclusive_flock(int descriptor) {
    struct stat descriptor_stat;
    if (fstat(descriptor, &descriptor_stat) != 0 ||
        !S_ISREG(descriptor_stat.st_mode) || descriptor_stat.st_nlink != 1 ||
        (descriptor_stat.st_mode & 077) != 0 ||
        descriptor_stat.st_uid != geteuid()) return 0;
    char path[64];
    int length = snprintf(path, sizeof(path), "/proc/self/fdinfo/%d", descriptor);
    if (length < 0 || (size_t)length >= sizeof(path)) return 0;
    FILE *info = fopen(path, "r");
    if (info == NULL) return 0;
    int locks = 0;
    char line[512];
    while (fgets(line, sizeof(line), info) != NULL) {
        unsigned int lock_id;
        char type[16], advisory[16], access[16];
        if (sscanf(line, "lock: %u: %15s %15s %15s",
                   &lock_id, type, advisory, access) == 4 &&
            strcmp(type, "FLOCK") == 0 &&
            strcmp(advisory, "ADVISORY") == 0 &&
            strcmp(access, "WRITE") == 0) locks += 1;
    }
    int failed = ferror(info);
    if (fclose(info) != 0) failed = 1;
    return !failed && locks == 1;
}

static int commit_atomic_unit(
    int fd, const void *expected, void *readback, off_t offset, size_t length,
    const struct writer_operations *operations
) {
    if (operations->write_atomic(fd, expected, length, offset) !=
            (ssize_t)length ||
        operations->synchronize(fd) != 0 ||
        operations->read_back(fd, readback, length, offset) !=
            (ssize_t)length ||
        memcmp(expected, readback, length) != 0) return 1;
    return 0;
}

static int parse_u64(const char *text, uint64_t *value) {
    char *end = NULL;
    errno = 0;
    unsigned long long parsed = strtoull(text, &end, 10);
    if (errno != 0 || end == text || *end != '\0') return 1;
    *value = (uint64_t)parsed;
    return 0;
}

static int nanoseconds_to_timespec(uint64_t value, struct timespec *time) {
    uint64_t seconds = value / 1000000000ULL;
    if (seconds > (uint64_t)INT64_MAX) return 1;
    time->tv_sec = (time_t)seconds;
    time->tv_nsec = (long)(value % 1000000000ULL);
    return 0;
}

static int restore_version(int fd, uint64_t mtime_ns) {
    struct timespec times[2] = {
        { .tv_sec = 0, .tv_nsec = UTIME_OMIT },
        {0},
    };
    if (nanoseconds_to_timespec(mtime_ns, &times[1]) != 0 ||
        futimens(fd, times) != 0 || fsync(fd) != 0) return 1;
    struct stat metadata;
    if (fstat(fd, &metadata) != 0 ||
        (uint64_t)metadata.st_mtim.tv_sec != mtime_ns / 1000000000ULL ||
        (uint64_t)metadata.st_mtim.tv_nsec != mtime_ns % 1000000000ULL) {
        return 1;
    }
    return 0;
}

static int read_exact_stdin(void *buffer, size_t length) {
    size_t offset = 0;
    while (offset < length) {
        ssize_t count = read(STDIN_FILENO, (unsigned char *)buffer + offset,
                             length - offset);
        if (count < 0 && errno == EINTR) continue;
        if (count <= 0) return 1;
        offset += (size_t)count;
    }
    unsigned char extra;
    ssize_t count;
    do { count = read(STDIN_FILENO, &extra, 1); } while (count < 0 && errno == EINTR);
    return count != 0;
}

int main(int argc, char **argv) {
    if (argc < 2 ||
        (strcmp(argv[1], "inspect") == 0 ? argc != 5 :
         strcmp(argv[1], "write") == 0 ? argc != 7 :
         strcmp(argv[1], "restore-version") == 0 ? argc != 6 : 1) ||
        !descriptor_holds_exclusive_flock(3)) return 2;
    uint64_t expected_device, expected_inode;
    int identity_index = strcmp(argv[1], "inspect") == 0 ? 3 :
        strcmp(argv[1], "write") == 0 ? 5 : 4;
    if (parse_u64(argv[identity_index], &expected_device) != 0 ||
        parse_u64(argv[identity_index + 1], &expected_inode) != 0) return 2;
    int direct_operation = strcmp(argv[1], "restore-version") != 0;
    int flags = O_RDWR | O_NOFOLLOW | O_CLOEXEC | O_NONBLOCK;
    if (direct_operation) flags |= O_DIRECT | O_SYNC;
    int fd = open(argv[2], flags);
    if (fd < 0) return 1;
    struct stat metadata;
    if (fstat(fd, &metadata) != 0 || !S_ISREG(metadata.st_mode) ||
        metadata.st_nlink != 1 || metadata.st_uid != geteuid() ||
        metadata.st_size <= 0 || (uint64_t)metadata.st_dev != expected_device ||
        (uint64_t)metadata.st_ino != expected_inode) {
        close(fd);
        return 1;
    }
    if (strcmp(argv[1], "restore-version") == 0) {
        uint64_t mtime_ns;
        if (parse_u64(argv[3], &mtime_ns) != 0 ||
            restore_version(fd, mtime_ns) != 0 ||
            !descriptor_holds_exclusive_flock(3)) {
            close(fd);
            return 1;
        }
        int status = close(fd);
        printf("{\"status\":\"restored\",\"mtimeNs\":\"%" PRIu64 "\"}\n",
               mtime_ns);
        return status == 0 ? 0 : 1;
    }
    const struct writer_operations operations = {
        .query = query_atomic,
        .write_atomic = write_atomic,
        .synchronize = fsync,
        .read_back = read_back,
    };
    struct writer_capability capability = {0};
    if (inspect_atomic_capability(fd, &capability, &operations) != 0) {
        close(fd);
        puts("{\"status\":\"unsupported\"}");
        return 0;
    }
    if (strcmp(argv[1], "inspect") == 0) {
        int status = close(fd);
        printf("{\"status\":\"supported\",\"unitBytes\":%u,"
               "\"memoryAlignmentBytes\":%u}\n",
               capability.unit_bytes, capability.memory_alignment);
        return status == 0 ? 0 : 1;
    }
    uint64_t offset, requested_unit;
    if (parse_u64(argv[3], &offset) != 0 ||
        parse_u64(argv[4], &requested_unit) != 0 ||
        requested_unit != capability.unit_bytes ||
        offset % capability.unit_bytes != 0 ||
        offset > (uint64_t)metadata.st_size ||
        capability.unit_bytes > (uint64_t)metadata.st_size - offset) {
        close(fd);
        return 2;
    }
    size_t alignment = capability.memory_alignment < sizeof(void *)
        ? sizeof(void *) : capability.memory_alignment;
    void *expected = NULL, *actual = NULL;
    if (posix_memalign(&expected, alignment, capability.unit_bytes) != 0 ||
        posix_memalign(&actual, alignment, capability.unit_bytes) != 0) {
        free(expected);
        free(actual);
        close(fd);
        return 1;
    }
    int status = read_exact_stdin(expected, capability.unit_bytes);
    if (status == 0 && !descriptor_holds_exclusive_flock(3)) status = 1;
    if (status == 0) status = commit_atomic_unit(
        fd, expected, actual, (off_t)offset, capability.unit_bytes, &operations);
    if (status == 0 && !descriptor_holds_exclusive_flock(3)) status = 1;
    free(expected);
    free(actual);
    if (close(fd) != 0) status = 1;
    if (status != 0) return 1;
    printf("{\"status\":\"written\",\"unitBytes\":%u,"
           "\"bytesWritten\":%u}\n",
           capability.unit_bytes, capability.unit_bytes);
    return 0;
}
