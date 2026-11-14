"""Focused checks for Music Hub's desktop instrument launcher."""

import io
import json
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch

import instrument_launcher as launcher


class FakeRequest:
    def __init__(self, body=b"", headers=None, client="127.0.0.1"):
        self.client_address = (client, 12345)
        self.headers = {"Host": "127.0.0.1:18769", "Content-Type": "application/json",
                        "Content-Length": str(len(body)), **(headers or {})}
        self.rfile = io.BytesIO(body)
        self.wfile = io.BytesIO()
        self.status = None

    def send_response(self, status):
        self.status = status

    def send_header(self, *args):
        pass

    def end_headers(self):
        pass

    def response(self):
        return json.loads(self.wfile.getvalue())


class InstrumentLauncherTests(unittest.TestCase):
    def test_known_installed_bundle_metadata(self):
        with patch.object(launcher, "_bridge_json", return_value=None):
            items = launcher.list_instruments()["items"]
        self.assertEqual(set(item["id"] for item in items), set(launcher.CATALOG))
        for item in items:
            self.assertEqual(item["connection"]["ableton"], "not_configured")
            self.assertEqual(item["connection"]["rekordbox"], "not_configured")
        self.assertEqual(launcher.CATALOG["asr10-sampler"][2], "com.mikristian.asr10samplerlab")

    def test_real_bridge_status_maps_to_only_three_samplers(self):
        status = {"rekordbox_connected": True, "ableton_midi_available": True,
                  "ableton_midi_port": "FLX4 Live 2D to Ableton"}
        samplers = {"samplers": [{"id": route[0], "path": str(launcher.CATALOG[app_id][1]),
                                  "installed": True, "running": True}
                                 for app_id, route in launcher._SAMPLER_ROUTES.items()]}
        with patch.object(launcher, "_bridge_json", side_effect=[status, samplers]), patch.object(
            launcher, "_processes", return_value=[]
        ), patch.object(launcher, "_bundle_executable", return_value=Path("/valid/executable")):
            inventory = launcher.list_instruments()
        self.assertTrue(inventory["bridgeAvailable"])
        self.assertTrue(inventory["rekordboxBridgeConnected"])
        self.assertTrue(inventory["abletonMidiOutputAvailable"])
        for app_id, channel, note_range in (("maschine-lab", 1, "36–51"),
                                            ("vintage-sampler", 2, "36–51"),
                                            ("asr10-sampler", 3, "60–75")):
            item = next(i for i in inventory["items"] if i["id"] == app_id)
            self.assertTrue(item["running"])
            self.assertTrue(item["canSendMidi"])
            self.assertEqual(item["midiChannel"], channel)
            self.assertEqual(item["midiWireChannel"], channel - 1)
            self.assertEqual(item["notes"], note_range)
            self.assertEqual(item["connection"], {"rekordbox": "bridge_connected", "ableton": "midi_output_available"})
            self.assertIn("unverified", item["setupGuidance"])
        controller = next(i for i in inventory["items"] if i["id"] == "flx4-flat")
        self.assertFalse(controller["canSendMidi"])
        self.assertEqual(controller["connection"]["ableton"], "not_configured")

    def test_partial_or_untrusted_bridge_does_not_claim_connection(self):
        status = {"rekordbox_connected": False, "ableton_midi_available": True,
                  "ableton_midi_port": None}
        samplers = {"samplers": [{"id": "asr10", "path": "/tmp/untrusted.app", "running": True}]}
        with patch.object(launcher, "_bridge_json", side_effect=[status, samplers]), patch.object(
            launcher, "_processes", return_value=[]
        ), patch.object(launcher, "_bundle_executable", return_value=Path("/valid/executable")):
            inventory = launcher.list_instruments()
        asr = next(i for i in inventory["items"] if i["id"] == "asr10-sampler")
        self.assertFalse(asr["running"])
        self.assertFalse(asr["canSendMidi"])
        self.assertEqual(asr["connection"]["ableton"], "not_configured")

    def test_bridge_unreachable_falls_back_to_process_check(self):
        with patch.object(launcher, "_bridge_json", return_value=None), patch.object(
            launcher, "_processes", return_value=[]
        ):
            inventory = launcher.list_instruments()
        self.assertFalse(inventory["bridgeAvailable"])
        self.assertFalse(inventory["abletonMidiOutputAvailable"])
        self.assertTrue(all(not i["canSendMidi"] for i in inventory["items"]))

    def test_unknown_id_cannot_run(self):
        with patch.object(launcher.subprocess, "run") as process:
            for bad_id in ("../Other.app", "/Applications/Terminal.app", "other", ""):
                with self.assertRaises(launcher.LauncherError):
                    launcher.launch_instrument(bad_id)
            process.assert_not_called()

    def test_wrong_bundle_id_cannot_launch(self):
        with patch.object(launcher, "_bundle_executable", return_value=None), patch.object(launcher.subprocess, "run") as process:
            with self.assertRaises(launcher.LauncherError) as raised:
                launcher.launch_instrument("maschine-lab")
            self.assertEqual(raised.exception.status, 404)
            process.assert_not_called()

    def test_launch_uses_fixed_bundle_and_no_shell(self):
        executable = Path("/approved/MASCHINE LAB.app/Contents/MacOS/MASCHINE LAB 2D")
        with patch.object(launcher, "_bundle_executable", return_value=executable), patch.object(
            launcher.subprocess, "run", return_value=SimpleNamespace(returncode=0)
        ) as process:
            result = launcher.launch_instrument("maschine-lab")
        self.assertTrue(result["launched"])
        args, kwargs = process.call_args
        self.assertEqual(args[0], ["/usr/bin/open", "-a", str(launcher.CATALOG["maschine-lab"][1])])
        self.assertNotIn("shell", kwargs)

    def test_cross_site_and_remote_rejected_before_launch(self):
        for overrides in ({"client": "192.168.1.2"},
                          {"headers": {"Host": "evil.example"}},
                          {"headers": {"Origin": "http://evil.example"}},
                          {"headers": {"Sec-Fetch-Site": "cross-site"}}):
            body = b'{"id":"maschine-lab"}'
            req = FakeRequest(body, **overrides)
            with patch.object(launcher, "launch_instrument") as launch:
                launcher.serve_post(req)
            self.assertEqual(req.status, 403)
            launch.assert_not_called()

    def test_post_contract_and_body_limits(self):
        for body, expected in ((b'{"id":"../bad"}', 404),
                               (b'{"id":"maschine-lab","path":"/tmp/a"}', 400),
                               (b'{"id":', 400), (b'[]', 400)):
            req = FakeRequest(body)
            launcher.serve_post(req)
            self.assertEqual(req.status, expected)
        req = FakeRequest(b"{" + b"a" * 1100 + b"}")
        launcher.serve_post(req)
        self.assertEqual(req.status, 413)

    def test_status_request_does_not_launch(self):
        req = FakeRequest()
        with patch.object(launcher, "launch_instrument") as launch:
            launcher.serve_get(req)
        self.assertEqual(req.status, 200)
        self.assertEqual(len(req.response()["items"]), 5)
        launch.assert_not_called()


if __name__ == "__main__":
    unittest.main()
