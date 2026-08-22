/* SPDX-License-Identifier: GPL-2.0-or-later */

#define _GNU_SOURCE
#define RIP_DVD_SG_IO_IMPLEMENTATION

#include "libdvdcss-sg-io.h"

#include <linux/cdrom.h>
#include <scsi/scsi.h>
#include <scsi/sg.h>

#include <dirent.h>
#include <errno.h>
#include <fcntl.h>
#include <inttypes.h>
#include <limits.h>
#include <pthread.h>
#include <stdarg.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/ioctl.h>
#include <sys/stat.h>
#include <sys/sysmacros.h>
#include <unistd.h>

#define DVD_REPORT_AGID 0x00
#define DVD_REPORT_CHALLENGE 0x01
#define DVD_SEND_CHALLENGE 0x01
#define DVD_REPORT_KEY1 0x02
#define DVD_SEND_KEY2 0x03
#define DVD_REPORT_TITLE_KEY 0x04
#define DVD_REPORT_ASF 0x05
#define DVD_REPORT_RPC 0x08
#define DVDCSS_INVALIDATE_AGID 0x3f
#define DVD_LOGICAL_BLOCK_BYTES 2048U
#define SCSI_REQUEST_SENSE 0x03
#define SCSI_READ_10 0x28
#define SG_COMMAND_TIMEOUT_MS 15000U

struct read_scope {
    int active;
    struct rip_dvd_scsi_completion completion;
};

enum sg_device_acquire_outcome {
    SG_DEVICE_UNAVAILABLE,
    SG_DEVICE_OPEN_FAILED,
    SG_DEVICE_READY,
};

struct scsi_device_identity {
    uint32_t host;
    uint32_t channel;
    uint32_t target;
    uint32_t lun;
    int host_unique_id;
};

struct scsi_idlun_result {
    int dev_id;
    int host_unique_id;
};

struct sg_device_association {
    int source_descriptor;
    struct stat source_identity;
    struct scsi_device_identity scsi_identity;
    enum sg_device_acquire_outcome outcome;
    int descriptor;
    struct stat descriptor_identity;
    int failure_errno;
    struct sg_device_association *next;
};

static _Thread_local struct read_scope current_read_scope;
static pthread_mutex_t sg_device_mutex = PTHREAD_MUTEX_INITIALIZER;
static struct sg_device_association *sg_device_associations;

#ifdef RIP_DVD_READER_TESTING
static struct {
    int enabled;
    int fail_discovery;
    int fail_open;
    int report_cleanup_at_exit;
    uint32_t source_drive_identity;
    uint32_t sg_drive_identity;
    uint32_t source_identity_check_count;
    uint32_t failing_source_identity_check_ordinal;
    uint32_t failing_content_read_ordinal;
    struct rip_dvd_scsi_test_metrics metrics;
} scsi_test_adapter;
#endif

static int scsi_device_identity_matches(
    const struct scsi_device_identity *left,
    const struct scsi_device_identity *right)
{
    return left->host == right->host &&
        left->channel == right->channel && left->target == right->target &&
        left->lun == right->lun &&
        left->host_unique_id == right->host_unique_id;
}

static int source_scsi_device_identity(
    int descriptor, struct scsi_device_identity *identity)
{
#ifdef RIP_DVD_READER_TESTING
    if (scsi_test_adapter.enabled) {
        scsi_test_adapter.source_identity_check_count += 1;
        if (scsi_test_adapter.source_identity_check_count ==
            scsi_test_adapter.failing_source_identity_check_ordinal) {
            errno = ENODEV;
            return -1;
        }
        *identity = (struct scsi_device_identity){
            .host = scsi_test_adapter.source_drive_identity,
            .host_unique_id =
                (int)scsi_test_adapter.source_drive_identity,
        };
        return 0;
    }
#endif
    struct scsi_idlun_result idlun;
    int host;
    if (ioctl(descriptor, SCSI_IOCTL_GET_IDLUN, &idlun) < 0 ||
        ioctl(descriptor, SCSI_IOCTL_GET_BUS_NUMBER, &host) < 0) {
        return -1;
    }
    uint32_t device_id = (uint32_t)idlun.dev_id;
    *identity = (struct scsi_device_identity){
        .host = (uint32_t)host,
        .channel = (device_id >> 16) & 0xffU,
        .target = device_id & 0xffU,
        .lun = (device_id >> 8) & 0xffU,
        .host_unique_id = idlun.host_unique_id,
    };
    return 0;
}

