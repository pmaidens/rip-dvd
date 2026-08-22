/* SPDX-License-Identifier: GPL-2.0-or-later */

#ifndef RIP_DVD_LIBDVDCSS_SG_IO_H
#define RIP_DVD_LIBDVDCSS_SG_IO_H

#include <stddef.h>
#include <stdint.h>
#include <sys/types.h>

#define RIP_DVD_SCSI_MAX_SENSE_BYTES 252

#ifdef RIP_DVD_READER_TESTING
#define RIP_DVD_SCSI_TEST_MAX_READ_REQUESTS 64

struct rip_dvd_scsi_test_request {
    uint64_t lba;
    uint32_t block_count;
};

struct rip_dvd_scsi_test_metrics {
    uint32_t discovery_count;
    uint32_t open_count;
    uint32_t close_count;
    uint32_t content_read_count;
    uint32_t request_sense_count;
    uint32_t diagnostic_command_count;
    size_t request_count;
    struct rip_dvd_scsi_test_request
        requests[RIP_DVD_SCSI_TEST_MAX_READ_REQUESTS];
};
#endif

struct rip_dvd_scsi_completion {
    int captured;
    int command_completed;
    int descriptor;
    uint8_t scsi_status;
    uint16_t host_status;
    uint16_t driver_status;
    size_t sense_reported_length;
    size_t sense_length;
    uint8_t sense[RIP_DVD_SCSI_MAX_SENSE_BYTES];
    uint64_t requested_lba;
    uint32_t requested_block_count;
    uint32_t retry_ordinal;
};

int dvdcss_linux_ioctl(int descriptor, unsigned long request, ...);
ssize_t dvdcss_linux_read(int descriptor, void *buffer, size_t length);
int dvdcss_linux_close(int descriptor);
void rip_dvd_scsi_read_scope_begin(uint64_t requested_lba,
                                   uint32_t requested_block_count,
                                   uint32_t retry_ordinal);
int rip_dvd_scsi_read_scope_end(struct rip_dvd_scsi_completion *completion);

#ifdef RIP_DVD_READER_TESTING
void rip_dvd_scsi_test_adapter_begin(void);
void rip_dvd_scsi_test_adapter_fail_discovery(void);
void rip_dvd_scsi_test_adapter_fail_open(void);
void rip_dvd_scsi_test_adapter_fail_content_read(uint32_t read_ordinal);
void rip_dvd_scsi_test_adapter_report_cleanup_at_exit(void);
void rip_dvd_scsi_test_adapter_change_drive_identity(void);
void rip_dvd_scsi_test_adapter_change_sg_drive_identity(void);
void rip_dvd_scsi_test_adapter_fail_source_identity_check(
    uint32_t check_ordinal);
int rip_dvd_scsi_test_abandon_source_descriptor(int descriptor);
ssize_t rip_dvd_scsi_test_invoke_wrapped_read(int descriptor, void *buffer,
                                              size_t length);
void rip_dvd_scsi_test_adapter_snapshot(
    struct rip_dvd_scsi_test_metrics *metrics);
#endif

#ifndef RIP_DVD_SG_IO_IMPLEMENTATION
#define ioctl dvdcss_linux_ioctl
#define read dvdcss_linux_read
#define close dvdcss_linux_close
#endif

#endif
