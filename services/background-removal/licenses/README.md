Third-party licenses for the local background-removal sidecar
===========================================================

This service is optional. When it is disabled, the application keeps using the
provider based background removal option.

1. rembg (Python package, MIT License)
   - Project: https://github.com/danielgatis/rembg (tag v2.0.67)
   - License file: rembg-MIT.txt (verbatim upstream LICENSE.txt)
   - Copyright (c) 2020 Daniel Gatis

2. U-2-Net (model architecture and trained weights, Apache License 2.0)
   - Project: https://github.com/xuebinqin/U-2-Net
   - Commit: ac7e1c817ecab7c7dff5ce6b1abba61cd213ff29
   - License file: U-2-Net-Apache-2.0.txt (verbatim upstream LICENSE)

3. u2net.onnx weights
   - Downloaded at image build time from the rembg release assets:
     https://github.com/danielgatis/rembg/releases/download/v0.0.0/u2net.onnx
   - Verified against MD5 60024c5c889badc19c04ad937298a77b
     (the checksum published by rembg v2.0.67 in rembg/sessions/u2net.py).
   - File size observed when the checksum was verified: 175,997,641 bytes.
   - These weights are a converted export of the U-2-Net model and therefore
     fall under the Apache License 2.0 above.

The weights are never fetched while the service is running. `provision.py`
runs once during `docker build`; `model.py` re-verifies the MD5 of the file at
process start, and the runtime refuses to become ready if the checksum does not
match.

The upstream project `rembg` also ships models with other licenses. Only
`u2net` is used here, precisely because it does not depend on the mutable
default BRIA weights, whose licensing is not a permissive open-source license.
