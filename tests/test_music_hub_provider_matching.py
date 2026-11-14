"""Contract: streaming metadata may match local files, never download them."""
import time
import tempfile
import unittest
from pathlib import Path
from music_hub_provider_matching import LocalTrackMatcher, normalized


def t(id, title, artist, **kw):
    return {"id": str(id), "title": title, "artist": artist, **kw}


class LocalMatching(unittest.TestCase):
    def test_identical_artist_and_title_is_an_exact_match(self):
        index = LocalTrackMatcher([t(100,"After Hours", "The Weeknd")])
        self.assertEqual(index.match({"name": "After Hours", "artists": [{"name":"The Weeknd"}]}),
                         {"status":"matched","trackId":"100","method":"exact","candidateCount":1})

    def test_unicode_and_nonrecording_labels(self):
        index = LocalTrackMatcher([t(101,"Déjà-Vu (Official Audio)","Beyoncé")])
        match = index.match({"name":"Deja Vu", "artists":[{"name":"Beyonce"}]})
        self.assertEqual(match["status"], "matched")
        self.assertEqual(match["method"], "normalized")
        self.assertEqual(normalized("Don’t"), normalized("Don't"))

    def test_does_not_conflate_edits_remixes_live_or_remasters(self):
        index = LocalTrackMatcher([t(101,"One More Time (Radio Edit)","Daft Punk")])
        for title in ("One More Time", "One More Time (Club Remix)",
                      "One More Time (Live)", "One More Time (Remastered)",
                      "One More Time (Acoustic)"):
            with self.subTest(title=title):
                self.assertEqual(index.match({"name":title,"artists":[{"name":"Daft Punk"}]})["status"],
                                 "not_in_local_library")

    def test_identical_duplicates_are_ambiguous(self):
        index = LocalTrackMatcher([t(1,"Song","Artist"), t(2,"Song","Artist")])
        result = index.match({"name":"Song","artists":[{"name":"Artist"}]})
        self.assertEqual(result["status"], "ambiguous")
        self.assertEqual(result["candidateCount"], 2)
        self.assertIsNone(result["trackId"])

    def test_duplicate_library_rows_pointing_to_one_actual_file_are_one_safe_match(self):
        with tempfile.TemporaryDirectory() as tmp:
            file = Path(tmp) / "one-recording.mp3"
            file.write_bytes(b"just a test")
            rows = [t(30,"Song","Artist",path=str(file)),t(31,"Song","Artist",path=str(file))]
            match = LocalTrackMatcher(rows).match({"name":"Song","artists":[{"name":"Artist"}]})
            self.assertEqual(match["status"],"matched")
            self.assertEqual(match["trackId"],"30")
            self.assertEqual(match["candidateCount"],2)
            self.assertEqual(match["method"],"exact_same_local_file")

    def test_duplicate_rows_pointing_to_different_available_files_stay_ambiguous(self):
        with tempfile.TemporaryDirectory() as tmp:
            a,b=Path(tmp)/"studio.mp3",Path(tmp)/"live.mp3"
            a.write_bytes(b"studio");b.write_bytes(b"live")
            rows=[t(30,"Song","Artist",path=str(a)),t(31,"Song","Artist",path=str(b))]
            match=LocalTrackMatcher(rows).match({"name":"Song","artists":[{"name":"Artist"}]})
            self.assertEqual(match["status"],"ambiguous")
            self.assertIsNone(match["trackId"])

    def test_duplicate_rows_with_one_available_file_and_one_stale_path(self):
        with tempfile.TemporaryDirectory() as tmp:
            available = Path(tmp)/"real-song.mp3"
            available.write_bytes(b"real file")
            missing = str(Path(tmp)/"missing-file.mp3")
            index=LocalTrackMatcher([t(30,"Song","Artist",path=missing),
                                     t(31,"Song","Artist",path=str(available))])
            result=index.match({"name":"Song","artists":[{"name":"Artist"}]})
            self.assertEqual(result["status"],"matched")
            self.assertEqual(result["trackId"],"31")

    def test_skip_sampler_missing_artist_invalid_and_missing_file(self):
        index = LocalTrackMatcher([t(1,"Noise","DJ",is_sampler=True),t(2,"Track","",path="/tmp/a"),
                                   t(3,"Available","DJ",path="/tmp/missing"),t(4,"Exists","DJ",path="/tmp/found")],
                                  file_available=lambda r: r.get("path")=="/tmp/found")
        self.assertEqual(index.indexed,1)
        self.assertEqual(index.match({"name":"Noise","artists":[{"name":"DJ"}]})["status"], "not_in_local_library")
        self.assertEqual(index.match({"name":"Exists","artists":[{"name":"DJ"}]})["trackId"], "4")
        self.assertEqual(index.match({"name":"", "artists":[]})["status"], "insufficient_metadata")
        self.assertEqual(index.match(None)["status"], "invalid")

    def test_artist_inequality_does_not_match(self):
        index = LocalTrackMatcher([t(1,"Breathe","The Prodigy")])
        self.assertEqual(index.match({"name":"Breathe","artists":[{"name":"Faith Hill"}]})["status"], "not_in_local_library")

    def test_featuring_credit_preserves_primary_artist(self):
        index = LocalTrackMatcher([t(1,"Forever", "Artist feat. Guest")])
        self.assertEqual(index.match({"name":"Forever","artists":[{"name":"Artist"},{"name":"Guest"}]})["trackId"],"1")

    def test_large_library_linear_once_and_bounded_batch(self):
        tracks = [t(i+1, f"DJ Song {i}", "Artist") for i in range(12352)]
        start = time.perf_counter()
        index = LocalTrackMatcher(tracks)
        self.assertEqual(index.indexed, len(tracks))
        items = [{"name":f"DJ Song {i}","artists":[{"name":"Artist"}]} for i in range(310)]
        matches = index.match_many(items)
        self.assertEqual(len(matches),250)
        self.assertEqual(matches[0]["trackId"],"1")
        self.assertTrue(all(m["status"]=="matched" for m in matches))
        self.assertLess(time.perf_counter()-start,3.0)


if __name__=="__main__":unittest.main()
