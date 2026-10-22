"""Lightweight protocol/bounds tests: stdlib + Pillow only.

No ONNX runtime and no model weights are required, so the suite runs on a
developer machine and in CI without downloading the 176 MB u2net file.
    python3 services/background-removal/test_service.py
"""
import hashlib
import http.client
import io
import sys
import tempfile
import threading
import unittest
from pathlib import Path
from unittest.mock import patch

from PIL import Image

sys.path.insert(0, str(Path(__file__).resolve().parent))

import engine  # noqa: E402
import model  # noqa: E402
import service  # noqa: E402


def image_bytes(size=(4, 3), mode="RGB", format="PNG"):
    stream = io.BytesIO()
    Image.new(mode, size, 255).save(stream, format=format)
    return stream.getvalue()


class FakeEngine:
    """Engine double: returns a solid mask without loading ONNX weights."""

    def __init__(self):
        self.ready = True
        self.lock = threading.Lock()
        self.calls = 0

    def healthy(self):
        return self.ready

    def infer(self, data):
        self.calls += 1
        rgb, encoded, _ = engine.decode_image(data)
        return image_bytes(encoded, "L")

    def stop(self):
        self.ready = False

    def restart(self):
        # A real engine respawns its worker; the double just stays available.
        self.ready = True
        return True


class ProtocolTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.engine = FakeEngine()
        cls.server = service.Server(("127.0.0.1", 0), cls.engine)
        cls.thread = threading.Thread(target=cls.server.serve_forever, daemon=True)
        cls.thread.start()

    @classmethod
    def tearDownClass(cls):
        cls.server.shutdown()
        cls.server.server_close()
        cls.thread.join()

    def request(self, method, path, body=None, headers=None):
        connection = http.client.HTTPConnection("127.0.0.1", self.server.server_port, timeout=5)
        connection.request(method, path, body, headers or {})
        response = connection.getresponse()
        result = response.status, response.getheader("Content-Type"), response.read()
        connection.close()
        return result

    def test_mask_png_and_jpeg(self):
        for format, mime in [("PNG", "image/png"), ("JPEG", "image/jpeg")]:
            status, mime_out, output = self.request("POST", "/mask", image_bytes(format=format), {"Content-Type": mime})
            self.assertEqual((status, mime_out), (200, "image/png"))
            with Image.open(io.BytesIO(output)) as mask:
                self.assertEqual(mask.mode, "L")
                self.assertEqual(mask.size, (4, 3))

    def test_health_reports_readiness(self):
        status, _, body = self.request("GET", "/health")
        self.assertEqual(status, 200)
        payload = __import__("json").loads(body)
        self.assertEqual((payload["ok"], payload["status"], payload["model"]), (True, "ready", "u2net"))

    def test_health_fails_when_model_missing(self):
        self.engine.ready = False
        try:
            self.assertEqual(self.request("GET", "/health")[0], 503)
            self.assertEqual(self.request("POST", "/mask", image_bytes(), {"Content-Type": "image/png"})[0], 503)
        finally:
            self.engine.ready = True

    def test_body_and_type_bounds(self):
        with patch.object(service, "MAX_BYTES", 8):
            self.assertEqual(self.request("POST", "/mask", image_bytes(), {"Content-Type": "image/png"})[0], 413)
        self.assertEqual(self.request("POST", "/mask", b"https://example.test/x.png", {"Content-Type": "text/plain"})[0], 415)
        self.assertEqual(self.request("POST", "/mask", b"not-an-image", {"Content-Type": "image/png"})[0], 422)
        self.assertEqual(self.request("POST", "/mask", b"", {"Content-Type": "image/png"})[0], 400)

    def test_dimension_bounds(self):
        with patch.object(engine, "MAX_SIDE", 2):
            self.assertEqual(self.request("POST", "/mask", image_bytes(), {"Content-Type": "image/png"})[0], 422)
        with patch.object(engine, "MAX_PIXELS", 10):
            self.assertEqual(self.request("POST", "/mask", image_bytes(), {"Content-Type": "image/png"})[0], 422)

    def test_no_url_endpoint(self):
        self.assertEqual(self.request("GET", "/mask?url=http://example.test")[0], 404)
        self.assertEqual(self.request("POST", "/mask?url=http://example.test", b"x")[0], 404)
        self.assertEqual(self.request("GET", "/download")[0], 404)
        self.assertEqual(self.request("POST", "/provision", b"x")[0], 404)

    def test_concurrency_is_one(self):
        self.engine.lock.acquire()
        try:
            self.assertEqual(self.request("POST", "/mask", image_bytes(), {"Content-Type": "image/png"})[0], 429)
        finally:
            self.engine.lock.release()

    def test_timeout_maps_to_504(self):
        with patch.object(self.engine, "infer", side_effect=engine.EngineTimeout("slow")):
            self.assertEqual(self.request("POST", "/mask", image_bytes(), {"Content-Type": "image/png"})[0], 504)

    def test_gif_is_rejected(self):
        stream = io.BytesIO()
        Image.new("RGB", (4, 4)).save(stream, format="GIF")
        self.assertEqual(self.request("POST", "/mask", stream.getvalue(), {"Content-Type": "image/png"})[0], 422)

    def test_exif_mask_matches_encoded_grid(self):
        stream = io.BytesIO()
        image = Image.new("RGB", (60, 30), 255)
        exif = image.getexif()
        exif[0x0112] = 6
        image.save(stream, format="JPEG", exif=exif)
        status, _, output = self.request("POST", "/mask", stream.getvalue(), {"Content-Type": "image/jpeg"})
        self.assertEqual(status, 200)
        with Image.open(io.BytesIO(output)) as mask:
            self.assertEqual(mask.size, (60, 30))


