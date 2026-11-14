"""Read-only contract tests for live DJ suggestions and connected-music UI.

Does not start playback, create bookmarks, contact a music provider, or
change any user's Rekordbox or Music Hub state.
"""
from __future__ import annotations

import json
from pathlib import Path
import unittest
from urllib.request import urlopen


ROOT = Path(__file__).resolve().parents[1]
BASE = "http://127.0.0.1:18769"


class MusicHubHarmonicsConnections(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.html = (ROOT / "music-hub" / "index.html").read_text("utf-8")
        cls.js = (ROOT / "music-hub" / "app.js").read_text("utf-8")
        cls.css = (ROOT / "music-hub" / "styles.css").read_text("utf-8")
        cls.native = (ROOT / "music-hub" / "native" / "MusicHub.swift").read_text("utf-8")

    def test_miniature_harmonic_rail_directly_after_decks(self):
        self.assertIn('id="harmonic-rail"', self.html)
        self.assertIn('id="harmonic-rail-scroll"', self.html)
        self.assertIn("shell.insertBefore($('harmonic-rail'),performance.nextSibling)", self.js)
        for text in ("/api/transition-candidates", "renderHarmonicRail", "harmonicReference",
                     "STAGED PREVIEW — NOT LOADED", "data-rail-queue", "data-rail-stage",
                     "railReferenceId", "railRequest"):
            self.assertIn(text, self.js)
        self.assertIn(".harmonic-pick", self.css)
        self.assertIn(".harmonic-rail-scroll", self.css)

    def test_live_ref_is_not_guessed_from_nonplaying_song(self):
        for snippet in ("playback unconfirmed", "not loaded", "Playing local preview",
                        "Selected library track · preview"):
            self.assertIn(snippet, self.js)
        self.assertNotIn("Math.random()", self.js)

    def test_official_provider_ui_without_fake_private_sync(self):
        for token in ("id=\"provider-dialog\"", "id=\"provider-url\"",
                      "id=\"provider-embed-container\"", "id=\"provider-link-list\""):
            self.assertIn(token, self.html)
        for token in ("/api/music-hub/providers/links", "Saved provider bookmark",
                      "link saved; contents not synced", "open.spotify.com/embed", "embed.music.apple.com",
                      "w.soundcloud.com/player/", "sandbox", "trustedProviderUrl"):
            self.assertIn(token, self.js + self.html)
        self.assertIn("Streaming audio is not downloadable as MP3", self.html)
        self.assertNotIn("spotifydownloader", self.js.lower())
        self.assertNotIn("yt-dlp", self.js.lower())

    def test_native_player_allows_only_known_embedded_music_hosts(self):
        for token in ("isOfficialMusicEmbed", "open.spotify.com", "embed.music.apple.com",
                      "w.soundcloud.com", "navigationAction.targetFrame?.isMainFrame == false"):
            self.assertIn(token, self.native)
        self.assertIn("NSWorkspace.shared.open", self.native)

    def test_real_live_library_and_provider_api(self):
        try:
            with urlopen(BASE + "/api/library", timeout=10) as r:
                library = json.load(r)
            with urlopen(BASE + "/api/music-hub/providers/status", timeout=5) as r:
                status = json.load(r)
            with urlopen(BASE + "/api/music-hub/providers/links", timeout=5) as r:
                links = json.load(r)
        except OSError as exc:
            self.skipTest(f"Music Hub local backend unavailable: {exc}")
        self.assertGreaterEqual(len(library.get("collection", [])), 12000)
        self.assertEqual(set(status.get("providers", {})), {"apple_music", "soundcloud", "spotify"})
        self.assertFalse(status["download"]["enabled"])
        self.assertTrue(all(not row["connected"] for row in status["providers"].values()))
        self.assertIsInstance(links["links"], list)


if __name__ == "__main__":
    unittest.main()
