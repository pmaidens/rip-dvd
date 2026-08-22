/* SPDX-License-Identifier: GPL-2.0-only */

#define _POSIX_C_SOURCE 200809L

#include <dvdcss/dvdcss.h>
#include <openssl/evp.h>

#include "libdvdcss-sg-io.h"

#include <errno.h>
#include <fcntl.h>
#include <inttypes.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/stat.h>
#include <time.h>
#include <unistd.h>

/* Some USB optical bridges reject larger READ(10) transfer lengths. */
#define READ_BLOCKS 31
#define RECOVERY_READ_ATTEMPTS 2
#define MAX_DVD_CONTENT_BYTES UINT64_C(9000000000)
#define PROGRESS_INTERVAL_BYTES UINT64_C(67108864)
#define PROGRESS_INTERVAL_NS INT64_C(1000000000)
#define RECOVERY_POLICY_VERSION "dvd-recovery-v1"
#define RECOVERY_RESULT_PREFIX "rip-dvd-recovery-result "
#define READ_FAILURE_CLASSIFIER_VERSION "scsi-read-classifier-v1"
#define READ_FAILURE_RESULT_PREFIX "rip-dvd-read-failure "
#define READ_FAILURE_EXIT_STATUS 3

#ifdef RIP_DVD_READER_TESTING
#define MAX_TEST_FAULTS 64

struct test_fault {
    enum {
        TEST_FAULT_MEDIUM_ERROR,
        TEST_FAULT_RAW_COMPLETION,
        TEST_FAULT_GENERIC_FAILURE,
    } kind;
    uint64_t lba;
    int remaining_failures;
    uint8_t scsi_status;
    uint16_t host_status;
    uint16_t driver_status;
    size_t sense_reported_length;
    size_t sense_length;
    uint8_t sense[RIP_DVD_SCSI_MAX_SENSE_BYTES];
};
#endif

enum operation {
    OPERATION_HASH,
    OPERATION_COPY,
};

enum test_result_mode {
    TEST_RESULT_VALID,
    TEST_RESULT_MALFORMED_RECOVERY,
    TEST_RESULT_INTERRUPTED_READ_FAILURE,
};

enum backend_read_status {
    BACKEND_READ_SUCCESS,
    BACKEND_READ_MEDIA_ERROR,
    BACKEND_READ_UNKNOWN_ERROR,
    BACKEND_READ_END,
    BACKEND_READ_FATAL,
};

struct decoded_sense {
    int well_formed;
    int has_response_code;
    uint8_t response_code;
    int has_sense_key;
    uint8_t sense_key;
    int has_asc;
    uint8_t asc;
    int has_ascq;
    uint8_t ascq;
    int has_information_lba;
    uint64_t information_lba;
};

struct read_failure {
    struct rip_dvd_scsi_completion completion;
    struct decoded_sense sense;
};

struct backend_read_result {
    enum backend_read_status status;
    int blocks_read;
    struct read_failure failure;
};

enum transport_read_status {
    TRANSPORT_READ_SUCCESS,
    TRANSPORT_READ_FAILURE,
    TRANSPORT_READ_END,
    TRANSPORT_READ_FATAL,
};

struct transport_read_result {
    enum transport_read_status status;
    int blocks_read;
    struct rip_dvd_scsi_completion completion;
};

struct read_backend {
    dvdcss_t dvdcss;
#ifdef RIP_DVD_READER_TESTING
    int test_source_fd;
    unsigned int test_delay_ms;
    size_t test_fault_count;
    struct test_fault test_faults[MAX_TEST_FAULTS];
    int use_test_source;
#endif
};

struct operation_state {
    enum operation operation;
    EVP_MD_CTX *hash;
    int output_fd;
    uint64_t last_progress_bytes;
    struct timespec last_progress_at;
};

struct recovery_state {
    unsigned char *bad_sector_bitmap;
    size_t bitmap_byte_count;
    uint64_t bad_sector_count;
    uint64_t bad_area_count;
    int emit_malformed_result;
    int interrupt_read_failure_result;
};

static int fail_errno(const char *operation);

static int emit_hash_progress(struct operation_state *state,
                              uint64_t bytes_read, int force)
{
    struct timespec current;
    if (clock_gettime(CLOCK_MONOTONIC, &current) != 0) {
        return fail_errno("DVD hash progress clock failed");
    }
    int64_t elapsed_nanoseconds =
        ((int64_t)current.tv_sec - (int64_t)state->last_progress_at.tv_sec) *
            INT64_C(1000000000) +
        ((int64_t)current.tv_nsec - (int64_t)state->last_progress_at.tv_nsec);
    if (!force &&
        bytes_read - state->last_progress_bytes < PROGRESS_INTERVAL_BYTES &&
        elapsed_nanoseconds < PROGRESS_INTERVAL_NS) {
        return 0;
    }
    fprintf(stderr, "%" PRIu64 " bytes hashed\n", bytes_read);
    state->last_progress_bytes = bytes_read;
    state->last_progress_at = current;
    return 0;
}

static int emit_copy_progress(uint64_t bytes_copied,
                              uint64_t *last_progress_bytes,
                              struct timespec *last_progress_at, int force)
{
    struct timespec current;
    if (clock_gettime(CLOCK_MONOTONIC, &current) != 0) {
        return fail_errno("DVD copy progress clock failed");
    }
    int64_t elapsed_nanoseconds =
        ((int64_t)current.tv_sec - (int64_t)last_progress_at->tv_sec) *
            INT64_C(1000000000) +
        ((int64_t)current.tv_nsec - (int64_t)last_progress_at->tv_nsec);
    if (!force &&
        bytes_copied - *last_progress_bytes < PROGRESS_INTERVAL_BYTES &&
        elapsed_nanoseconds < PROGRESS_INTERVAL_NS) {
        return 0;
    }
    fprintf(stderr, "%" PRIu64 " bytes copied\n", bytes_copied);
    *last_progress_bytes = bytes_copied;
    *last_progress_at = current;
    return 0;
}

static int fail_errno(const char *operation)
{
    fprintf(stderr, "%s: %s\n", operation, strerror(errno));
    return 1;
}

static int fail_dvdcss_read(dvdcss_t dvdcss, uint64_t byte_offset)
{
    const char *detail = dvdcss_error(dvdcss);
    fprintf(stderr, "DVD content read failed at byte %" PRIu64 "%s%s\n",
            byte_offset, detail ? ": " : "", detail ? detail : "");
    return 1;
}

static int parse_size(const char *text, uint64_t *size_bytes)
{
    char *end = NULL;
    errno = 0;
    unsigned long long value = strtoull(text, &end, 10);
    if (errno != 0 || end == text || *end != '\0' || value == 0 ||
        value > MAX_DVD_CONTENT_BYTES || value % DVDCSS_BLOCK_SIZE != 0) {
        fprintf(stderr, "DVD content size is invalid\n");
        return 1;
    }
    *size_bytes = (uint64_t)value;
    return 0;
}

static int write_all(int descriptor, const unsigned char *buffer, size_t length)
{
    size_t written = 0;
    while (written < length) {
        ssize_t result = write(descriptor, buffer + written, length - written);
        if (result < 0) {
            if (errno == EINTR) {
                continue;
            }
            return fail_errno("DVD archive write failed");
        }
        if (result == 0) {
            fprintf(stderr, "DVD archive write ended early\n");
            return 1;
        }
        written += (size_t)result;
    }
    return 0;
}

