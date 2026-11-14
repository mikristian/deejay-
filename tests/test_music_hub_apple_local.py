"""No Apple Music app launch, playback or protected audio downloads in tests."""
import json
import subprocess
import tempfile
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch

import music_hub_apple_local as apple


class TestAppleLocalBridge(unittest.TestCase):
    def test_inert_when_music_not_running(self):
        result = apple._call("status",runner=lambda *a,**kw:SimpleNamespace(returncode=0,stdout='{"running":false,"available":true}',stderr=""))
        self.assertFalse(result["running"])
        self.assertNotIn("tracks", result)

    def test_status_and_safe_automation_tool_invocation(self):
        calls = []
        def fake(args,**kw):
            calls.append((args,kw))
            return SimpleNamespace(returncode=0,stdout='{"running":true,"playlistCount":120}',stderr="")
        self.assertEqual(apple._call("status",runner=fake)["playlistCount"],120)
        self.assertEqual(calls[0][0][:4],["/usr/bin/osascript","-l","JavaScript","-e"])
        self.assertLessEqual(calls[0][1]["timeout"],12)

    def test_ids_and_page_limits_reject_injection_and_heavy_scans(self):
        for bad in ("", "ABC", "0000000000000000; rm -rf ~/", "../secrets", "\n" * 17):
            with self.subTest(bad=bad), self.assertRaises(apple.AppleLocalError):
                apple.playlist_items(bad)
        for offset,limit in ((-1,50),(0,101),(20001,1),(0,0)):
            with self.subTest(args=(offset,limit)),self.assertRaises(apple.AppleLocalError):
                apple.playlist_items("ABCDABCDABCDABCD",offset,limit)

    def test_metadata_match_does_not_claim_file_download(self):
        source={"running":True,"playlistId":"ABCDABCDABCDABCD","total":2,"offset":0,"limit":50,
                "tracks":[{"id":"APPLE1","name":"Song (Official Audio)","artist":"Artist","kind":"Apple Music AAC audio file"},
                          {"id":"APPLE2","name":"Other Song","artist":"Artist"}]}
        with tempfile.TemporaryDirectory() as tmp:
            path = Path(tmp) / "local-song.mp3"
            path.write_bytes(b"test-only")
            with patch.object(apple,"_call",return_value=source):
                data=apple.playlist_items("ABCDABCDABCDABCD",collection=[{"id":"101","title":"Song","artist":"Artist","is_sampler":False,"path":str(path)}])
        self.assertEqual(data["tracks"][0]["localMatch"]["trackId"],"101")
        self.assertEqual(data["tracks"][1]["localMatch"]["status"],"not_in_local_library")
        self.assertNotIn("mp3",str(data["tracks"][0]).lower())

    def test_database_metadata_match_is_not_false_local_file(self):
        source={"running":True,"tracks":[{"id":"CLOUD1","name":"Song","artist":"Artist"}]}
        with patch.object(apple,"_call",return_value=source):
            data=apple.playlist_items("ABCDABCDABCDABCD",collection=[{"id":"1","title":"Song","artist":"Artist","path":"/this/path/is/not/there.mp3"}])
        self.assertEqual(data["tracks"][0]["localMatch"]["status"],"local_file_unavailable")
        self.assertIsNone(data["tracks"][0]["localMatch"]["trackId"])

    def test_automation_failure_has_safe_message_not_system_paths(self):
        def fail(*a,**kw):return SimpleNamespace(returncode=1,stdout="",stderr="/private/var/very/secret/filename")
        with self.assertRaises(apple.AppleLocalError) as err:apple._call("status",runner=fail)
        self.assertNotIn("secret",str(err.exception))
        self.assertEqual(err.exception.status,503)
        def timeout(*a,**kw):raise subprocess.TimeoutExpired(cmd="osascript",timeout=12)
        with self.assertRaises(apple.AppleLocalError) as err:apple._call("status",runner=timeout)
        self.assertEqual(err.exception.status,503)


if __name__=="__main__":unittest.main()