class DecodeTests(unittest.TestCase):
    def test_exif_orientation_is_preserved_in_size(self):
        stream = io.BytesIO()
        image = Image.new("RGB", (60, 30), 255)
        exif = image.getexif()
        exif[0x0112] = 6  # rotate 90 CW
        image.save(stream, format="JPEG", exif=exif)
        rgb, encoded, orientation = engine.decode_image(stream.getvalue())
        # The encoded grid stays 60x30 so the mask matches the request bytes.
        self.assertEqual(encoded, (60, 30))
        self.assertEqual(orientation, 6)
        # The pixel data is transposed for inference.
        self.assertEqual(rgb.size, (30, 60))

    def test_bomb_guard(self):
        with patch.object(engine, "MAX_PIXELS", 10):
            with self.assertRaises(ValueError):
                engine.decode_image(image_bytes(size=(32, 32)))


class ExifTests(unittest.TestCase):
    """Every EXIF orientation must round-trip back onto the encoded grid."""

    @staticmethod
    def marker():
        base = Image.new("RGB", (60, 30), (0, 0, 0))
        for x in range(0, 60, 7):
            for y in range(0, 30, 5):
                base.putpixel((x, y), (255, 0, 0))
        base.putpixel((0, 0), (0, 255, 0))
        return base

    def test_inverse_transpose_round_trip(self):
        from PIL import ImageOps
        for orientation in range(2, 9):
            base = self.marker()
            exif = base.getexif()
            exif[0x0112] = orientation
            oriented = ImageOps.exif_transpose(base)
            restored = oriented.transpose(engine._EXIF_INVERSE[orientation])
            self.assertEqual(restored.size, base.size, orientation)
            # Compare raw bytes: list diffs on large tuples are pathologically slow.
            self.assertEqual(restored.tobytes(), base.tobytes(), orientation)


class ModelTests(unittest.TestCase):
    def test_checksum_fails_closed(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "model.onnx"
            path.write_bytes(b"wrong weights")
            with self.assertRaises(ValueError):
                model.verify_model(path)
            with patch.object(model, "MODEL_MD5", hashlib.md5(b"wrong weights").hexdigest()):
                self.assertEqual(model.verify_model(path), path)
            with self.assertRaises(FileNotFoundError):
                model.verify_model(Path(directory) / "missing.onnx")

    def test_provenance_constants(self):
        self.assertEqual(model.MODEL_NAME, "u2net")
        self.assertEqual(model.MODEL_MD5, "60024c5c889badc19c04ad937298a77b")
        self.assertNotIn("bria", model.MODEL_URL.lower())


class RestartTests(unittest.TestCase):
    """After a hard failure the worker must respawn instead of staying dead."""

    def test_restart_respawns_worker(self):
        instance = engine.Engine()
        with patch.object(instance, "stop") as stop, patch.object(instance, "start") as start:
            self.assertTrue(instance.restart())
            stop.assert_called_once()
            start.assert_called_once()
            self.assertEqual(instance.restarts, 1)

    def test_restart_budget_is_finite(self):
        instance = engine.Engine()
        with patch.object(instance, "stop"), patch.object(instance, "start"):
            for _ in range(engine.MAX_RESTARTS):
                self.assertTrue(instance.restart())
            self.assertFalse(instance.restart())
            self.assertEqual(instance.restarts, engine.MAX_RESTARTS)

    def test_success_resets_restart_budget(self):
        instance = engine.Engine()
        instance.restarts = 2
        instance.healthy = lambda: True
        instance.connection = type("C", (), {
            "send": lambda self, data: None,
            "poll": lambda self, timeout: True,
            "recv": lambda self: ("ok", b"mask"),
        })()
        self.assertEqual(instance.infer(b"image"), b"mask")
        self.assertEqual(instance.restarts, 0)

    def test_timeout_raises_and_service_restarts(self):
        instance = engine.Engine()
        instance.healthy = lambda: True
        instance.connection = type("C", (), {
            "send": lambda self, data: None,
            "poll": lambda self, timeout: False,
        })()
        with self.assertRaises(engine.EngineTimeout):
            instance.infer(b"image")


if __name__ == "__main__":
    unittest.main(verbosity=2)