static int write_all_at(int descriptor, const unsigned char *buffer,
                        size_t length, off_t offset)
{
    size_t written = 0;
    while (written < length) {
        ssize_t result = pwrite(descriptor, buffer + written,
                                length - written, offset + (off_t)written);
        if (result < 0) {
            if (errno == EINTR) {
                continue;
            }
            return fail_errno("DVD rescue write failed");
        }
        if (result == 0) {
            fprintf(stderr, "DVD rescue write ended early\n");
            return 1;
        }
        written += (size_t)result;
    }
    return 0;
}

static int consume(struct operation_state *state, const unsigned char *buffer,
                   size_t length, uint64_t bytes_read)
{
    if (state->operation == OPERATION_HASH) {
        if (EVP_DigestUpdate(state->hash, buffer, length) != 1) {
            fprintf(stderr, "DVD content hash update failed\n");
            return 1;
        }
        return emit_hash_progress(state, bytes_read, 0);
    }
    if (write_all(state->output_fd, buffer, length) != 0) {
        return 1;
    }
    fprintf(stderr, "%" PRIu64 " bytes copied\n", bytes_read);
    return 0;
}

static uint64_t read_big_endian_u64(const uint8_t bytes[8])
{
    uint64_t value = 0;
    for (size_t index = 0; index < 8; index++) {
        value = (value << 8) | bytes[index];
    }
    return value;
}

static uint32_t read_big_endian_u32(const uint8_t bytes[4])
{
    uint32_t value = 0;
    for (size_t index = 0; index < 4; index++) {
        value = (value << 8) | bytes[index];
    }
    return value;
}

static int information_lba_matches_request(
    const struct rip_dvd_scsi_completion *completion,
    uint64_t information_lba)
{
    return information_lba >= completion->requested_lba &&
        information_lba - completion->requested_lba <
            completion->requested_block_count;
}

static struct decoded_sense decode_sense(
    const struct rip_dvd_scsi_completion *completion)
{
    struct decoded_sense decoded = { 0 };
    if (!completion->captured ||
        completion->sense_reported_length > RIP_DVD_SCSI_MAX_SENSE_BYTES ||
        completion->sense_reported_length != completion->sense_length ||
        completion->sense_length == 0) {
        return decoded;
    }
    const uint8_t *sense = completion->sense;
    size_t length = completion->sense_length;
    decoded.has_response_code = 1;
    decoded.response_code = sense[0] & 0x7f;
    if (decoded.response_code == 0x70 || decoded.response_code == 0x71) {
        if (length >= 3) {
            decoded.has_sense_key = 1;
            decoded.sense_key = sense[2] & 0x0f;
        }
        if (length < 8) {
            return decoded;
        }
        size_t declared_length = 8U + sense[7];
        if (declared_length < 14 || declared_length != length ||
            (sense[2] & 0xe0) != 0) {
            return decoded;
        }
        decoded.has_asc = 1;
        decoded.asc = sense[12];
        decoded.has_ascq = 1;
        decoded.ascq = sense[13];
        if ((sense[0] & 0x80) != 0) {
            uint64_t information_lba = read_big_endian_u32(sense + 3);
            if (!information_lba_matches_request(
                    completion, information_lba)) {
                return decoded;
            }
            decoded.has_information_lba = 1;
            decoded.information_lba = information_lba;
        }
        decoded.well_formed = 1;
        return decoded;
    }
    if (sense[0] != 0x72 && sense[0] != 0x73) {
        return decoded;
    }
    if (length < 8) {
        return decoded;
    }
    decoded.has_sense_key = 1;
    decoded.sense_key = sense[1] & 0x0f;
    decoded.has_asc = 1;
    decoded.asc = sense[2];
    decoded.has_ascq = 1;
    decoded.ascq = sense[3];
    size_t declared_length = 8U + sense[7];
    if (declared_length != length || (sense[1] & 0xf0) != 0 ||
        sense[4] != 0 || sense[5] != 0 || sense[6] != 0) {
        return decoded;
    }
    int information_descriptor_seen = 0;
    for (size_t offset = 8; offset < declared_length;) {
        if (declared_length - offset < 2) {
            return decoded;
        }
        size_t descriptor_length = 2U + sense[offset + 1];
        if (descriptor_length > declared_length - offset) {
            return decoded;
        }
        if (sense[offset] != 0x00 || sense[offset + 1] != 0x0a ||
            information_descriptor_seen) {
            return decoded;
        }
        information_descriptor_seen = 1;
        if ((sense[offset + 2] & 0x7f) != 0 ||
            sense[offset + 3] != 0) {
            return decoded;
        }
        if ((sense[offset + 2] & 0x80) != 0) {
            uint64_t information_lba =
                read_big_endian_u64(sense + offset + 4);
            if (!information_lba_matches_request(
                    completion, information_lba)) {
                return decoded;
            }
            decoded.has_information_lba = 1;
            decoded.information_lba = information_lba;
        }
        offset += descriptor_length;
    }
    decoded.well_formed = 1;
    return decoded;
}

static enum backend_read_status classify_read_failure(
    const struct rip_dvd_scsi_completion *completion,
    struct decoded_sense *sense)
{
    *sense = decode_sense(completion);
    if (!completion->captured || !completion->command_completed ||
        !sense->well_formed || completion->scsi_status != 0x02 ||
        completion->host_status != 0 ||
        ((completion->driver_status & 0x0f) != 0x00 &&
         (completion->driver_status & 0x0f) != 0x08) ||
        (sense->response_code != 0x70 && sense->response_code != 0x72) ||
        sense->sense_key != 0x03) {
        return BACKEND_READ_UNKNOWN_ERROR;
    }
    return BACKEND_READ_MEDIA_ERROR;
}

static void format_optional_u64(char text[32], int present, uint64_t value)
{
    if (present) {
        snprintf(text, 32, "%" PRIu64, value);
    } else {
        memcpy(text, "null", 5);
    }
}

static int write_terminal_output(const char *output, size_t length)
{
    size_t written = 0;
    while (written < length) {
        ssize_t result = write(STDERR_FILENO, output + written,
                               length - written);
        if (result < 0) {
            if (errno == EINTR) {
                continue;
            }
            return fail_errno("DVD terminal result output failed");
        }
        if (result == 0) {
            fprintf(stderr, "DVD terminal result output ended early\n");
            return 1;
        }
        written += (size_t)result;
    }
    return 0;
}

