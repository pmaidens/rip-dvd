/* SPDX-License-Identifier: GPL-2.0-or-later */

#ifndef RIP_DVD_LIBDVDCSS_SG_IO_H
#define RIP_DVD_LIBDVDCSS_SG_IO_H

int dvdcss_linux_ioctl(int descriptor, unsigned long request, ...);
#define ioctl dvdcss_linux_ioctl

#endif
