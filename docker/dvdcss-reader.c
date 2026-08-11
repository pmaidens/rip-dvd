/* SPDX-License-Identifier: GPL-2.0-only */

#define _POSIX_C_SOURCE 200809L

#include <dvdcss/dvdcss.h>
#include <openssl/evp.h>

#include <errno.h>
#include <fcntl.h>
#include <inttypes.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/stat.h>
#include <unistd.h>

/* Some USB optical bridges reject larger READ(10) transfer lengths. */
#define READ_BLOCKS 16
#define MAX_DVD_CONTENT_BYTES UINT64_C(9000000000)

enum operation {
    OPERATION_HASH,
    OPERATION_COPY,
};

struct operation_state {
    enum operation operation;
    EVP_MD_CTX *hash;
    int output_fd;
};

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

static int consume(struct operation_state *state, const unsigned char *buffer,
                   size_t length, uint64_t bytes_read)
{
    if (state->operation == OPERATION_HASH) {
        if (EVP_DigestUpdate(state->hash, buffer, length) != 1) {
            fprintf(stderr, "DVD content hash update failed\n");
            return 1;
        }
        return 0;
    }
    if (write_all(state->output_fd, buffer, length) != 0) {
        return 1;
    }
    fprintf(stderr, "%" PRIu64 " bytes copied\n", bytes_read);
    return 0;
}

static int read_disc(dvdcss_t dvdcss, uint64_t size_bytes,
                     struct operation_state *state)
{
    void *allocation = NULL;
    if (posix_memalign(&allocation, DVDCSS_BLOCK_SIZE,
                       READ_BLOCKS * DVDCSS_BLOCK_SIZE) != 0) {
        fprintf(stderr, "DVD read buffer allocation failed\n");
        return 1;
    }
    unsigned char *buffer = allocation;
    uint64_t blocks_remaining = size_bytes / DVDCSS_BLOCK_SIZE;
    uint64_t bytes_read = 0;
    int status = 0;
    while (blocks_remaining > 0) {
        int requested = blocks_remaining > READ_BLOCKS
                            ? READ_BLOCKS
                            : (int)blocks_remaining;
        int result = dvdcss_read(dvdcss, buffer, requested, DVDCSS_NOFLAGS);
        if (result < 0) {
            status = fail_dvdcss_read(dvdcss, bytes_read);
            break;
        }
        if (result == 0) {
            fprintf(stderr, "DVD content read ended before the declared media size\n");
            status = 1;
            break;
        }
        size_t byte_count = (size_t)result * DVDCSS_BLOCK_SIZE;
        bytes_read += byte_count;
        if (consume(state, buffer, byte_count, bytes_read) != 0) {
            status = 1;
            break;
        }
        blocks_remaining -= (uint64_t)result;
    }
    free(allocation);
    return status;
}

static int run_hash(dvdcss_t dvdcss, uint64_t size_bytes)
{
    EVP_MD_CTX *hash = EVP_MD_CTX_new();
    if (hash == NULL || EVP_DigestInit_ex(hash, EVP_sha256(), NULL) != 1) {
        EVP_MD_CTX_free(hash);
        fprintf(stderr, "DVD content hash initialization failed\n");
        return 1;
    }
    char size_text[32];
    int size_length = snprintf(size_text, sizeof(size_text), "%" PRIu64, size_bytes);
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
    };
    int status = read_disc(dvdcss, size_bytes, &state);
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
    return fflush(stdout) == 0 ? 0 : fail_errno("DVD content hash output failed");
}

static int run_copy(dvdcss_t dvdcss, const char *output_path,
                    uint64_t size_bytes)
{
    int output_fd = open(output_path,
                         O_WRONLY | O_CREAT | O_EXCL | O_NOFOLLOW | O_CLOEXEC,
                         S_IRUSR | S_IWUSR | S_IRGRP | S_IROTH);
    if (output_fd < 0) {
        return fail_errno("DVD archive output open failed");
    }
    struct operation_state state = {
        .operation = OPERATION_COPY,
        .hash = NULL,
        .output_fd = output_fd,
    };
    int status = read_disc(dvdcss, size_bytes, &state);
    if (status == 0 && fsync(output_fd) != 0) {
        status = fail_errno("DVD archive sync failed");
    }
    if (close(output_fd) != 0 && status == 0) {
        status = fail_errno("DVD archive close failed");
    }
    return status;
}

int main(int argc, char **argv)
{
    if (argc < 4 || (strcmp(argv[1], "hash") != 0 && strcmp(argv[1], "copy") != 0)) {
        fprintf(stderr, "usage: %s hash DEVICE SIZE | copy DEVICE OUTPUT SIZE\n", argv[0]);
        return 2;
    }
    enum operation operation = strcmp(argv[1], "hash") == 0
                                   ? OPERATION_HASH
                                   : OPERATION_COPY;
    if ((operation == OPERATION_HASH && argc != 4) ||
        (operation == OPERATION_COPY && argc != 5)) {
        fprintf(stderr, "DVD reader arguments are invalid\n");
        return 2;
    }
    uint64_t size_bytes = 0;
    if (parse_size(argv[operation == OPERATION_HASH ? 3 : 4], &size_bytes) != 0) {
        return 2;
    }
    dvdcss_t dvdcss = dvdcss_open(argv[2]);
    if (dvdcss == NULL) {
        fprintf(stderr, "DVD content open failed\n");
        return 1;
    }
    int status = operation == OPERATION_HASH
                     ? run_hash(dvdcss, size_bytes)
                     : run_copy(dvdcss, argv[3], size_bytes);
    if (dvdcss_close(dvdcss) != 0 && status == 0) {
        fprintf(stderr, "DVD content close failed\n");
        status = 1;
    }
    return status;
}
