"""Read-only acceptance contracts for compact performance and nested DJ library.

Run: python3 -m unittest discover -s tests -p test_music_hub_dense_navigation.py -v

Checks locally authored UI wiring and the live GET-only library snapshot. These
checks do NOT launch MIDI, write the user's playlists, or load a DJ deck.
"""
from pathlib import Path
import json
import re
import unittest
from urllib.request import urlopen


ROOT = Path(__file__).resolve().parents[1]


class DenseNavigationContract(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.html = (ROOT / "music-hub/index.html").read_text(encoding="utf-8")
        cls.js = (ROOT / "music-hub/app.js").read_text(encoding="utf-8")
        cls.css = (ROOT / "music-hub/styles.css").read_text(encoding="utf-8")

    def test_dragging_a_real_track_stages_only_not_auto_play(self):
        for token in ("application/x-music-hub-track", "dragstart", "dragover", "drop", "stageDeck(",
                      "STAGED PREVIEW", "Load to Rekordbox", "music-hub/load"):
            self.assertIn(token, self.js + self.html)
        self.assertIn("dataTransfer", self.js)
        self.assertIn("verifiedDeck", self.js)
        self.assertNotIn("Math.random()", self.js)

    def test_multiple_song_density_modes_and_persistent_views(self):
        for token in ("compact", "gallery", "square", "list", "music-hub-display-v2",
                      "music-hub-collection-view", "collection-rows", "renderRows"):
            self.assertIn(token, self.js + self.css)
        for id_ in ("list-mode", "compact-mode", "grid-mode", "square-mode"):
            self.assertIn(id_, self.js + self.html)
        self.assertRegex(self.css, r"\.shell>\.performance\s*\{[^}]*grid-column:\s*1/-1")

    def test_real_camelot_colors_and_no_fake_genres(self):
        source = self.js + self.css
        for word in ("camelot", "key", "genre", "Untagged"):
            self.assertIn(word.lower(), source.lower())
        self.assertIn("genreValue", self.js)
        self.assertNotIn("Math.random()", self.js)

    def test_nested_native_and_personal_organization_ui(self):
        for token in ("playlistTree", "treeMarkup", "folder.create", "folder.assign", "folders",
                      "genre-vibe-groups", "playlist-folder", "collection-view-modes"):
            self.assertIn(token, self.js + self.html)
        self.assertIn("native:", self.js)

    def test_live_backend_returns_real_library_and_nested_tree(self):
        base = "http://127.0.0.1:18769"
        try:
            with urlopen(base + "/api/library", timeout=14) as response:
                library = json.load(response)
            with urlopen(base + "/api/music-hub/state", timeout=5) as response:
                state = json.load(response)
        except OSError as exc:
            self.skipTest(f"Local server not running: {exc}")
        self.assertGreaterEqual(len(library.get("collection", [])), 12000)
        self.assertIn("playlistTree", library)
        self.assertIsInstance(library["playlistTree"], list)
        self.assertIn("folders", state)
        self.assertIsInstance(state["folders"], list)
        self.assertIsInstance(library.get("playlists"), list)


if __name__ == "__main__":
    unittest.main()
