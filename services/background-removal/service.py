"""Private HTTP wrapper around the local u2net mask engine.

Contract (internal, unauthenticated, Docker-internal network only):
  POST /mask  raw PNG/JPEG bytes -> image/png grayscale mask, same dimensions,
              white = foreground, black = background.
  GET  /health -> 200 {"ok": true, "status": "ready"} only when the checksum
              verified model is loaded; 503 otherwise.

There is deliberately no endpoint that accepts a URL, and no request path
that triggers a network download.
"""
import json
import logging
import os
import socket
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

from PIL import Image

from engine import Engine, EngineTimeout, EngineUnavailableError, InvalidImageError

MAX_BYTES = int(os.getenv("BG_REMOVAL_MAX_BYTES", "10485760"))
MAX_CONCURRENT_REQUESTS = int(os.getenv("BG_REMOVAL_MAX_CONCURRENCY", "2"))
READ_TIMEOUT = float(os.getenv("BG_REMOVAL_READ_TIMEOUT_SECONDS", "20"))
ALLOWED_MEDIA = {"image/png", "image/jpeg"}

Image.MAX_IMAGE_PIXELS = 25_000_000
LOG = logging.getLogger("background-removal")


class Handler(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"
    server_version = "background-removal/1.0"
    sys_version = ""

    def setup(self):
        super().setup()
        self.connection.settimeout(READ_TIMEOUT)

    def respond(self, status, body, content_type="application/json"):
        self.send_response(status)
        self.send_header("Content-Type", content_type)
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        self.send_header("X-Content-Type-Options", "nosniff")
        self.end_headers()
        self.close_connection = True
        if self.command != "HEAD":
            self.wfile.write(body)

    def fail(self, status, code):
        self.respond(status, json.dumps({"ok": False, "error": code}).encode())

    def do_GET(self):
        if self.path != "/health":
            return self.fail(404, "not_found")
        ready = self.server.engine.healthy()
        self.respond(200 if ready else 503, json.dumps({
            "ok": ready,
            "status": "ready" if ready else "unavailable",
            "model": "u2net",
        }).encode())

    def do_POST(self):
        if self.path != "/mask":
            return self.fail(404, "not_found")
        if not self.server.engine.healthy():
            return self.fail(503, "model_unavailable")
        media = self.headers.get("Content-Type", "").split(";", 1)[0].strip().lower()
        if media not in ALLOWED_MEDIA:
            return self.fail(415, "unsupported_media_type")
        if self.headers.get("Transfer-Encoding"):
            return self.fail(400, "transfer_encoding_not_supported")
        lengths = self.headers.get_all("Content-Length", [])
        if len(lengths) != 1:
            return self.fail(411, "content_length_required")
        try:
            size = int(lengths[0])
        except ValueError:
            return self.fail(400, "invalid_content_length")
        if size < 1:
            return self.fail(400, "empty_body")
        if size > MAX_BYTES:
            return self.fail(413, "body_exceeds_bounds")
        # One CPU inference at a time: extra requests are rejected, not queued.
        if not self.server.engine.lock.acquire(blocking=False):
            return self.fail(429, "busy")
        try:
            body = self.read_exactly(size)
            if body is None:
                return self.fail(408, "read_timeout")
            output = self.server.engine.infer(body)
        except EngineTimeout:
            # Kill the worker so a stuck inference cannot overlap the next one,
            # then respawn it so the service recovers without an operator.
            self.server.engine.stop()
            self.server.engine.restart()
            return self.fail(504, "inference_timeout")
        except InvalidImageError:
            return self.fail(422, "invalid_image")
        except EngineUnavailableError as error:
            LOG.warning("inference unavailable: %s", error)
            return self.fail(503, "model_unavailable")
        except (socket.timeout, TimeoutError):
            return self.fail(408, "read_timeout")
        except (EOFError, BrokenPipeError, OSError):
            self.server.engine.ready = False
            return self.fail(503, "model_unavailable")
        finally:
            self.server.engine.lock.release()
        self.respond(200, output, "image/png")

    def read_exactly(self, size):
        chunks = []
        remaining = size
        deadline = time.monotonic() + READ_TIMEOUT
        while remaining:
            budget = deadline - time.monotonic()
            if budget <= 0:
                return None
            self.connection.settimeout(budget)
            chunk = self.rfile.read1(min(65536, remaining))
            if not chunk:
                raise OSError("incomplete body")
            chunks.append(chunk)
            remaining -= len(chunk)
        return b"".join(chunks)

    def log_message(self, format, *args):
        # Never log bodies, query strings or user supplied paths.
        pass


class Server(ThreadingHTTPServer):
    daemon_threads = True
    request_queue_size = 16
    allow_reuse_address = True

    def __init__(self, address, engine):
        self.engine = engine
        self.slots = threading.BoundedSemaphore(MAX_CONCURRENT_REQUESTS)
        super().__init__(address, Handler)

    def process_request(self, request, client_address):
        if not self.slots.acquire(blocking=False):
            self.shutdown_request(request)
            return
        try:
            super().process_request(request, client_address)
        except Exception:
            self.slots.release()
            raise

    def process_request_thread(self, request, client_address):
        try:
            super().process_request_thread(request, client_address)
        finally:
            self.slots.release()


def main():
    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(name)s %(message)s")
    engine = Engine()
    engine.start()
    server = Server(("0.0.0.0", int(os.getenv("BG_REMOVAL_PORT", "7000"))), engine)
    LOG.info("listening on port %s", server.server_port)
    try:
        server.serve_forever()
    finally:
        server.server_close()
        engine.stop()


if __name__ == "__main__":
    main()
