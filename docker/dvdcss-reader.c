/* SPDX-License-Identifier: GPL-2.0-only */

#define _POSIX_C_SOURCE 200809L

#include <dvdcss/dvdcss.h>
#include <openssl/evp.h>

#include "libdvdcss-sg-io.h"

#include <errno.h>
#include <fcntl.h>
#include <inttypes.h>
#include <pthread.h>
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
#define READ_FAILURE_CLASSIFIER_VERSION "scsi-read-classifier-v2"
#define READ_FAILURE_RESULT_PREFIX "rip-dvd-read-failure "
#define READ_FAILURE_EXIT_STATUS 3
#define BOUNDARY_PROOF_VERSION "dvd-sector-boundary-proof-v1"
#define BOUNDARY_CONFIRMATION_READS 2

#ifdef RIP_DVD_READER_TESTING
#define MAX_TEST_FAULTS 64

struct test_fault {
    enum {
        TEST_FAULT_RAW_COMPLETION,
        TEST_FAULT_RAW_TAIL_COMPLETION,
        TEST_FAULT_RAW_REQUEST_COMPLETION,
        TEST_FAULT_CORRUPT_REQUEST,
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
    BACKEND_READ_MEDIUM_ERROR,
    BACKEND_READ_TERMINAL_FAILURE,
    BACKEND_READ_OUT_OF_RANGE_ERROR,
    BACKEND_READ_END,
    BACKEND_READ_FATAL,
};

enum read_failure_category {
    READ_FAILURE_UNKNOWN,
    READ_FAILURE_NOT_READY,
    READ_FAILURE_UNIT_ATTENTION,
    READ_FAILURE_HARDWARE_ERROR,
    READ_FAILURE_TRANSPORT_ERROR,
    READ_FAILURE_PROTECTION_ERROR,
};

struct decoded_sense {
    int recognized_format;
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
    enum read_failure_category category;
    enum backend_read_status status;
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
    int test_wait_for_cancellation;
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
    int allow_boundary_proof;
    int include_boundary_recovery_snapshot;
    int boundary_failure;
    int boundary_proven;
    uint64_t boundary_retained_image_byte_count;
    int emit_malformed_result;
    int interrupt_read_failure_result;
};

struct boundary_conflict_evidence {
    uint64_t medium_error_lbas[READ_BLOCKS];
    size_t medium_error_lba_count;
    int has_unlocated_medium_error;
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
        size_t usable_length = length < declared_length
            ? length : declared_length;
        if (usable_length >= 13) {
            decoded.has_asc = 1;
            decoded.asc = sense[12];
        }
        if (usable_length >= 14) {
            decoded.has_ascq = 1;
            decoded.ascq = sense[13];
        }
        if ((sense[0] & 0x80) != 0) {
            uint64_t information_lba = read_big_endian_u32(sense + 3);
            if (information_lba_matches_request(
                    completion, information_lba)) {
                decoded.has_information_lba = 1;
                decoded.information_lba = information_lba;
            }
        }
        decoded.recognized_format = 1;
        return decoded;
    }
    if (sense[0] != 0x72 && sense[0] != 0x73) {
        return decoded;
    }
    if (length < 4) {
        return decoded;
    }
    decoded.has_sense_key = 1;
    decoded.sense_key = sense[1] & 0x0f;
    decoded.has_asc = 1;
    decoded.asc = sense[2];
    decoded.has_ascq = 1;
    decoded.ascq = sense[3];
    decoded.recognized_format = 1;
    if (length < 8) {
        return decoded;
    }
    size_t declared_length = 8U + sense[7];
    size_t descriptor_end = length < declared_length
        ? length : declared_length;
    int information_descriptor_seen = 0;
    int information_descriptors_valid = length >= declared_length;
    for (size_t offset = 8; offset < descriptor_end;) {
        if (descriptor_end - offset < 2) {
            information_descriptors_valid = 0;
            break;
        }
        size_t descriptor_length = 2U + sense[offset + 1];
        if (descriptor_length > descriptor_end - offset) {
            information_descriptors_valid = 0;
            break;
        }
        if (sense[offset] == 0x00) {
            if (sense[offset + 1] != 0x0a ||
                information_descriptor_seen ||
                (sense[offset + 2] & 0x7f) != 0 ||
                sense[offset + 3] != 0) {
                information_descriptors_valid = 0;
            } else {
                information_descriptor_seen = 1;
                if ((sense[offset + 2] & 0x80) != 0) {
                    uint64_t information_lba =
                        read_big_endian_u64(sense + offset + 4);
                    if (information_lba_matches_request(
                            completion, information_lba)) {
                        decoded.has_information_lba = 1;
                        decoded.information_lba = information_lba;
                    }
                }
            }
        }
        offset += descriptor_length;
    }
    if (!information_descriptors_valid) {
        decoded.has_information_lba = 0;
        decoded.information_lba = 0;
    }
    return decoded;
}

static int is_recognized_dvd_medium_read_error(
    const struct decoded_sense *sense)
{
    return sense->sense_key == 0x03;
}

static int is_recognized_host_transport_failure(uint16_t host_status)
{
    return host_status != 0;
}

static int is_recognized_driver_transport_failure(uint16_t driver_status)
{
    uint16_t base_status = driver_status & 0x0f;
    return base_status == 0x01 || base_status == 0x02 ||
           base_status == 0x04 || base_status == 0x06;
}

static int is_recognized_dvd_protection_error(
    const struct decoded_sense *sense)
{
    if (sense->sense_key == 0x07) {
        return 1;
    }
    return sense->sense_key == 0x05 && sense->asc == 0x6f;
}

static int is_recognized_dvd_out_of_range_error(
    const struct decoded_sense *sense)
{
    return sense->sense_key == 0x05 && sense->asc == 0x21 &&
        sense->ascq == 0x00 && sense->has_information_lba;
}

static enum backend_read_status classify_read_failure(
    const struct rip_dvd_scsi_completion *completion,
    struct read_failure *failure)
{
    failure->category = READ_FAILURE_UNKNOWN;
    failure->completion = *completion;
    failure->sense = decode_sense(completion);
    if (!completion->captured || !completion->command_completed) {
        return BACKEND_READ_TERMINAL_FAILURE;
    }
    if (is_recognized_host_transport_failure(completion->host_status) ||
        (completion->host_status == 0 &&
         is_recognized_driver_transport_failure(
             completion->driver_status))) {
        failure->category = READ_FAILURE_TRANSPORT_ERROR;
        return BACKEND_READ_TERMINAL_FAILURE;
    }
    const struct decoded_sense *sense = &failure->sense;
    uint16_t driver_base_status = completion->driver_status & 0x0f;
    if (!sense->recognized_format ||
        (completion->scsi_status & 0xfe) != 0x02 ||
        completion->host_status != 0 ||
        (driver_base_status != 0x00 && driver_base_status != 0x08) ||
        (sense->response_code != 0x70 && sense->response_code != 0x72) ||
        !sense->has_sense_key || !sense->has_asc || !sense->has_ascq) {
        return BACKEND_READ_TERMINAL_FAILURE;
    }
    if (sense->sense_key == 0x02) {
        failure->category = READ_FAILURE_NOT_READY;
        return BACKEND_READ_TERMINAL_FAILURE;
    }
    if (sense->sense_key == 0x06) {
        failure->category = READ_FAILURE_UNIT_ATTENTION;
        return BACKEND_READ_TERMINAL_FAILURE;
    }
    if (is_recognized_dvd_medium_read_error(sense)) {
        return BACKEND_READ_MEDIUM_ERROR;
    }
    if (is_recognized_dvd_out_of_range_error(sense)) {
        return BACKEND_READ_OUT_OF_RANGE_ERROR;
    }
    if (sense->sense_key == 0x04) {
        failure->category = READ_FAILURE_HARDWARE_ERROR;
    } else if (is_recognized_dvd_protection_error(sense)) {
        failure->category = READ_FAILURE_PROTECTION_ERROR;
    }
    return BACKEND_READ_TERMINAL_FAILURE;
}