static int sg_scsi_device_identity(
    int descriptor, struct scsi_device_identity *identity)
{
#ifdef RIP_DVD_READER_TESTING
    if (scsi_test_adapter.enabled) {
        (void)descriptor;
        *identity = (struct scsi_device_identity){
            .host = scsi_test_adapter.sg_drive_identity,
            .host_unique_id = (int)scsi_test_adapter.sg_drive_identity,
        };
        return 0;
    }
#endif
    struct sg_scsi_id sg_identity;
    struct scsi_idlun_result idlun;
    int host;
    if (ioctl(descriptor, SG_GET_SCSI_ID, &sg_identity) < 0 ||
        ioctl(descriptor, SCSI_IOCTL_GET_IDLUN, &idlun) < 0 ||
        ioctl(descriptor, SCSI_IOCTL_GET_BUS_NUMBER, &host) < 0) {
        return -1;
    }
    *identity = (struct scsi_device_identity){
        .host = (uint32_t)host,
        .channel = (uint32_t)sg_identity.channel & 0xffU,
        .target = (uint32_t)sg_identity.scsi_id & 0xffU,
        .lun = (uint32_t)sg_identity.lun & 0xffU,
        .host_unique_id = idlun.host_unique_id,
    };
    return 0;
}

void rip_dvd_scsi_read_scope_begin(uint64_t requested_lba,
                                   uint32_t requested_block_count,
                                   uint32_t retry_ordinal)
{
    current_read_scope = (struct read_scope){
        .active = 1,
        .completion = {
            .descriptor = -1,
            .requested_lba = requested_lba,
            .requested_block_count = requested_block_count,
            .retry_ordinal = retry_ordinal,
        },
    };
}

int rip_dvd_scsi_read_scope_end(struct rip_dvd_scsi_completion *completion)
{
    if (!current_read_scope.active) {
        return 0;
    }
    *completion = current_read_scope.completion;
    current_read_scope = (struct read_scope){ 0 };
    return completion->captured;
}

static int resolve_sg_device(int block_descriptor, char path[PATH_MAX])
{
#ifdef RIP_DVD_READER_TESTING
    if (scsi_test_adapter.enabled) {
        scsi_test_adapter.metrics.discovery_count += 1;
        if (scsi_test_adapter.fail_discovery) {
            errno = ENODEV;
            return -1;
        }
        int length = snprintf(path, PATH_MAX, "test-scsi-generic");
        if (length < 0 || length >= PATH_MAX) {
            errno = ENAMETOOLONG;
            return -1;
        }
        return 0;
    }
#endif
    const char *override = getenv("DVDCSS_SG_DEVICE");
    if (override != NULL && override[0] != '\0') {
        int length = snprintf(path, PATH_MAX, "%s", override);
        if (length < 0 || length >= PATH_MAX) {
            errno = ENAMETOOLONG;
            return -1;
        }
        return 0;
    }

    struct stat status;
    if (fstat(block_descriptor, &status) < 0 || !S_ISBLK(status.st_mode)) {
        errno = ENODEV;
        return -1;
    }

    char directory_path[PATH_MAX];
    int length = snprintf(
        directory_path, sizeof(directory_path),
        "/sys/dev/block/%u:%u/device/scsi_generic",
        major(status.st_rdev), minor(status.st_rdev));
    if (length < 0 || (size_t)length >= sizeof(directory_path)) {
        errno = ENAMETOOLONG;
        return -1;
    }

    DIR *directory = opendir(directory_path);
    if (directory == NULL) {
        return -1;
    }
    int result = -1;
    struct dirent *entry;
    while ((entry = readdir(directory)) != NULL) {
        if (entry->d_name[0] != 's' || entry->d_name[1] != 'g' ||
            entry->d_name[2] < '0' || entry->d_name[2] > '9') {
            continue;
        }
        length = snprintf(path, PATH_MAX, "/dev/%s", entry->d_name);
        if (length < 0 || length >= PATH_MAX) {
            errno = ENAMETOOLONG;
            break;
        }
        result = 0;
        break;
    }
    int saved_errno = result == 0 ? 0 : ENODEV;
    closedir(directory);
    if (result < 0) {
        errno = saved_errno;
    }
    return result;
}

static int descriptor_identity_matches(const struct stat *left,
                                       const struct stat *right)
{
    return left->st_dev == right->st_dev && left->st_ino == right->st_ino &&
        left->st_rdev == right->st_rdev &&
        (left->st_mode & S_IFMT) == (right->st_mode & S_IFMT);
}

static int source_identity_is_compatible(const struct stat *identity)
{
#ifdef RIP_DVD_READER_TESTING
    if (scsi_test_adapter.enabled) {
        return S_ISREG(identity->st_mode);
    }
#endif
    return S_ISBLK(identity->st_mode);
}

