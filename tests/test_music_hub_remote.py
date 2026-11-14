"""Remote bridge safety and queue contract tests (no live services)."""
import http.client
import json
import socket
import tempfile
import threading
import unittest
from http.server import ThreadingHTTPServer
from pathlib import Path
from unittest.mock import patch

from music_hub_remote import (
    RemoteError, RemoteQueue, PreviewCommands, make_handler, capabilities,
    safe_library, safe_mobile_waveform, safe_native_playlist,
)


class RemoteQueueTests(unittest.TestCase):
    def setUp(self):
        self.queue = RemoteQueue(lambda: {"101", "102"})

    def test_order_target_and_optimistic_revision(self):
        first = self.queue.mutate({"revision": 0, "action": "enqueue", "trackId": "101", "deck": "1"})
        second = self.queue.mutate({"revision": 1, "action": "enqueue", "trackId": "102", "deck": "auto"})
        self.assertEqual([x["trackId"] for x in second["items"]], ["101", "102"])
        moved = self.queue.mutate({"revision": 2, "action": "move", "id": second["items"][1]["id"], "index": 0})
        self.assertEqual([x["trackId"] for x in moved["items"]], ["102", "101"])
        changed = self.queue.mutate({"revision": 3, "action": "target", "id": first["items"][0]["id"], "deck": "2"})
        self.assertEqual(changed["items"][1]["deck"], "2")
        with self.assertRaises(RemoteError) as exc:
            self.queue.mutate({"revision": 2, "action": "remove", "id": first["items"][0]["id"]})
        self.assertEqual(exc.exception.status, 409)

    def test_invalid_tracks_are_atomic(self):
        for track in ("../../bad", "999", 101):
            with self.assertRaises(RemoteError):
                self.queue.mutate({"revision": 0, "action": "enqueue", "trackId": track, "deck": "1"})
        self.assertEqual(self.queue.snapshot(), {"revision": 0, "items": []})
        self.assertFalse(capabilities()["play"])
        self.assertFalse(capabilities()["seek"])
        self.assertTrue(capabilities()["smartReorder"], "saved queue.reorder is available through the authenticated Hub bridge")

    def test_mobile_measured_waveform_is_bounded_and_never_exposes_paths(self):
        calls = []
        def source(tid,points):
            calls.append((tid,points))
            return {"id":tid,"heights":[.5,1.5,-.4,0.8],"colors":[[1,2,3]],
                    "error":"/private/rekordbox/PIONEER/USB.anlz"}
        payload = safe_mobile_waveform("101",valid_track_ids=lambda:{"101"},waveform_provider=source)
        self.assertEqual(payload, {"id":"101","heights":[.5,1,0,.8]})
        self.assertEqual(calls,[("101",96)])
        for unsafe in ("/tmp/not-a-track", "not-numeric", "１２３", "", "1"*21, 101):
            with self.assertRaises(RemoteError):
                safe_mobile_waveform(unsafe,valid_track_ids=lambda:{"101"},waveform_provider=source)
        with self.assertRaises(RemoteError) as error:
            safe_mobile_waveform("999",valid_track_ids=lambda:{"101"},waveform_provider=source)
        self.assertEqual(error.exception.status,404)
        self.assertEqual(len(calls),1,"invalid IDs never trigger waveform analysis")
        with self.assertRaises(RemoteError):
            safe_mobile_waveform("101",valid_track_ids=lambda:{"101"},
                                 waveform_provider=lambda *_:{"heights":[float("nan")]})
        self.assertEqual(safe_mobile_waveform("101",valid_track_ids=lambda:{"101"},
            waveform_provider=lambda *_:{"heights":[]}),{"id":"101","heights":[]})

    def test_native_playlist_order_is_read_only_sanitized_and_validated(self):
        provider=lambda:{"collection":[{"id":"101","genre":"House"}],
                         "playlists":[{"id":"209","name":"House favorites",
                                       "kind":"playlist","count":3,"path":"/private"}]}
        source=lambda ident,limit:{"id":ident,"count":3,"tracks":[
            {"id":"102","title":"Song","path":"/private/song.mp3"},
            {"id":"101","path":"/private/second.mp3"},{"id":"102","path":"/private/repeat.mp3"}]}
        index=safe_library(provider=provider)
        self.assertEqual(index["nativePlaylists"],
                         [{"id":"209","name":"House favorites","kind":"playlist","count":3}])
        self.assertEqual(index["collection"][0]["genre"],"House")
        detail=safe_native_playlist("209",library_provider=provider,playlist_provider=source)
        self.assertEqual(detail,{"id":"209","name":"House favorites","count":3,
                                 "trackIds":["102","101","102"]})
        self.assertNotIn("path",str(detail))
        with self.assertRaises(RemoteError) as error:
            safe_native_playlist("210",library_provider=provider,playlist_provider=source)
        self.assertEqual(error.exception.status,404)
        for unsafe in ("../../foo","209/..","２０９",""):
            with self.assertRaises(RemoteError):
                safe_native_playlist(unsafe,library_provider=provider,playlist_provider=source)

    def test_exact_tailscale_https_origin_without_public_cors(self):
        """Tailnet Serve can use MagicDNS Host while the API stays token-gated."""
        from music_hub_remote import make_handler
        hostname = "my-laptop.tail123456.ts.net"
        token = "x" * 40
        with socket.socket() as locator:
            locator.bind(("127.0.0.1", 0))
            port = locator.getsockname()[1]
        origin = f"https://{hostname}:{port}"
        with self.assertRaises(ValueError):
            make_handler(token, self.queue, tailscale_origin=f"http://untrusted.example:{port}")
        server = ThreadingHTTPServer(("127.0.0.1", port),
            make_handler(token, self.queue, tailscale_origin=origin,
                library_provider=lambda: {"collection": []}))
        thread = threading.Thread(target=server.serve_forever, daemon=True)
        thread.start()
        try:
            def request(host, origin_header=None, authorization=True):
                conn = http.client.HTTPConnection("127.0.0.1", server.server_port, timeout=2)
                headers = {"Host": host}
                if origin_header:
                    headers["Origin"] = origin_header
                if authorization:
                    headers["Authorization"] = "Bearer " + token
                conn.request("GET", "/api/remote/v1/queue", headers=headers)
                response = conn.getresponse()
                result = response.status, response.getheader("Access-Control-Allow-Origin")
                response.read()
                conn.close()
                return result

            self.assertEqual(request(f"{hostname}:{port}", origin, False)[0], 401)
            self.assertEqual(request(f"{hostname}:{port}", origin), (200, None))
            self.assertEqual(request(f"{hostname}:{port}", f"https://attacker.ts.net:{port}")[0], 403)
            self.assertEqual(request(f"attacker.ts.net:{port}", origin)[0], 403)
            self.assertEqual(request(f"127.0.0.1:{port}", f"http://127.0.0.1:{port}")[0], 200)
            self.assertEqual(request(f"127.0.0.1:{port}", origin)[0], 200,
                             "Tailscale proxies may rewrite upstream Host to loopback")
        finally:
            server.shutdown()
            server.server_close()
            thread.join(timeout=2)

    def test_auth_and_no_cors(self):
        token = "t" * 40
        server = ThreadingHTTPServer(("127.0.0.1", 0), make_handler(token, self.queue,
            library_provider=lambda: {"collection": [{"id": "101", "title": "Song", "artist": "DJ", "path": "/secret/song.wav", "artwork": "/private/image"}],
                                      "playlists":[{"id":"209","name":"House","kind":"playlist","count":2,"path":"/private/playlist"}]},
            waveform_provider=lambda tid,pts: {"heights":[.2,.8,.4],"colors":[[200,0,0]]},
            playlist_provider=lambda ident,limit:{"id":ident,"count":2,"tracks":[{"id":"101","path":"/private/a.mp3"},{"id":"102","path":"/private/b.mp3"}]}))
        worker = threading.Thread(target=server.serve_forever, daemon=True)
        worker.start()
        try:
            def request(auth=None, origin=None, method="GET", body=None, path=None, host=None):
                conn = http.client.HTTPConnection("127.0.0.1", server.server_port, timeout=2)
                headers = {"Host": host or "127.0.0.1:" + str(server.server_port), "Content-Type": "application/json"}
                if auth:
                    headers["Authorization"] = "Bearer " + auth
                if origin:
                    headers["Origin"] = origin
                conn.request(method, path or ("/api/remote/v1/status" if method == "GET" else "/api/remote/v1/queue"),
                             body=json.dumps(body) if body else None, headers=headers)
                response = conn.getresponse()
                code, payload, cors = response.status, response.read(), response.getheader("Access-Control-Allow-Origin")
                conn.close()
                try:
                    data = json.loads(payload)
                except (ValueError, UnicodeError):
                    data = payload
                return code, data, cors

            self.assertEqual(request()[0], 401)
            self.assertEqual(request(token, "http://evil.example")[0], 403)
            self.assertEqual(request(token, host="example.com")[0], 403)
            same_origin = "http://127.0.0.1:" + str(server.server_port)
            self.assertEqual(request(token, same_origin)[0], 200)
            self.assertEqual(request(path="/music-hub/mobile.html")[0], 200)
            self.assertEqual(request(path="/music-hub/mobile.css")[0], 200)
            self.assertEqual(request(path="/music-hub/mobile.js")[0], 200)
            self.assertEqual(request(path="/music-hub/index.html")[0], 401)
            code, data, cors = request(token)
            self.assertEqual(code, 200)
            self.assertFalse(data["capabilities"]["controllerCommands"])
            self.assertTrue(data["capabilities"]["smartReorder"])
            self.assertIsNone(cors)
            code, data, _ = request(token, path="/api/library")
            self.assertEqual(code, 200)
            self.assertEqual(data["collection"], [{"id": "101", "title": "Song", "artist": "DJ"}])
            self.assertEqual(data["nativePlaylists"],[{"id":"209","name":"House","kind":"playlist","count":2}])
            self.assertEqual(request(path="/api/remote/v1/native-playlist?id=209")[0],401)
            code, native, _ = request(token,path="/api/remote/v1/native-playlist?id=209")
            self.assertEqual((code,native),(200,{"id":"209","name":"House","count":2,
                                                 "trackIds":["101","102"]}))
            self.assertEqual(request(token,path="/api/remote/v1/native-playlist?id=210")[0],404)
            code, page, _ = request(token, path="/api/remote/v1/library?offset=0&limit=1")
            self.assertEqual((code, page["limit"]), (200, 1))
            self.assertEqual(request(token, path="/api/remote/v1/library?limit=1001")[0], 400)
            self.assertEqual(request(path="/api/remote/v1/waveform?id=101")[0],401)
            self.assertEqual(request(token,path="/api/remote/v1/waveform?id=101"),
                             (200,{"id":"101","heights":[.2,.8,.4]},None))
            self.assertEqual(request(token,path="/api/remote/v1/waveform?id=999")[0],404)
            self.assertEqual(request(token,path="/api/remote/v1/waveform?id=../../bad")[0],400)
            self.assertEqual(request(token,path="/api/remote/v1/waveform?id=101&id=102")[0],400)
            self.assertEqual(request(token, method="POST", body={"revision": 0, "action": "enqueue", "trackId": "101", "deck": "auto"})[0], 200)
            self.assertEqual(self.queue.snapshot()["items"][0]["trackId"], "101")
        finally:
            server.shutdown()
            server.server_close()
            worker.join(timeout=2)

    def test_persisted_canonical_queue_actions(self):
        import music_hub_backend
        from music_hub_remote import save_hub_queue
        from http.server import BaseHTTPRequestHandler

        with tempfile.TemporaryDirectory() as folder:
            path = Path(folder) / "hub-state.json"
            original_apply = music_hub_backend.apply_action
            original_state = music_hub_backend.state
            class StubHub(BaseHTTPRequestHandler):
                def log_message(self, *_args):
                    pass

                def do_POST(self):
                    self.assert_called = True
                    assert self.path == "/api/music-hub/action"
                    assert self.headers.get("Origin") is None
                    assert self.client_address[0] == "127.0.0.1"
                    body = json.loads(self.rfile.read(int(self.headers["Content-Length"])))
                    try:
                        result = original_apply(body, {"101", "102"}, path=path)
                        code = 200
                    except music_hub_backend.HubError as exc:
                        result, code = {"error": str(exc)}, exc.status
                    payload = json.dumps(result).encode()
                    self.send_response(code)
                    self.send_header("Content-Length", str(len(payload)))
                    self.end_headers()
                    self.wfile.write(payload)

            server = ThreadingHTTPServer(("127.0.0.1", 0), StubHub)
            worker = threading.Thread(target=server.serve_forever, daemon=True)
            worker.start()
            try:
                with patch("music_hub_remote.HUB_PORT", server.server_port):
                    self.assertEqual(save_hub_queue({"action": "queue.add", "trackId": "101"})["queue"], ["101"])
                    self.assertEqual(save_hub_queue({"action": "queue.add", "trackId": "102"})["queue"], ["101", "102"])
                    self.assertEqual(save_hub_queue({"action": "queue.reorder", "from": 1, "to": 0})["queue"], ["102", "101"])
                    with self.assertRaises(RemoteError) as exc:
                        save_hub_queue({"action": "queue.add", "trackId": "999"})
                    self.assertEqual(exc.exception.status, 404)
                    self.assertEqual(original_state(path=path)["queue"], ["102", "101"])
                    self.assertEqual(save_hub_queue({"action": "queue.remove", "index": 0, "trackId": "102"})["queue"], ["101"])
                    with self.assertRaises(RemoteError):
                        save_hub_queue({"action": "playlist.delete", "playlistId": "anything"})
            finally:
                server.shutdown()
                server.server_close()
                worker.join(timeout=2)
            self.assertEqual(json.loads(path.read_text())["queue"], ["101"])

    def test_library_sanitization_and_bounds(self):
        rows = [{"id": str(i), "title": "A" * 500, "path": "/private/track", "metadata": {"internal": True}} for i in range(4)]
        result = safe_library(2, 1, provider=lambda: {"collection": rows})
        self.assertEqual((result["offset"], result["total"], result["hasMore"]), (1, 4, True))
        self.assertEqual([x["id"] for x in result["collection"]], ["1", "2"])
        self.assertEqual(len(result["collection"][0]["title"]), 256)
        self.assertNotIn("path", result["collection"][0])

    def test_preview_commands_require_live_desktop_and_deliver_once(self):
        clock = [100.0]
        commands = PreviewCommands(clock=lambda: clock[0])
        self.assertFalse(capabilities(commands)["localPreviewRemote"])
        with self.assertRaises(RemoteError) as error:
            commands.submit({"action": "local.play", "deck": "1"})
        self.assertEqual(error.exception.status, 409)
        commands.heartbeat()
        self.assertTrue(capabilities(commands)["localPreviewRemote"])
        for invalid in ({"action": "local.seek", "deck": "1", "positionSec": -1},
                        {"action": "local.play", "deck": "3"},
                        {"action": "crossfader", "target": 0.1},
                        {"action": "local.play", "deck": "1", "secret": True}):
            with self.assertRaises(RemoteError):
                commands.submit(invalid)
        a = commands.submit({"action": "local.seek", "deck": "2", "positionSec": 43.5})
        self.assertEqual(commands.poll()["commands"], [{"id": a["id"], "action": "local.seek", "args": {"deck": "2", "positionSec": 43.5}}])
        self.assertEqual(commands.poll()["commands"], [])
        self.assertTrue(commands.ack({"id": a["id"]})["acknowledged"])
        clock[0] += 11
        self.assertFalse(commands.active())
        with self.assertRaises(RemoteError):
            commands.submit({"action": "local.autoMixStart"})

    def test_local_stage_validates_library_and_delivery(self):
        clock = [100.0]
        calls = []
        commands = PreviewCommands(clock=lambda: clock[0],
                                   valid_track_ids=lambda: (calls.append(True) or {"101", "202"}))
        payload = {"action": "local.stage", "deck": "2", "trackId": "202"}
        with self.assertRaises(RemoteError) as offline:
            commands.submit(payload)
        self.assertEqual(offline.exception.status, 409)
        self.assertEqual(calls, [])
        commands.heartbeat({})
        invalid = ({"action": "local.stage", "deck": "3", "trackId": "101"},
                   {"action": "local.stage", "deck": 1, "trackId": "101"},
                   {"action": "local.stage", "deck": "1", "trackId": "../101"},
                   {"action": "local.stage", "deck": "1", "trackId": "١٠١"},
                   {"action": "local.stage", "deck": "1", "trackId": 101},
                   {"action": "local.stage", "deck": "1", "trackId": ""},
                   {"action": "local.stage", "deck": "1", "trackId": "1" * 21},
                   {"action": "local.stage", "deck": "1", "trackId": "101", "native": True})
        for value in invalid:
            with self.subTest(value=value), self.assertRaises(RemoteError):
                commands.submit(value)
            self.assertEqual(commands.poll()["commands"], [])
        with self.assertRaises(RemoteError) as unknown:
            commands.submit({"action": "local.stage", "deck": "1", "trackId": "999"})
        self.assertEqual(unknown.exception.status, 404)
        accepted = commands.submit(payload)
        self.assertTrue(calls)
        self.assertEqual(commands.poll()["commands"], [
            {"id": accepted["id"], "action": "local.stage", "args": {"deck": "2", "trackId": "202"}}])
        self.assertEqual(commands.poll()["commands"], [])
        self.assertTrue(commands.ack({"id": accepted["id"]})["acknowledged"])
        commands.submit(payload)
        clock[0] += 16
        self.assertEqual(commands.poll()["commands"], [])

    def test_local_stage_library_unavailable_fails_closed(self):
        commands = PreviewCommands(valid_track_ids=lambda: (_ for _ in ()).throw(OSError("offline")))
        commands.heartbeat({})
        with self.assertRaises(RemoteError) as error:
            commands.submit({"action": "local.stage", "deck": "1", "trackId": "101"})
        self.assertEqual(error.exception.status, 503)
        self.assertEqual(commands.poll()["commands"], [])

    def test_heartbeat_preview_validated_atomic_and_expires(self):
        clock = [50.0]
        commands = PreviewCommands(clock=lambda: clock[0])
        preview = {"deckA": "101", "deckB": None, "playingA": True, "playingB": False,
                   "positionA": 46.25, "positionB": 0, "durationA": 245.0,
                   "durationB": 0, "crossfade": 0.5, "autoFading": False}
        commands.heartbeat({"preview": preview})
        self.assertEqual(commands.preview_snapshot(), preview)
        self.assertIsNot(commands.preview_snapshot(), preview)
        for change in ({"positionA": float("nan")}, {"durationA": float("inf")},
                       {"crossfade": 1.01}, {"positionB": -1}, {"playingA": 1},
                       {"autoFading": "false"}, {"deckA": "../101"},
                       {"deckB": "not-an-id"}, {"durationB": 86401}):
            with self.subTest(change=change):
                with self.assertRaises(RemoteError):
                    commands.heartbeat({"preview": {**preview, **change}})
                self.assertEqual(commands.preview_snapshot(), preview)
        for invalid in ({"preview": {"deckA": "101"}}, {"unknown": True},
                        {"preview": preview, "extra": True}, []):
            with self.assertRaises(RemoteError):
                commands.heartbeat(invalid)
        clock[0] += 11
        self.assertIsNone(commands.preview_snapshot())
        self.assertFalse(commands.active())
        commands.heartbeat({})
        self.assertTrue(commands.active())
        self.assertIsNone(commands.preview_snapshot())

    def test_heartbeat_preview_http_status_contract(self):
        token = "b" * 40
        commands = PreviewCommands(valid_track_ids=lambda: {"101"})
        queue = RemoteQueue(lambda: {"101"})
        server = ThreadingHTTPServer(("127.0.0.1", 0), make_handler(token, queue, commands=commands))
        worker = threading.Thread(target=server.serve_forever, daemon=True)
        worker.start()
        preview = {"deckA": "101", "deckB": None, "playingA": True, "playingB": False,
                   "positionA": 30, "positionB": 0, "durationA": 180,
                   "durationB": 0, "crossfade": 0.25, "autoFading": True}
        try:
            def call(path, body=None):
                conn = http.client.HTTPConnection("127.0.0.1", server.server_port, timeout=2)
                headers = {"Authorization": "Bearer " + token, "Content-Type": "application/json"}
                if body is not None:
                    headers["Origin"] = "http://127.0.0.1:18769"
                conn.request("POST" if body is not None else "GET", path,
                             json.dumps(body) if body is not None else None, headers=headers)
                response = conn.getresponse()
                status, result = response.status, json.loads(response.read())
                conn.close()
                return status, result

            with patch("music_hub_remote.safe_hub_state", return_value={"queue": [], "favorites": [], "playlists": []}):
                self.assertIsNone(call("/api/remote/v1/status")[1]["preview"])
                self.assertEqual(call("/api/remote/v1/heartbeat", {"preview": preview})[0], 200)
                status, result = call("/api/remote/v1/status")
                self.assertEqual(status, 200)
                self.assertEqual(result["preview"], preview)
                self.assertTrue(result["capabilities"]["localPreviewRemote"])
                self.assertFalse(result["capabilities"]["playheadVerified"])
                self.assertEqual(call("/api/remote/v1/heartbeat", {"preview": {**preview, "playingA": 1}})[0], 400)
                self.assertEqual(call("/api/remote/v1/status")[1]["preview"], preview)
                self.assertEqual(call("/api/remote/v1/heartbeat", {})[0], 200)
                self.assertIsNone(call("/api/remote/v1/status")[1]["preview"])
        finally:
            server.shutdown()
            server.server_close()
            worker.join(timeout=2)

    def test_preview_desktop_http_security(self):
        token = "a" * 40
        commands = PreviewCommands(valid_track_ids=lambda: {"101"})
        server = ThreadingHTTPServer(("127.0.0.1", 0), make_handler(token, RemoteQueue(lambda: {"101"}), commands=commands))
        worker = threading.Thread(target=server.serve_forever, daemon=True)
        worker.start()
        try:
            def request(method, path, origin=None, payload=None, auth=True):
                connection = http.client.HTTPConnection("127.0.0.1", server.server_port, timeout=2)
                headers = {"Host": "127.0.0.1:" + str(server.server_port), "Content-Type": "application/json"}
                if auth:
                    headers["Authorization"] = "Bearer " + token
                if origin:
                    headers["Origin"] = origin
                connection.request(method, path, json.dumps(payload).encode() if payload is not None else None, headers)
                response = connection.getresponse()
                code, cors = response.status, response.getheader("Access-Control-Allow-Origin")
                data = response.read()
                connection.close()
                return code, cors, json.loads(data) if data else {}

            desktop = "http://127.0.0.1:18769"
            self.assertEqual(request("POST", "/api/remote/v1/heartbeat", "http://evil.example", {})[0], 403)
            self.assertEqual(request("POST", "/api/remote/v1/heartbeat", desktop, {}, auth=False)[0], 401)
            code, cors, _ = request("POST", "/api/remote/v1/heartbeat", desktop, {})
            self.assertEqual((code, cors), (200, desktop))
            code, _, item = request("POST", "/api/remote/v1/command", None, {"action": "local.play", "deck": "1"})
            self.assertEqual(code, 200)
            code, _, stage = request("POST", "/api/remote/v1/command", None,
                                     {"action": "local.stage", "deck": "2", "trackId": "101"})
            self.assertEqual(code, 200)
            self.assertEqual(request("POST", "/api/remote/v1/command", None,
                                     {"action": "local.stage", "deck": "2", "trackId": "999"})[0], 404)
            self.assertEqual(request("GET", "/api/remote/v1/commands", "http://evil.example")[0], 403)
            code, cors, data = request("GET", "/api/remote/v1/commands", desktop)
            self.assertEqual((code, cors), (200, desktop))
            self.assertEqual(data["commands"][0]["id"], item["id"])
            self.assertEqual(data["commands"][1], {"id": stage["id"], "action": "local.stage",
                                                   "args": {"deck": "2", "trackId": "101"}})
            self.assertEqual(request("GET", "/api/remote/v1/commands", desktop)[2]["commands"], [])
            self.assertTrue(request("POST", "/api/remote/v1/ack", desktop, {"id": item["id"]})[2]["acknowledged"])
        finally:
            server.shutdown()
            server.server_close()
            worker.join(timeout=2)


if __name__ == "__main__":
    unittest.main()