static const char *read_failure_category_name(
    enum read_failure_category category)
{
    switch (category) {
    case READ_FAILURE_NOT_READY:
        return "not_ready";
    case READ_FAILURE_UNIT_ATTENTION:
        return "unit_attention";
    case READ_FAILURE_HARDWARE_ERROR:
        return "hardware_error";
    case READ_FAILURE_TRANSPORT_ERROR:
        return "transport_error";
    case READ_FAILURE_PROTECTION_ERROR:
        return "protection_error";
    case READ_FAILURE_UNKNOWN:
        return "unknown";
    }
    return "unknown";
}

static int backend_read_has_terminal_failure_result(
    enum backend_read_status status)
{
    return status == BACKEND_READ_TERMINAL_FAILURE ||
        status == BACKEND_READ_OUT_OF_RANGE_ERROR;
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
    const struct read_failure *failure, struct recovery_state *recovery,
    uint64_t declared_byte_count, uint64_t retained_image_byte_count)
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
    int includes_recovery_snapshot =
        failure->status == BACKEND_READ_OUT_OF_RANGE_ERROR &&
        recovery != NULL && recovery->boundary_proven &&
        (recovery->bad_sector_count > 0 ||
         recovery->include_boundary_recovery_snapshot);
    char boundary_fields[512];
    int boundary_length;
    const char *category;
    if (failure->status == BACKEND_READ_OUT_OF_RANGE_ERROR) {
        category = "out_of_range";
        if (includes_recovery_snapshot) {
            uint64_t recovered_byte_count = declared_byte_count -
                recovery->bad_sector_count * DVDCSS_BLOCK_SIZE;
            boundary_length = snprintf(
                boundary_fields, sizeof(boundary_fields),
                ",\"boundaryProofVersion\":\"" BOUNDARY_PROOF_VERSION "\""
                ",\"candidateConfirmationCount\":%d"
                ",\"precedingSectorLba\":%" PRIu64
                ",\"declaredByteCount\":%" PRIu64
                ",\"firstFailingLba\":%" PRIu64
                ",\"retainedImageByteCount\":%" PRIu64
                ",\"recoveryProtocol\":{\"protocolVersion\":1"
                ",\"declaredByteCount\":%" PRIu64
                ",\"recoveredByteCount\":%" PRIu64
                ",\"recoveryPolicyVersion\":\"" RECOVERY_POLICY_VERSION "\""
                ",\"badSectorCount\":%" PRIu64
                ",\"badAreaCount\":%" PRIu64
                ",\"badSectorBitmapHex\":\"",
                BOUNDARY_CONFIRMATION_READS,
                sense->information_lba - 1,
                declared_byte_count, sense->information_lba,
                retained_image_byte_count, declared_byte_count,
                recovered_byte_count, recovery->bad_sector_count,
                recovery->bad_area_count);
        } else if (recovery != NULL && recovery->boundary_proven) {
            boundary_length = snprintf(
                boundary_fields, sizeof(boundary_fields),
                ",\"boundaryProofVersion\":\"" BOUNDARY_PROOF_VERSION "\""
                ",\"candidateConfirmationCount\":%d"
                ",\"precedingSectorLba\":%" PRIu64
                ",\"declaredByteCount\":%" PRIu64
                ",\"firstFailingLba\":%" PRIu64
                ",\"retainedImageByteCount\":%" PRIu64 "}\n",
                BOUNDARY_CONFIRMATION_READS,
                sense->information_lba - 1,
                declared_byte_count, sense->information_lba,
                retained_image_byte_count);
        } else {
            boundary_length = snprintf(
                boundary_fields, sizeof(boundary_fields),
                ",\"declaredByteCount\":%" PRIu64
                ",\"firstFailingLba\":%" PRIu64
                ",\"retainedImageByteCount\":%" PRIu64 "}\n",
                declared_byte_count, sense->information_lba,
                retained_image_byte_count);
        }
        if (recovery != NULL) {
            recovery->boundary_failure = 1;
            recovery->boundary_retained_image_byte_count =
                retained_image_byte_count;
        }
    } else {
        category = read_failure_category_name(failure->category);
        memcpy(boundary_fields, "}\n", 3);
        boundary_length = 2;
    }
    if (boundary_length <= 0 ||
        (size_t)boundary_length >= sizeof(boundary_fields)) {
        fprintf(stderr, "DVD read failure result exceeded its bound\n");
        return 1;
    }
    if (includes_recovery_snapshot &&
        recovery->bitmap_byte_count > (SIZE_MAX - 2048) / 2) {
        fprintf(stderr, "DVD read failure result exceeded its bound\n");
        return 1;
    }
    size_t output_capacity = 2048 +
        (includes_recovery_snapshot ? recovery->bitmap_byte_count * 2 : 0);
    char *output = malloc(output_capacity);
    if (output == NULL) {
        fprintf(stderr, "DVD read failure result allocation failed\n");
        return 1;
    }
    int formatted_length = snprintf(
        output, output_capacity, READ_FAILURE_RESULT_PREFIX
        "{\"protocolVersion\":%d,\"classifierVersion\":\""
        READ_FAILURE_CLASSIFIER_VERSION
        "\",\"category\":\"%s\",\"scsiStatus\":%s"
        ",\"hostStatus\":%s,\"driverStatus\":%s"
        ",\"senseResponseCode\":%s,\"senseKey\":%s"
        ",\"asc\":%s,\"ascq\":%s,\"informationLba\":%s"
        ",\"requestedLba\":%" PRIu64
        ",\"requestedBlockCount\":%" PRIu32
        ",\"retryOrdinal\":%" PRIu32 "%s",
        includes_recovery_snapshot ? 2 : 1,
        category, scsi_status, host_status, driver_status, response_code,
        sense_key, asc, ascq, information_lba, completion->requested_lba,
        completion->requested_block_count, completion->retry_ordinal,
        boundary_fields);
    if (formatted_length <= 0 ||
        (size_t)formatted_length >= output_capacity) {
        free(output);
        fprintf(stderr, "DVD read failure result exceeded its bound\n");
        return 1;
    }
    size_t output_length = (size_t)formatted_length;
    if (includes_recovery_snapshot) {
        static const char hex_digits[] = "0123456789abcdef";
        size_t offset = output_length;
        if (recovery->bad_sector_count > 0) {
            for (size_t index = 0;
                 index < recovery->bitmap_byte_count; index++) {
                unsigned char byte = recovery->bad_sector_bitmap[index];
                output[offset++] = hex_digits[byte >> 4];
                output[offset++] = hex_digits[byte & 0x0f];
            }
        }
        memcpy(output + offset, "\"}}\n", 4);
        offset += 4;
        output[offset] = '\0';
        output_length = offset;
    }
#ifdef RIP_DVD_READER_TESTING
    if (recovery != NULL && recovery->interrupt_read_failure_result) {
        size_t partial_length = output_length - 2;
        if (write_terminal_output(output, partial_length) != 0) {
            free(output);
            return 1;
        }
        sleep(5);
        if (write_terminal_output(output + partial_length,
                                  output_length - partial_length) != 0) {
            free(output);
            return 1;
        }
        free(output);
        return READ_FAILURE_EXIT_STATUS;
    }
#else
    (void)recovery;
#endif
    if (write_terminal_output(output, output_length) != 0) {
        free(output);
        return 1;
    }
    free(output);
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

static int finish_test_read_attempt(struct read_backend *backend,
                                    uint64_t lba, int block_count)
{
    fprintf(stderr, "test-read %" PRIu64 " %d\n", lba, block_count);
    if (backend->test_wait_for_cancellation) {
        if (fflush(stderr) != 0) {
            return fail_errno("DVD test cancellation output failed");
        }
        for (;;) {
            pause();
        }
    }
    return delay_test_read(backend->test_delay_ms);
}

