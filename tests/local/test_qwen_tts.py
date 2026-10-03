import importlib.util
import json
from pathlib import Path
import threading
import unittest
from http.client import HTTPConnection
from http.server import ThreadingHTTPServer

spec = importlib.util.spec_from_file_location("qwen_server", Path(__file__).resolve().parents[2] / "scripts/qwen-tts-server.py")
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)
TOKEN = "local-test-token-0123456789abcdef0123456789"


class FakeSynthesizer:
    device = "test"
    voice_id = "original-announcer"
    calls = 0
    fail = False

    def generate(self, *_):
        self.calls += 1
        if self.fail:
            raise RuntimeError("test inference failure")
        return b"RIFF-test-audio", False


class SpeechTests(unittest.TestCase):
    def setUp(self):
        self.synth = FakeSynthesizer()
        self.server = ThreadingHTTPServer(("127.0.0.1", 0), module.make_handler(self.synth, TOKEN))
        self.thread = threading.Thread(target=self.server.serve_forever, daemon=True)
        self.thread.start()

    def tearDown(self):
        self.server.shutdown()
        self.server.server_close()
        self.thread.join()

    def request(self, body, headers=None, path="/v1/audio/speech"):
        connection = HTTPConnection("127.0.0.1", self.server.server_port)
        connection.request("POST", path, body=json.dumps(body), headers={"Authorization": f"Bearer {TOKEN}", **(headers or {})})
        response = connection.getresponse()
        result = response.status, dict(response.getheaders()), response.read()
        connection.close()
        return result

    def test_invalid_requests_never_start_inference(self):
        for body in [{}, {"input": "x", "model": "other"}, {"input": "x", "voice": "nova"}, {"input": "x", "speed": 0}, {"input": "x", "response_format": "pcm"}, {"input": "x" * 1001}]:
            self.assertEqual(self.request(body)[0], 400)
        self.assertEqual(self.synth.calls, 0)

    def test_auth_and_cross_origin_requests_are_refused(self):
        self.assertEqual(self.request({"input": "x"}, {"Authorization": ""})[0], 401)
        self.assertEqual(self.request({"input": "x"}, {"Origin": "https://example.com"})[0], 403)
        self.assertEqual(self.request({"input": "x"}, path="/unknown")[0], 404)
        self.assertEqual(self.synth.calls, 0)

    def test_response_carries_playable_type_and_actual_voice_identity(self):
        status, headers, audio = self.request({"input": "안녕하세요", "response_format": "wav"})
        self.assertEqual(status, 200)
        self.assertEqual(headers["Content-Type"], "audio/wav")
        self.assertEqual(headers["X-Qwen-Voice"], self.synth.voice_id)
        self.assertEqual(int(headers["Content-Length"]), len(audio))

    def test_model_failure_is_explicit(self):
        self.synth.fail = True
        status, _, data = self.request({"input": "test"})
        self.assertEqual(status, 502)
        self.assertIn("failed", json.loads(data)["error"]["message"])


if __name__ == "__main__":
    unittest.main()
