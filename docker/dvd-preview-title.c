/* Prove the exact libdvdread title path before a sample reads content. Complex
 * multi-PGC and multi-angle paths fail explicitly until they can be represented.
 */
#include <dvdread/dvd_reader.h>
#include <dvdread/ifo_read.h>
#include <errno.h>
#include <stdio.h>
#include <stdlib.h>
#include <stdint.h>

static unsigned parse(const char *text) {
    char *end;
    errno = 0;
    unsigned long value = strtoul(text, &end, 10);
    if (errno || *text == '\0' || *end != '\0' || value == 0 || value > 65535)
        exit(EXIT_FAILURE);
    return (unsigned)value;
}
struct audio_mapping { unsigned source, physical, channels; const char *codec; };
struct subtitle_mapping { unsigned source, physical; const char *style; };
static void add_subtitle(struct subtitle_mapping *items, unsigned *count,
                         unsigned source, unsigned physical, const char *style) {
    for (unsigned i = 0; i < *count; i++) if (items[i].physical == physical) return;
    items[(*count)++] = (struct subtitle_mapping){source, physical, style};
}
int main(int argc, char **argv) {
    if (argc != 7) return EXIT_FAILURE;
    unsigned title = parse(argv[2]), angle = parse(argv[3]);
    unsigned chapter_start = parse(argv[4]), chapter_end = parse(argv[5]);
    /* argv[6] is an execution-specific marker used to prove reader quiescence. */
    if (angle != 1 || chapter_start > chapter_end) return EXIT_FAILURE;
    dvd_reader_t *dvd = DVDOpen(argv[1]);
    if (!dvd) return EXIT_FAILURE;
    ifo_handle_t *manager = ifoOpen(dvd, 0), *vts = NULL;
    int result = EXIT_FAILURE;
    if (!manager || !manager->tt_srpt || title > manager->tt_srpt->nr_of_srpts) goto done;
    title_info_t *info = &manager->tt_srpt->title[title - 1];
    if (info->nr_of_angles != 1) goto done;
    vts = ifoOpen(dvd, info->title_set_nr);
    if (!vts || !vts->vts_ptt_srpt || !vts->vts_pgcit ||
        info->vts_ttn == 0 || info->vts_ttn > vts->vts_ptt_srpt->nr_of_srpts) goto done;
    ttu_t *parts = &vts->vts_ptt_srpt->title[info->vts_ttn - 1];
    if (chapter_end > parts->nr_of_ptts || parts->nr_of_ptts == 0) goto done;
    unsigned pgcn = parts->ptt[0].pgcn;
    if (pgcn == 0 || pgcn > vts->vts_pgcit->nr_of_pgci_srp) goto done;
    pgc_t *pgc = vts->vts_pgcit->pgci_srp[pgcn - 1].pgc;
    if (!pgc || !pgc->program_map || !pgc->cell_playback || !pgc->cell_position) goto done;
    for (unsigned chapter = 0; chapter < parts->nr_of_ptts; chapter++) {
        unsigned program = parts->ptt[chapter].pgn;
        if (parts->ptt[chapter].pgcn != pgcn || program == 0 || program > pgc->nr_of_programs ||
            (chapter && program <= parts->ptt[chapter - 1].pgn)) goto done;
    }
    unsigned first_program = parts->ptt[chapter_start - 1].pgn;
    unsigned last_program = chapter_end == parts->nr_of_ptts ? pgc->nr_of_programs : parts->ptt[chapter_end].pgn - 1;
    if (first_program > last_program) goto done;
    for (unsigned program = 1; program <= pgc->nr_of_programs; program++) {
        unsigned cell = pgc->program_map[program - 1];
        if (cell == 0 || cell > pgc->nr_of_cells || (program > 1 && cell <= pgc->program_map[program - 2])) goto done;
    }
    for (unsigned cell = 0; cell < pgc->nr_of_cells; cell++) if (pgc->cell_playback[cell].block_type) goto done;
    if (!vts->vtsi_mat || vts->vtsi_mat->nr_of_vts_audio_streams > 8 || vts->vtsi_mat->nr_of_vts_subp_streams > 32) goto done;
    struct audio_mapping audio[8];
    struct subtitle_mapping subtitles[32];
    unsigned audio_count = 0, subtitle_count = 0;
    for (unsigned slot = 0; slot < vts->vtsi_mat->nr_of_vts_audio_streams; slot++) {
        unsigned control = pgc->audio_control[slot];
        if (!(control & 0x8000)) continue;
        unsigned position = (control >> 8) & 0x7f, base;
        const char *codec;
        switch (vts->vtsi_mat->vts_audio_attr[slot].audio_format) {
            case 0: base = 0x80; codec = "ac3"; break;
            case 2: case 3: base = 0xc0; codec = "mpeg"; break;
            case 4: base = 0xa0; codec = "lpcm"; break;
            case 6: base = 0x88; codec = "dts"; break;
            default: continue;
        }
        if (position > 7) goto done;
        unsigned duplicate = 0;
        for (unsigned j = 0; j < audio_count; j++) if (audio[j].physical == base + position) duplicate = 1;
        if (duplicate) continue;
        audio[audio_count++] = (struct audio_mapping){base + slot, base + position,
            vts->vtsi_mat->vts_audio_attr[slot].channels + 1, codec};
    }
    unsigned aspect = vts->vtsi_mat->vts_video_attr.display_aspect_ratio;
    if (aspect != 0 && aspect != 3) goto done;
    for (unsigned slot = 0; slot < vts->vtsi_mat->nr_of_vts_subp_streams; slot++) {
        uint32_t control = pgc->subp_control[slot];
        if (!(control & 0x80000000u)) continue;
        if (aspect == 0) add_subtitle(subtitles, &subtitle_count, 0x20 + slot, 0x20 + ((control >> 24) & 31), "4By3");
        else {
            add_subtitle(subtitles, &subtitle_count, 0x20 + slot, 0x20 + ((control >> 16) & 31), "Wide");
            unsigned permitted = vts->vtsi_mat->vts_video_attr.permitted_df;
            if (!(permitted & 1)) add_subtitle(subtitles, &subtitle_count, 0x20 + slot, 0x20 + ((control >> 8) & 31), "Letterbox");
            if (!(permitted & 2)) add_subtitle(subtitles, &subtitle_count, 0x20 + slot, 0x20 + (control & 31), "PanScan");
        }
    }
    printf("{\"navigation\":{\"videoTitleSetNumber\":%u,\"titleSetTitleNumber\":%u,\"programChainNumber\":%u},\"selectedPath\":[", info->title_set_nr, info->vts_ttn, pgcn);
    int comma = 0;
    for (unsigned program = first_program; program <= last_program; program++) {
        unsigned start = pgc->program_map[program - 1];
        unsigned end = program == pgc->nr_of_programs ? pgc->nr_of_cells + 1 : pgc->program_map[program];
        for (unsigned cell = start; cell < end; cell++) {
            printf("%s{\"programNumber\":%u,\"cellNumber\":%u,\"vobId\":%u,\"cellId\":%u}", comma ? "," : "", program, cell, pgc->cell_position[cell - 1].vob_id_nr, pgc->cell_position[cell - 1].cell_nr);
            comma = 1;
        }
    }
    printf("],\"audio\":[");
    for (unsigned i = 0; i < audio_count; i++) printf("%s{\"sourceId\":%u,\"physicalId\":%u,\"codec\":\"%s\",\"channels\":%u}", i ? "," : "", audio[i].source, audio[i].physical, audio[i].codec, audio[i].channels);
    printf("],\"subtitles\":[");
    for (unsigned i = 0; i < subtitle_count; i++) printf("%s{\"sourceId\":%u,\"physicalId\":%u,\"style\":\"%s\"}", i ? "," : "", subtitles[i].source, subtitles[i].physical, subtitles[i].style);
    puts("]}");
    result = ferror(stdout) ? EXIT_FAILURE : EXIT_SUCCESS;
done:
    if (vts) ifoClose(vts);
    if (manager) ifoClose(manager);
    DVDClose(dvd);
    return result;
}