static struct test_fault *test_fault_for_read(struct read_backend *backend,
                                              uint64_t lba, int block_count)
{
    uint64_t end_lba = lba + (uint64_t)block_count;
    for (size_t index = 0; index < backend->test_fault_count; index++) {
        struct test_fault *fault = &backend->test_faults[index];
        int applies;
        if (fault->kind == TEST_FAULT_RAW_TAIL_COMPLETION) {
            applies = end_lba > fault->lba;
        } else if (fault->kind == TEST_FAULT_RAW_REQUEST_COMPLETION ||
                   fault->kind == TEST_FAULT_CORRUPT_REQUEST) {
            applies = fault->lba == lba;
        } else {
            applies = fault->lba >= lba && fault->lba < end_lba;
        }
        if (!applies || fault->remaining_failures == 0) {
            continue;
        }
        if (fault->remaining_failures > 0) {
            fault->remaining_failures -= 1;
        }
        return fault;
    }
    return NULL;
}

static void write_big_endian_u64(uint8_t bytes[8], uint64_t value)
{
    for (size_t index = 0; index < 8; index++) {
        bytes[7 - index] = (uint8_t)(value & 0xff);
        value >>= 8;
    }
}

static void write_big_endian_u32(uint8_t bytes[4], uint32_t value)
{
    for (size_t index = 0; index < 4; index++) {
        bytes[3 - index] = (uint8_t)(value & 0xff);
        value >>= 8;
    }
}

static void set_test_tail_information_lba(
    struct rip_dvd_scsi_completion *completion, uint64_t information_lba)
{
    if (completion->sense_length >= 8 &&
        (completion->sense[0] & 0x7f) == 0x70 &&
        (completion->sense[0] & 0x80) != 0 &&
        information_lba <= UINT32_MAX) {
        write_big_endian_u32(completion->sense + 3,
                             (uint32_t)information_lba);
        return;
    }
    if (completion->sense_length >= 20 && completion->sense[0] == 0x72 &&
        completion->sense[8] == 0x00 && completion->sense[9] == 0x0a &&
        (completion->sense[10] & 0x80) != 0) {
        write_big_endian_u64(completion->sense + 12, information_lba);
    }
}

