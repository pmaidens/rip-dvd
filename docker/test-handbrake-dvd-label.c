/* Compile once as a mock libdvdread and once as its caller. LD_PRELOAD must
 * intercept the real public symbol between them, as it does for HandBrake.
 */
#include <assert.h>
#include <dvdread/dvd_reader.h>
#include <stdio.h>
#include <string.h>

struct fixture {
    const char *label;
    int result;
};

#ifdef RIP_DVD_LABEL_MOCK
int DVDUDFVolumeInfo(dvd_reader_t *dvd, char *volid, unsigned int volid_size,
                     unsigned char *volsetid, unsigned int volsetid_size)
{
    struct fixture *fixture = (struct fixture *)dvd;
    if (volsetid != NULL)
        memset(volsetid, 0xe9, volsetid_size);
    if (fixture->result != 0)
        return fixture->result;
    if (volid != NULL && volid_size > 0) {
        size_t length = strlen(fixture->label);
        assert(length < 32);
        if (length >= volid_size) length = volid_size - 1;
        memcpy(volid, fixture->label, length);
        volid[length] = '\0';
    }
    return 0;
}
#else
static void check(const char *latin1, const char *utf8)
{
    struct fixture fixture = {latin1, 0};
    for (unsigned int size = 0; size <= 66; size++) {
        unsigned char output[68];
        unsigned char volume_set[128];
        memset(output, 0xa5, sizeof(output));
        memset(volume_set, 0, sizeof(volume_set));
        assert(DVDUDFVolumeInfo((dvd_reader_t *)&fixture, (char *)output + 1,
                               size, volume_set, sizeof(volume_set)) == 0);
        for (size_t i = 0; i < sizeof(volume_set); i++) assert(volume_set[i] == 0xe9);
        assert(output[0] == 0xa5);
        for (size_t i = size + 1; i < sizeof(output); i++) assert(output[i] == 0xa5);
        if (size == 0) continue;
        size_t length = 0;
        while (utf8[length] != 0) {
            size_t width = (unsigned char)utf8[length] < 0x80 ? 1 : 2;
            if (length + width >= size) break;
            length += width;
        }
        assert(memcmp(output + 1, utf8, length) == 0);
        assert(output[length + 1] == 0);
    }
}

int main(void)
{
    check("", "");
    check("ASCII DVD", "ASCII DVD");
    check("Caf\xe9", "Caf\xc3\xa9");
    check("\xc3\xa9", "\xc3\x83\xc2\xa9");
    for (unsigned int byte = 1; byte <= 255; byte++) {
        char latin1[] = {(char)byte, 0};
        char utf8[3] = {(char)byte, 0, 0};
        if (byte >= 128) {
            utf8[0] = (char)(0xc0 | (byte >> 6));
            utf8[1] = (char)(0x80 | (byte & 0x3f));
        }
        check(latin1, utf8);
    }
    char longest[32], expanded[63];
    memset(longest, 0xff, 31);
    longest[31] = 0;
    for (size_t i = 0; i < 31; i++) {
        expanded[i * 2] = (char)0xc3;
        expanded[i * 2 + 1] = (char)0xbf;
    }
    expanded[62] = 0;
    check(longest, expanded);
    struct fixture fixture = {"\xe9", -1};
    char output[4] = "old";
    assert(DVDUDFVolumeInfo((dvd_reader_t *)&fixture, output, sizeof(output), NULL, 0) == -1);
    assert(strcmp(output, "old") == 0);
    fixture.result = 0;
    unsigned char volume_set[1] = {0};
    assert(DVDUDFVolumeInfo((dvd_reader_t *)&fixture, NULL, 42, volume_set, 1) == 0);
    assert(volume_set[0] == 0xe9);
    puts("HandBrake DVD label ABI, Latin-1, bounds and failure tests passed");
    return 0;
}
#endif