static int emit_read_failure_result(
    const struct read_failure *failure,
    const struct recovery_state *recovery)
{
    const struct rip_dvd_scsi_completion *completion = &failure->completion;
    const struct decoded_sense *sense = &failure->sense;
    char scsi_status[32];
    char host_status[32];
    char driver_status[32];
    char response_code[32];
    char sense_key[32];
    char asc[32];
    char ascq[32];
    char information_lba[32];
    format_optional_u64(scsi_status, completion->captured,
                        completion->scsi_status);
    format_optional_u64(host_status, completion->captured,
                        completion->host_status);
    format_optional_u64(driver_status, completion->captured,
                        completion->driver_status);
    format_optional_u64(response_code, sense->has_response_code,
                        sense->response_code);
    format_optional_u64(sense_key, sense->has_sense_key, sense->sense_key);
    format_optional_u64(asc, sense->has_asc, sense->asc);
    format_optional_u64(ascq, sense->has_ascq, sense->ascq);
    format_optional_u64(information_lba, sense->has_information_lba,
                        sense->information_lba);
    char output[1024];
    int length = snprintf(
        output, sizeof(output), READ_FAILURE_RESULT_PREFIX
        "{\"protocolVersion\":1,\"classifierVersion\":\""
        READ_FAILURE_CLASSIFIER_VERSION
        "\",\"category\":\"unknown\",\"scsiStatus\":%s"
        ",\"hostStatus\":%s,\"driverStatus\":%s"
        ",\"senseResponseCode\":%s,\"senseKey\":%s"
        ",\"asc\":%s,\"ascq\":%s,\"informationLba\":%s"
        ",\"requestedLba\":%" PRIu64
        ",\"requestedBlockCount\":%" PRIu32
        ",\"retryOrdinal\":%" PRIu32 "}\n",
        scsi_status, host_status, driver_status, response_code, sense_key,
        asc, ascq, information_lba, completion->requested_lba,
        completion->requested_block_count, completion->retry_ordinal);
    if (length <= 0 || (size_t)length >= sizeof(output)) {
        fprintf(stderr, "DVD read failure result exceeded its bound\n");
        return 1;
    }
#ifdef RIP_DVD_READER_TESTING
    if (recovery != NULL && recovery->interrupt_read_failure_result) {
        size_t partial_length = (size_t)length - 2;
        if (write_terminal_output(output, partial_length) != 0) {
            return 1;
        }
        sleep(5);
        if (write_terminal_output(output + partial_length,
                                  (size_t)length - partial_length) != 0) {
            return 1;
        }
        return READ_FAILURE_EXIT_STATUS;
    }
#else
    (void)recovery;
#endif
    if (write_terminal_output(output, (size_t)length) != 0) {
        return 1;
    }
    return READ_FAILURE_EXIT_STATUS;
}

#ifdef RIP_DVD_READER_TESTING
static int delay_test_read(unsigned int delay_ms)
{
    if (delay_ms == 0) {
        return 0;
    }
    struct timespec remaining = {
        .tv_sec = (time_t)(delay_ms / 1000),
        .tv_nsec = (long)(delay_ms % 1000) * 1000000L,
    };
    while (nanosleep(&remaining, &remaining) != 0) {
        if (errno != EINTR) {
            return fail_errno("DVD test read delay failed");
        }
    }
    return 0;
}

static struct test_fault *test_fault_for_read(struct read_backend *backend,
                                              uint64_t lba, int block_count)
{
    uint64_t end_lba = lba + (uint64_t)block_count;
    for (size_t index = 0; index < backend->test_fault_count; index++) {
        struct test_fault *fault = &backend->test_faults[index];
        if (fault->lba < lba || fault->lba >= end_lba ||
            fault->remaining_failures == 0) {
            continue;
        }
        if (fault->remaining_failures > 0) {
            fault->remaining_failures -= 1;
        }
        return fault;
    }
    return NULL;
}

static void create_test_medium_completion(
    struct rip_dvd_scsi_completion *completion,
    const struct test_fault *fault)
{
    completion->captured = 1;
    completion->command_completed = 1;
    completion->descriptor = -1;
    completion->scsi_status = 0x02;
    completion->driver_status = 0x08;
    completion->sense_reported_length = 18;
    completion->sense_length = 18;
    completion->sense[0] = 0xf0;
    completion->sense[2] = 0x03;
    completion->sense[3] = (uint8_t)(fault->lba >> 24);
    completion->sense[4] = (uint8_t)(fault->lba >> 16);
    completion->sense[5] = (uint8_t)(fault->lba >> 8);
    completion->sense[6] = (uint8_t)fault->lba;
    completion->sense[7] = 10;
    completion->sense[12] = 0x11;
}

static struct transport_read_result test_transport_read(
    struct read_backend *backend, unsigned char *buffer, uint64_t lba,
    int block_count, uint32_t retry_ordinal)
{
    fprintf(stderr, "test-read %" PRIu64 " %d\n", lba, block_count);
    if (delay_test_read(backend->test_delay_ms) != 0) {
        return (struct transport_read_result){
            .status = TRANSPORT_READ_FATAL,
        };
    }
    struct test_fault *fault = test_fault_for_read(backend, lba, block_count);
    if (fault != NULL) {
        struct rip_dvd_scsi_completion completion = {
            .descriptor = -1,
            .requested_lba = lba,
            .requested_block_count = (uint32_t)block_count,
            .retry_ordinal = retry_ordinal,
        };
        if (fault->kind == TEST_FAULT_MEDIUM_ERROR) {
            create_test_medium_completion(&completion, fault);
        } else if (fault->kind == TEST_FAULT_RAW_COMPLETION) {
            completion.captured = 1;
            completion.command_completed = 1;
            completion.scsi_status = fault->scsi_status;
            completion.host_status = fault->host_status;
            completion.driver_status = fault->driver_status;
            completion.sense_reported_length = fault->sense_reported_length;
            completion.sense_length = fault->sense_length;
            memcpy(completion.sense, fault->sense, fault->sense_length);
        }
        return (struct transport_read_result){
            .status = TRANSPORT_READ_FAILURE,
            .completion = completion,
        };
    }
    size_t length = (size_t)block_count * DVDCSS_BLOCK_SIZE;
    ssize_t bytes_read;
    do {
        bytes_read = pread(backend->test_source_fd, buffer, length,
                           (off_t)(lba * DVDCSS_BLOCK_SIZE));
    } while (bytes_read < 0 && errno == EINTR);
    if (bytes_read < 0) {
        fail_errno("DVD test source read failed");
        return (struct transport_read_result){
            .status = TRANSPORT_READ_FATAL,
        };
    }
    if (bytes_read == 0) {
        return (struct transport_read_result){
            .status = TRANSPORT_READ_END,
        };
    }
    if (bytes_read % DVDCSS_BLOCK_SIZE != 0) {
        fprintf(stderr, "DVD test source returned a partial sector\n");
        return (struct transport_read_result){
            .status = TRANSPORT_READ_FATAL,
        };
    }
    return (struct transport_read_result){
        .status = TRANSPORT_READ_SUCCESS,
        .blocks_read = (int)(bytes_read / DVDCSS_BLOCK_SIZE),
    };
}
#endif

static struct transport_read_result dvdcss_transport_read(
    struct read_backend *backend, unsigned char *buffer, uint64_t lba,
    int block_count, int absolute, uint32_t retry_ordinal)
{
    if (absolute &&
        dvdcss_seek(backend->dvdcss, (int)lba, DVDCSS_NOFLAGS) < 0) {
        const char *detail = dvdcss_error(backend->dvdcss);
        fprintf(stderr, "DVD content seek failed at LBA %" PRIu64 "%s%s\n",
                lba, detail ? ": " : "", detail ? detail : "");
        return (struct transport_read_result){
            .status = TRANSPORT_READ_FATAL,
        };
    }
    rip_dvd_scsi_read_scope_begin(lba, (uint32_t)block_count, retry_ordinal);
    int result =
        dvdcss_read(backend->dvdcss, buffer, block_count, DVDCSS_NOFLAGS);
    struct rip_dvd_scsi_completion completion = { 0 };
    rip_dvd_scsi_read_scope_end(&completion);
    if (result < 0) {
        return (struct transport_read_result){
            .status = TRANSPORT_READ_FAILURE,
            .completion = completion,
        };
    }
    if (result == 0) {
        return (struct transport_read_result){
            .status = TRANSPORT_READ_END,
        };
    }
    return (struct transport_read_result){
        .status = TRANSPORT_READ_SUCCESS,
        .blocks_read = result,
    };
}

