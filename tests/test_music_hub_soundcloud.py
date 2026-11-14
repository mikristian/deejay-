"""SoundCloud metadata bridge: offline OAuth, pagination, and privacy checks."""
import os
import unittest
from unittest import mock
from urllib.parse import parse_qs, urlsplit

import music_hub_soundcloud as sc


class SoundCloudTests(unittest.TestCase):
    def setUp(self):
        sc._pending.clear()
        sc._access, sc._account, sc._expires = None, None, 0
        env = mock.patch.dict(os.environ, {sc.CLIENT_ENV: "test_client_123", sc.SECRET_ENV: "test_secret"})
        env.start()
        self.addCleanup(env.stop)

    def test_configuration_pkce_and_state_expiry(self):
        with mock.patch.dict(os.environ, {sc.SECRET_ENV: ""}):
            self.assertFalse(sc.status()["configured"])
            with self.assertRaises(sc.SoundCloudError):
                sc.connect()
        auth = sc.connect()
        params = parse_qs(urlsplit(auth["authUrl"]).query)
        self.assertEqual(params["code_challenge_method"], ["S256"])
        self.assertEqual(params["redirect_uri"], [sc.REDIRECT])
        self.assertNotIn("code_verifier", auth["authUrl"])
        with self.assertRaises(sc.SoundCloudError):
            sc.callback({"state": ["unrecognized"], "code": ["x"]})
        with mock.patch.object(sc.time, "monotonic", return_value=float("inf")):
            with self.assertRaises(sc.SoundCloudError):
                sc.callback({"state": params["state"], "code": ["x"]})

    def test_callback_and_single_use_refresh_rotation(self):
        state = parse_qs(urlsplit(sc.connect()["authUrl"]).query)["state"][0]
        calls = []
        def fetch(url, **kwargs):
            calls.append((url, kwargs))
            if url == sc.TOKEN_URL:
                return {"access_token": "PRIVATE_ACCESS", "refresh_token": "PRIVATE_REFRESH", "expires_in": 1800}
            return {"id": 77, "username": "DJ"}
        with mock.patch.object(sc, "_request", side_effect=fetch), mock.patch.object(sc, "_keychain") as keychain:
            self.assertTrue(sc.callback({"state": [state], "code": ["authorization-code"]}))
            keychain.assert_called_once_with("write", "PRIVATE_REFRESH")
            self.assertNotIn("PRIVATE_ACCESS", str(sc.status()))
            self.assertNotIn("PRIVATE_REFRESH", str(sc.status()))
            sc._access = None
            keychain.reset_mock()
            keychain.side_effect = lambda op, value=None: "OLD_REFRESH" if op == "read" else True
            self.assertEqual(sc._authorized()[1]["id"], "77")
            self.assertEqual(keychain.call_args_list[1], mock.call("write", "PRIVATE_REFRESH"))
            self.assertEqual(calls[-2][1]["data"]["refresh_token"], "OLD_REFRESH")
        with self.assertRaises(sc.SoundCloudError):
            sc.callback({"state": [state], "code": ["replay"]})

    def test_likes_match_only_present_local_file(self):
        rows = [{"id": 11, "title": "Song", "user": {"username": "Artist"}},
                {"id": 12, "title": "Lost", "user": {"username": "Artist"}}]
        with mock.patch.object(sc, "_page", return_value=(rows, None)), mock.patch(
            "dashboard_http.get_rekordbox_library_fast", return_value={"collection": [
                {"id": 5, "title": "Song", "artist": "Artist", "path": "/music/song.mp3"},
                {"id": 6, "title": "Lost", "artist": "Artist", "path": "/music/lost.mp3"}]}), mock.patch.object(sc.os.path, "isfile", side_effect=lambda p: p.endswith("song.mp3")):
            result = sc.likes()
        self.assertEqual(result["items"][0]["localMatch"]["trackId"], "5")
        self.assertIsNone(result["items"][1]["localMatch"]["trackId"])
        self.assertFalse(result["downloadAvailable"])

    def test_url_validation_prevents_token_exfiltration(self):
        for url in ("https://api.soundcloud.com.evil.test/me", "http://api.soundcloud.com/me",
                    "https://api.soundcloud.com/redirect", "https://api.soundcloud.com@evil.test/me",
                    "https://api.soundcloud.com/me/playlists/123"):
            with self.subTest(url=url):
                self.assertFalse(sc._allowed_url(url))
        with self.assertRaises(sc.SoundCloudError):
            sc._page("/me/likes/tracks", "https://api.soundcloud.com.evil.test/me/likes/tracks")
        with mock.patch.object(sc, "_authorized", return_value=("ACCESS", {})), mock.patch.object(sc, "_request", return_value={
            "collection": [], "next_href": "https://evil.test/steal?token=secret"}):
            with self.assertRaises(sc.SoundCloudError):
                sc._page("/me/likes/tracks")

    def test_loopback_host_origin_and_fetch_site(self):
        sc.validate_local_request("127.0.0.1", "127.0.0.1:18769")
        sc.validate_local_request("::1", "127.0.0.1:18769", callback_request=True,
                                  fetch_site="cross-site")
        for params in ({"ip": "192.168.1.1", "host": "127.0.0.1:18769"},
                       {"ip": "127.0.0.1", "host": "evil.test:18769"},
                       {"ip": "127.0.0.1", "host": "localhost:18769", "callback_request": True},
                       {"ip": "127.0.0.1", "host": "127.0.0.1:18769", "origin": "https://evil.test"},
                       {"ip": "127.0.0.1", "host": "127.0.0.1:18769", "fetch_site": "cross-site"}):
            with self.subTest(params=params), self.assertRaises(sc.SoundCloudError) as caught:
                sc.validate_local_request(**params)
            self.assertEqual(caught.exception.status, 403)

    def test_pagination_and_playlist_metadata(self):
        data = {"collection": [{"id": 42, "title": "House", "track_count": 2,
                                "tracks": [{"id": 9, "title": "Beat", "user": {"username": "DJ"}}]}],
                "next_href": "https://api.soundcloud.com/me/playlists?cursor=abc&linked_partitioning=true"}
        with mock.patch.object(sc, "_authorized", return_value=("TOKEN", {})), mock.patch.object(sc, "_request", return_value=data), mock.patch.object(sc, "_attach_matches", side_effect=lambda x: x):
            page = sc.playlists()
            self.assertEqual(page["items"][0]["name"], "House")
            self.assertEqual(page["items"][0]["tracks"][0]["title"], "Beat")
            self.assertIn("cursor=abc", page["nextHref"])
            with self.assertRaises(sc.SoundCloudError):
                sc._page("/me/playlists", "https://api.soundcloud.com/me/likes/tracks?cursor=abc")

    def test_official_soundcloud_next_href_playlist_cursor(self):
        # Their published playlist pagination example legitimately changes
        # /me/playlists into /playlists?show_tracks=false&page_size=25&cursor=...
        url = "https://api.soundcloud.com/playlists?show_tracks=false&page_size=25&cursor=abc"
        with mock.patch.object(sc, "_authorized", return_value=("ACCESS", {})), mock.patch.object(
            sc, "_request", return_value={"collection": [{"id": 5}], "next_href": url}
        ) as request:
            rows, next_href = sc._page("/me/playlists")
            self.assertEqual(rows, [{"id": 5}])
            self.assertEqual(next_href, url)
            sc._page("/me/playlists", url)
            self.assertEqual(request.call_args.args[0], url)
            self.assertIn("show_tracks=false", request.call_args_list[0].args[0])
        for invalid in (
            "https://api.soundcloud.com/playlists?cursor=abc&access_token=SECRET",
            "https://api.soundcloud.com/playlists?cursor=abc&cursor=duplicate",
            "https://api.soundcloud.com.evil.test/playlists?cursor=abc",
            "https://api.soundcloud.com/me/likes/tracks?cursor=abc",
            "https://api.soundcloud.com/playlists?cursor=abc&page_size=invalid",
            "https://api.soundcloud.com/playlists?cursor=abc&show_tracks=secret",
            "https://api.soundcloud.com:bad/playlists?cursor=abc",
        ):
            with self.subTest(url=invalid), self.assertRaises(sc.SoundCloudError):
                sc._page("/me/playlists", invalid)

    def test_playlist_items_never_returns_audio_or_uses_invalid_ids(self):
        with mock.patch.object(sc, "_authorized", return_value=("ACCESS", {})), mock.patch.object(
            sc, "_request", return_value={"collection": [
                {"id": 55, "title": "Beat", "user": {"username": "Artist"},
                 "permalink_url": "https://soundcloud.com/artist/beat"}]}
        ), mock.patch.object(sc, "_attach_matches", side_effect=lambda x: x):
            items = sc.playlist_items("12345")
        self.assertEqual(items["playlistId"], "12345")
        self.assertEqual(items["items"][0]["artist"], "Artist")
        self.assertEqual(items["items"][0]["title"], "Beat")
        self.assertFalse(items["downloadAvailable"])
        for bad in ("abc", "1/../../../me", "1?auth=secret", ""):
            with self.assertRaises(sc.SoundCloudError):
                sc.playlist_items(bad)

    def test_artist_download_permission_is_only_a_hint_for_official_website(self):
        downloadable = sc._track({"id": 11, "title": "Original upload", "downloadable": True,
                                   "permalink_url": "https://soundcloud.com/dj/original"})
        blocked = sc._track({"id": 12, "title": "Stream only", "downloadable": False})
        unspecified = sc._track({"id": 13, "title": "Unknown"})
        self.assertTrue(downloadable["creatorDownloadEnabled"])
        self.assertFalse(blocked["creatorDownloadEnabled"])
        self.assertFalse(unspecified["creatorDownloadEnabled"])
        for row in (downloadable, blocked, unspecified):
            self.assertNotIn("download_url", row)
            self.assertNotIn("stream_url", row)
            self.assertNotIn("mp3", row)

    def test_disconnect_clears_everything_without_api(self):
        sc._pending["state"] = ("verifier", 123)
        sc._access, sc._expires, sc._account = "SECRET", 999999, {"id": "someone"}
        with mock.patch.object(sc, "_keychain", return_value=True) as keychain, mock.patch.object(sc, "_request", side_effect=AssertionError("offline")):
            result = sc.disconnect()
        keychain.assert_called_once_with("delete")
        self.assertEqual(result, {"configured": True, "connected": False, "account": None})
        self.assertEqual(sc._pending, {})
        self.assertIsNone(sc._access)
        self.assertIsNone(sc._account)
        self.assertEqual(sc._expires, 0)


if __name__ == "__main__":
    unittest.main()
