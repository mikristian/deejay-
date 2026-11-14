"""Read-only Music Hub UI/API smoke contract; no browser, app-state or DB writes.

Run: python3 -m unittest discover -s tests -p test_music_hub_visual_contract.py -v
Optional: MUSIC_HUB_BASE_URL=http://127.0.0.1:18769
"""

import json
import os
from pathlib import Path
import re
import unittest
from urllib.request import urlopen


ROOT = Path(__file__).resolve().parents[1]
BASE_URL = os.environ.get("MUSIC_HUB_BASE_URL", "http://127.0.0.1:18769").rstrip("/")


class MusicHubVisualContract(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.html = (ROOT / "music-hub/index.html").read_text(encoding="utf-8")
        cls.js = (ROOT / "music-hub/app.js").read_text(encoding="utf-8")
        cls.css = (ROOT / "music-hub/styles.css").read_text(encoding="utf-8")

    def test_decks_reparented_into_full_width_shell_row(self):
        self.assertIn("shell.insertBefore(performance,shell.firstElementChild)", self.js)
        self.assertRegex(self.css, r"\.shell>\.performance\s*\{[^}]*grid-column:\s*1/-1")
        self.assertRegex(self.css, r"\.shell>\.sidebar\s*\{[^}]*grid-row:\s*2")
        self.assertRegex(self.css, r"\.shell>\.main\s*\{[^}]*grid-row:\s*2")
        for name in ("deck-one-title", "deck-two-title", "deck-one-wave", "deck-two-wave"):
            self.assertIn('id="' + name + '"', self.html)

    def test_collapsible_sidebar_and_mobile_layout(self):
        self.assertIn("'sidebar-collapse').addEventListener('click'", self.js)
        self.assertIn("sidebar-compact", self.js)
        self.assertIn("music-hub-sidebar-compact", self.js)
        self.assertIn("@media(max-width:640px)", self.css)
        self.assertIn(".shell>.performance .deck-pair", self.css)
        self.assertIn("top:var(--deck-header-height,170px)", self.css)
        self.assertIn("new ResizeObserver(updateDeckHeight)", self.js)
        self.assertIn("shell.style.setProperty('--deck-header-height'", self.js)

    def test_default_songs_and_staged_preview_disclosure(self):
        self.assertIn("view: 'all'", self.js)
        self.assertIn("const stagedDeckIds={1:null,2:null}", self.js)
        self.assertIn("'STAGED PREVIEW — NOT LOADED'", self.js)
        self.assertIn("'VERIFIED REKORDBOX DECK · PLAY STATE UNKNOWN'", self.js)
        self.assertIn("verifiedDeckSlots[deck]", self.js)
        self.assertIn("stageDeck(Number(button.dataset.stage))", self.js)
        self.assertIn("renderDeckWave(prefix+'-wave'", self.js)

    def test_list_grid_and_real_genre_rating_semantics(self):
        for token in ("'list-mode'", "'grid-mode'", "setDisplayMode(displayMode)", "'music-hub-display-v2'",
                      "'genre-filter'", "'rating-filter'", "'untagged'", "genreValue(t)",
                      "ratingMarkup(t)", "'rating.set'", "data-rating"):
            self.assertIn(token, self.js)
        self.assertIn('>GENRE</SPAN>', self.html.upper())
        self.assertIn('>RATING</SPAN>', self.html.upper())
        self.assertNotIn("Math.random()", self.js)

    def test_themes_and_local_preview_distinguished_from_native_feedback(self):
        for token in ("glass-dark", "glass-light", "music-hub-theme-v2", "localStorage.setItem",
                      "'settings'", "--glass-blur", "'music-hub-glass-blur'"):
            self.assertIn(token, self.js)
        self.assertIn('data-theme="glass-dark"', self.css)
        self.assertIn('data-theme="glass-light"', self.css)
        self.assertIn("Read-only feedback", self.html)
        self.assertIn("PREPARATION MODE", self.html)
        self.assertIn("LOCAL PREVIEW", self.html)
        self.assertIn("Playback has not been started", self.js)

    def test_queue_setlists_and_actions_wired(self):
        for token in ("'queue.add'", "'queue.reorder'", "'queue.clear'", "'setlist.create'",
                      "'setlist.queue'", "'setlist.delete'", "'/api/music-hub/state'",
                      "'/api/music-hub/action'"):
            self.assertIn(token, self.js)

    def test_live_http_read_only_contract(self):
        try:
            with urlopen(BASE_URL + "/api/library", timeout=12) as response:
                self.assertEqual(response.status, 200)
                library = json.load(response)
            with urlopen(BASE_URL + "/api/music-hub/state", timeout=6) as response:
                self.assertEqual(response.status, 200)
                state = json.load(response)
        except OSError as exc:
            self.skipTest("Running localhost Music Hub unavailable: " + str(exc))
        tracks = library.get("collection", [])
        self.assertEqual(len(tracks), 12352)
        self.assertEqual(sum(bool(str(t.get("genre") or "").strip()) for t in tracks), 1315)
        self.assertEqual(sum(bool(t.get("rating")) for t in tracks), 0)
        self.assertIsInstance(state.get("ratings"), dict)
        self.assertIsInstance(state.get("queue"), list)
        self.assertIsInstance(state.get("setlists"), list)


if __name__ == "__main__":
    unittest.main()