static int sg_identity_is_compatible(const struct stat *identity)
{
#ifdef RIP_DVD_READER_TESTING
    if (scsi_test_adapter.enabled) {
        return S_ISREG(identity->st_mode);
    }
#endif
    return S_ISCHR(identity->st_mode);
}

static int close_sg_descriptor(int descriptor)
{
#ifdef RIP_DVD_READER_TESTING
    if (scsi_test_adapter.enabled) {
        scsi_test_adapter.metrics.close_count += 1;
    }
#endif
    return close(descriptor);
}

static void release_sg_device_association(
    struct sg_device_association *association)
{
    if (association->descriptor >= 0) {
        close_sg_descriptor(association->descriptor);
    }
    free(association);
}

static void remove_sg_device_association(
    struct sg_device_association **association_link)
{
    struct sg_device_association *association = *association_link;
    *association_link = association->next;
    release_sg_device_association(association);
}

static void invalidate_sg_device_association(int source_descriptor)
{
    struct sg_device_association **association_link =
        &sg_device_associations;
    while (*association_link != NULL) {
        if ((*association_link)->source_descriptor == source_descriptor) {
            remove_sg_device_association(association_link);
            return;
        }
        association_link = &(*association_link)->next;
    }
}

static void invalidate_all_sg_device_associations(void)
{
    while (sg_device_associations != NULL) {
        remove_sg_device_association(&sg_device_associations);
    }
}

static int open_resolved_sg_device(int block_descriptor, const char *path)
{
#ifdef RIP_DVD_READER_TESTING
    if (scsi_test_adapter.enabled) {
        scsi_test_adapter.metrics.open_count += 1;
        if (scsi_test_adapter.fail_open) {
            errno = EACCES;
            return -1;
        }
        return fcntl(block_descriptor, F_DUPFD_CLOEXEC, 0);
    }
#else
    (void)block_descriptor;
#endif
    return open(path, O_RDONLY | O_CLOEXEC);
}

static int acquire_sg_device(
    int block_descriptor, enum sg_device_acquire_outcome *outcome)
{
    struct stat source_identity;
    if (fstat(block_descriptor, &source_identity) < 0 ||
        !source_identity_is_compatible(&source_identity)) {
        invalidate_sg_device_association(block_descriptor);
        *outcome = SG_DEVICE_UNAVAILABLE;
        errno = ENODEV;
        return -1;
    }

    struct sg_device_association **association_link =
        &sg_device_associations;
    while (*association_link != NULL &&
           (*association_link)->source_descriptor != block_descriptor) {
        association_link = &(*association_link)->next;
    }
    struct sg_device_association *association = *association_link;
    if (association != NULL &&
        !descriptor_identity_matches(&association->source_identity,
                                     &source_identity)) {
        remove_sg_device_association(association_link);
        association = NULL;
    }

    struct scsi_device_identity source_scsi_identity;
    if (source_scsi_device_identity(
            block_descriptor, &source_scsi_identity) < 0) {
        int saved_errno = errno;
        if (association != NULL && association->descriptor >= 0) {
            close_sg_descriptor(association->descriptor);
            association->descriptor = -1;
            association->outcome = SG_DEVICE_OPEN_FAILED;
            association->failure_errno = saved_errno;
        }
        *outcome = association == NULL
            ? SG_DEVICE_UNAVAILABLE
            : association->outcome;
        errno = saved_errno;
        return -1;
    }
    if (association != NULL &&
        !scsi_device_identity_matches(
            &association->scsi_identity, &source_scsi_identity)) {
        remove_sg_device_association(association_link);
        association = NULL;
    }

    if (association != NULL) {
        *outcome = association->outcome;
        if (association->descriptor < 0) {
            errno = association->failure_errno;
            return -1;
        }
        struct stat descriptor_identity;
        if (fstat(association->descriptor, &descriptor_identity) != 0 ||
            !sg_identity_is_compatible(&descriptor_identity) ||
            !descriptor_identity_matches(
                &association->descriptor_identity, &descriptor_identity)) {
            association->descriptor = -1;
        } else {
            struct scsi_device_identity current_sg_identity;
            if (sg_scsi_device_identity(
                    association->descriptor, &current_sg_identity) == 0 &&
                scsi_device_identity_matches(
                    &source_scsi_identity, &current_sg_identity)) {
                return association->descriptor;
            }
            close_sg_descriptor(association->descriptor);
            association->descriptor = -1;
        }
        association->outcome = SG_DEVICE_OPEN_FAILED;
        association->failure_errno = ENODEV;
        errno = ENODEV;
        return -1;
    }

    association = calloc(1, sizeof(*association));
    if (association == NULL) {
        *outcome = SG_DEVICE_UNAVAILABLE;
        return -1;
    }
    association->source_descriptor = block_descriptor;
    association->source_identity = source_identity;
    association->scsi_identity = source_scsi_identity;
    association->descriptor = -1;
    association->next = sg_device_associations;
    sg_device_associations = association;

    char path[PATH_MAX];
    if (resolve_sg_device(block_descriptor, path) < 0) {
        association->failure_errno = errno;
        *outcome = SG_DEVICE_UNAVAILABLE;
        return -1;
    }
    association->outcome = SG_DEVICE_OPEN_FAILED;
    *outcome = SG_DEVICE_OPEN_FAILED;
    int descriptor = open_resolved_sg_device(block_descriptor, path);
    if (descriptor < 0) {
        association->failure_errno = errno;
        return -1;
    }
    struct stat descriptor_identity;
    int descriptor_stat_result = fstat(descriptor, &descriptor_identity);
    struct scsi_device_identity descriptor_scsi_identity;
    if (descriptor_stat_result < 0 ||
        !sg_identity_is_compatible(&descriptor_identity) ||
        sg_scsi_device_identity(descriptor, &descriptor_scsi_identity) < 0 ||
        !scsi_device_identity_matches(
            &source_scsi_identity, &descriptor_scsi_identity)) {
        int saved_errno = descriptor_stat_result < 0 ? errno : ENODEV;
        close_sg_descriptor(descriptor);
        association->failure_errno = saved_errno;
        errno = saved_errno;
        return -1;
    }
    association->descriptor = descriptor;
    association->descriptor_identity = descriptor_identity;
    association->outcome = SG_DEVICE_READY;
    *outcome = SG_DEVICE_READY;
    return descriptor;
}