static struct backend_read_result backend_read(
    struct read_backend *backend, unsigned char *buffer, uint64_t lba,
    int block_count, int absolute, uint32_t retry_ordinal)
{
    struct transport_read_result transport;
#ifdef RIP_DVD_READER_TESTING
    if (backend->use_test_source) {
        transport = test_transport_read(
            backend, buffer, lba, block_count, retry_ordinal);
    } else
#endif
    {
        transport = dvdcss_transport_read(
            backend, buffer, lba, block_count, absolute, retry_ordinal);
    }
    if (transport.status == TRANSPORT_READ_SUCCESS) {
        return (struct backend_read_result){
            .status = BACKEND_READ_SUCCESS,
            .blocks_read = transport.blocks_read,
        };
    }
    if (transport.status == TRANSPORT_READ_END) {
        return (struct backend_read_result){ .status = BACKEND_READ_END };
    }
    if (transport.status == TRANSPORT_READ_FATAL) {
        return (struct backend_read_result){ .status = BACKEND_READ_FATAL };
    }
    struct decoded_sense sense;
    enum backend_read_status status =
        classify_read_failure(&transport.completion, &sense);
    return (struct backend_read_result){
        .status = status,
        .failure = {
            .completion = transport.completion,
            .sense = sense,
        },
    };
}

static int consume_blocks(struct operation_state *state,
                          const unsigned char *buffer, int block_count,
                          uint64_t *bytes_processed)
{
    size_t byte_count = (size_t)block_count * DVDCSS_BLOCK_SIZE;
    *bytes_processed += byte_count;
    return consume(state, buffer, byte_count, *bytes_processed);
}

static int sector_is_bad(const struct recovery_state *recovery, uint64_t lba)
{
    size_t byte_index = (size_t)(lba / 8);
    unsigned int bit_index = (unsigned int)(lba % 8);
    return (recovery->bad_sector_bitmap[byte_index] &
            (unsigned char)(1U << bit_index)) != 0;
}

static void mark_bad_sector(struct recovery_state *recovery, uint64_t lba)
{
    size_t byte_index = (size_t)(lba / 8);
    unsigned int bit_index = (unsigned int)(lba % 8);
    recovery->bad_sector_bitmap[byte_index] |=
        (unsigned char)(1U << bit_index);
    recovery->bad_sector_count += 1;
    if (lba == 0 || !sector_is_bad(recovery, lba - 1)) {
        recovery->bad_area_count += 1;
    }
}

static int recover_range(struct read_backend *backend,
                         struct operation_state *state,
                         struct recovery_state *recovery,
                         unsigned char *buffer, uint64_t start_lba,
                         int block_count, uint64_t *bytes_processed,
                         uint32_t first_retry_ordinal)
{
    for (int attempt = 0; attempt < RECOVERY_READ_ATTEMPTS; attempt++) {
        struct backend_read_result result =
            backend_read(backend, buffer, start_lba, block_count, 1,
                         first_retry_ordinal + (uint32_t)attempt);
        if (result.status == BACKEND_READ_FATAL) {
            return 1;
        }
        if (result.status == BACKEND_READ_END) {
            fprintf(stderr,
                    "DVD content read ended before the declared media size\n");
            return 1;
        }
        if (result.status == BACKEND_READ_MEDIA_ERROR) {
            continue;
        }
        if (result.status == BACKEND_READ_UNKNOWN_ERROR) {
            return emit_read_failure_result(&result.failure, recovery);
        }
        if (consume_blocks(state, buffer, result.blocks_read,
                           bytes_processed) != 0) {
            return 1;
        }
        if (result.blocks_read == block_count) {
            return 0;
        }
        return recover_range(backend, state, recovery, buffer,
                             start_lba + (uint64_t)result.blocks_read,
                             block_count - result.blocks_read,
                             bytes_processed, 0);
    }

    if (block_count == 1) {
        memset(buffer, 0, DVDCSS_BLOCK_SIZE);
        if (consume_blocks(state, buffer, 1, bytes_processed) != 0) {
            return 1;
        }
        mark_bad_sector(recovery, start_lba);
        return 0;
    }

    int left_block_count = block_count / 2;
    int left_status = recover_range(backend, state, recovery, buffer,
                                    start_lba, left_block_count,
                                    bytes_processed, 0);
    if (left_status != 0) {
        return left_status;
    }
    return recover_range(backend, state, recovery, buffer,
                         start_lba + (uint64_t)left_block_count,
                         block_count - left_block_count, bytes_processed, 0);
}

static int read_disc(struct read_backend *backend, uint64_t size_bytes,
                     struct operation_state *state,
                     struct recovery_state *recovery)
{
    void *allocation = NULL;
    if (posix_memalign(&allocation, DVDCSS_BLOCK_SIZE,
                       READ_BLOCKS * DVDCSS_BLOCK_SIZE) != 0) {
        fprintf(stderr, "DVD read buffer allocation failed\n");
        return 1;
    }
    unsigned char *buffer = allocation;
    uint64_t blocks_remaining = size_bytes / DVDCSS_BLOCK_SIZE;
    uint64_t bytes_processed = 0;
    int require_absolute_read = 0;
    int status = 0;
    while (blocks_remaining > 0) {
        int requested = blocks_remaining > READ_BLOCKS
                            ? READ_BLOCKS
                            : (int)blocks_remaining;
        uint64_t start_lba = bytes_processed / DVDCSS_BLOCK_SIZE;
        struct backend_read_result result =
            backend_read(backend, buffer, start_lba, requested,
                         require_absolute_read, 0);
        require_absolute_read = 0;
        if (result.status == BACKEND_READ_FATAL) {
            status = 1;
            break;
        }
        if (result.status == BACKEND_READ_END) {
            fprintf(stderr,
                    "DVD content read ended before the declared media size\n");
            status = 1;
            break;
        }
        if (result.status == BACKEND_READ_MEDIA_ERROR) {
            if (recovery == NULL) {
                status = fail_dvdcss_read(backend->dvdcss, bytes_processed);
                break;
            }
            int recovery_status = recover_range(
                backend, state, recovery, buffer, start_lba, requested,
                &bytes_processed, 1);
            if (recovery_status != 0) {
                status = recovery_status;
                break;
            }
            blocks_remaining -= (uint64_t)requested;
            require_absolute_read = blocks_remaining > 0;
            continue;
        }
        if (result.status == BACKEND_READ_UNKNOWN_ERROR) {
            status = emit_read_failure_result(&result.failure, recovery);
            break;
        }
        if (consume_blocks(state, buffer, result.blocks_read,
                           &bytes_processed) != 0) {
            status = 1;
            break;
        }
        blocks_remaining -= (uint64_t)result.blocks_read;
    }
    free(allocation);
    return status;
}

