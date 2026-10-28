/* Prove the exact libdvdread title path before a sample reads content. Complex
 * multi-PGC and multi-angle paths fail explicitly until they can be represented.
 */
#include <dvdread/dvd_reader.h>
#include <dvdread/ifo_read.h>
#include <errno.h>
#include <stdio.h>
#include <stdlib.h>

static unsigned parse(const char *text) {
    char *end;
    errno = 0;
    unsigned long value = strtoul(text, &end, 10);
    if (errno || *text == '\0' || *end != '\0' || value == 0 || value > 65535)
        exit(EXIT_FAILURE);
    return (unsigned)value;
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
    puts("]}");
    result = ferror(stdout) ? EXIT_FAILURE : EXIT_SUCCESS;
done:
    if (vts) ifoClose(vts);
    if (manager) ifoClose(manager);
    DVDClose(dvd);
    return result;
}