static struct transport_read_result test_transport_read(
    struct read_backend *backend, unsigned char *buffer, uint64_t lba,
    int block_count, uint32_t retry_ordinal)
{
    struct test_fault *fault = test_fault_for_read(backend, lba, block_count);
    int corrupt_read = fault != NULL &&
        fault->kind == TEST_FAULT_CORRUPT_REQUEST;
    if (fault != NULL && !corrupt_read) {
        struct rip_dvd_scsi_completion completion = {
            .descriptor = -1,
            .requested_lba = lba,
            .requested_block_count = (uint32_t)block_count,
            .retry_ordinal = retry_ordinal,
        };
        if (fault->kind == TEST_FAULT_RAW_COMPLETION ||
            fault->kind == TEST_FAULT_RAW_TAIL_COMPLETION ||
            fault->kind == TEST_FAULT_RAW_REQUEST_COMPLETION) {
            completion.captured = 1;
            completion.command_completed = 1;
            completion.scsi_status = fault->scsi_status;
            completion.host_status = fault->host_status;
            completion.driver_status = fault->driver_status;
            completion.sense_reported_length = fault->sense_reported_length;
            completion.sense_length = fault->sense_length;
            memcpy(completion.sense, fault->sense, fault->sense_length);
            if (fault->kind == TEST_FAULT_RAW_TAIL_COMPLETION) {
                uint64_t information_lba = lba > fault->lba
                    ? lba : fault->lba;
                set_test_tail_information_lba(
                    &completion, information_lba);
            }
        }
        if (finish_test_read_attempt(backend, lba, block_count) != 0) {
            return (struct transport_read_result){
                .status = TRANSPORT_READ_FATAL,
            };
        }
        return (struct transport_read_result){
            .status = TRANSPORT_READ_FAILURE,
            .completion = completion,
        };
    }
    size_t length = (size_t)block_count * DVDCSS_BLOCK_SIZE;
    off_t offset = (off_t)(lba * DVDCSS_BLOCK_SIZE);
    if (lseek(backend->test_source_fd, offset, SEEK_SET) != offset) {
        fail_errno("DVD test source seek failed");
        return (struct transport_read_result){
            .status = TRANSPORT_READ_FATAL,
        };
    }
    rip_dvd_scsi_read_scope_begin(lba, (uint32_t)block_count, retry_ordinal);
    ssize_t bytes_read =
        rip_dvd_scsi_test_invoke_wrapped_read(
            backend->test_source_fd, buffer, length);
    struct rip_dvd_scsi_completion completion = { 0 };
    rip_dvd_scsi_read_scope_end(&completion);
    if (finish_test_read_attempt(backend, lba, block_count) != 0) {
        return (struct transport_read_result){
            .status = TRANSPORT_READ_FATAL,
        };
    }
    if (bytes_read < 0) {
        return (struct transport_read_result){
            .status = TRANSPORT_READ_FAILURE,
            .completion = completion,
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
    if (corrupt_read) {
        buffer[0] ^= 0xff;
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
    struct read_failure failure;
    enum backend_read_status status =
        classify_read_failure(&transport.completion, &failure);
    failure.status = status;
    return (struct backend_read_result){
        .status = status,
        .failure = failure,
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

static uint64_t boundary_retained_image_byte_count(
    const struct recovery_state *recovery, uint64_t bytes_processed)
{
    if (recovery == NULL || recovery->bad_sector_count == 0) {
        return bytes_processed;
    }
    for (size_t byte_index = 0;
         byte_index < recovery->bitmap_byte_count; byte_index++) {
        unsigned char byte = recovery->bad_sector_bitmap[byte_index];
        if (byte == 0) {
            continue;
        }
        for (unsigned int bit_index = 0; bit_index < 8; bit_index++) {
            if ((byte & (unsigned char)(1U << bit_index)) != 0) {
                uint64_t first_bad_lba =
                    (uint64_t)byte_index * 8 + bit_index;
                uint64_t first_bad_byte = first_bad_lba * DVDCSS_BLOCK_SIZE;
                return first_bad_byte < bytes_processed
                    ? first_bad_byte : bytes_processed;
            }
        }
    }
    return bytes_processed;
}

static void rollback_boundary_image(int output_fd,
                                    const struct recovery_state *recovery)
{
    if (!recovery->boundary_failure) {
        return;
    }
    if (ftruncate(
            output_fd,
            (off_t)recovery->boundary_retained_image_byte_count) != 0) {
        fail_errno("DVD boundary rescue rollback failed");
    }
}

static int read_all_at(int descriptor, unsigned char *buffer,
                       size_t length, off_t offset)
{
    size_t read_count = 0;
    while (read_count < length) {
        ssize_t result = pread(descriptor, buffer + read_count,
                               length - read_count,
                               offset + (off_t)read_count);
        if (result < 0) {
            if (errno == EINTR) {
                continue;
            }
            return fail_errno("DVD boundary retained sector read failed");
        }
        if (result == 0) {
            fprintf(stderr, "DVD boundary retained sector ended early\n");
            return 1;
        }
        read_count += (size_t)result;
    }
    return 0;
}

static int authorize_boundary_probe(void)
{
#ifdef RIP_DVD_READER_TESTING
    return 0;
#else
    static const char ready[] =
        "rip-dvd-boundary-probe-authorization-ready\n";
    size_t written = 0;
    while (written < sizeof(ready) - 1) {
        ssize_t result = write(6, ready + written,
                               sizeof(ready) - 1 - written);
        if (result < 0) {
            if (errno == EINTR) {
                continue;
            }
            return fail_errno(
                "DVD boundary probe authorization readiness failed");
        }
        if (result == 0) {
            fprintf(stderr,
                    "DVD boundary probe authorization readiness ended early\n");
            return 1;
        }
        written += (size_t)result;
    }
    char authorized = 0;
    ssize_t bytes_read;
    do {
        bytes_read = read(7, &authorized, 1);
    } while (bytes_read < 0 && errno == EINTR);
    if (bytes_read != 1 || authorized != '1') {
        fprintf(stderr, "DVD boundary probe authorization was denied\n");
        return 1;
    }
    return 0;
#endif
}

static struct backend_read_result boundary_probe_read(
    struct read_backend *backend, unsigned char *buffer, uint64_t lba,
    int block_count, uint32_t retry_ordinal)
{
    if (authorize_boundary_probe() != 0) {
        return (struct backend_read_result){
            .status = BACKEND_READ_FATAL,
        };
    }
    struct backend_read_result result = backend_read(
        backend, buffer, lba, block_count, 1, retry_ordinal);
    if (authorize_boundary_probe() != 0) {
        return (struct backend_read_result){
            .status = BACKEND_READ_FATAL,
        };
    }
    return result;
}

static int emit_unproven_boundary_failure(
    const struct read_failure *failure, struct recovery_state *recovery,
    uint64_t declared_byte_count, uint64_t bytes_processed)
{
    recovery->boundary_proven = 0;
    return emit_read_failure_result(
        failure, recovery, declared_byte_count,
        boundary_retained_image_byte_count(recovery, bytes_processed));
}

static int normalized_failure_evidence_matches(
    const struct read_failure *left, const struct read_failure *right)
{
    return left->category == right->category &&
        left->status == right->status &&
        left->completion.scsi_status == right->completion.scsi_status &&
        left->completion.host_status == right->completion.host_status &&
        left->completion.driver_status == right->completion.driver_status &&
        left->sense.response_code == right->sense.response_code &&
        left->sense.sense_key == right->sense.sense_key &&
        left->sense.asc == right->sense.asc &&
        left->sense.ascq == right->sense.ascq &&
        left->sense.information_lba == right->sense.information_lba;
}

static void record_boundary_medium_error(
    struct boundary_conflict_evidence *evidence,
    const struct read_failure *failure)
{
    if (!failure->sense.has_information_lba) {
        evidence->has_unlocated_medium_error = 1;
        return;
    }
    uint64_t lba = failure->sense.information_lba;
    for (size_t index = 0;
         index < evidence->medium_error_lba_count; index++) {
        if (evidence->medium_error_lbas[index] == lba) {
            return;
        }
    }
    if (evidence->medium_error_lba_count >= READ_BLOCKS) {
        evidence->has_unlocated_medium_error = 1;
        return;
    }
    evidence->medium_error_lbas[evidence->medium_error_lba_count] = lba;
    evidence->medium_error_lba_count += 1;
}

static int boundary_conflicts_with_medium_error(
    const struct boundary_conflict_evidence *evidence,
    const struct read_failure *boundary_failure)
{
    if (evidence->has_unlocated_medium_error ||
        !boundary_failure->sense.has_information_lba) {
        return 1;
    }
    for (size_t index = 0;
         index < evidence->medium_error_lba_count; index++) {
        if (evidence->medium_error_lbas[index] ==
            boundary_failure->sense.information_lba) {
            return 1;
        }
    }
    return 0;
}

static int prove_boundary_candidate(
    struct read_backend *backend, struct operation_state *state,
    struct recovery_state *recovery, unsigned char *buffer,
    const struct read_failure *initial_failure, uint64_t *bytes_processed,
    const uint64_t *unproven_bytes_processed, uint64_t declared_byte_count)
{
    const struct decoded_sense *initial_sense = &initial_failure->sense;
    const struct rip_dvd_scsi_completion *initial_completion =
        &initial_failure->completion;
    uint64_t total_sector_count =
        declared_byte_count / DVDCSS_BLOCK_SIZE;
    uint64_t candidate_lba = initial_sense->information_lba;
    uint64_t retained_lba = *bytes_processed / DVDCSS_BLOCK_SIZE;
    if (!recovery->allow_boundary_proof ||
        state->operation != OPERATION_COPY || state->output_fd < 0 ||
        candidate_lba == 0 || candidate_lba >= total_sector_count ||
        initial_completion->requested_lba != retained_lba ||
        candidate_lba < retained_lba ||
        candidate_lba - retained_lba >=
            initial_completion->requested_block_count) {
        return emit_unproven_boundary_failure(
            initial_failure, recovery, declared_byte_count,
            *unproven_bytes_processed);
    }

    while (retained_lba < candidate_lba) {
        uint64_t remaining = candidate_lba - retained_lba;
        int requested = remaining > READ_BLOCKS
            ? READ_BLOCKS : (int)remaining;
        struct backend_read_result prefix = boundary_probe_read(
            backend, buffer, retained_lba, requested, 0);
        if (prefix.status == BACKEND_READ_FATAL) {
            return 1;
        }
        if (prefix.status != BACKEND_READ_SUCCESS ||
            prefix.blocks_read <= 0 || prefix.blocks_read > requested) {
            return emit_unproven_boundary_failure(
                initial_failure, recovery, declared_byte_count,
                *unproven_bytes_processed);
        }
        if (consume_blocks(state, buffer, prefix.blocks_read,
                           bytes_processed) != 0) {
            return 1;
        }
        retained_lba += (uint64_t)prefix.blocks_read;
    }

    unsigned char retained_sector[DVDCSS_BLOCK_SIZE];
    if (read_all_at(
            state->output_fd, retained_sector, sizeof(retained_sector),
            (off_t)((candidate_lba - 1) * DVDCSS_BLOCK_SIZE)) != 0) {
        return 1;
    }
    struct backend_read_result preceding = boundary_probe_read(
        backend, buffer, candidate_lba - 1, 1, 0);
    if (preceding.status == BACKEND_READ_FATAL) {
        return 1;
    }
    if (preceding.status != BACKEND_READ_SUCCESS ||
        preceding.blocks_read != 1 ||
        memcmp(buffer, retained_sector, DVDCSS_BLOCK_SIZE) != 0) {
        return emit_unproven_boundary_failure(
            initial_failure, recovery, declared_byte_count,
            *unproven_bytes_processed);
    }

    struct backend_read_result confirmation = { 0 };
    for (uint32_t ordinal = 0;
         ordinal < BOUNDARY_CONFIRMATION_READS; ordinal++) {
        confirmation = boundary_probe_read(
            backend, buffer, candidate_lba, 1, ordinal);
        if (confirmation.status == BACKEND_READ_FATAL) {
            return 1;
        }
        if (confirmation.status != BACKEND_READ_OUT_OF_RANGE_ERROR ||
            !confirmation.failure.sense.has_information_lba ||
            confirmation.failure.sense.information_lba != candidate_lba) {
            return emit_unproven_boundary_failure(
                initial_failure, recovery, declared_byte_count,
                *unproven_bytes_processed);
        }
        if (!normalized_failure_evidence_matches(
                initial_failure, &confirmation.failure)) {
            return emit_unproven_boundary_failure(
                initial_failure, recovery, declared_byte_count,
                *unproven_bytes_processed);
        }
    }

    uint64_t upper_probe_lbas[2] = {
        candidate_lba + 1,
        total_sector_count - 1,
    };
    uint64_t previous_probe_lba = candidate_lba;
    for (size_t index = 0; index < 2; index++) {
        uint64_t probe_lba = upper_probe_lbas[index];
        if (probe_lba >= total_sector_count ||
            probe_lba == previous_probe_lba) {
            continue;
        }
        struct backend_read_result upper = boundary_probe_read(
            backend, buffer, probe_lba, 1, 0);
        if (upper.status == BACKEND_READ_FATAL) {
            return 1;
        }
        if (upper.status != BACKEND_READ_OUT_OF_RANGE_ERROR ||
            !upper.failure.sense.has_information_lba ||
            upper.failure.sense.information_lba != probe_lba) {
            return emit_unproven_boundary_failure(
                initial_failure, recovery, declared_byte_count,
                *unproven_bytes_processed);
        }
        previous_probe_lba = probe_lba;
    }

    recovery->boundary_proven = 1;
    return emit_read_failure_result(
        &confirmation.failure, recovery, declared_byte_count,
        candidate_lba * DVDCSS_BLOCK_SIZE);
}

static int recover_range(struct read_backend *backend,
                         struct operation_state *state,
                         struct recovery_state *recovery,
                         struct boundary_conflict_evidence *conflict_evidence,
                         unsigned char *buffer, uint64_t start_lba,
                         int block_count, uint64_t *bytes_processed,
                         uint32_t first_retry_ordinal,
                         uint64_t declared_byte_count)
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
        if (result.status == BACKEND_READ_MEDIUM_ERROR) {
            record_boundary_medium_error(conflict_evidence, &result.failure);
            continue;
        }
        if (backend_read_has_terminal_failure_result(result.status)) {
            if (result.status == BACKEND_READ_OUT_OF_RANGE_ERROR) {
                uint64_t unproven_bytes_processed = *bytes_processed;
                if (boundary_conflicts_with_medium_error(
                        conflict_evidence, &result.failure)) {
                    return emit_unproven_boundary_failure(
                        &result.failure, recovery, declared_byte_count,
                        unproven_bytes_processed);
                }
                return prove_boundary_candidate(
                    backend, state, recovery, buffer, &result.failure,
                    bytes_processed, &unproven_bytes_processed,
                    declared_byte_count);
            }
            return emit_read_failure_result(
                &result.failure, recovery, declared_byte_count,
                boundary_retained_image_byte_count(
                    recovery, *bytes_processed));
        }
        if (consume_blocks(state, buffer, result.blocks_read,
                           bytes_processed) != 0) {
            return 1;
        }
        if (result.blocks_read == block_count) {
            return 0;
        }
        return recover_range(backend, state, recovery, conflict_evidence,
                             buffer,
                             start_lba + (uint64_t)result.blocks_read,
                             block_count - result.blocks_read,
                             bytes_processed, 0, declared_byte_count);
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
    int left_status = recover_range(
        backend, state, recovery, conflict_evidence, buffer,
        start_lba, left_block_count, bytes_processed, 0,
        declared_byte_count);
    if (left_status != 0) {
        return left_status;
    }
    return recover_range(backend, state, recovery, conflict_evidence, buffer,
                         start_lba + (uint64_t)left_block_count,
                         block_count - left_block_count, bytes_processed, 0,
                         declared_byte_count);
}

static int read_disc(struct read_backend *backend, uint64_t size_bytes,
                     struct operation_state *state,
                     struct recovery_state *recovery,
                     uint64_t initial_byte_count)
{
    void *allocation = NULL;
    if (posix_memalign(&allocation, DVDCSS_BLOCK_SIZE,
                       READ_BLOCKS * DVDCSS_BLOCK_SIZE) != 0) {
        fprintf(stderr, "DVD read buffer allocation failed\n");
        return 1;
    }
    unsigned char *buffer = allocation;
    uint64_t blocks_remaining =
        (size_bytes - initial_byte_count) / DVDCSS_BLOCK_SIZE;
    uint64_t bytes_processed = initial_byte_count;
    int require_absolute_read = initial_byte_count > 0;
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
        if (result.status == BACKEND_READ_MEDIUM_ERROR) {
            if (recovery == NULL) {
                status = fail_dvdcss_read(backend->dvdcss, bytes_processed);
                break;
            }
            struct boundary_conflict_evidence conflict_evidence = { 0 };
            record_boundary_medium_error(
                &conflict_evidence, &result.failure);
            int recovery_status = recover_range(
                backend, state, recovery, &conflict_evidence, buffer,
                start_lba, requested,
                &bytes_processed, 1, size_bytes);
            if (recovery_status != 0) {
                status = recovery_status;
                break;
            }
            blocks_remaining -= (uint64_t)requested;
            require_absolute_read = blocks_remaining > 0;
            continue;
        }
        if (backend_read_has_terminal_failure_result(result.status)) {
            status = result.status == BACKEND_READ_OUT_OF_RANGE_ERROR &&
                    recovery != NULL
                ? prove_boundary_candidate(
                    backend, state, recovery, buffer, &result.failure,
                    &bytes_processed, &bytes_processed, size_bytes)
                : emit_read_failure_result(
                    &result.failure, recovery, size_bytes,
                    boundary_retained_image_byte_count(
                        recovery, bytes_processed));
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
    int status = read_disc(backend, size_bytes, &state, NULL, 0);
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
                         O_RDWR | O_CREAT | O_EXCL | O_NOFOLLOW | O_CLOEXEC,
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
        .allow_boundary_proof = 1,
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
    int status = read_disc(backend, size_bytes, &state, &recovery, 0);
    rollback_boundary_image(output_fd, &recovery);
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
        .allow_boundary_proof = 1,
        .include_boundary_recovery_snapshot = 1,
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
        struct boundary_conflict_evidence conflict_evidence = { 0 };
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
            if (result.status == BACKEND_READ_MEDIUM_ERROR) {
                record_boundary_medium_error(
                    &conflict_evidence, &result.failure);
                continue;
            }
            if (backend_read_has_terminal_failure_result(result.status)) {
                uint64_t boundary_byte_count = lba * DVDCSS_BLOCK_SIZE;
                uint64_t unproven_byte_count = size_bytes;
                if (result.status == BACKEND_READ_OUT_OF_RANGE_ERROR &&
                    boundary_conflicts_with_medium_error(
                        &conflict_evidence, &result.failure)) {
                    status = emit_unproven_boundary_failure(
                        &result.failure, &recovery, size_bytes,
                        unproven_byte_count);
                } else if (
                    result.status == BACKEND_READ_OUT_OF_RANGE_ERROR) {
                    status = prove_boundary_candidate(
                        backend, &state, &recovery, buffer,
                        &result.failure, &boundary_byte_count,
                        &unproven_byte_count,
                        size_bytes);
                } else {
                    status = emit_read_failure_result(
                        &result.failure, &recovery, size_bytes, size_bytes);
                }
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

static int run_boundary_resume(
    struct read_backend *backend, const char *output_path,
    uint64_t size_bytes, uint64_t image_byte_count,
    const char *expected_filesystem_identity,
    enum test_result_mode test_result_mode)
{
    uintmax_t expected_device = 0;
    uintmax_t expected_inode = 0;
    if (image_byte_count >= size_bytes ||
        image_byte_count % DVDCSS_BLOCK_SIZE != 0 ||
        parse_filesystem_identity(expected_filesystem_identity,
                                  &expected_device, &expected_inode) != 0) {
        return 1;
    }
    int output_fd = open(output_path, O_RDWR | O_NOFOLLOW | O_CLOEXEC);
    if (output_fd < 0) {
        return fail_errno("DVD boundary rescue image open failed");
    }
    struct stat output;
    if (fstat(output_fd, &output) != 0 || !S_ISREG(output.st_mode) ||
        output.st_size < 0 ||
        (uint64_t)output.st_size < image_byte_count ||
        (uint64_t)output.st_size > size_bytes ||
        (uint64_t)output.st_size % DVDCSS_BLOCK_SIZE != 0 ||
        (uintmax_t)output.st_dev != expected_device ||
        (uintmax_t)output.st_ino != expected_inode) {
        close(output_fd);
        fprintf(stderr,
                "DVD boundary rescue image does not match its recovery map\n");
        return 1;
    }
    if ((uint64_t)output.st_size != image_byte_count &&
        (ftruncate(output_fd, (off_t)image_byte_count) != 0 ||
         fsync(output_fd) != 0)) {
        close(output_fd);
        return fail_errno("DVD boundary rescue rollback failed");
    }
    if (lseek(output_fd, (off_t)image_byte_count, SEEK_SET) < 0) {
        close(output_fd);
        return fail_errno("DVD boundary rescue seek failed");
    }
    uint64_t total_sector_count = size_bytes / DVDCSS_BLOCK_SIZE;
    size_t bitmap_byte_count = (size_t)((total_sector_count + 7) / 8);
    unsigned char *bad_sector_bitmap = calloc(bitmap_byte_count, 1);
    if (bad_sector_bitmap == NULL) {
        close(output_fd);
        fprintf(stderr, "DVD boundary rescue map allocation failed\n");
        return 1;
    }
    struct recovery_state recovery = {
        .bad_sector_bitmap = bad_sector_bitmap,
        .bitmap_byte_count = bitmap_byte_count,
        .allow_boundary_proof = 1,
        .emit_malformed_result =
            test_result_mode == TEST_RESULT_MALFORMED_RECOVERY,
        .interrupt_read_failure_result =
            test_result_mode == TEST_RESULT_INTERRUPTED_READ_FAILURE,
    };
    struct operation_state state = {
        .operation = OPERATION_COPY,
        .output_fd = output_fd,
        .last_progress_bytes = image_byte_count,
    };
    int status = read_disc(
        backend, size_bytes, &state, &recovery, image_byte_count);
    rollback_boundary_image(output_fd, &recovery);
    if (status == 0 && fsync(output_fd) != 0) {
        status = fail_errno("DVD boundary rescue image sync failed");
    }
    if (close(output_fd) != 0 && status == 0) {
        status = fail_errno("DVD boundary rescue image close failed");
    }
    if (status == 0) {
        status = emit_recovery_result(size_bytes, &recovery);
    }
    free(bad_sector_bitmap);
    return status;
}

enum authorized_resume_mode {
    AUTHORIZED_RESUME_NONE,
    AUTHORIZED_RESUME_DAMAGE,
    AUTHORIZED_RESUME_BOUNDARY,
};

static int await_copy_authorization(uint64_t size_bytes,
                                    enum authorized_resume_mode resume_mode,
                                    unsigned char **resume_bitmap,
                                    uint64_t *resume_bad_sector_count,
                                    uint64_t *boundary_image_byte_count)
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
    if (resume_mode == AUTHORIZED_RESUME_NONE) {
        return 0;
    }
    if (resume_mode == AUTHORIZED_RESUME_BOUNDARY) {
        char text[32];
        size_t received = 0;
        while (received < sizeof(text) - 1) {
            do {
                bytes_read = read(5, text + received,
                                  sizeof(text) - 1 - received);
            } while (bytes_read < 0 && errno == EINTR);
            if (bytes_read < 0) {
                return fail_errno(
                    "DVD boundary rescue authorization failed");
            }
            if (bytes_read == 0) {
                break;
            }
            received += (size_t)bytes_read;
        }
        char extra;
        do {
            bytes_read = read(5, &extra, 1);
        } while (bytes_read < 0 && errno == EINTR);
        text[received] = '\0';
        char *end = NULL;
        errno = 0;
        unsigned long long parsed = strtoull(text, &end, 10);
        if (received == 0 || bytes_read != 0 || errno != 0 || end == text ||
            *end != '\0' || parsed >= size_bytes ||
            parsed % DVDCSS_BLOCK_SIZE != 0) {
            fprintf(stderr,
                    "DVD boundary rescue authorization is invalid\n");
            return 1;
        }
        *boundary_image_byte_count = (uint64_t)parsed;
        return 0;
    }
    uint64_t total_sector_count = size_bytes / DVDCSS_BLOCK_SIZE;
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
    int simple_fault = part_count > 0 &&
        (strcmp(parts[0], "generic") == 0 ||
         strcmp(parts[0], "corrupt-request") == 0);
    size_t expected_parts = simple_fault ? 3 : 8;
    if (part_count != expected_parts ||
        (strcmp(parts[0], "raw") != 0 &&
         strcmp(parts[0], "raw-tail") != 0 &&
         strcmp(parts[0], "raw-request") != 0 &&
         strcmp(parts[0], "corrupt-request") != 0 &&
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
    if (strcmp(parts[0], "corrupt-request") == 0) {
        fault->kind = TEST_FAULT_CORRUPT_REQUEST;
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
    if (strcmp(parts[0], "raw-tail") == 0) {
        fault->kind = TEST_FAULT_RAW_TAIL_COMPLETION;
    } else if (strcmp(parts[0], "raw-request") == 0) {
        fault->kind = TEST_FAULT_RAW_REQUEST_COMPLETION;
    } else {
        fault->kind = TEST_FAULT_RAW_COMPLETION;
    }
    fault->scsi_status = (uint8_t)scsi_status;
    fault->host_status = (uint16_t)host_status;
    fault->driver_status = (uint16_t)driver_status;
    fault->sense_reported_length = (size_t)sense_reported_length;
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
        int parse_status =
            parse_exact_test_fault(entry, total_sector_count, &fault);
        if (parse_status != 0) {
            fprintf(stderr, "DVD test fault is invalid\n");
            return 1;
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
    int wait_for_cancellation = 0;
    int fail_wrapped_content_read = 0;
    if (strcmp(result_mode, "valid") == 0) {
        *test_result_mode = TEST_RESULT_VALID;
    } else if (strcmp(result_mode, "cancellation") == 0) {
        *test_result_mode = TEST_RESULT_VALID;
        wait_for_cancellation = 1;
    } else if (strcmp(result_mode, "wrapped-medium-error") == 0) {
        *test_result_mode = TEST_RESULT_VALID;
        fail_wrapped_content_read = 1;
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
        .test_wait_for_cancellation = wait_for_cancellation,
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
    rip_dvd_scsi_test_adapter_begin();
    if (fail_wrapped_content_read) {
        rip_dvd_scsi_test_adapter_fail_content_read(1);
    }
    return 0;
}

static int emit_test_scsi_session_result(void)
{
    struct rip_dvd_scsi_test_metrics metrics;
    rip_dvd_scsi_test_adapter_snapshot(&metrics);
    fprintf(stderr,
            "rip-dvd-scsi-session-result "
            "{\"discoveryCount\":%" PRIu32
            ",\"openCount\":%" PRIu32
            ",\"closeCount\":%" PRIu32
            ",\"contentReadCount\":%" PRIu32
            ",\"requestSenseCount\":%" PRIu32
            ",\"diagnosticCommandCount\":%" PRIu32
            ",\"requests\":[",
            metrics.discovery_count, metrics.open_count, metrics.close_count,
            metrics.content_read_count, metrics.request_sense_count,
            metrics.diagnostic_command_count);
    for (size_t index = 0; index < metrics.request_count; index++) {
        fprintf(stderr,
                "%s{\"lba\":%" PRIu64 ",\"blocks\":%" PRIu32 "}",
                index == 0 ? "" : ",", metrics.requests[index].lba,
                metrics.requests[index].block_count);
    }
    fprintf(stderr, "]}\n");
    return ferror(stderr) == 0 ? 0 :
        fail_errno("DVD test SCSI session output failed");
}

static int close_test_backend(struct read_backend *backend, int status)
{
    if (backend->test_source_fd >= 0 &&
        close(backend->test_source_fd) != 0 && status == 0) {
        status = fail_errno("DVD test source close failed");
    }
    backend->test_source_fd = -1;
    if (emit_test_scsi_session_result() != 0 && status == 0) {
        status = 1;
    }
    return status;
}

static int open_scsi_test_source(const char *path)
{
    int descriptor = open(path, O_RDONLY | O_NOFOLLOW | O_CLOEXEC);
    if (descriptor < 0) {
        fail_errno("DVD SCSI test source open failed");
        return -1;
    }
    struct stat identity;
    if (fstat(descriptor, &identity) != 0 || !S_ISREG(identity.st_mode)) {
        close(descriptor);
        fprintf(stderr, "DVD SCSI test source is invalid\n");
        return -1;
    }
    return descriptor;
}

static int run_scsi_test_read(int descriptor, int expect_failure)
{
    unsigned char buffer[READ_BLOCKS * DVDCSS_BLOCK_SIZE];
    if (lseek(descriptor, 0, SEEK_SET) != 0) {
        return fail_errno("DVD SCSI test source seek failed");
    }
    rip_dvd_scsi_read_scope_begin(0, READ_BLOCKS, 0);
    ssize_t result = rip_dvd_scsi_test_invoke_wrapped_read(
        descriptor, buffer, sizeof(buffer));
    struct rip_dvd_scsi_completion completion = { 0 };
    rip_dvd_scsi_read_scope_end(&completion);
    if (!expect_failure) {
        return result == (ssize_t)sizeof(buffer) ? 0 : 1;
    }
    return result < 0 && completion.captured &&
        completion.command_completed && completion.descriptor == descriptor &&
        completion.requested_lba == 0 &&
        completion.requested_block_count == READ_BLOCKS &&
        completion.retry_ordinal == 0 && completion.sense_length == 18
            ? 0
            : 1;
}

struct concurrent_scsi_gate {
    pthread_mutex_t mutex;
    pthread_cond_t condition;
    int ready_count;
    int started;
};

struct concurrent_scsi_read {
    int descriptor;
    uint32_t retry_ordinal;
    struct concurrent_scsi_gate *gate;
    int status;
};

static void *run_concurrent_scsi_test_read(void *argument)
{
    struct concurrent_scsi_read *read = argument;
    unsigned char buffer[READ_BLOCKS * DVDCSS_BLOCK_SIZE];
    rip_dvd_scsi_read_scope_begin(0, READ_BLOCKS, read->retry_ordinal);
    pthread_mutex_lock(&read->gate->mutex);
    read->gate->ready_count += 1;
    pthread_cond_broadcast(&read->gate->condition);
    while (!read->gate->started) {
        pthread_cond_wait(&read->gate->condition, &read->gate->mutex);
    }
    pthread_mutex_unlock(&read->gate->mutex);

    ssize_t result = rip_dvd_scsi_test_invoke_wrapped_read(
        read->descriptor, buffer, sizeof(buffer));
    struct rip_dvd_scsi_completion completion = { 0 };
    rip_dvd_scsi_read_scope_end(&completion);
    read->status = result == (ssize_t)sizeof(buffer) && completion.captured &&
        completion.command_completed &&
        completion.descriptor == read->descriptor &&
        completion.requested_lba == 0 &&
        completion.requested_block_count == READ_BLOCKS &&
        completion.retry_ordinal == read->retry_ordinal
            ? 0
            : 1;
    return NULL;
}

static int run_concurrent_scsi_test_reads(
    int first_descriptor, int second_descriptor)
{
    struct concurrent_scsi_gate gate;
    int error = pthread_mutex_init(&gate.mutex, NULL);
    if (error != 0) {
        errno = error;
        return fail_errno("DVD concurrent SCSI test mutex setup failed");
    }
    error = pthread_cond_init(&gate.condition, NULL);
    if (error != 0) {
        pthread_mutex_destroy(&gate.mutex);
        errno = error;
        return fail_errno("DVD concurrent SCSI test gate setup failed");
    }
    gate.ready_count = 0;
    gate.started = 0;
    struct concurrent_scsi_read reads[2] = {
        { .descriptor = first_descriptor, .retry_ordinal = 3, .gate = &gate },
        { .descriptor = second_descriptor, .retry_ordinal = 7, .gate = &gate },
    };
    pthread_t threads[2];
    size_t created_count = 0;
    for (; created_count < 2; created_count++) {
        error = pthread_create(
            &threads[created_count], NULL, run_concurrent_scsi_test_read,
            &reads[created_count]);
        if (error != 0) {
            break;
        }
    }
    pthread_mutex_lock(&gate.mutex);
    while (created_count == 2 && gate.ready_count < 2) {
        pthread_cond_wait(&gate.condition, &gate.mutex);
    }
    gate.started = 1;
    pthread_cond_broadcast(&gate.condition);
    pthread_mutex_unlock(&gate.mutex);

    int status = error == 0 ? 0 : 1;
    for (size_t index = 0; index < created_count; index++) {
        int join_error = pthread_join(threads[index], NULL);
        if (join_error != 0 || reads[index].status != 0) {
            status = 1;
        }
    }
    pthread_cond_destroy(&gate.condition);
    pthread_mutex_destroy(&gate.mutex);
    if (error != 0) {
        errno = error;
        return fail_errno("DVD concurrent SCSI test thread setup failed");
    }
    return status;
}

enum scsi_test_scenario {
    SCSI_TEST_SCENARIO_INVALID,
    SCSI_TEST_SCENARIO_SOURCE_CHANGE,
    SCSI_TEST_SCENARIO_DRIVE_IDENTITY_CHANGE,
    SCSI_TEST_SCENARIO_SG_IDENTITY_CHANGE,
    SCSI_TEST_SCENARIO_IDENTITY_CHECK_FAILURE,
    SCSI_TEST_SCENARIO_CONCURRENT_SOURCES,
    SCSI_TEST_SCENARIO_DESCRIPTOR_REUSE,
    SCSI_TEST_SCENARIO_DISCOVERY_FAILURE,
    SCSI_TEST_SCENARIO_OPEN_FAILURE,
    SCSI_TEST_SCENARIO_READ_FAILURE,
    SCSI_TEST_SCENARIO_NORMAL_EXIT,
};

static enum scsi_test_scenario parse_scsi_test_scenario(const char *value)
{
    if (strcmp(value, "source-change") == 0) {
        return SCSI_TEST_SCENARIO_SOURCE_CHANGE;
    }
    if (strcmp(value, "drive-identity-change") == 0) {
        return SCSI_TEST_SCENARIO_DRIVE_IDENTITY_CHANGE;
    }
    if (strcmp(value, "sg-identity-change") == 0) {
        return SCSI_TEST_SCENARIO_SG_IDENTITY_CHANGE;
    }
    if (strcmp(value, "identity-check-failure") == 0) {
        return SCSI_TEST_SCENARIO_IDENTITY_CHECK_FAILURE;
    }
    if (strcmp(value, "concurrent-sources") == 0) {
        return SCSI_TEST_SCENARIO_CONCURRENT_SOURCES;
    }
    if (strcmp(value, "descriptor-reuse") == 0) {
        return SCSI_TEST_SCENARIO_DESCRIPTOR_REUSE;
    }
    if (strcmp(value, "discovery-failure") == 0) {
        return SCSI_TEST_SCENARIO_DISCOVERY_FAILURE;
    }
    if (strcmp(value, "open-failure") == 0) {
        return SCSI_TEST_SCENARIO_OPEN_FAILURE;
    }
    if (strcmp(value, "read-failure") == 0) {
        return SCSI_TEST_SCENARIO_READ_FAILURE;
    }
    if (strcmp(value, "normal-exit") == 0) {
        return SCSI_TEST_SCENARIO_NORMAL_EXIT;
    }
    return SCSI_TEST_SCENARIO_INVALID;
}

static int run_test_scsi_session(int argc, char **argv)
{
    enum scsi_test_scenario scenario = argc == 5
        ? parse_scsi_test_scenario(argv[2])
        : SCSI_TEST_SCENARIO_INVALID;
    if (scenario == SCSI_TEST_SCENARIO_INVALID) {
        fprintf(stderr,
                "usage: %s scsi-session-test "
                "source-change|drive-identity-change|"
                "sg-identity-change|identity-check-failure|"
                "concurrent-sources|"
                "descriptor-reuse|discovery-failure|"
                "open-failure|read-failure|normal-exit SOURCE REPLACEMENT\n",
                argv[0]);
        return 2;
    }
    int first_descriptor = open_scsi_test_source(argv[3]);
    int second_descriptor = -1;
    if (first_descriptor < 0) {
        return 1;
    }
    if (scenario == SCSI_TEST_SCENARIO_SOURCE_CHANGE ||
        scenario == SCSI_TEST_SCENARIO_CONCURRENT_SOURCES ||
        scenario == SCSI_TEST_SCENARIO_DESCRIPTOR_REUSE) {
        second_descriptor = open_scsi_test_source(argv[4]);
        if (second_descriptor < 0) {
            close(first_descriptor);
            return 1;
        }
    }

    rip_dvd_scsi_test_adapter_begin();
    int expect_failure = scenario == SCSI_TEST_SCENARIO_READ_FAILURE;
    if (expect_failure) {
        rip_dvd_scsi_test_adapter_fail_content_read(1);
    } else if (scenario == SCSI_TEST_SCENARIO_DISCOVERY_FAILURE) {
        rip_dvd_scsi_test_adapter_fail_discovery();
    } else if (scenario == SCSI_TEST_SCENARIO_OPEN_FAILURE) {
        rip_dvd_scsi_test_adapter_fail_open();
    } else if (scenario == SCSI_TEST_SCENARIO_IDENTITY_CHECK_FAILURE) {
        rip_dvd_scsi_test_adapter_fail_source_identity_check(2);
    }
    int status = scenario == SCSI_TEST_SCENARIO_CONCURRENT_SOURCES
        ? run_concurrent_scsi_test_reads(first_descriptor, second_descriptor)
        : run_scsi_test_read(first_descriptor, expect_failure);

    if (status == 0 &&
        (scenario == SCSI_TEST_SCENARIO_DISCOVERY_FAILURE ||
         scenario == SCSI_TEST_SCENARIO_OPEN_FAILURE)) {
        status = run_scsi_test_read(first_descriptor, 0);
    }

    if (status == 0 && scenario == SCSI_TEST_SCENARIO_SOURCE_CHANGE) {
        status = run_scsi_test_read(second_descriptor, 0);
        if (status == 0) {
            status = run_scsi_test_read(first_descriptor, 0);
        }
    } else if (status == 0 &&
               scenario == SCSI_TEST_SCENARIO_DRIVE_IDENTITY_CHANGE) {
        rip_dvd_scsi_test_adapter_change_drive_identity();
        status = run_scsi_test_read(first_descriptor, 0);
    } else if (status == 0 &&
               scenario == SCSI_TEST_SCENARIO_SG_IDENTITY_CHANGE) {
        rip_dvd_scsi_test_adapter_change_sg_drive_identity();
        status = run_scsi_test_read(first_descriptor, 0);
        if (status == 0) {
            status = run_scsi_test_read(first_descriptor, 0);
        }
    } else if (status == 0 &&
               scenario == SCSI_TEST_SCENARIO_IDENTITY_CHECK_FAILURE) {
        status = run_scsi_test_read(first_descriptor, 0);
        if (status == 0) {
            status = run_scsi_test_read(first_descriptor, 0);
        }
    } else if (status == 0 &&
               scenario == SCSI_TEST_SCENARIO_DESCRIPTOR_REUSE) {
        int reused_descriptor = first_descriptor;
        if (rip_dvd_scsi_test_abandon_source_descriptor(first_descriptor) != 0) {
            status = fail_errno("DVD SCSI test source abandon failed");
        }
        first_descriptor = -1;
        if (status == 0 && second_descriptor != reused_descriptor) {
            if (dup2(second_descriptor, reused_descriptor) < 0) {
                status = fail_errno("DVD SCSI test descriptor reuse failed");
            } else {
                close(second_descriptor);
                second_descriptor = reused_descriptor;
            }
        }
        if (status == 0) {
            status = run_scsi_test_read(second_descriptor, 0);
        }
    }

    if (status == 0 && scenario == SCSI_TEST_SCENARIO_NORMAL_EXIT) {
        rip_dvd_scsi_test_adapter_report_cleanup_at_exit();
        first_descriptor = -1;
        return 0;
    }

    if (first_descriptor >= 0 && close(first_descriptor) != 0 && status == 0) {
        status = fail_errno("DVD SCSI test source close failed");
    }
    if (second_descriptor >= 0 && close(second_descriptor) != 0 && status == 0) {
        status = fail_errno("DVD SCSI test replacement close failed");
    }
    if (emit_test_scsi_session_result() != 0 && status == 0) {
        status = 1;
    }
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

static int run_test_boundary_resume(int argc, char **argv)
{
    if (argc != 10) {
        fprintf(stderr,
                "usage: %s resume-boundary-test SOURCE OUTPUT SIZE FAULTS DELAY MODE IMAGE_BYTES IDENTITY\n",
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
    uint64_t image_byte_count = 0;
    if (parse_test_integer(argv[8], size_bytes - 1, &image_byte_count) != 0 ||
        image_byte_count % DVDCSS_BLOCK_SIZE != 0) {
        return close_test_backend(&backend, 2);
    }
    int status = run_boundary_resume(
        &backend, argv[3], size_bytes, image_byte_count, argv[9],
        test_result_mode);
    return close_test_backend(&backend, status);
}
#endif

int main(int argc, char **argv)
{
#ifdef RIP_DVD_READER_TESTING
    if (argc > 1 && strcmp(argv[1], "scsi-session-test") == 0) {
        return run_test_scsi_session(argc, argv);
    }
    if (argc > 1 && strcmp(argv[1], "copy-test") == 0) {
        return run_test_copy(argc, argv);
    }
    if (argc > 1 && strcmp(argv[1], "resume-test") == 0) {
        return run_test_resume(argc, argv);
    }
    if (argc > 1 && strcmp(argv[1], "resume-boundary-test") == 0) {
        return run_test_boundary_resume(argc, argv);
    }
#endif
    int authorized_copy = argc > 1 &&
        strcmp(argv[1], "copy-authorized") == 0;
    int authorized_resume = argc > 1 &&
        strcmp(argv[1], "resume-authorized") == 0;
    int authorized_boundary_resume = argc > 1 &&
        strcmp(argv[1], "resume-boundary-authorized") == 0;
    if (argc < 4 || (strcmp(argv[1], "hash") != 0 &&
                     strcmp(argv[1], "copy") != 0 && !authorized_copy &&
                     !authorized_resume && !authorized_boundary_resume)) {
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
         argc != ((authorized_resume || authorized_boundary_resume) ? 6 : 5))) {
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
    uint64_t boundary_image_byte_count = 0;
    enum authorized_resume_mode resume_mode =
        authorized_resume
            ? AUTHORIZED_RESUME_DAMAGE
            : authorized_boundary_resume
                ? AUTHORIZED_RESUME_BOUNDARY
                : AUTHORIZED_RESUME_NONE;
    if ((authorized_copy || authorized_resume || authorized_boundary_resume) &&
        await_copy_authorization(size_bytes, resume_mode, &resume_bitmap,
                                 &resume_bad_sector_count,
                                 &boundary_image_byte_count) != 0) {
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
    } else if (authorized_boundary_resume) {
        status = run_boundary_resume(
            &backend, argv[3], size_bytes, boundary_image_byte_count,
            argv[5], TEST_RESULT_VALID);
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
