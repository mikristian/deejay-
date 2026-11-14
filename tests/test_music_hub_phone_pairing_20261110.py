"""Live-HTTP contract tests for the one-tap tailnet-only phone pairing flow."""
import http.client
import json
import tempfile
import threading
import socket
import unittest
from http.server import ThreadingHTTPServer
from pathlib import Path

from music_hub_pairing import PhonePairing, COOKIE_NAME
from music_hub_remote import make_handler, RemoteQueue, PreviewCommands


class PhonePairingHTTPTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.token = "t" * 42
        self.commands = PreviewCommands()
        self.commands.heartbeat()
        self.pairing = PhonePairing(Path(self.tmp.name) / "paired.json")
        with socket.socket() as probe:
            probe.bind(("127.0.0.1", 0))
            port = probe.getsockname()[1]
        self.origin = f"https://unit-test.ts.net:{port}"
        self.server = ThreadingHTTPServer(
            ("127.0.0.1", port),
            make_handler(self.token, RemoteQueue(lambda: {"101"}), commands=self.commands,
                         phone_pairing=self.pairing, library_provider=lambda: {"collection": []},
                         tailscale_origin=self.origin))
        self.thread = threading.Thread(target=self.server.serve_forever, daemon=True)
        self.thread.start()
        self.addCleanup(self.shutdown)

    def shutdown(self):
        self.server.shutdown()
        self.server.server_close()
        self.thread.join(timeout=2)

    def request(self, path, method="GET", body=None, *, origin="default",
                bearer=None, cookie=None):
        connection = http.client.HTTPConnection("127.0.0.1", self.server.server_port, timeout=3)
        headers = {"Host": f"127.0.0.1:{self.server.server_port}"}
        if origin == "default":
            origin = self.origin
        if origin is not None:
            headers["Origin"] = origin
        if bearer:
            headers["Authorization"] = "Bearer " + bearer
        if cookie:
            headers["Cookie"] = cookie
        if body is not None:
            headers["Content-Type"] = "application/json"
        connection.request(method, path, body=json.dumps(body) if body is not None else None, headers=headers)
        response = connection.getresponse()
        status, raw, new_cookie = response.status, response.read(), response.getheader("Set-Cookie")
        connection.close()
        return status, json.loads(raw), new_cookie

    def test_requires_laptop_approval_then_cookie_survives_reload(self):
        # Actual proxy Host need not be preserved, but Origin must match exact
        # allowlisted Tailscale HTTPS origin.
        self.assertEqual(self.request("/api/remote/v1/queue")[0], 401)
        status, started, _ = self.request("/api/remote/v1/pair/start", "POST", {"label": "My iPhone"})
        self.assertEqual(status, 200)
        self.assertEqual(len(started["code"]), 6)
        pending = self.request("/api/remote/v1/pair/status", "POST",
            {"requestId": started["requestId"], "secret": started["secret"]})
        self.assertEqual(pending[1]["state"], "pending")
        self.assertIsNone(pending[2])

        unauthorized = self.request("/api/remote/v1/pair/pending")
        self.assertEqual(unauthorized[0], 401)
        # Desktop origin is permitted for bearer-authenticated approval only.
        # Existing require_desktop accepts explicit desktop origin.
        desktop = "http://127.0.0.1:18769"
        fetched = self.request("/api/remote/v1/pair/pending", origin=desktop, bearer=self.token)
        self.assertEqual(fetched[0], 200)
        self.assertEqual(fetched[1]["requests"][0]["code"], started["code"])
        incorrect = self.request("/api/remote/v1/pair/approve", "POST",
            {"requestId": started["requestId"], "code": "111111" if started["code"] != "111111" else "222222"},
            origin=desktop, bearer=self.token)
        self.assertEqual(incorrect[0], 409)
        approved = self.request("/api/remote/v1/pair/approve", "POST",
            {"requestId": started["requestId"], "code": started["code"]}, origin=desktop, bearer=self.token)
        self.assertEqual(approved[0], 200)
        finished = self.request("/api/remote/v1/pair/status", "POST",
            {"requestId": started["requestId"], "secret": started["secret"]})
        self.assertEqual(finished[1]["state"], "connected")
        cookie = finished[2]
        self.assertIn("HttpOnly", cookie)
        self.assertIn("Secure", cookie)
        self.assertIn("SameSite=Strict", cookie)
        self.assertNotIn(started["secret"], cookie)
        self.assertEqual(self.request("/api/remote/v1/queue",cookie=cookie.split(";",1)[0])[0], 200)
        self.assertEqual(self.request("/api/remote/v1/pair/status", "POST",
            {"requestId": started["requestId"], "secret": started["secret"]})[1]["state"], "expired")
        loaded = PhonePairing(Path(self.tmp.name)/"paired.json")
        self.assertTrue(loaded.authorized(cookie.split(";",1)[0]))
        disconnected = self.request("/api/remote/v1/pair/revoke", "POST", {},
                                    cookie=cookie.split(";",1)[0])
        self.assertEqual(disconnected[0], 200)
        self.assertIn("Max-Age=0", disconnected[2])
        self.assertEqual(self.request("/api/remote/v1/queue",cookie=cookie.split(";",1)[0])[0], 401)

    def test_no_cross_origin_pairing_or_plain_http_or_unauthorized_enrollment(self):
        invalid = self.request("/api/remote/v1/pair/start", "POST", {"label":"iPhone"},
                               origin=f"https://another.ts.net:{self.server.server_port}")
        self.assertEqual(invalid[0], 403)
        no_origin = self.request("/api/remote/v1/pair/start", "POST", {"label":"iPhone"},
                                 origin=None)
        self.assertEqual(no_origin[0], 403)
        self.assertEqual(self.request("/api/remote/v1/pair/enroll", "POST", {})[0], 401)
        # Existing token holders can migrate once without exposing it in page HTML.
        migrated = self.request("/api/remote/v1/pair/enroll", "POST", {}, bearer=self.token)
        self.assertEqual(migrated[0], 200)
        self.assertIn(COOKIE_NAME, migrated[2])


if __name__ == "__main__":
    unittest.main()
