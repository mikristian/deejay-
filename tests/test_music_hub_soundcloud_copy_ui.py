"""Read-only SoundCloud copy contracts; the UI only copies existing local IDs."""
from collections import Counter
from html.parser import HTMLParser
from pathlib import Path
import re
import unittest


ROOT = Path(__file__).resolve().parents[1] / "music-hub"


class IdParser(HTMLParser):
    def __init__(self):
        super().__init__()
        self.ids = []

    def handle_starttag(self, tag, attrs):
        self.ids.extend(value for key, value in attrs if key == "id")


class SoundCloudCopyUiContract(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.js = (ROOT / "app.js").read_text("utf-8")
        cls.html = (ROOT / "index.html").read_text("utf-8")

    def test_both_copy_panels_exist_and_are_explicitly_wired(self):
        parser = IdParser()
        parser.feed(self.html)
        self.assertFalse([key for key, count in Counter(parser.ids).items() if count > 1])
        for view in ("soundcloud-likes", "soundcloud-playlist"):
            for suffix in ("copy-panel", "copy-count", "copy-limit", "copy-matched"):
                self.assertIn(f"{view}-{suffix}", parser.ids)
            self.assertIn(f"copyProviderMatches('{view}')", self.js)
        self.assertIn("Copy matched tracks from loaded songs", self.html)

    def test_first_250_loaded_items_and_verified_local_ids_only(self):
        self.assertIn("MATCH_CAP=250", self.js)
        self.assertIn("items.slice(0,Math.max(0,MATCH_CAP-copy.rows.length))", self.js)
        self.assertIn("for(const item of rows.slice(0,MATCH_CAP))", self.js)
        self.assertIn("match?.status==='matched'", self.js)
        self.assertIn("!seen.has(id)", self.js)
        self.assertIn("seen.add(id);ids.push(id)", self.js)
        self.assertIn("ids.filter(id=>Boolean(track(id)))", self.js)

    def test_one_manual_hub_create_and_unavailable_states(self):
        body = self.js.split("async function copyProviderMatches(provider)", 1)[1].split("const localMatchBadge=", 1)[0]
        self.assertEqual(body.count("hubAction('playlist.create'"), 1)
        self.assertIn("trackIds:copyIds", body)
        self.assertIn("isSoundCloud&&!soundcloudConnected", body)
        self.assertIn("state.pending||state.saved", body)
        self.assertIn("!model.hubAvailable", body)
        self.assertIn("if(!copyIds.length)return", body)
        render = self.js.split("function renderProviderCopy(provider)", 1)[1].split("async function copyProviderMatches", 1)[0]
        self.assertIn("soundcloudCollectionCursor", render)
        self.assertIn("soundcloudPlaylistCursor", render)
        self.assertIn("'Copy matched tracks from loaded songs ('", render)
        self.assertNotIn("fetch('https://api.soundcloud.com", self.js)


if __name__ == "__main__":
    unittest.main()
