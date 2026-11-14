"""User-provided lyrics remain in a bounded Music Hub sidecar."""
import json
import tempfile
import unittest
from pathlib import Path
from unittest import mock

import music_hub_backend as hub


class LyricsTests(unittest.TestCase):
    def setUp(self):
        folder = tempfile.TemporaryDirectory()
        self.addCleanup(folder.cleanup)
        self.path = Path(folder.name) / "state.json"
        self.ids = {"101", "202"}

    def set_lyrics(self, track_id="101", fmt="lrc", content="[00:01.00]Hello & 世界"):
        return hub.apply_action({"action": "lyrics.set", "trackId": track_id,
                                 "format": fmt, "text": content}, self.ids, self.path)

    def test_round_trip_metadata_and_clear(self):
        state = self.set_lyrics()
        self.assertEqual(state["lyricsAvailable"], {"101": "lrc"})
        self.assertNotIn("Hello", json.dumps(state))
        self.assertEqual(hub.lyrics_for_track("101", self.ids, self.path), {
            "trackId": "101", "available": True, "format": "lrc",
            "text": "[00:01.00]Hello & 世界", "source": "user"})
        before = hub._lyrics_path(self.path).read_bytes()
        self.set_lyrics()
        self.assertEqual(hub._lyrics_path(self.path).read_bytes(), before)
        self.assertEqual(self.set_lyrics(content="")["lyricsAvailable"], {})
        self.assertEqual(hub.lyrics_for_track("101", self.ids, self.path)["text"], "")

    def test_validation_and_limits_do_not_overwrite_valid_data(self):
        self.set_lyrics()
        sidecar = hub._lyrics_path(self.path)
        previous = sidecar.read_bytes()
        for tid, fmt, content in [("999", "plain", "x"), ("../101", "plain", "x"),
                                  ("101", "invalid", "x"), ("101", "plain", None),
                                  ("101", "plain", "🎵" * 5000)]:
            with self.subTest(tid=tid, fmt=fmt), self.assertRaises(hub.HubError):
                self.set_lyrics(tid, fmt, content)
            self.assertEqual(sidecar.read_bytes(), previous)
        with mock.patch.object(hub, "MAX_LYRICS_TRACKS", 1):
            with self.assertRaises(hub.HubError):
                self.set_lyrics("202", "plain", "Other")
        self.assertEqual(sidecar.read_bytes(), previous)

    def test_legacy_state_is_preserved_and_no_rekordbox_paths_written(self):
        original = {"queue": ["101"], "favorites": [], "playlists": []}
        self.path.write_text(json.dumps(original))
        self.set_lyrics(content="user words")
        self.assertEqual(json.loads(self.path.read_text()), original)
        self.assertEqual({f.name for f in self.path.parent.iterdir()}, {"state.json", "state.lyrics.json"})

    def test_local_sidecar_read_only_precedence_and_safety(self):
        music = self.path.parent / "concert.mp3"
        music.write_bytes(b"audio")
        lrc = self.path.parent / "concert.lrc"
        lrc.write_text("[00:01.20]First line", encoding="utf-8")
        collection = [{"id": 101, "path": str(music)}]

        def lyrics():
            return hub.lyrics_for_track("101", self.ids, self.path, collection=collection)

        self.assertEqual(lyrics(), {"trackId": "101", "available": True,
                                   "format": "lrc", "text": "[00:01.20]First line", "source": "sidecar"})
        before = lrc.read_bytes()
        self.set_lyrics(content="my own text", fmt="plain")
        self.assertEqual(lyrics()["source"], "user")
        self.assertEqual(lyrics()["text"], "my own text")
        self.set_lyrics(content="")
        self.assertEqual(lyrics()["source"], "sidecar")
        self.assertEqual(lrc.read_bytes(), before)

        lrc.write_text("[00:01.20]First <00:01.30>word", encoding="utf-8")
        self.assertEqual(lyrics()["format"], "elrc")
        lrc.unlink()
        elrc = self.path.parent / "concert.elrc"
        elrc.write_text("[00:01.20]Second", encoding="utf-8")
        self.assertEqual(lyrics()["format"], "elrc")
        elrc.write_bytes(b"a" * (hub.MAX_TRACK_LYRICS_BYTES + 1))
        self.assertFalse(lyrics()["available"])

        elrc.unlink()
        target = self.path.parent / "private.txt"
        target.write_text("do not read")
        elrc.symlink_to(target)
        self.assertFalse(lyrics()["available"])
        collection[0]["path"] = "../concert.mp3"
        self.assertFalse(lyrics()["available"])
        collection[0]["path"] = str(self.path.parent / "folder" / ".." / "concert.mp3")
        self.assertFalse(lyrics()["available"])
        with self.assertRaises(hub.HubError):
            hub.lyrics_for_track("999", self.ids, self.path, collection=collection)


if __name__ == "__main__":
    unittest.main()