static int execute_sg_io(int descriptor, unsigned long request, void *argument)
{
#ifdef RIP_DVD_READER_TESTING
    if (scsi_test_adapter.enabled && request == SG_IO) {
        sg_io_hdr_t *io = argument;
        if (io == NULL || io->cmdp == NULL || io->cmd_len == 0) {
            errno = EINVAL;
            return -1;
        }
        uint8_t operation = io->cmdp[0];
        if (operation == SCSI_REQUEST_SENSE) {
            scsi_test_adapter.metrics.request_sense_count += 1;
        }
        if (operation != SCSI_READ_10) {
            scsi_test_adapter.metrics.diagnostic_command_count += 1;
            errno = ENOTSUP;
            return -1;
        }
        if (io->cmd_len < 10) {
            errno = EINVAL;
            return -1;
        }
        uint64_t lba = ((uint64_t)io->cmdp[2] << 24) |
            ((uint64_t)io->cmdp[3] << 16) |
            ((uint64_t)io->cmdp[4] << 8) | (uint64_t)io->cmdp[5];
        uint32_t block_count = ((uint32_t)io->cmdp[7] << 8) |
            (uint32_t)io->cmdp[8];
        scsi_test_adapter.metrics.content_read_count += 1;
        if (scsi_test_adapter.metrics.request_count <
            RIP_DVD_SCSI_TEST_MAX_READ_REQUESTS) {
            size_t index = scsi_test_adapter.metrics.request_count;
            scsi_test_adapter.metrics.requests[index] =
                (struct rip_dvd_scsi_test_request){
                    .lba = lba,
                    .block_count = block_count,
                };
            scsi_test_adapter.metrics.request_count += 1;
        }
        if (scsi_test_adapter.failing_content_read_ordinal ==
            scsi_test_adapter.metrics.content_read_count) {
            uint8_t fixed_sense[18] = { 0 };
            fixed_sense[0] = 0xf0;
            fixed_sense[2] = 0x03;
            fixed_sense[3] = (uint8_t)(lba >> 24);
            fixed_sense[4] = (uint8_t)(lba >> 16);
            fixed_sense[5] = (uint8_t)(lba >> 8);
            fixed_sense[6] = (uint8_t)lba;
            fixed_sense[7] = 10;
            fixed_sense[12] = 0x11;
            if (io->sbp != NULL && io->mx_sb_len >= sizeof(fixed_sense)) {
                memcpy(io->sbp, fixed_sense, sizeof(fixed_sense));
                io->sb_len_wr = sizeof(fixed_sense);
            } else {
                io->sb_len_wr = 0;
            }
            io->status = 0x02;
            io->host_status = 0;
            io->driver_status = 0x08;
            io->info = SG_INFO_CHECK;
            io->resid = (int)io->dxfer_len;
            return 0;
        }
        size_t expected_length =
            (size_t)block_count * DVD_LOGICAL_BLOCK_BYTES;
        if (block_count == 0 || io->dxferp == NULL ||
            io->dxfer_len != expected_length || lba > (uint64_t)INT64_MAX /
                                                    DVD_LOGICAL_BLOCK_BYTES) {
            errno = EINVAL;
            return -1;
        }
        ssize_t bytes_read = pread(
            descriptor, io->dxferp, io->dxfer_len,
            (off_t)(lba * DVD_LOGICAL_BLOCK_BYTES));
        if (bytes_read < 0) {
            return -1;
        }
        io->status = 0;
        io->host_status = 0;
        io->driver_status = 0;
        io->sb_len_wr = 0;
        io->info = SG_INFO_OK;
        io->resid = (int)(io->dxfer_len - (uint32_t)bytes_read);
        return 0;
    }
#endif
    return ioctl(descriptor, request, argument);
}

