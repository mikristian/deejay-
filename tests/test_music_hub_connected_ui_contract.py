"""Safe static contracts for the native Music Hub's connected-service panel.

This suite never signs in, calls a third-party service, downloads audio,
modifies Rekordbox, changes Music Hub state or sends a MIDI message.
"""
from __future__ import annotations

from collections import Counter
from html.parser import HTMLParser
from pathlib import Path
import re
import unittest


ROOT = Path(__file__).resolve().parents[1] / "music-hub"


class _ElementIds(HTMLParser):
    def __init__(self):
        super().__init__()
        self.ids = []

    def handle_starttag(self, tag, attrs):
        self.ids.extend(value for key, value in attrs if key == "id")


class ConnectedMusicUiContracts(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.js = (ROOT / "app.js").read_text(encoding="utf-8")
        cls.html = (ROOT / "index.html").read_text(encoding="utf-8")
        cls.css = (ROOT / "styles.css").read_text(encoding="utf-8")
        parser = _ElementIds()
        parser.feed(cls.html)
        cls.ids = parser.ids

    def test_no_duplicate_dom_ids(self):
        duplicates = [name for name, count in Counter(self.ids).items() if count > 1]
        self.assertEqual(duplicates, [])

    def test_every_connected_service_control_has_real_html_element(self):
        # The Streaming Links panel used to reference these IDs in JavaScript
        # before adding buttons to HTML, preventing the entire panel opening.
        required = {
            "provider-dialog", "provider-open", "provider-close",
            "provider-panel-links", "provider-panel-spotify",
            "provider-panel-apple_music", "provider-panel-soundcloud",
            "spotify-connect", "spotify-disconnect", "spotify-recheck",
            "spotify-library", "spotify-library-list", "spotify-copy-matched",
            "soundcloud-connect", "soundcloud-disconnect", "soundcloud-recheck",
            "soundcloud-show-playlists", "soundcloud-show-likes",
            "soundcloud-library-list", "soundcloud-more", "soundcloud-playlist-more",
            "soundcloud-playlist-detail", "soundcloud-playlist-tracks",
            "apple-local-search", "apple-local-playlists", "apple-local-more",
            "apple-local-copy-matched", "provider-link-form", "provider-embed-container",
        }
        self.assertEqual(sorted(required - set(self.ids)), [])
        for name in ("spotify-disconnect", "soundcloud-disconnect", "soundcloud-more",
                     "soundcloud-playlist-more", "apple-local-more"):
            self.assertIn(f"$('{name}')", self.js)

    def test_account_sign_in_and_disconnect_are_explicit(self):
        for provider in ("spotify", "soundcloud"):
            for operation in ("status", "connect", "disconnect"):
                self.assertIn(f"/api/music-hub/{provider}/{operation}", self.js)
        self.assertIn("authUrl", self.js)
        self.assertIn("window.open", self.js)
        self.assertNotIn("client_secret", self.html.lower())
        self.assertNotIn("refresh_token", self.html.lower())

    def test_soundcloud_pages_are_manually_paginated_and_never_downloaded(self):
        for token in ("soundcloudCollectionCursor", "soundcloudPlaylistCursor",
                      "soundcloud-more", "soundcloud-playlist-more", "encodeURIComponent"):
            self.assertIn(token, self.js)
        self.assertIn("/api/music-hub/soundcloud/playlist-items?id=", self.js)
        self.assertNotIn("yt-dlp", self.js.lower())
        self.assertNotIn("soundcloud-downloader", self.js.lower())

    def test_mac_music_browser_and_copy_stay_separate(self):
        for token in ("apple-local-more", "appleLocalHasMore", "MATCH_CAP=250",
                      "localMatch", "Copy locally matched songs", "playlist.create"):
            self.assertIn(token, self.js + self.html)
        # Copy must only use an explicit local ID; a Spotify/Apple streaming
        # track's metadata alone must not be assigned a Rekordbox track ID.
        self.assertRegex(self.js, r"match\?\.status\s*===\s*'matched'")


if __name__ == "__main__":
    unittest.main()
