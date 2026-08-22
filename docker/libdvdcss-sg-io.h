/* SPDX-License-Identifier: GPL-2.0-or-later */

#ifndef RIP_DVD_LIBDVDCSS_SG_IO_H
#define RIP_DVD_LIBDVDCSS_SG_IO_H

#include <stddef.h>
#include <stdint.h>
#include <sys/types.h>

#define RIP_DVD_SCSI_MAX_SENSE_BYTES 252

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
void rip_dvd_scsi_read_scope_begin(uint64_t requested_lba,
                                   uint32_t requested_block_count,
                                   uint32_t retry_ordinal);
int rip_dvd_scsi_read_scope_end(struct rip_dvd_scsi_completion *completion);

#ifndef RIP_DVD_SG_IO_IMPLEMENTATION
#define ioctl dvdcss_linux_ioctl
#define read dvdcss_linux_read
#endif

#endif