int dvdcss_linux_close(int descriptor)
{
    pthread_mutex_lock(&sg_device_mutex);
    invalidate_sg_device_association(descriptor);
    pthread_mutex_unlock(&sg_device_mutex);
    return close(descriptor);
}

__attribute__((destructor)) static void close_scsi_session_at_exit(void)
{
    pthread_mutex_lock(&sg_device_mutex);
    invalidate_all_sg_device_associations();
#ifdef RIP_DVD_READER_TESTING
    int report_cleanup = scsi_test_adapter.report_cleanup_at_exit;
    struct rip_dvd_scsi_test_metrics metrics = scsi_test_adapter.metrics;
#endif
    pthread_mutex_unlock(&sg_device_mutex);
#ifdef RIP_DVD_READER_TESTING
    if (report_cleanup) {
        dprintf(STDERR_FILENO,
                "rip-dvd-scsi-exit-result "
                "{\"discoveryCount\":%" PRIu32
                ",\"openCount\":%" PRIu32
                ",\"closeCount\":%" PRIu32
                ",\"contentReadCount\":%" PRIu32 "}\n",
                metrics.discovery_count, metrics.open_count,
                metrics.close_count, metrics.content_read_count);
    }
#endif
}

#ifdef RIP_DVD_READER_TESTING
void rip_dvd_scsi_test_adapter_begin(void)
{
    pthread_mutex_lock(&sg_device_mutex);
    invalidate_all_sg_device_associations();
    memset(&scsi_test_adapter, 0, sizeof(scsi_test_adapter));
    scsi_test_adapter.enabled = 1;
    scsi_test_adapter.source_drive_identity = 1;
    scsi_test_adapter.sg_drive_identity = 1;
    pthread_mutex_unlock(&sg_device_mutex);
}

void rip_dvd_scsi_test_adapter_report_cleanup_at_exit(void)
{
    pthread_mutex_lock(&sg_device_mutex);
    scsi_test_adapter.report_cleanup_at_exit = 1;
    pthread_mutex_unlock(&sg_device_mutex);
}

void rip_dvd_scsi_test_adapter_change_drive_identity(void)
{
    pthread_mutex_lock(&sg_device_mutex);
    scsi_test_adapter.source_drive_identity += 1;
    scsi_test_adapter.sg_drive_identity += 1;
    pthread_mutex_unlock(&sg_device_mutex);
}

void rip_dvd_scsi_test_adapter_change_sg_drive_identity(void)
{
    pthread_mutex_lock(&sg_device_mutex);
    scsi_test_adapter.sg_drive_identity += 1;
    pthread_mutex_unlock(&sg_device_mutex);
}

void rip_dvd_scsi_test_adapter_fail_source_identity_check(
    uint32_t check_ordinal)
{
    pthread_mutex_lock(&sg_device_mutex);
    scsi_test_adapter.failing_source_identity_check_ordinal = check_ordinal;
    pthread_mutex_unlock(&sg_device_mutex);
}

void rip_dvd_scsi_test_adapter_fail_content_read(uint32_t read_ordinal)
{
    pthread_mutex_lock(&sg_device_mutex);
    scsi_test_adapter.failing_content_read_ordinal = read_ordinal;
    pthread_mutex_unlock(&sg_device_mutex);
}

void rip_dvd_scsi_test_adapter_fail_discovery(void)
{
    pthread_mutex_lock(&sg_device_mutex);
    scsi_test_adapter.fail_discovery = 1;
    pthread_mutex_unlock(&sg_device_mutex);
}

void rip_dvd_scsi_test_adapter_fail_open(void)
{
    pthread_mutex_lock(&sg_device_mutex);
    scsi_test_adapter.fail_open = 1;
    pthread_mutex_unlock(&sg_device_mutex);
}

