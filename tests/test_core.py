from pathlib import Path
import unittest

from rip_dvd.core import (
    DvdTitle,
    MovieMetadata,
    build_disc_archive_plan,
    build_encode_plan,
    build_extra_plan,
    build_rip_plan,
    classify_title,
    default_extra_name,
    format_duration,
    parse_duration,
    parse_handbrake_progress,
    parse_lsdvd_output,
    parse_title_numbers,
    pretty_from_label,
    sanitize_filename,
    suggested_extra_titles,
)


class DurationTests(unittest.TestCase):
    def test_parse_duration_accepts_dvd_duration_format(self):
        self.assertEqual(parse_duration("01:23:45.000"), 5025)

    def test_parse_duration_returns_zero_for_unrecognized_values(self):
        self.assertEqual(parse_duration("not a duration"), 0)

    def test_format_duration_uses_compact_human_units(self):
        self.assertEqual(format_duration(65), "1m 5s")
        self.assertEqual(format_duration(3661), "1h 1m 1s")


class NamingTests(unittest.TestCase):
    def test_sanitize_filename_removes_filesystem_separators(self):
        self.assertEqual(sanitize_filename('Movie: A/B? "Test"'), "Movie A B Test")

    def test_pretty_from_label_title_cases_disc_labels(self):
        self.assertEqual(pretty_from_label("THE_MATRIX_RELOADED"), "The Matrix Reloaded")

    def test_classify_title_accounts_for_multiple_feature_length_titles(self):
        self.assertEqual(classify_title(7200, feature_count=2), "possible feature / double feature")


class ScanParsingTests(unittest.TestCase):
    def test_parse_lsdvd_output_extracts_disc_and_titles(self):
        sample = """
Disc Title: SAMPLE_MOVIE
Title: 01, Length: 01:35:11.000 Chapters: 12, Cells: 12, Audio streams: 2, Subpictures: 3
Title: 02, Length: 00:04:05.000 Chapters: 1, Cells: 1, Audio streams: 1, Subpictures: 0
"""
        scan = parse_lsdvd_output(sample, returncode=0)

        self.assertEqual(scan.disc_title, "SAMPLE_MOVIE")
        self.assertEqual(len(scan.titles), 2)
        self.assertEqual(scan.titles[0].number, 1)
        self.assertEqual(scan.titles[0].seconds, 5711)
        self.assertEqual(scan.titles[0].chapters, 12)
        self.assertEqual(scan.titles[1].subtitles, 0)

    def test_suggested_extra_titles_excludes_main_feature_and_junk(self):
        scan = parse_lsdvd_output(
            """
Title: 01, Length: 01:35:11.000 Chapters: 12, Cells: 12, Audio streams: 2, Subpictures: 3
Title: 02, Length: 00:04:05.000 Chapters: 1, Cells: 1, Audio streams: 1, Subpictures: 0
Title: 03, Length: 00:00:45.000 Chapters: 1, Cells: 1, Audio streams: 1, Subpictures: 0
""",
            returncode=0,
        )

        self.assertEqual([title.number for title in suggested_extra_titles(scan)], [2])

