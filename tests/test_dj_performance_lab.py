"""No live audio, controller or Rekordbox database access required."""
import unittest

from dj_performance_lab import TransitionRejected, compile_bass_swap


def fixture(bpm=140):
    a = {"id": "1", "title": "Source", "bpm": bpm, "length": 220, "key": "8A"}
    b = {"id": "2", "title": "Target", "bpm": bpm, "length": 240, "key": "8A"}
    phrases_a = {"phrases": [{"index": 2, "start_sec": 145.0, "start_beat": 20, "end_beat": 84, "kind": 3}]}
    phrases_b = {"phrases": [{"index": 1, "start_sec": 18.0, "start_beat": 0, "end_beat": 64, "kind": 1}]}
    return a, b, phrases_a, phrases_b


class TestDJPerformanceLab(unittest.TestCase):
    def test_dry_run_is_phrase_aligned_and_has_no_effect_commands(self):
        output = compile_bass_swap(*fixture())
        self.assertEqual(output["mode"], "dry_run_only")
        self.assertEqual(output["length_bars"], 16)
        self.assertAlmostEqual(output["length_seconds"], 16 * 4 * 60 / 140, places=4)
        actions = output["events"]
        self.assertEqual([e["bar"] for e in actions], sorted(e["bar"] for e in actions))
        self.assertEqual(actions[0]["value"], 0.0)
        self.assertEqual(actions[3]["operation"], "start_deck")
        self.assertEqual(actions[-1]["operation"], "set_eq")
        self.assertEqual(actions[-1]["value"], 0.5)  # normalized UNITY, not 1.0
        self.assertEqual(actions[-3]["value"], 1.0)  # full crossfade
        for event in actions:
            self.assertIn(event["operation"], {"set_eq", "set_crossfade", "seek_paused", "start_deck", "pause_deck"})
            self.assertLessEqual(event["when_outgoing_position_sec"], fixture()[0]["length"])

    def test_missing_analysis_refused(self):
        a, b, _, pb = fixture()
        with self.assertRaisesRegex(TransitionRejected, "phrase analysis"):
            compile_bass_swap(a, b, None, pb)

    def test_unverified_tempo_is_refused(self):
        a, b, pa, pb = fixture()
        b["bpm"] = 150
        with self.assertRaisesRegex(TransitionRejected, "Tempo difference"):
            compile_bass_swap(a, b, pa, pb)

    def test_insufficient_outgoing_tail_is_refused(self):
        a, b, pa, pb = fixture()
        a["length"] = 158
        with self.assertRaisesRegex(TransitionRejected, "ends before"):
            compile_bass_swap(a, b, pa, pb)

    def test_unsupported_duration_is_refused(self):
        with self.assertRaisesRegex(TransitionRejected, "8, 16 or 32"):
            compile_bass_swap(*fixture(), bars=13)

    def test_shorter_bass_swap_keeps_monotone_timeline(self):
        for bars in (8, 32):
            plan = compile_bass_swap(*fixture(), bars=bars)
            self.assertEqual(max(e["bar"] for e in plan["events"]), bars)
            self.assertEqual(plan["events"][0]["when_outgoing_position_sec"], 145.0)

    def test_reverse_direction_for_alternating_decks(self):
        plan = compile_bass_swap(*fixture(), outgoing_deck=2)
        self.assertEqual(plan["outgoing_deck"], 2)
        self.assertEqual(plan["incoming_deck"], 1)
        self.assertEqual(plan["events"][0]["deck"], 1)
        self.assertEqual(plan["events"][1]["value"], 1.0)
        self.assertEqual(plan["events"][-3]["value"], 0.0)
        self.assertEqual(plan["events"][-2]["deck"], 2)

    def test_invalid_deck_is_refused(self):
        with self.assertRaises(TransitionRejected):
            compile_bass_swap(*fixture(), outgoing_deck=3)

    def test_nan_and_bad_bpm_refused(self):
        a, b, pa, pb = fixture()
        a["bpm"] = float("nan")
        with self.assertRaises(TransitionRejected):
            compile_bass_swap(a, b, pa, pb)


if __name__ == "__main__":
    unittest.main()