int rip_dvd_scsi_test_abandon_source_descriptor(int descriptor)
{
    return close(descriptor);
}

ssize_t rip_dvd_scsi_test_invoke_wrapped_read(int descriptor, void *buffer,
                                              size_t length)
{
    /* Keep test invocation in the translation unit that owns interposition. */
    return dvdcss_linux_read(descriptor, buffer, length);
}

void rip_dvd_scsi_test_adapter_snapshot(
    struct rip_dvd_scsi_test_metrics *metrics)
{
    pthread_mutex_lock(&sg_device_mutex);
    *metrics = scsi_test_adapter.metrics;
    pthread_mutex_unlock(&sg_device_mutex);
}
#endif

static void capture_read_completion(int block_descriptor,
                                    const sg_io_hdr_t *io,
                                    const uint8_t *sense)
{
    struct rip_dvd_scsi_completion *completion =
        &current_read_scope.completion;
    completion->captured = 1;
    completion->command_completed = 1;
    completion->descriptor = block_descriptor;
    completion->scsi_status = io->status;
    completion->host_status = io->host_status;
    completion->driver_status = io->driver_status;
    completion->sense_reported_length = io->sb_len_wr;
    completion->sense_length = io->sb_len_wr;
    if (completion->sense_length > RIP_DVD_SCSI_MAX_SENSE_BYTES) {
        completion->sense_length = RIP_DVD_SCSI_MAX_SENSE_BYTES;
    }
    memcpy(completion->sense, sense, completion->sense_length);
}

static int set_read_position(int descriptor, ssize_t bytes_read)
{
    if (bytes_read < 0 || lseek(descriptor, bytes_read, SEEK_CUR) < 0) {
        return -1;
    }
    return 0;
}

ssize_t dvdcss_linux_read(int descriptor, void *buffer, size_t length)
{
    struct rip_dvd_scsi_completion *expected =
        &current_read_scope.completion;
    pthread_mutex_lock(&sg_device_mutex);
    if (!current_read_scope.active ||
        expected->requested_lba > UINT32_MAX ||
        expected->requested_block_count == 0 ||
        expected->requested_block_count > UINT16_MAX ||
        length != (size_t)expected->requested_block_count *
                      DVD_LOGICAL_BLOCK_BYTES) {
        ssize_t result = read(descriptor, buffer, length);
        pthread_mutex_unlock(&sg_device_mutex);
        return result;
    }
    off_t offset = lseek(descriptor, 0, SEEK_CUR);
    if (offset < 0 || (uint64_t)offset % DVD_LOGICAL_BLOCK_BYTES != 0 ||
        (uint64_t)offset / DVD_LOGICAL_BLOCK_BYTES !=
            expected->requested_lba) {
        ssize_t result = read(descriptor, buffer, length);
        pthread_mutex_unlock(&sg_device_mutex);
        return result;
    }
    enum sg_device_acquire_outcome outcome = SG_DEVICE_UNAVAILABLE;
    int sg_descriptor = acquire_sg_device(descriptor, &outcome);
    if (sg_descriptor < 0) {
        ssize_t result = read(descriptor, buffer, length);
        pthread_mutex_unlock(&sg_device_mutex);
        return result;
    }
    uint8_t command[10] = { 0 };
    uint32_t lba = (uint32_t)expected->requested_lba;
    uint16_t block_count = (uint16_t)expected->requested_block_count;
    command[0] = SCSI_READ_10;
    command[2] = (uint8_t)(lba >> 24);
    command[3] = (uint8_t)(lba >> 16);
    command[4] = (uint8_t)(lba >> 8);
    command[5] = (uint8_t)lba;
    command[7] = (uint8_t)(block_count >> 8);
    command[8] = (uint8_t)block_count;
    uint8_t sense[RIP_DVD_SCSI_MAX_SENSE_BYTES] = { 0 };
    sg_io_hdr_t io = {
        .interface_id = 'S',
        .dxfer_direction = SG_DXFER_FROM_DEV,
        .cmd_len = sizeof(command),
        .mx_sb_len = sizeof(sense),
        .dxfer_len = length,
        .dxferp = buffer,
        .cmdp = command,
        .sbp = sense,
        .timeout = SG_COMMAND_TIMEOUT_MS,
    };
    int result = execute_sg_io(sg_descriptor, SG_IO, &io);
    int saved_errno = errno;
    if (result == 0) {
        capture_read_completion(descriptor, &io, sense);
    }
    if (result < 0 || (io.info & SG_INFO_OK_MASK) != SG_INFO_OK ||
        io.resid < 0 || (uint32_t)io.resid > io.dxfer_len) {
        pthread_mutex_unlock(&sg_device_mutex);
        errno = result < 0 ? saved_errno : EIO;
        return -1;
    }
    ssize_t bytes_read = (ssize_t)(io.dxfer_len - (uint32_t)io.resid);
    if ((size_t)bytes_read % DVD_LOGICAL_BLOCK_BYTES != 0 ||
        set_read_position(descriptor, bytes_read) < 0) {
        pthread_mutex_unlock(&sg_device_mutex);
        errno = EIO;
        return -1;
    }
    pthread_mutex_unlock(&sg_device_mutex);
    return bytes_read;
}