static int run_hash(struct read_backend *backend, uint64_t size_bytes)
{
    EVP_MD_CTX *hash = EVP_MD_CTX_new();
    if (hash == NULL || EVP_DigestInit_ex(hash, EVP_sha256(), NULL) != 1) {
        EVP_MD_CTX_free(hash);
        fprintf(stderr, "DVD content hash initialization failed\n");
        return 1;
    }
    char size_text[32];
    int size_length =
        snprintf(size_text, sizeof(size_text), "%" PRIu64, size_bytes);
    static const char prefix[] = "rip-dvd-content-v2";
    if (size_length <= 0 || (size_t)size_length >= sizeof(size_text) ||
        EVP_DigestUpdate(hash, prefix, sizeof(prefix)) != 1 ||
        EVP_DigestUpdate(hash, size_text, (size_t)size_length) != 1) {
        EVP_MD_CTX_free(hash);
        fprintf(stderr, "DVD content hash initialization failed\n");
        return 1;
    }
    struct operation_state state = {
        .operation = OPERATION_HASH,
        .hash = hash,
        .output_fd = -1,
        .last_progress_bytes = 0,
    };
    if (clock_gettime(CLOCK_MONOTONIC, &state.last_progress_at) != 0) {
        EVP_MD_CTX_free(hash);
        return fail_errno("DVD hash progress clock failed");
    }
    int status = read_disc(backend, size_bytes, &state, NULL);
    if (status == 0 && state.last_progress_bytes != size_bytes) {
        status = emit_hash_progress(&state, size_bytes, 1);
    }
    unsigned char digest[EVP_MAX_MD_SIZE];
    unsigned int digest_length = 0;
    if (status == 0 && EVP_DigestFinal_ex(hash, digest, &digest_length) != 1) {
        fprintf(stderr, "DVD content hash finalization failed\n");
        status = 1;
    }
    EVP_MD_CTX_free(hash);
    if (status != 0) {
        return status;
    }
    printf("sha256:");
    for (unsigned int index = 0; index < digest_length; index++) {
        printf("%02x", digest[index]);
    }
    return fflush(stdout) == 0 ? 0 :
        fail_errno("DVD content hash output failed");
}

static int emit_recovery_result(uint64_t size_bytes,
                                const struct recovery_state *recovery)
{
    if (recovery->emit_malformed_result) {
        fprintf(stderr, RECOVERY_RESULT_PREFIX "{malformed}\n");
        return ferror(stderr) == 0 ? 0 :
            fail_errno("DVD recovery result output failed");
    }
    uint64_t recovered_byte_count =
        size_bytes - recovery->bad_sector_count * DVDCSS_BLOCK_SIZE;
    fprintf(stderr,
            RECOVERY_RESULT_PREFIX
            "{\"protocolVersion\":1,\"declaredByteCount\":%" PRIu64
            ",\"recoveredByteCount\":%" PRIu64
            ",\"recoveryPolicyVersion\":\"" RECOVERY_POLICY_VERSION
            "\",\"badSectorCount\":%" PRIu64
            ",\"badAreaCount\":%" PRIu64
            ",\"badSectorBitmapHex\":\"",
            size_bytes, recovered_byte_count, recovery->bad_sector_count,
            recovery->bad_area_count);
    if (recovery->bad_sector_count > 0) {
        for (size_t index = 0; index < recovery->bitmap_byte_count; index++) {
            fprintf(stderr, "%02x", recovery->bad_sector_bitmap[index]);
        }
    }
    fprintf(stderr, "\"}\n");
    return ferror(stderr) == 0 ? 0 :
        fail_errno("DVD recovery result output failed");
}

static int run_copy(struct read_backend *backend, const char *output_path,
                    uint64_t size_bytes,
                    enum test_result_mode test_result_mode)
{
    int output_fd = open(output_path,
                         O_WRONLY | O_CREAT | O_EXCL | O_NOFOLLOW | O_CLOEXEC,
                         S_IRUSR | S_IWUSR | S_IRGRP | S_IROTH);
    if (output_fd < 0) {
        return fail_errno("DVD archive output open failed");
    }
    uint64_t total_sector_count = size_bytes / DVDCSS_BLOCK_SIZE;
    size_t bitmap_byte_count = (size_t)((total_sector_count + 7) / 8);
    unsigned char *bad_sector_bitmap = calloc(bitmap_byte_count, 1);
    if (bad_sector_bitmap == NULL) {
        close(output_fd);
        fprintf(stderr, "DVD recovery map allocation failed\n");
        return 1;
    }
    struct recovery_state recovery = {
        .bad_sector_bitmap = bad_sector_bitmap,
        .bitmap_byte_count = bitmap_byte_count,
        .bad_sector_count = 0,
        .bad_area_count = 0,
        .emit_malformed_result =
            test_result_mode == TEST_RESULT_MALFORMED_RECOVERY,
        .interrupt_read_failure_result =
            test_result_mode == TEST_RESULT_INTERRUPTED_READ_FAILURE,
    };
    struct operation_state state = {
        .operation = OPERATION_COPY,
        .hash = NULL,
        .output_fd = output_fd,
    };
    int status = read_disc(backend, size_bytes, &state, &recovery);
    if (status == 0 && fsync(output_fd) != 0) {
        status = fail_errno("DVD archive sync failed");
    }
    if (close(output_fd) != 0 && status == 0) {
        status = fail_errno("DVD archive close failed");
    }
    if (status == 0) {
        status = emit_recovery_result(size_bytes, &recovery);
    }
    free(bad_sector_bitmap);
    return status;
}

static int hex_digit_value(char value)
{
    if (value >= '0' && value <= '9') {
        return value - '0';
    }
    if (value >= 'a' && value <= 'f') {
        return value - 'a' + 10;
    }
    return -1;
}

static int parse_resume_bitmap(const char *text, uint64_t total_sector_count,
                               unsigned char *bitmap, size_t bitmap_byte_count,
                               uint64_t *bad_sector_count)
{
    size_t expected_length = bitmap_byte_count * 2;
    if (strlen(text) != expected_length) {
        fprintf(stderr, "DVD rescue map is invalid\n");
        return 1;
    }
    *bad_sector_count = 0;
    for (size_t index = 0; index < bitmap_byte_count; index++) {
        int high = hex_digit_value(text[index * 2]);
        int low = hex_digit_value(text[index * 2 + 1]);
        if (high < 0 || low < 0) {
            fprintf(stderr, "DVD rescue map is invalid\n");
            return 1;
        }
        bitmap[index] = (unsigned char)((high << 4) | low);
        for (unsigned int bit = 0; bit < 8; bit++) {
            uint64_t lba = (uint64_t)index * 8 + bit;
            if ((bitmap[index] & (unsigned char)(1U << bit)) == 0) {
                continue;
            }
            if (lba >= total_sector_count) {
                fprintf(stderr, "DVD rescue map is invalid\n");
                return 1;
            }
            *bad_sector_count += 1;
        }
    }
    if (*bad_sector_count == 0) {
        fprintf(stderr, "DVD rescue map is empty\n");
        return 1;
    }
    return 0;
}