class PlanningTests(unittest.TestCase):
    def test_parse_title_numbers_deduplicates_and_accepts_commas_or_spaces(self):
        self.assertEqual(parse_title_numbers("2, 3 2,4"), [2, 3, 4])

    def test_parse_title_numbers_accepts_none_aliases(self):
        self.assertEqual(parse_title_numbers("none"), [])

    def test_parse_title_numbers_rejects_non_numeric_tokens(self):
        with self.assertRaisesRegex(ValueError, "invalid title number: x"):
            parse_title_numbers("1,x")

    def test_default_extra_name_uses_title_duration_and_chapters(self):
        title = DvdTitle(2, "00:07:30.000", 450, 3, 1, 0)
        self.assertEqual(default_extra_name(2, title_info=title, sequence=1), "Bonus Feature 01 - 7m 30s, 3 chapters")

    def test_build_rip_plan_for_main_feature(self):
        metadata = MovieMetadata(hint="Disc", title="Example Movie", year="1999")
        plan = build_rip_plan("/dev/sr0", "/srv/media/Movies", "Fast 480p30", metadata)

        self.assertEqual(plan.movie_dir, Path("/srv/media/Movies/Example Movie (1999)"))
        self.assertEqual(plan.output, Path("/srv/media/Movies/Example Movie (1999)/Example Movie (1999).mkv"))
        self.assertEqual(plan.cmd[0:2], ["HandBrakeCLI", "--main-feature"])

    def test_build_extra_plan_sanitizes_custom_name(self):
        plan = build_extra_plan("/dev/sr0", "Fast 480p30", Path("/movies/Film"), 4, extra_name="Behind/Scenes")

        self.assertEqual(plan.output, Path("/movies/Film/extras/Behind Scenes.mkv"))
        self.assertEqual(plan.cmd[0:4], ["HandBrakeCLI", "--title", "4", "-i"])

    def test_build_disc_archive_plan_saves_iso_under_originals_library(self):
        metadata = MovieMetadata(hint="Disc", title="Example Movie", year="1999")
        plan = build_disc_archive_plan("/dev/sr0", "/srv/media/Movies", "/srv/media/DVD Originals", metadata)

        self.assertEqual(plan.output, Path("/srv/media/DVD Originals/Example Movie (1999)/Example Movie (1999).iso"))
        self.assertEqual(plan.metadata_path, Path("/srv/media/DVD Originals/Example Movie (1999)/Example Movie (1999).rip-dvd.json"))
        self.assertEqual(plan.cmd[0], "dd")
        self.assertIn("if=/dev/sr0", plan.cmd)
        self.assertIn("of=/srv/media/DVD Originals/Example Movie (1999)/.Example Movie (1999).iso.rip-dvd-partial", plan.cmd)

    def test_build_encode_plan_reads_iso_title_and_writes_final_output(self):
        plan = build_encode_plan(
            "/originals/Example Movie.iso",
            "/movies/Example Movie/Example Movie.mkv",
            "Fast 480p30",
            2,
        )

        self.assertEqual(plan.output, Path("/movies/Example Movie/Example Movie.mkv"))
        self.assertEqual(plan.cmd[0:3], ["HandBrakeCLI", "--title", "2"])
        self.assertIn("/originals/Example Movie.iso", plan.cmd)
        self.assertIn("av_mkv", plan.cmd)

    def test_build_encode_plan_can_defer_main_feature_selection_to_handbrake(self):
        plan = build_encode_plan(
            "/originals/Example Movie.iso",
            "/movies/Example Movie/Example Movie.mkv",
            "Fast 480p30",
            None,
        )

        self.assertEqual(plan.cmd[0:2], ["HandBrakeCLI", "--main-feature"])
        self.assertNotIn("--title", plan.cmd)


class HandBrakeProgressTests(unittest.TestCase):
    def test_parse_rip_progress_with_handbrake_eta(self):
        progress = parse_handbrake_progress("Encoding: task 1 of 1, 42.50 % (128.00 fps, avg 90.00 fps, ETA 0h12m03s)")

        self.assertEqual(progress.phase, "rip")
        self.assertEqual(progress.percent_value, 42.5)
        self.assertEqual(progress.eta_seconds, 723)

    def test_parse_scan_progress(self):
        progress = parse_handbrake_progress("Scanning title 1 of 8, 25.00 %")

        self.assertEqual(progress.phase, "scan")
        self.assertEqual(progress.percent_value, 25.0)

    def test_parse_preview_progress(self):
        progress = parse_handbrake_progress("Scanning title 1 of 8, preview 3, 60.00 %")

        self.assertEqual(progress.phase, "preview")
        self.assertEqual(progress.percent_value, 60.0)

    def test_non_progress_line_returns_none(self):
        self.assertIsNone(parse_handbrake_progress("libdvdread: Using libdvdcss version 1.4.3"))


if __name__ == "__main__":
    unittest.main()
