"""Laptop phone-bridge validation; no live playback or remote commands."""
import unittest
from unittest.mock import patch

from music_hub_phone_bridge import PhoneBridgeError, validate_action, relay


class LaptopPhoneBridgeTests(unittest.TestCase):
    def test_only_explicit_phone_actions(self):
        good = [
            ({"action": "local.stage", "deck": "1", "trackId": "101"}, "/api/remote/v1/command"),
            ({"action": "local.play", "deck": "2"}, "/api/remote/v1/command"),
            ({"action": "local.seek", "deck": "1", "positionSec": 20.5}, "/api/remote/v1/command"),
            ({"action": "local.fade", "target": 0.5, "durationMs": 1000}, "/api/remote/v1/command"),
            ({"action": "queue.add", "trackId": "101"}, "/api/music-hub/action"),
        ]
        for data, endpoint in good:
            with self.subTest(data=data):
                self.assertEqual(validate_action(data), (endpoint, data))

    def test_all_native_commands_are_rejected(self):
        unsafe = [
            {"action": "native.play", "deck": "1"},
            {"action": "native.load", "deck": "1", "trackId": "101"},
            {"action": "local.stage", "deck": "3", "trackId": "101"},
            {"action": "local.stage", "deck": "1", "trackId": "../101"},
            {"action": "local.stage", "deck": "1", "trackId": "１２３"},
            {"action": "local.stage", "deck": "1", "trackId": 101},
            {"action": "local.play", "deck": "1", "native": True},
            {"action": "local.seek", "deck": "2", "positionSec": float("inf")},
            {"action": "local.seek", "deck": "2", "positionSec": -2},
            {"action": "local.fade", "target": float("nan"), "durationMs": 400},
            {"action": "queue.add", "trackId": "101", "index": 0},
            {"action": "queue.clear"},
        ]
        for body in unsafe:
            with self.subTest(body=body), self.assertRaises(PhoneBridgeError):
                validate_action(body)

    def test_only_fixed_loopback_bridge_endpoints(self):
        with patch("music_hub_phone_bridge._token", return_value="x" * 40):
            for path in ("http://evil.example", "/api/music-hub/audio", "/api/remote/v1/commands"):
                with self.subTest(path=path), self.assertRaises(PhoneBridgeError):
                    relay(path)


if __name__ == "__main__":
    unittest.main()