static int parse_filesystem_identity(const char *text,
                                     uintmax_t *expected_device,
                                     uintmax_t *expected_inode)
{
    if (text == NULL || text[0] < '0' || text[0] > '9') {
        fprintf(stderr, "DVD rescue image identity is invalid\n");
        return 1;
    }
    char *device_end = NULL;
    errno = 0;
    uintmax_t device = strtoumax(text, &device_end, 10);
    if (errno != 0 || device_end == text || *device_end != ':' ||
        device_end[1] < '0' || device_end[1] > '9') {
        fprintf(stderr, "DVD rescue image identity is invalid\n");
        return 1;
    }
    char *inode_end = NULL;
    errno = 0;
    uintmax_t inode = strtoumax(device_end + 1, &inode_end, 10);
    if (errno != 0 || inode_end == device_end + 1 || *inode_end != '\0' ||
        inode == 0) {
        fprintf(stderr, "DVD rescue image identity is invalid\n");
        return 1;
    }
    *expected_device = device;
    *expected_inode = inode;
    return 0;
}

static int run_resume(struct read_backend *backend, const char *output_path,
                      uint64_t size_bytes,
                      const unsigned char *prior_bad_sector_bitmap,
                      uint64_t prior_bad_sector_count,
                      const char *expected_filesystem_identity,
                      enum test_result_mode test_result_mode)
{
    uintmax_t expected_device = 0;
    uintmax_t expected_inode = 0;
    if (parse_filesystem_identity(expected_filesystem_identity,
                                  &expected_device, &expected_inode) != 0) {
        return 1;
    }
    int output_fd = open(output_path, O_RDWR | O_NOFOLLOW | O_CLOEXEC);
    if (output_fd < 0) {
        return fail_errno("DVD rescue image open failed");
    }
    struct stat output;
    if (fstat(output_fd, &output) != 0 || !S_ISREG(output.st_mode) ||
        output.st_size < 0 || (uint64_t)output.st_size != size_bytes ||
        (uintmax_t)output.st_dev != expected_device ||
        (uintmax_t)output.st_ino != expected_inode) {
        close(output_fd);
        fprintf(stderr, "DVD rescue image does not match its recovery map\n");
        return 1;
    }
    uint64_t total_sector_count = size_bytes / DVDCSS_BLOCK_SIZE;
    size_t bitmap_byte_count = (size_t)((total_sector_count + 7) / 8);
    unsigned char *bad_sector_bitmap = calloc(bitmap_byte_count, 1);
    void *allocation = NULL;
    if (bad_sector_bitmap == NULL ||
        posix_memalign(&allocation, DVDCSS_BLOCK_SIZE, DVDCSS_BLOCK_SIZE) != 0) {
        free(bad_sector_bitmap);
        close(output_fd);
        fprintf(stderr, "DVD rescue allocation failed\n");
        return 1;
    }
    unsigned char *buffer = allocation;
    struct recovery_state recovery = {
        .bad_sector_bitmap = bad_sector_bitmap,
        .bitmap_byte_count = bitmap_byte_count,
        .bad_sector_count = 0,
        .bad_area_count = 0,
        .emit_malformed_result =
            test_result_mode == TEST_RESULT_MALFORMED_RECOVERY,
        .interrupt_read_failure_result =
            test_result_mode == TEST_RESULT_INTERRUPTED_READ_FAILURE,
    };
    uint64_t bytes_processed =
        size_bytes - prior_bad_sector_count * DVDCSS_BLOCK_SIZE;
    uint64_t last_progress_bytes = bytes_processed;
    struct timespec last_progress_at;
    if (clock_gettime(CLOCK_MONOTONIC, &last_progress_at) != 0) {
        free(allocation);
        free(bad_sector_bitmap);
        close(output_fd);
        return fail_errno("DVD copy progress clock failed");
    }
    int status = 0;
    for (uint64_t lba = 0; lba < total_sector_count; lba++) {
        size_t byte_index = (size_t)(lba / 8);
        unsigned int bit_index = (unsigned int)(lba % 8);
        if ((prior_bad_sector_bitmap[byte_index] &
             (unsigned char)(1U << bit_index)) == 0) {
            continue;
        }
        int recovered = 0;
        for (int attempt = 0; attempt < RECOVERY_READ_ATTEMPTS; attempt++) {
            struct backend_read_result result =
                backend_read(backend, buffer, lba, 1, 1,
                             (uint32_t)attempt);
            if (result.status == BACKEND_READ_FATAL) {
                status = 1;
                break;
            }
            if (result.status == BACKEND_READ_END) {
                fprintf(stderr,
                        "DVD content read ended before the declared media size\n");
                status = 1;
                break;
            }
            if (result.status == BACKEND_READ_MEDIA_ERROR) {
                continue;
            }
            if (result.status == BACKEND_READ_UNKNOWN_ERROR) {
                status = emit_read_failure_result(&result.failure, &recovery);
                break;
            }
            if (result.blocks_read != 1 ||
                write_all_at(output_fd, buffer, DVDCSS_BLOCK_SIZE,
                             (off_t)(lba * DVDCSS_BLOCK_SIZE)) != 0) {
                status = 1;
                break;
            }
            recovered = 1;
            break;
        }
        if (status != 0) {
            break;
        }
        if (!recovered) {
            memset(buffer, 0, DVDCSS_BLOCK_SIZE);
            if (write_all_at(output_fd, buffer, DVDCSS_BLOCK_SIZE,
                             (off_t)(lba * DVDCSS_BLOCK_SIZE)) != 0) {
                status = 1;
                break;
            }
            mark_bad_sector(&recovery, lba);
        }
        bytes_processed += DVDCSS_BLOCK_SIZE;
        if (emit_copy_progress(bytes_processed, &last_progress_bytes,
                               &last_progress_at, 0) != 0) {
            status = 1;
            break;
        }
    }
    if (status == 0 && last_progress_bytes != size_bytes &&
        emit_copy_progress(size_bytes, &last_progress_bytes,
                           &last_progress_at, 1) != 0) {
        status = 1;
    }
    if (status == 0 && fsync(output_fd) != 0) {
        status = fail_errno("DVD rescue image sync failed");
    }
    if (close(output_fd) != 0 && status == 0) {
        status = fail_errno("DVD rescue image close failed");
    }
    if (status == 0) {
        status = emit_recovery_result(size_bytes, &recovery);
    }
    free(allocation);
    free(bad_sector_bitmap);
    return status;
}

