/* HandBrake expects UTF-8; DVDUDFVolumeInfo documents a Latin-1 label.
 * Interpose only for rip-dvd-handbrake, never for other libdvdread consumers.
 * Do not guess whether the bytes already look like UTF-8: Latin-1 sequences
 * can also be valid UTF-8, and still require conversion.
 */
#define _GNU_SOURCE
#include <dlfcn.h>
#include <dvdread/dvd_reader.h>
#include <stdio.h>
#include <stdlib.h>

int DVDUDFVolumeInfo(dvd_reader_t *dvd, char *volid, unsigned int volid_size,
                     unsigned char *volsetid, unsigned int volsetid_size)
{
    typedef int (*volume_info_fn)(dvd_reader_t *, char *, unsigned int,
                                  unsigned char *, unsigned int);
    volume_info_fn original = (volume_info_fn)dlsym(RTLD_NEXT, "DVDUDFVolumeInfo");
    if (original == NULL) {
        fputs("HandBrake DVD label compatibility library cannot resolve libdvdread\n", stderr);
        exit(EXIT_FAILURE);
    }
    if (volid == NULL || volid_size == 0)
        return original(dvd, volid, volid_size, volsetid, volsetid_size);

    /* The public libdvdread API returns at most 32 bytes including the NUL.
     * Read into a separate buffer so UTF-8 expansion cannot overwrite input.
     * Volume-set bytes and failures keep libdvdread's original semantics.
     */
    unsigned char latin1[32] = {0};
    int result = original(dvd, (char *)latin1, sizeof(latin1), volsetid, volsetid_size);
    if (result != 0)
        return result;

    size_t output = 0;
    for (size_t input = 0; input < sizeof(latin1) && latin1[input] != 0; input++) {
        unsigned char byte = latin1[input];
        size_t width = byte < 0x80 ? 1 : 2;
        if (output + width >= volid_size)
            break; /* Always terminate, and never split a UTF-8 character. */
        if (width == 2) {
            volid[output++] = (char)(0xc0 | (byte >> 6));
            volid[output++] = (char)(0x80 | (byte & 0x3f));
        } else {
            volid[output++] = (char)byte;
        }
    }
    volid[output] = '\0';
    return result;
}
