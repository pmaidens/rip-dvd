/* SPDX-License-Identifier: GPL-2.0-or-later */

#define _GNU_SOURCE

#include <linux/cdrom.h>
#include <scsi/sg.h>

#include <dirent.h>
#include <errno.h>
#include <fcntl.h>
#include <limits.h>
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
#define SG_COMMAND_TIMEOUT_MS 15000U

static int resolve_sg_device(int block_descriptor, char path[PATH_MAX])
{
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

static int open_sg_device(int block_descriptor)
{
    char path[PATH_MAX];
    if (resolve_sg_device(block_descriptor, path) < 0) {
        return -1;
    }
    return open(path, O_RDONLY | O_CLOEXEC);
}

static int send_sg_command(int block_descriptor,
                           const uint8_t command[12], void *data,
                           uint32_t data_length, int direction)
{
    int descriptor = open_sg_device(block_descriptor);
    if (descriptor < 0) {
        return -1;
    }
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
    int result = ioctl(descriptor, SG_IO, &io);
    int saved_errno = errno;
    close(descriptor);
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

    char sg_device[PATH_MAX];
    if (resolve_sg_device(descriptor, sg_device) < 0) {
        return ioctl(descriptor, request, argument);
    }
    if (request == DVD_READ_STRUCT) {
        return bridge_read_structure(descriptor, argument);
    }
    if (request == DVD_AUTH) {
        return bridge_authentication(descriptor, argument);
    }
    if (request == SG_IO) {
        int sg_descriptor = open_sg_device(descriptor);
        if (sg_descriptor < 0) {
            return -1;
        }
        int result = ioctl(sg_descriptor, request, argument);
        int saved_errno = errno;
        close(sg_descriptor);
        errno = saved_errno;
        return result;
    }
    return ioctl(descriptor, request, argument);
}