static int await_copy_authorization(uint64_t total_sector_count, int resume,
                                    unsigned char **resume_bitmap,
                                    uint64_t *resume_bad_sector_count)
{
    static const char ready[] = "rip-dvd-copy-authorization-ready\n";
    if (write(4, ready, sizeof(ready) - 1) != (ssize_t)(sizeof(ready) - 1)) {
        return fail_errno("DVD copy authorization readiness failed");
    }
    char authorized = 0;
    ssize_t bytes_read;
    do {
        bytes_read = read(5, &authorized, 1);
    } while (bytes_read < 0 && errno == EINTR);
    if (bytes_read != 1 || authorized != '1') {
        fprintf(stderr, "DVD copy authorization was denied\n");
        return 1;
    }
    if (!resume) {
        return 0;
    }
    size_t bitmap_byte_count =
        (size_t)((total_sector_count + 7) / 8);
    size_t text_length = bitmap_byte_count * 2;
    char *text = malloc(text_length + 1);
    unsigned char *bitmap = calloc(bitmap_byte_count, 1);
    if (text == NULL || bitmap == NULL) {
        free(text);
        free(bitmap);
        fprintf(stderr, "DVD rescue map allocation failed\n");
        return 1;
    }
    size_t received = 0;
    while (received < text_length) {
        do {
            bytes_read = read(5, text + received, text_length - received);
        } while (bytes_read < 0 && errno == EINTR);
        if (bytes_read <= 0) {
            free(text);
            free(bitmap);
            fprintf(stderr, "DVD rescue map authorization is incomplete\n");
            return 1;
        }
        received += (size_t)bytes_read;
    }
    text[text_length] = '\0';
    char extra;
    do {
        bytes_read = read(5, &extra, 1);
    } while (bytes_read < 0 && errno == EINTR);
    if (bytes_read != 0 ||
        parse_resume_bitmap(text, total_sector_count, bitmap,
                            bitmap_byte_count,
                            resume_bad_sector_count) != 0) {
        free(text);
        free(bitmap);
        if (bytes_read != 0) {
            fprintf(stderr, "DVD rescue map authorization is invalid\n");
        }
        return 1;
    }
    free(text);
    *resume_bitmap = bitmap;
    return 0;
}

#ifdef RIP_DVD_READER_TESTING
static int parse_test_delay(const char *text, unsigned int *delay_ms)
{
    char *end = NULL;
    errno = 0;
    unsigned long value = strtoul(text, &end, 10);
    if (errno != 0 || end == text || *end != '\0' || value > 1000) {
        fprintf(stderr, "DVD test read delay is invalid\n");
        return 1;
    }
    *delay_ms = (unsigned int)value;
    return 0;
}

static int parse_test_integer(const char *text, uint64_t maximum,
                              uint64_t *value)
{
    char *end = NULL;
    errno = 0;
    unsigned long long parsed = strtoull(text, &end, 10);
    if (errno != 0 || end == text || *end != '\0' || parsed > maximum) {
        return 1;
    }
    *value = parsed;
    return 0;
}

static int parse_test_remaining_failures(const char *text,
                                         int *remaining_failures)
{
    if (strcmp(text, "always") == 0) {
        *remaining_failures = -1;
        return 0;
    }
    uint64_t count = 0;
    if (parse_test_integer(text, 1000, &count) != 0 || count == 0) {
        return 1;
    }
    *remaining_failures = (int)count;
    return 0;
}

static int parse_test_sense(const char *text, struct test_fault *fault)
{
    if (strcmp(text, "-") == 0) {
        return 0;
    }
    size_t text_length = strlen(text);
    if (text_length == 0 || text_length % 2 != 0 ||
        text_length / 2 > RIP_DVD_SCSI_MAX_SENSE_BYTES) {
        return 1;
    }
    for (size_t index = 0; index < text_length / 2; index++) {
        int high = hex_digit_value(text[index * 2]);
        int low = hex_digit_value(text[index * 2 + 1]);
        if (high < 0 || low < 0) {
            return 1;
        }
        fault->sense[index] = (uint8_t)((high << 4) | low);
    }
    fault->sense_length = text_length / 2;
    return 0;
}

static int parse_exact_test_fault(char *entry, uint64_t total_sector_count,
                                  struct test_fault *fault)
{
    char *parts[8] = { 0 };
    size_t part_count = 0;
    char *save = NULL;
    for (char *part = strtok_r(entry, "@", &save); part != NULL;
         part = strtok_r(NULL, "@", &save)) {
        if (part_count >= sizeof(parts) / sizeof(parts[0])) {
            return 1;
        }
        parts[part_count++] = part;
    }
    size_t expected_parts =
        part_count > 0 && strcmp(parts[0], "generic") == 0 ? 3 : 8;
    if (part_count != expected_parts ||
        (strcmp(parts[0], "raw") != 0 &&
         strcmp(parts[0], "generic") != 0)) {
        return 1;
    }
    uint64_t lba = 0;
    if (parse_test_integer(parts[1], total_sector_count - 1, &lba) != 0 ||
        parse_test_remaining_failures(parts[2],
                                      &fault->remaining_failures) != 0) {
        return 1;
    }
    fault->lba = lba;
    if (strcmp(parts[0], "generic") == 0) {
        fault->kind = TEST_FAULT_GENERIC_FAILURE;
        return 0;
    }
    uint64_t scsi_status = 0;
    uint64_t host_status = 0;
    uint64_t driver_status = 0;
    uint64_t sense_reported_length = 0;
    if (parse_test_integer(parts[3], UINT8_MAX, &scsi_status) != 0 ||
        parse_test_integer(parts[4], UINT16_MAX, &host_status) != 0 ||
        parse_test_integer(parts[5], UINT16_MAX, &driver_status) != 0 ||
        parse_test_integer(parts[6], 4096, &sense_reported_length) != 0 ||
        parse_test_sense(parts[7], fault) != 0) {
        return 1;
    }
    fault->kind = TEST_FAULT_RAW_COMPLETION;
    fault->scsi_status = (uint8_t)scsi_status;
    fault->host_status = (uint16_t)host_status;
    fault->driver_status = (uint16_t)driver_status;
    fault->sense_reported_length = (size_t)sense_reported_length;
    return 0;
}

static int parse_legacy_test_fault(char *entry, uint64_t total_sector_count,
                                   struct test_fault *fault)
{
    char *separator = strchr(entry, ':');
    if (separator == NULL || strchr(separator + 1, ':') != NULL) {
        return 1;
    }
    *separator = '\0';
    uint64_t lba = 0;
    if (parse_test_integer(entry, total_sector_count - 1, &lba) != 0 ||
        parse_test_remaining_failures(separator + 1,
                                      &fault->remaining_failures) != 0) {
        return 1;
    }
    fault->kind = TEST_FAULT_MEDIUM_ERROR;
    fault->lba = lba;
    return 0;
}

static int parse_test_faults(char *text, uint64_t total_sector_count,
                             struct read_backend *backend)
{
    if (strcmp(text, "none") == 0) {
        return 0;
    }
    char *save = NULL;
    for (char *entry = strtok_r(text, ",", &save); entry != NULL;
         entry = strtok_r(NULL, ",", &save)) {
        if (backend->test_fault_count >= MAX_TEST_FAULTS) {
            fprintf(stderr, "DVD test fault count is invalid\n");
            return 1;
        }
        struct test_fault fault = { 0 };
        int parse_status = strchr(entry, '@') == NULL
                               ? parse_legacy_test_fault(
                                     entry, total_sector_count, &fault)
                               : parse_exact_test_fault(
                                     entry, total_sector_count, &fault);
        if (parse_status != 0) {
            fprintf(stderr, "DVD test fault is invalid\n");
            return 1;
        }
        for (size_t index = 0; index < backend->test_fault_count; index++) {
            if (backend->test_faults[index].lba == fault.lba) {
                fprintf(stderr, "DVD test fault LBA is duplicated\n");
                return 1;
            }
        }
        backend->test_faults[backend->test_fault_count] = fault;
        backend->test_fault_count += 1;
    }
    return 0;
}

