"""Read-only UI acceptance contracts for connected-to-local DJ workflows."""
import json
from pathlib import Path
import unittest
from urllib.request import urlopen


ROOT = Path(__file__).resolve().parents[1]


class ConnectedLocalActionsContract(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.js = (ROOT/"music-hub"/"app.js").read_text("utf-8")
        cls.html = (ROOT/"music-hub"/"index.html").read_text("utf-8")

    def test_accessible_explicit_connected_music_shortcut(self):
        self.assertIn('aria-keyshortcuts="Meta+Shift+M"', self.html)
        self.assertIn('data-provider-open="links"', self.html)
        self.assertIn('openProviderDialog(\'links\')', self.js)
        self.assertIn("$('provider-tab-links').focus()", self.js)

    def test_provider_local_actions_are_real_existing_library_only(self):
        self.assertIn('function localDjActions(match)', self.js)
        self.assertIn("match?.status!=='matched'", self.js)
        self.assertIn('!track(id)', self.js)
        for token in ('data-local-queue=', 'data-local-stage=', 'data-local-track=',
                      "hubAction('queue.add',{trackId:id})", 'stageDeck(Number(stage.dataset.localStage),id)'):
            self.assertIn(token, self.js)
        self.assertIn("if(!/^\\d+$/.test(id)||!track(id))", self.js)

    def test_playlist_copy_requires_explicit_click_and_local_matches_only(self):
        for token in ('Copy locally matched songs', 'matchedTrackIds',
                      "match?.status==='matched'", "hubAction('playlist.create'", 'trackIds:ids'):
            self.assertIn(token, self.js + self.html)

    def test_live_mac_app_metadata_is_read_only(self):
        try:
            with urlopen('http://127.0.0.1:18769/api/music-hub/apple-local/status',timeout=5) as response:
                status=json.load(response)
        except OSError as exc:
            self.skipTest(str(exc))
        self.assertTrue(status['available'])
        self.assertNotIn('token',status)
        self.assertNotIn('mp3',json.dumps(status).lower())


if __name__ == '__main__':
    unittest.main()
