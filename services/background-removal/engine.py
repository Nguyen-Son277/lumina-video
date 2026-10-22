"""Inference engine: one CPU-only u2net session in a child process.

The child owns the ONNX session so a hung inference can be killed without
affecting the HTTP listener. Nothing here downloads anything at runtime.
"""
import io
import logging
import multiprocessing
import os
import threading

from PIL import Image, ImageOps, UnidentifiedImageError

from model import MODEL_NAME, verify_model

LOG = logging.getLogger("background-removal.engine")
MAX_SIDE = int(os.getenv("BG_REMOVAL_MAX_SIDE", "8192"))
MAX_PIXELS = int(os.getenv("BG_REMOVAL_MAX_PIXELS", "25000000"))
INFERENCE_TIMEOUT = float(os.getenv("BG_REMOVAL_TIMEOUT_SECONDS", "110"))
MAX_RESTARTS = int(os.getenv("BG_REMOVAL_MAX_RESTARTS", "3"))

# Pillow's own bomb guard fires above 2x MAX_IMAGE_PIXELS; the explicit limit
# below is the real bound, so keep the Pillow guard above it.
Image.MAX_IMAGE_PIXELS = MAX_PIXELS * 2

# EXIF orientation -> transform that maps the displayed image back onto the
# encoded pixel grid, so the mask always matches the request bytes exactly.
_EXIF_INVERSE = {
    2: Image.Transpose.FLIP_LEFT_RIGHT,
    3: Image.Transpose.ROTATE_180,
    4: Image.Transpose.FLIP_TOP_BOTTOM,
    5: Image.Transpose.TRANSPOSE,
    6: Image.Transpose.ROTATE_90,
    7: Image.Transpose.TRANSVERSE,
    8: Image.Transpose.ROTATE_270,
}


class InvalidImageError(ValueError):
    """The request bytes are not a usable PNG/JPEG within the bounds."""


class EngineUnavailableError(RuntimeError):
    """The model is not loaded or the inference failed."""


class EngineTimeout(EngineUnavailableError):
    """A single inference exceeded the configured budget."""


def _orientation(image):
    try:
        exif = image.getexif()
    except Exception:
        return 1
    value = exif.get(0x0112, 1) if exif else 1
    try:
        value = int(value)
    except (TypeError, ValueError):
        return 1
    return value if value in (1, 2, 3, 4, 5, 6, 7, 8) else 1


def decode_image(data: bytes):
    """Validate bytes and return (rgb_image, encoded_size, orientation)."""
    if not data:
        raise InvalidImageError("empty body")
    try:
        with Image.open(io.BytesIO(data)) as image:
            if image.format not in {"PNG", "JPEG"}:
                raise InvalidImageError("unsupported format")
            if getattr(image, "n_frames", 1) != 1:
                raise InvalidImageError("animated images are not supported")
            width, height = image.size
            if width < 1 or height < 1:
                raise InvalidImageError("empty image")
            if max(width, height) > MAX_SIDE or width * height > MAX_PIXELS:
                raise InvalidImageError("image dimensions exceed bounds")
            orientation = _orientation(image)
            image.load()
            encoded = (width, height)
            if orientation in _EXIF_INVERSE:
                image = ImageOps.exif_transpose(image)
            rgb = image.convert("RGB")
    except InvalidImageError:
        raise
    except (UnidentifiedImageError, Image.DecompressionBombError, OSError, ValueError) as error:
        raise InvalidImageError("unreadable image") from error
    return rgb, encoded, orientation


def _mask_for(session, rgb, encoded, orientation):
    mask = session.predict(rgb)[0].convert("L")
    if orientation in _EXIF_INVERSE:
        # Undo the display transform so the mask matches the encoded grid.
        mask = mask.transpose(_EXIF_INVERSE[orientation])
    if mask.size != encoded:
        mask = mask.resize(encoded, Image.Resampling.LANCZOS)
    return mask


def worker(connection):
    """Child process entry point: verify weights, load model, then serve masks."""
    try:
        path = verify_model()
        import onnxruntime as ort
        from rembg.sessions.u2net import U2netSession

        class OfflineU2netSession(U2netSession):
            @classmethod
            def download_models(cls, *args, **kwargs):
                # Upstream would fetch weights here; the image already holds
                # checksum-verified weights, so never download at runtime.
                return str(path)

        options = ort.SessionOptions()
        options.intra_op_num_threads = 1
        options.inter_op_num_threads = 1
        session = OfflineU2netSession(MODEL_NAME, options, providers=["CPUExecutionProvider"])
        connection.send(("ready", None))
        while True:
            payload = connection.recv()
            try:
                rgb, encoded, orientation = decode_image(payload)
                mask = _mask_for(session, rgb, encoded, orientation)
                buffer = io.BytesIO()
                mask.save(buffer, format="PNG", optimize=False)
                connection.send(("ok", buffer.getvalue()))
            except InvalidImageError as error:
                connection.send(("invalid", str(error)))
            except Exception:
                LOG.exception("inference failed")
                connection.send(("error", None))
    except EOFError:
        pass
    except Exception:
        LOG.exception("model initialization failed; readiness stays unavailable")
        try:
            connection.send(("unavailable", None))
        except Exception:
            pass
    finally:
        connection.close()


class Engine:
    def __init__(self):
        self.lock = threading.Lock()
        self.ready = False
        self.process = None
        self.connection = None
        self.restarts = 0

    def start(self):
        context = multiprocessing.get_context("spawn")
        self.connection, child = context.Pipe()
        self.process = context.Process(target=worker, args=(child,), daemon=True)
        self.process.start()
        child.close()
        threading.Thread(target=self._await_ready, daemon=True).start()

    def _await_ready(self):
        try:
            if self.connection.poll(300):
                self.ready = self.connection.recv()[0] == "ready"
        except (EOFError, OSError):
            self.ready = False

    def healthy(self):
        return bool(self.ready and self.process is not None and self.process.is_alive())

    def stop(self):
        self.ready = False
        if self.process is not None and self.process.is_alive():
            self.process.terminate()
            self.process.join(timeout=5)
            if self.process.is_alive():
                self.process.kill()
                self.process.join(timeout=5)
        if self.connection is not None:
            try:
                self.connection.close()
            except OSError:
                pass

    def restart(self):
        """Respawn the worker after a hard failure (for example a timeout).

        The service returns to healthy on its own instead of waiting for an
        operator to restart the container. Restart is rate limited so a
        permanently broken model cannot spin the CPU.
        """
        if self.restarts >= MAX_RESTARTS:
            LOG.error("restart limit reached; staying unhealthy")
            return False
        self.restarts += 1
        LOG.warning("restarting inference worker (attempt %s)", self.restarts)
        self.stop()
        try:
            self.start()
            return True
        except Exception:
            LOG.exception("worker restart failed")
            self.ready = False
            return False

    def infer(self, data):
        if not self.healthy():
            raise EngineUnavailableError("engine unavailable")
        self.connection.send(data)
        if not self.connection.poll(INFERENCE_TIMEOUT):
            raise EngineTimeout("inference timeout")
        status, payload = self.connection.recv()
        if status == "ok":
            # A successful inference proves the worker is healthy again, so the
            # restart budget is restored.
            self.restarts = 0
            return payload
        if status == "invalid":
            raise InvalidImageError(payload or "invalid image")
        raise EngineUnavailableError(payload or status)