static int initialize_test_backend(const char *source_path,
                                   const char *size_text,
                                   const char *fault_text,
                                   const char *delay_text,
                                   const char *result_mode,
                                   uint64_t *size_bytes,
                                   enum test_result_mode *test_result_mode,
                                   struct read_backend *backend)
{
    if (parse_size(size_text, size_bytes) != 0) {
        return 2;
    }
    if (strcmp(result_mode, "valid") == 0) {
        *test_result_mode = TEST_RESULT_VALID;
    } else if (strcmp(result_mode, "malformed") == 0) {
        *test_result_mode = TEST_RESULT_MALFORMED_RECOVERY;
    } else if (strcmp(result_mode, "interrupted-read-failure") == 0) {
        *test_result_mode = TEST_RESULT_INTERRUPTED_READ_FAILURE;
    } else {
        fprintf(stderr, "DVD test result mode is invalid\n");
        return 2;
    }
    *backend = (struct read_backend){
        .dvdcss = NULL,
        .test_source_fd = -1,
        .use_test_source = 1,
    };
    if (parse_test_delay(delay_text, &backend->test_delay_ms) != 0) {
        return 2;
    }
    char *faults = strdup(fault_text);
    if (faults == NULL) {
        fprintf(stderr, "DVD test fault allocation failed\n");
        return 1;
    }
    int fault_status = parse_test_faults(
        faults, *size_bytes / DVDCSS_BLOCK_SIZE, backend);
    free(faults);
    if (fault_status != 0) {
        return 2;
    }
    backend->test_source_fd =
        open(source_path, O_RDONLY | O_NOFOLLOW | O_CLOEXEC);
    if (backend->test_source_fd < 0) {
        return fail_errno("DVD test source open failed");
    }
    struct stat source;
    if (fstat(backend->test_source_fd, &source) != 0 ||
        !S_ISREG(source.st_mode)) {
        close(backend->test_source_fd);
        backend->test_source_fd = -1;
        fprintf(stderr, "DVD test source is invalid\n");
        return 1;
    }
    return 0;
}

static int close_test_backend(struct read_backend *backend, int status)
{
    if (backend->test_source_fd >= 0 &&
        close(backend->test_source_fd) != 0 && status == 0) {
        status = fail_errno("DVD test source close failed");
    }
    backend->test_source_fd = -1;
    return status;
}

static int run_test_copy(int argc, char **argv)
{
    if (argc != 8) {
        fprintf(stderr,
                "usage: %s copy-test SOURCE OUTPUT SIZE FAULTS DELAY MODE\n",
                argv[0]);
        return 2;
    }
    uint64_t size_bytes = 0;
    enum test_result_mode test_result_mode;
    struct read_backend backend;
    int setup_status = initialize_test_backend(
        argv[2], argv[4], argv[5], argv[6], argv[7], &size_bytes,
        &test_result_mode, &backend);
    if (setup_status != 0) {
        return setup_status;
    }
    int status = run_copy(&backend, argv[3], size_bytes, test_result_mode);
    return close_test_backend(&backend, status);
}

static int run_test_resume(int argc, char **argv)
{
    if (argc != 10) {
        fprintf(stderr,
                "usage: %s resume-test SOURCE OUTPUT SIZE FAULTS DELAY MODE BITMAP IDENTITY\n",
                argv[0]);
        return 2;
    }
    uint64_t size_bytes = 0;
    enum test_result_mode test_result_mode;
    struct read_backend backend;
    int setup_status = initialize_test_backend(
        argv[2], argv[4], argv[5], argv[6], argv[7], &size_bytes,
        &test_result_mode, &backend);
    if (setup_status != 0) {
        return setup_status;
    }
    uint64_t total_sector_count = size_bytes / DVDCSS_BLOCK_SIZE;
    size_t bitmap_byte_count = (size_t)((total_sector_count + 7) / 8);
    unsigned char *resume_bitmap = calloc(bitmap_byte_count, 1);
    uint64_t resume_bad_sector_count = 0;
    if (resume_bitmap == NULL ||
        parse_resume_bitmap(argv[8], total_sector_count, resume_bitmap,
                            bitmap_byte_count,
                            &resume_bad_sector_count) != 0) {
        free(resume_bitmap);
        return close_test_backend(&backend, 2);
    }
    int status = run_resume(&backend, argv[3], size_bytes, resume_bitmap,
                            resume_bad_sector_count, argv[9],
                            test_result_mode);
    free(resume_bitmap);
    return close_test_backend(&backend, status);
}
#endif

int main(int argc, char **argv)
{
#ifdef RIP_DVD_READER_TESTING
    if (argc > 1 && strcmp(argv[1], "copy-test") == 0) {
        return run_test_copy(argc, argv);
    }
    if (argc > 1 && strcmp(argv[1], "resume-test") == 0) {
        return run_test_resume(argc, argv);
    }
#endif
    int authorized_copy = argc > 1 &&
        strcmp(argv[1], "copy-authorized") == 0;
    int authorized_resume = argc > 1 &&
        strcmp(argv[1], "resume-authorized") == 0;
    if (argc < 4 || (strcmp(argv[1], "hash") != 0 &&
                     strcmp(argv[1], "copy") != 0 && !authorized_copy &&
                     !authorized_resume)) {
        fprintf(stderr,
                "usage: %s hash DEVICE SIZE | copy DEVICE OUTPUT SIZE\n",
                argv[0]);
        return 2;
    }
    enum operation operation = strcmp(argv[1], "hash") == 0
                                   ? OPERATION_HASH
                                   : OPERATION_COPY;
    if ((operation == OPERATION_HASH && argc != 4) ||
        (operation == OPERATION_COPY &&
         argc != (authorized_resume ? 6 : 5))) {
        fprintf(stderr, "DVD reader arguments are invalid\n");
        return 2;
    }
    uint64_t size_bytes = 0;
    if (parse_size(argv[operation == OPERATION_HASH ? 3 : 4],
                   &size_bytes) != 0) {
        return 2;
    }
    unsigned char *resume_bitmap = NULL;
    uint64_t resume_bad_sector_count = 0;
    if ((authorized_copy || authorized_resume) &&
        await_copy_authorization(size_bytes / DVDCSS_BLOCK_SIZE,
                                 authorized_resume, &resume_bitmap,
                                 &resume_bad_sector_count) != 0) {
        return 1;
    }
    dvdcss_t dvdcss = dvdcss_open(argv[2]);
    if (dvdcss == NULL) {
        free(resume_bitmap);
        fprintf(stderr, "DVD content open failed\n");
        return 1;
    }
    struct read_backend backend = { .dvdcss = dvdcss };
    int status;
    if (operation == OPERATION_HASH) {
        status = run_hash(&backend, size_bytes);
    } else if (authorized_resume) {
        status = run_resume(&backend, argv[3], size_bytes, resume_bitmap,
                            resume_bad_sector_count, argv[5],
                            TEST_RESULT_VALID);
    } else {
        status = run_copy(&backend, argv[3], size_bytes, TEST_RESULT_VALID);
    }
    free(resume_bitmap);
    if (dvdcss_close(dvdcss) != 0 && status == 0) {
        fprintf(stderr, "DVD content close failed\n");
        status = 1;
    }
    return status;
}
