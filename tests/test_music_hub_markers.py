"""Marker persistence and read-only Rekordbox cue preservation."""
import json
import os
import tempfile
import unittest
from pathlib import Path
from unittest import mock

import music_hub_markers as markers


class MarkerTests(unittest.TestCase):
    def setUp(self):
        temp = tempfile.TemporaryDirectory()
        self.addCleanup(temp.cleanup)
        self.path = Path(temp.name) / "markers.json"
        self.collection = [{"id": 101, "length": 120}, {"id": 202, "length": 0}]
        self.cues = {"cues": [{"id": "12", "in_ms": 2000, "out_ms": -1,
                               "label": "A", "hot_cue": True, "kind": 1,
                               "color": 2, "comment": "original comment"}]}

    def add(self, **fields):
        return markers.mutate({"action": "add", "trackId": "101", "timeMs": 5000, **fields},
                              self.collection, self.cues, self.path)

    def test_roundtrip_and_rekordbox_fields_unchanged(self):
        result = self.add(label="Break", color="#12ABef", type="hotcue")
        self.assertEqual(result["count"], 2)
        rekordbox, custom = result["markers"]
        self.assertEqual((rekordbox["source"], rekordbox["comment"], rekordbox["kind"]),
                         ("rekordbox", "original comment", 1))
        self.assertEqual((custom["source"], custom["timeMs"], custom["label"]),
                         ("user", 5000, "Break"))
        self.assertEqual(os.stat(self.path).st_mode & 0o777, 0o600)
        self.assertEqual(markers.get_markers("101", self.collection, self.cues, self.path), result)
        updated = markers.mutate({"action": "update", "trackId": "101", "id": custom["id"],
                                  "timeMs": 6000, "label": "Drop"}, self.collection, self.cues, self.path)
        self.assertEqual(updated["markers"][1]["label"], "Drop")
        removed = markers.mutate({"action": "remove", "trackId": "101", "id": custom["id"]},
                                 self.collection, self.cues, self.path)
        self.assertEqual((removed["count"], removed["userCount"]), (1, 0))
        self.assertEqual(json.loads(self.path.read_text()), {})

    def test_invalid_ids_and_bounds_never_overwrite(self):
        result = self.add()
        original = self.path.read_bytes()
        bad = [
            {"action": "add", "trackId": "999", "timeMs": 20},
            {"action": "add", "trackId": "../101", "timeMs": 20},
            {"action": "add", "trackId": 101, "timeMs": 20},
            {"action": "add", "trackId": "101", "timeMs": 120001},
            {"action": "add", "trackId": "101", "timeMs": -1},
            {"action": "add", "trackId": "101", "timeMs": True},
            {"action": "add", "trackId": "101", "timeMs": 50, "color": "red"},
            {"action": "add", "trackId": "101", "timeMs": 50, "label": "x" * 81},
            {"action": "update", "trackId": "101", "id": result["markers"][0]["id"], "timeMs": 20},
            {"action": "remove", "trackId": "101", "id": "not-a-uuid"},
        ]
        for payload in bad:
            with self.subTest(payload=payload), self.assertRaises(markers.MarkerError):
                markers.mutate(payload, self.collection, self.cues, self.path)
            self.assertEqual(self.path.read_bytes(), original)

    def test_limits_and_corrupt_safe_read(self):
        self.add()
        original = self.path.read_bytes()
        with mock.patch.object(markers, "MAX_PER_TRACK", 1):
            with self.assertRaises(markers.MarkerError):
                self.add()
        self.assertEqual(self.path.read_bytes(), original)
        with mock.patch.object(markers, "MAX_TRACKS", 1):
            with self.assertRaises(markers.MarkerError):
                markers.mutate({"action": "add", "trackId": "202", "timeMs": 1},
                               self.collection, path=self.path)
        self.assertEqual(self.path.read_bytes(), original)
        self.path.write_text('{"101":[{"broken":true}]}')
        with self.assertRaises(markers.MarkerError):
            markers.get_markers("101", self.collection, self.cues, self.path)
        self.assertEqual(self.path.read_text(), '{"101":[{"broken":true}]}')

    def test_missing_marker_read_is_side_effect_free(self):
        data = markers.get_markers("101", self.collection, self.cues, self.path)
        self.assertEqual((data["count"], data["userCount"]), (1, 0))
        self.assertFalse(self.path.exists())
        with self.assertRaises(markers.MarkerError):
            markers.get_markers("999", self.collection, self.cues, self.path)


if __name__ == "__main__":
    unittest.main()