static int send_sg_command(int sg_descriptor,
                           const uint8_t command[12], void *data,
                           uint32_t data_length, int direction)
{
    uint8_t sense[32] = { 0 };
    sg_io_hdr_t io = {
        .interface_id = 'S',
        .dxfer_direction = direction,
        .cmd_len = 12,
        .mx_sb_len = sizeof(sense),
        .dxfer_len = data_length,
        .dxferp = data,
        .cmdp = (uint8_t *)command,
        .sbp = sense,
        .timeout = SG_COMMAND_TIMEOUT_MS,
    };
    int result = execute_sg_io(sg_descriptor, SG_IO, &io);
    int saved_errno = errno;
    if (result == 0 && (io.info & SG_INFO_OK_MASK) != SG_INFO_OK) {
        saved_errno = EIO;
        result = -1;
    }
    errno = saved_errno;
    return result;
}

static void set_transfer_length(uint8_t command[12], uint32_t length)
{
    command[8] = (uint8_t)((length >> 8) & 0xff);
    command[9] = (uint8_t)(length & 0xff);
}

static int read_dvd_structure(int descriptor, uint8_t format, uint8_t layer,
                              uint8_t agid,
                              void *data, uint32_t length)
{
    uint8_t command[12] = { 0 };
    command[0] = GPCMD_READ_DVD_STRUCTURE;
    command[6] = layer;
    command[7] = format;
    command[10] = (uint8_t)(agid << 6);
    set_transfer_length(command, length);
    return send_sg_command(
        descriptor, command, data, length, SG_DXFER_FROM_DEV);
}

static int report_key(int descriptor, uint8_t format, uint8_t agid,
                      uint32_t block,
                      void *data, uint32_t length)
{
    uint8_t command[12] = { 0 };
    command[0] = GPCMD_REPORT_KEY;
    command[2] = (uint8_t)(block >> 24);
    command[3] = (uint8_t)(block >> 16);
    command[4] = (uint8_t)(block >> 8);
    command[5] = (uint8_t)block;
    command[10] = (uint8_t)(format | (agid << 6));
    set_transfer_length(command, length);
    return send_sg_command(
        descriptor, command,
        length == 0 ? NULL : data,
        length,
        length == 0 ? SG_DXFER_NONE : SG_DXFER_FROM_DEV);
}

static int send_key(int descriptor, uint8_t format, uint8_t agid,
                    void *data, uint32_t length)
{
    uint8_t command[12] = { 0 };
    command[0] = GPCMD_SEND_KEY;
    command[10] = (uint8_t)(format | (agid << 6));
    set_transfer_length(command, length);
    return send_sg_command(
        descriptor, command, data, length, SG_DXFER_TO_DEV);
}

static int bridge_read_structure(int descriptor, dvd_struct *dvd)
{
    if (dvd->type == DVD_STRUCT_COPYRIGHT) {
        uint8_t data[8] = { 0 };
        int result = read_dvd_structure(
            descriptor, DVD_STRUCT_COPYRIGHT, dvd->copyright.layer_num, 0,
            data, sizeof(data));
        if (result == 0) {
            dvd->copyright.cpst = data[4];
            dvd->copyright.rmi = data[5];
        }
        return result;
    }
    if (dvd->type == DVD_STRUCT_DISCKEY) {
        uint8_t data[sizeof(dvd->disckey.value) + 4] = { 0 };
        int result = read_dvd_structure(
            descriptor, DVD_STRUCT_DISCKEY, 0, dvd->disckey.agid,
            data, sizeof(data));
        if (result == 0) {
            memcpy(dvd->disckey.value, data + 4, sizeof(dvd->disckey.value));
        }
        return result;
    }
    errno = ENOTSUP;
    return -1;
}

