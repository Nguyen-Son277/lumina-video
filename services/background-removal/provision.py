"""Explicit build-only provisioner: fixed upstream URL and checked model bytes."""
import os
import urllib.request
from pathlib import Path

from model import MODEL_PATH, MODEL_URL, verify_model


def provision(destination: Path = MODEL_PATH) -> None:
    destination.parent.mkdir(parents=True, exist_ok=True)
    temporary = destination.with_suffix(".download")
    try:
        with urllib.request.urlopen(MODEL_URL, timeout=120) as source, temporary.open("wb") as target:
            total = 0
            while chunk := source.read(1024 * 1024):
                total += len(chunk)
                if total > 200 * 1024 * 1024:
                    raise ValueError("model exceeds provision size bound")
                target.write(chunk)
        verify_model(temporary)
        os.replace(temporary, destination)
        destination.chmod(0o444)
    finally:
        temporary.unlink(missing_ok=True)


if __name__ == "__main__":
    provision()
