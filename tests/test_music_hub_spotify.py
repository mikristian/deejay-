"""Offline contract tests for Spotify OAuth and authorized metadata."""
import os
import unittest
from unittest import mock
from urllib.parse import parse_qs, urlparse

import music_hub_spotify as spotify


class SpotifyTests(unittest.TestCase):
    def setUp(self):
        spotify._pending.clear()
        spotify._access = None
        spotify._account = None
        spotify._expires = 0
        self.env = mock.patch.dict(os.environ, {spotify.CLIENT_ENV: "a" * 32})
        self.env.start()
        self.addCleanup(self.env.stop)

    def test_missing_config_and_pkce(self):
        with mock.patch.dict(os.environ, {spotify.CLIENT_ENV: "invalid"}):
            self.assertFalse(spotify.status()["configured"])
            with self.assertRaises(spotify.SpotifyError):
                spotify.connect()
        url = spotify.connect()["authUrl"]
        params = parse_qs(urlparse(url).query)
        self.assertEqual(params["code_challenge_method"], ["S256"])
        self.assertEqual(params["scope"], [spotify.SCOPES])
        self.assertEqual(params["redirect_uri"], [spotify.REDIRECT])
        self.assertNotIn("code_verifier", params)

    def test_callback_rejects_invalid_expired_replay_and_denial(self):
        with self.assertRaises(spotify.SpotifyError):
            spotify.callback({"state": ["invalid"], "code": ["secret"]})
        state = parse_qs(urlparse(spotify.connect()["authUrl"]).query)["state"][0]
        with mock.patch.object(spotify.time, "monotonic", return_value=float("inf")):
            with self.assertRaises(spotify.SpotifyError):
                spotify.callback({"state": [state], "code": ["secret"]})
        state = parse_qs(urlparse(spotify.connect()["authUrl"]).query)["state"][0]
        with self.assertRaises(spotify.SpotifyError):
            spotify.callback({"state": [state], "error": ["access_denied"]})
        with self.assertRaises(spotify.SpotifyError):
            spotify.callback({"state": [state], "code": ["replay"]})

    def test_callback_validates_profile_then_keychain(self):
        state = parse_qs(urlparse(spotify.connect()["authUrl"]).query)["state"][0]
        def fetch(url, **kwargs):
            if url.endswith("/api/token"):
                self.assertIn("code_verifier", kwargs["data"])
                return {"access_token": "access", "refresh_token": "refresh", "token_type": "Bearer", "expires_in": 3600}
            return {"id": "user1", "display_name": "Test User"}
        with mock.patch.object(spotify, "_json_request", side_effect=fetch), mock.patch.object(spotify, "_keychain") as keychain:
            spotify.callback({"state": [state], "code": ["code"]})
            keychain.assert_called_once_with("write", "refresh")
            self.assertTrue(spotify.status()["connected"])
            self.assertEqual(spotify.status()["account"]["id"], "user1")

    def test_owned_collab_filter_and_pagination(self):
        rows = [{"id": "A" * 22, "name": "Mine", "owner": {"id": "user1"}},
                {"id": "B" * 22, "name": "Shared", "owner": {"id": "other"}, "collaborative": True},
                {"id": "C" * 22, "name": "Public", "owner": {"id": "other"}, "collaborative": False}]
        with mock.patch.object(spotify, "_authorized", return_value=("token", {"id": "user1"})), mock.patch.object(spotify, "_page", return_value={"items": rows, "next": "yes", "total": 120}):
            data = spotify.playlists()
        self.assertEqual(len(data["items"]), 2)
        self.assertEqual(data["nextOffset"], 3)

    def test_playlist_denial_validation_and_items_2026_endpoint(self):
        pid = "A" * 22
        with self.assertRaises(spotify.SpotifyError):
            spotify.playlist_items("https://evil.test/" + pid)
        requests = []
        def pages(path, token, limit=100, offset=0):
            requests.append((path, limit, offset))
            if path == "/v1/me/playlists":
                return {"items": [{"id": pid, "owner": {"id": "user1"}}], "next": None}
            return {"items": [{"item": {"id": "B" * 22, "name": "Song", "artists": [{"name": "Artist"}]}}], "next": None}
        with mock.patch.object(spotify, "_authorized", return_value=("token", {"id": "user1"})), mock.patch.object(spotify, "_page", side_effect=pages):
            result = spotify.playlist_items(pid)
            self.assertEqual(result["items"][0]["title"], "Song")
            self.assertTrue(any(path.endswith("/items") for path, _, _ in requests))
            self.assertFalse(any(path.endswith("/tracks") for path, _, _ in requests))
            with mock.patch.object(spotify, "_page", return_value={"items": [{"id": pid, "owner": {"id": "different"}}], "next": None}):
                with self.assertRaises(spotify.SpotifyError) as caught:
                    spotify.playlist_items(pid)
                self.assertEqual(caught.exception.status, 403)

    def test_rate_limit_and_endpoint_allowlist(self):
        from urllib.error import HTTPError
        for code, expected in ((429, 429), (401, 401), (403, 403)):
            with self.subTest(code=code), mock.patch.object(spotify, "urlopen", side_effect=HTTPError("https://api.spotify.com/v1/me", code, "", {}, None)):
                with self.assertRaises(spotify.SpotifyError) as caught:
                    spotify._json_request("https://api.spotify.com/v1/me", bearer="token")
                self.assertEqual(caught.exception.status, expected)
        with self.assertRaises(spotify.SpotifyError):
            spotify._json_request("https://api.spotify.com.evil.test/v1/me")

    def test_local_matching_attached_without_stream_url(self):
        items = [{"id": "A" * 22, "title": "Local Song", "artists": ["Local Artist"],
                  "url": "https://open.spotify.com/track/" + "A" * 22}]
        with mock.patch("dashboard_http.get_rekordbox_library_fast", return_value={
            "collection": [{"id": 91, "title": "Local Song", "artist": "Local Artist", "path": "/music/song.mp3"}]}), mock.patch.object(spotify.os.path, "isfile", return_value=True):
            matched = spotify._attach_local_matches(items)
        self.assertEqual(matched[0]["localMatch"]["trackId"], "91")
        self.assertEqual(matched[0]["localMatch"]["status"], "matched")
        self.assertNotIn("downloadUrl", matched[0])

    def test_search_uses_authorized_official_api_and_local_matching(self):
        seen = []
        def fetch(url, **kwargs):
            seen.append((url, kwargs))
            return {"tracks": {"items": [{"id": "B" * 22, "name": "Found", "artists": [{"name": "Artist"}]}], "total": 1}}
        with mock.patch.object(spotify, "_authorized", return_value=("token", {"id": "u"})), \
             mock.patch.object(spotify, "_json_request", side_effect=fetch), \
             mock.patch.object(spotify, "_attach_local_matches", side_effect=lambda rows: rows):
            result = spotify.search("house & beats")
        self.assertEqual(result["items"][0]["title"], "Found")
        self.assertIn("/v1/search?", seen[0][0])
        self.assertIn("house+%26+beats", seen[0][0])
        self.assertEqual(seen[0][1]["bearer"], "token")
        self.assertFalse(result["downloadAvailable"])
        with self.assertRaises(spotify.SpotifyError):
            spotify.search("a" * 151)


if __name__ == "__main__":
    unittest.main()
