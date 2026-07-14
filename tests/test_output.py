import io
import unittest

from rip_dvd.output import RipProgressDisplay, progress_bar, truncate


class ProgressFormattingTests(unittest.TestCase):
    def test_progress_bar_clamps_percent(self):
        self.assertEqual(progress_bar(-5, width=10), "[----------]")
        self.assertEqual(progress_bar(45, width=10), "[####------]")
        self.assertEqual(progress_bar(150, width=10), "[##########]")

    def test_truncate_preserves_requested_width(self):
        self.assertEqual(truncate("Main Feature", 7), "Main...")
        self.assertEqual(len(truncate("Main Feature", 7)), 7)


class RipProgressDisplayTests(unittest.TestCase):
    def test_begin_lists_all_rip_queue_items(self):
        stream = io.StringIO()
        display = RipProgressDisplay(
            ["Movie: Example", "Extra 1: Trailer"],
            stream=stream,
            enabled=False,
            bar_width=10,
            label_width=16,
        )

        display.begin()

        output = stream.getvalue()
        self.assertIn("Rip queue:", output)
        self.assertIn("Movie: Example", output)
        self.assertIn("Extra 1: Trailer", output)
        self.assertEqual(output.count("[----------]   0% waiting"), 2)

    def test_update_redraws_rows_when_enabled(self):
        stream = io.StringIO()
        display = RipProgressDisplay(
            ["Movie: Example"],
            stream=stream,
            enabled=True,
            bar_width=10,
            label_width=16,
        )

        display.begin()
        display.update(0, 42, "ripping", "ETA 2m 3s")

        output = stream.getvalue()
        self.assertIn("\x1b[1A", output)
        self.assertIn("[####------]  42% ripping ETA 2m 3s", output)

    def test_finish_prints_final_snapshot_when_redraw_is_disabled(self):
        stream = io.StringIO()
        display = RipProgressDisplay(
            ["Movie: Example"],
            stream=stream,
            enabled=False,
            bar_width=10,
            label_width=16,
        )

        display.begin()
        display.update(0, 100, "done")
        display.finish()

        output = stream.getvalue()
        self.assertIn("Rip results:", output)
        self.assertIn("[##########] 100% done", output)


if __name__ == "__main__":
    unittest.main()
