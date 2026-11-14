"""Small, isolated playlist hierarchy, cover, and user-owned ordering tests."""
import json
import tempfile
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest import mock

import dashboard_http
import music_hub_backend as hub


class PlaylistIntegrity(unittest.TestCase):
    def test_hierarchy_retains_folders_and_all_real_leaves(self):
        make = lambda ident, name, parent, attribute, seq: SimpleNamespace(
            ID=ident, Name=name, ParentID=parent, Attribute=attribute, Seq=seq)
        records = [make(10, "Main", "root", 1, 0), make(11, "House", 10, 0, 2),
                   make(12, "Other", "root", 0, 3), make(13, "System", "root", -128, 4)]
        leaves, tree = dashboard_http.build_playlist_hierarchy(records)
        self.assertEqual({n["id"] for n in leaves}, {"11", "12"})
        self.assertEqual(tree[0]["kind"], "folder")
        self.assertEqual(tree[0]["children"][0]["id"], "11")

    def test_playlist_cover_picks_first_available_actual_track(self):
        make = lambda ident: SimpleNamespace(ID=ident, Name="List", ParentID="root", Attribute=0, Seq=1)
        leaves, tree = dashboard_http.build_playlist_hierarchy([make(21)])
        dashboard_http.apply_playlist_artwork(leaves, tree, {"21": {"tracks": [
            {"artwork": ""}, {"artwork": "/artwork/123/artwork_s.jpg"}]}})
        self.assertEqual(leaves[0]["artwork"], "/artwork/123/artwork_s.jpg")
        self.assertEqual(tree[0]["artwork"], leaves[0]["artwork"])

    def test_cached_playlist_tree_gains_actual_artwork_without_database_access(self):
        snapshot = {"source": "rekordbox-master-db", "collection": [],
                    "playlists": [{"id": "21", "name": "House", "kind": "playlist", "count": 1}],
                    "playlistTree": [{"id": "21", "name": "House", "kind": "playlist",
                                      "children": [], "count": 1}]}
        tracks = {"21": {"tracks": [{"id": "100", "artwork": "/artwork/aa/artwork_s.jpg"}]}}
        with mock.patch.object(dashboard_http, "_PLAYLIST_TRACKS_SNAPSHOT_READY", True), \
             mock.patch.object(dashboard_http, "_PLAYLIST_TRACKS_BY_ID", tracks):
            dashboard_http.ensure_playlist_tree(snapshot)
            self.assertEqual(snapshot["playlists"][0]["artwork"], "/artwork/aa/artwork_s.jpg")
            self.assertEqual(snapshot["playlistTree"][0]["artwork"], "/artwork/aa/artwork_s.jpg")

    def test_playlist_reorder_moves_only_existing_music_hub_tracks(self):
        with tempfile.TemporaryDirectory() as tmp:
            path = Path(tmp) / "hub.json"
            created = hub.apply_action({"action": "playlist.create", "name": "Local",
                                        "trackIds": ["1", "2", "3"]}, {"1", "2", "3"}, path)
            pid = created["playlists"][0]["id"]
            result = hub.apply_action({"action": "playlist.reorder", "playlistId": pid,
                                       "from": 0, "to": 2}, {"1", "2", "3"}, path)
            self.assertEqual(result["playlists"][0]["trackIds"], ["2", "3", "1"])
            before = path.read_bytes()
            for invalid in (-1, 3, True, "1"):
                with self.subTest(invalid=invalid), self.assertRaises(hub.HubError):
                    hub.apply_action({"action": "playlist.reorder", "playlistId": pid,
                                      "from": 0, "to": invalid}, {"1", "2", "3"}, path)
                self.assertEqual(path.read_bytes(), before)
            with self.assertRaises(hub.HubError):
                hub.apply_action({"action": "playlist.reorder", "playlistId": "3844007549",
                                  "from": 0, "to": 1}, {"1", "2", "3"}, path)
            self.assertEqual(path.read_bytes(), before)

    def test_full_native_length_playlist_copy_is_atomic_and_non_destructive(self):
        with tempfile.TemporaryDirectory() as tmp:
            path = Path(tmp) / "hub.json"
            ids = [str(i) for i in range(1, 1920)]
            collection = set(ids)
            state = hub.apply_action({"action": "playlist.create", "name": "House · Harmonic",
                                      "trackIds": ids}, collection, path)
            self.assertEqual(state["playlists"][0]["trackIds"], ids)
            before = path.read_bytes()
            with self.assertRaises(hub.HubError):
                hub.apply_action({"action": "playlist.create", "name": "Invalid",
                                  "trackIds": ids + ["999999999"]}, collection, path)
            self.assertEqual(path.read_bytes(), before)
            with self.assertRaises(hub.HubError):
                hub.apply_action({"action": "playlist.create", "name": "Too many",
                                  "trackIds": ["1"] * 6001}, collection, path)
            self.assertEqual(path.read_bytes(), before)
            with self.assertRaises(hub.HubError):
                hub.apply_action({"action": "setlist.create", "name": "Set",
                                  "trackIds": ids[:251]}, collection, path)
            self.assertEqual(path.read_bytes(), before)


if __name__ == "__main__":
    unittest.main()