static int bridge_authentication(int descriptor, dvd_authinfo *authentication)
{
    switch (authentication->type) {
    case DVD_LU_SEND_AGID: {
        uint8_t data[8] = { 0 };
        int result = report_key(
            descriptor, DVD_REPORT_AGID, authentication->lsa.agid, 0,
            data, sizeof(data));
        if (result == 0) {
            authentication->lsa.agid = data[7] >> 6;
        }
        return result;
    }
    case DVD_LU_SEND_CHALLENGE: {
        uint8_t data[16] = { 0 };
        int result = report_key(
            descriptor, DVD_REPORT_CHALLENGE, authentication->lsc.agid, 0,
            data, sizeof(data));
        if (result == 0) {
            memcpy(authentication->lsc.chal, data + 4,
                   sizeof(authentication->lsc.chal));
        }
        return result;
    }
    case DVD_LU_SEND_KEY1: {
        uint8_t data[12] = { 0 };
        int result = report_key(
            descriptor, DVD_REPORT_KEY1, authentication->lsk.agid, 0,
            data, sizeof(data));
        if (result == 0) {
            memcpy(authentication->lsk.key, data + 4,
                   sizeof(authentication->lsk.key));
        }
        return result;
    }
    case DVD_LU_SEND_TITLE_KEY: {
        uint8_t data[12] = { 0 };
        int result = report_key(
            descriptor, DVD_REPORT_TITLE_KEY, authentication->lstk.agid,
            (uint32_t)authentication->lstk.lba, data, sizeof(data));
        if (result == 0) {
            authentication->lstk.cpm = (data[4] >> 7) & 1;
            authentication->lstk.cp_sec = (data[4] >> 6) & 1;
            authentication->lstk.cgms = (data[4] >> 4) & 3;
            memcpy(authentication->lstk.title_key, data + 5,
                   sizeof(authentication->lstk.title_key));
        }
        return result;
    }
    case DVD_LU_SEND_ASF: {
        uint8_t data[8] = { 0 };
        int result = report_key(
            descriptor, DVD_REPORT_ASF, 0, 0, data, sizeof(data));
        if (result == 0) {
            authentication->lsasf.asf = data[7] & 1;
        }
        return result;
    }
    case DVD_HOST_SEND_CHALLENGE: {
        uint8_t data[16] = { 0 };
        data[1] = 0x0e;
        memcpy(data + 4, authentication->hsc.chal,
               sizeof(authentication->hsc.chal));
        return send_key(
            descriptor, DVD_SEND_CHALLENGE, authentication->hsc.agid,
            data, sizeof(data));
    }
    case DVD_HOST_SEND_KEY2: {
        uint8_t data[12] = { 0 };
        data[1] = 0x0a;
        memcpy(data + 4, authentication->hsk.key,
               sizeof(authentication->hsk.key));
        return send_key(
            descriptor, DVD_SEND_KEY2, authentication->hsk.agid,
            data, sizeof(data));
    }
    case DVD_INVALIDATE_AGID:
        return report_key(
            descriptor, DVDCSS_INVALIDATE_AGID,
            authentication->lsa.agid, 0, NULL, 0);
    case DVD_LU_SEND_RPC_STATE: {
        uint8_t data[8] = { 0 };
        int result = report_key(
            descriptor, DVD_REPORT_RPC, 0, 0, data, sizeof(data));
        if (result == 0) {
            authentication->lrpcs.type = data[4] >> 6;
            authentication->lrpcs.region_mask = data[5];
            authentication->lrpcs.rpc_scheme = data[6];
        }
        return result;
    }
    default:
        errno = ENOTSUP;
        return -1;
    }
}

int dvdcss_linux_ioctl(int descriptor, unsigned long request, ...)
{
    va_list arguments;
    va_start(arguments, request);
    void *argument = va_arg(arguments, void *);
    va_end(arguments);

    if (request != DVD_READ_STRUCT && request != DVD_AUTH && request != SG_IO) {
        return ioctl(descriptor, request, argument);
    }

    pthread_mutex_lock(&sg_device_mutex);
    enum sg_device_acquire_outcome outcome = SG_DEVICE_UNAVAILABLE;
    int sg_descriptor = acquire_sg_device(descriptor, &outcome);
    if (sg_descriptor < 0) {
        int saved_errno = errno;
        pthread_mutex_unlock(&sg_device_mutex);
        if (outcome == SG_DEVICE_UNAVAILABLE) {
            return ioctl(descriptor, request, argument);
        }
        errno = saved_errno;
        return -1;
    }

    int result;
    if (request == DVD_READ_STRUCT) {
        result = bridge_read_structure(sg_descriptor, argument);
    } else if (request == DVD_AUTH) {
        result = bridge_authentication(sg_descriptor, argument);
    } else {
        result = execute_sg_io(sg_descriptor, request, argument);
    }
    int saved_errno = errno;
    pthread_mutex_unlock(&sg_device_mutex);
    errno = saved_errno;
    return result;
}
