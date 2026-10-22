"""Fixed u2net provenance. Downloads are allowed ONLY by provision.py at build time."""
import hashlib
from pathlib import Path

MODEL_NAME = "u2net"
MODEL_URL = "https://github.com/danielgatis/rembg/releases/download/v0.0.0/u2net.onnx"
# Verified against rembg v2.0.67/rembg/sessions/u2net.py (upstream uses MD5).
MODEL_MD5 = "60024c5c889badc19c04ad937298a77b"
MODEL_PATH = Path("/opt/models/u2net.onnx")


def verify_model(path: Path = MODEL_PATH) -> Path:
    digest = hashlib.md5(usedforsecurity=False)
    with path.open("rb") as source:
        for chunk in iter(lambda: source.read(1024 * 1024), b""):
            digest.update(chunk)
    if digest.hexdigest() != MODEL_MD5:
        raise ValueError("u2net model checksum mismatch")
    return path
